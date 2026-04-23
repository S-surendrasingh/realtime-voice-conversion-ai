"""Resident streaming engine — local WebSocket server (Phase 3.1). Binds
127.0.0.1 only. See docs/phase3.1-resident-engine.md for the full protocol
this implements; app/server/protocol.py is the executable source of truth
for message shapes.

One WebSocket connection hosts at most one open stream at a time (matching
how a future Electron client would use it: connect, load a voice, open one
stream for the session's live audio, close it, maybe open another). An
unexpected disconnect only tears down THIS connection's session — the
resident engine and its target-voice cache are unaffected, so other
connections (or the next one) keep working.
"""

import asyncio
import json
import logging
import uuid
from pathlib import Path

import websockets

from app.core.config import Settings
from app.core.errors import AIEngineError
from app.server import protocol
from app.server.engine_manager import EngineManager
from app.server.session import BackpressureError, ResidentStreamSession

logger = logging.getLogger("app.server.websocket_server")


class ConnectionHandler:
    def __init__(self, engine_manager: EngineManager, shutdown_event: asyncio.Event, max_queue_depth: int):
        self._engine_manager = engine_manager
        self._shutdown_event = shutdown_event
        self._max_queue_depth = max_queue_depth
        self._session: ResidentStreamSession | None = None
        self._consumer_task: asyncio.Task | None = None
        self._loaded_voice_artifact_path: Path | None = None

    async def handle(self, websocket) -> None:
        peer = getattr(websocket, "remote_address", None)
        logger.info("Client connected: %s", peer)
        try:
            async for raw in websocket:
                if isinstance(raw, (bytes, bytearray)):
                    await self._handle_binary(websocket, bytes(raw))
                else:
                    await self._handle_control(websocket, raw)
        except websockets.exceptions.ConnectionClosed:
            logger.info("Client disconnected (connection closed): %s", peer)
        finally:
            # Disconnect must not corrupt engine state — only this
            # connection's session is torn down.
            await self._cleanup_session()

    async def _cleanup_session(self) -> None:
        if self._session is not None:
            await self._session.close()
        if self._consumer_task is not None:
            try:
                await asyncio.wait_for(self._consumer_task, timeout=2.0)
            except (TimeoutError, asyncio.CancelledError):
                self._consumer_task.cancel()
        self._session = None
        self._consumer_task = None

    async def _handle_binary(self, websocket, raw: bytes) -> None:
        if self._session is None:
            await websocket.send(
                json.dumps(
                    protocol.error_message(None, "NO_STREAM_OPEN", "Send stream.open before audio frames")
                )
            )
            return
        try:
            frame = protocol.decode_audio_frame(raw)
        except ValueError as exc:
            await websocket.send(json.dumps(protocol.error_message(None, "INVALID_AUDIO_FRAME", str(exc))))
            return
        try:
            await self._session.submit(frame.sequence, frame.sample_rate, frame.samples)
        except BackpressureError as exc:
            await websocket.send(json.dumps(protocol.error_message(None, "BACKPRESSURE", str(exc))))

    async def _on_result(self, websocket, sequence: int, result, error: Exception | None) -> None:
        if error is not None:
            await websocket.send(json.dumps(protocol.error_message(None, "CONVERSION_FAILED", str(error))))
            return
        samples, output_sample_rate = result
        try:
            await websocket.send(protocol.encode_audio_frame(sequence, output_sample_rate, samples))
        except websockets.exceptions.ConnectionClosed:
            pass  # client is gone; the session cleanup path handles teardown

    async def _handle_control(self, websocket, raw: str) -> None:
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            await websocket.send(
                json.dumps(protocol.error_message(None, "INVALID_MESSAGE", "Not valid JSON"))
            )
            return

        msg_type = message.get("type")
        request_id = message.get("request_id")
        try:
            await self._dispatch(websocket, msg_type, request_id, message)
        except AIEngineError as exc:
            await websocket.send(json.dumps(protocol.error_message(request_id, exc.code.value, exc.message)))
        except (KeyError, ValueError) as exc:
            await websocket.send(json.dumps(protocol.error_message(request_id, "BAD_REQUEST", str(exc))))

    async def _dispatch(self, websocket, msg_type: str, request_id: str | None, message: dict) -> None:
        if msg_type == protocol.MSG_HELLO:
            await websocket.send(
                json.dumps(
                    protocol.control_message(
                        protocol.MSG_WELCOME, request_id, protocol_version=protocol.PROTOCOL_VERSION
                    )
                )
            )

        elif msg_type == protocol.MSG_HEALTH:
            health = self._engine_manager.health()
            await websocket.send(
                json.dumps(
                    protocol.control_message(protocol.MSG_HEALTH_REPORT, request_id, **health.to_dict())
                )
            )

        elif msg_type == protocol.MSG_LOAD_VOICE:
            voice_profile_id = message["voice_profile_id"]
            reference_paths = [Path(p) for p in message["reference_paths"]]
            prepared_voice_id, artifact_path = self._engine_manager.load_voice(
                voice_profile_id, reference_paths
            )
            self._loaded_voice_artifact_path = artifact_path
            await websocket.send(
                json.dumps(
                    protocol.control_message(
                        protocol.MSG_VOICE_LOADED,
                        request_id,
                        voice_profile_id=voice_profile_id,
                        prepared_voice_id=prepared_voice_id,
                    )
                )
            )

        elif msg_type == protocol.MSG_UNLOAD_VOICE:
            voice_profile_id = message["voice_profile_id"]
            unloaded = self._engine_manager.unload_voice(voice_profile_id)
            await websocket.send(
                json.dumps(
                    protocol.control_message(
                        protocol.MSG_VOICE_UNLOADED,
                        request_id,
                        voice_profile_id=voice_profile_id,
                        unloaded=unloaded,
                    )
                )
            )

        elif msg_type == protocol.MSG_STREAM_OPEN:
            if self._loaded_voice_artifact_path is None:
                raise ValueError("No voice loaded — send engine.load_voice before stream.open")
            if self._session is not None:
                raise ValueError("A stream is already open on this connection — stream.close it first")
            session_id = str(uuid.uuid4())
            stream = self._engine_manager.engine.create_stream(self._loaded_voice_artifact_path)
            self._session = ResidentStreamSession(stream, session_id, max_queue_depth=self._max_queue_depth)
            self._consumer_task = asyncio.ensure_future(
                self._session.run(lambda seq, result, err: self._on_result(websocket, seq, result, err))
            )
            await websocket.send(
                json.dumps(
                    protocol.control_message(protocol.MSG_STREAM_OPENED, request_id, session_id=session_id)
                )
            )

        elif msg_type == protocol.MSG_STREAM_CLOSE:
            metrics = self._session.metrics_snapshot() if self._session else {}
            await self._cleanup_session()
            await websocket.send(
                json.dumps(protocol.control_message(protocol.MSG_STREAM_CLOSED, request_id, **metrics))
            )

        elif msg_type == protocol.MSG_SHUTDOWN:
            await self._cleanup_session()
            self._engine_manager.shutdown()
            await websocket.send(json.dumps(protocol.control_message(protocol.MSG_SHUTTING_DOWN, request_id)))
            self._shutdown_event.set()

        else:
            raise ValueError(f"Unknown message type: {msg_type!r}")


async def run_server(
    engine,
    settings: Settings,
    ready_event: asyncio.Event | None = None,
    bound_port: list[int] | None = None,
) -> None:
    """`bound_port`, if given, is a single-element list that gets the actual
    bound port appended after binding — lets tests use server_port=0 (OS
    picks a free port) and discover it, without a fixed port risking
    collisions between test runs."""
    engine_manager = EngineManager(engine, Path(settings.model_cache_dir) / "resident-targets", settings)
    shutdown_event = asyncio.Event()

    async def handler(websocket):
        await ConnectionHandler(engine_manager, shutdown_event, settings.stream_max_queue_depth).handle(
            websocket
        )

    async with websockets.serve(handler, settings.server_host, settings.server_port) as server:
        actual_port = server.sockets[0].getsockname()[1]
        logger.info("Resident AI engine listening on ws://%s:%s", settings.server_host, actual_port)
        if bound_port is not None:
            bound_port.append(actual_port)
        if ready_event is not None:
            ready_event.set()
        await shutdown_event.wait()
        logger.info("Shutdown requested — stopping server")
