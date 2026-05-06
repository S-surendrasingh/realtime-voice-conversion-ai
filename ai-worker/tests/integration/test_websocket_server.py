"""Real WebSocket connection, real asyncio server — only the AI engine is
faked (see tests/fakes.py), so these tests exercise the actual IPC protocol
(app/server/protocol.py) end-to-end without downloading real weights.
"""

import asyncio
import json

import numpy as np
import pytest
import websockets

from app.core.config import Settings
from app.server import protocol
from app.server.websocket_server import run_server
from tests.fakes import FakeVoiceConversionEngine

pytestmark = pytest.mark.integration


@pytest.fixture
async def server(tmp_path):
    engine = FakeVoiceConversionEngine()
    settings = Settings(
        _env_file=None,
        server_host="127.0.0.1",
        server_port=0,
        model_cache_dir=tmp_path,
        stream_max_queue_depth=4,
    )
    ready = asyncio.Event()
    bound_port: list[int] = []
    task = asyncio.ensure_future(run_server(engine, settings, ready_event=ready, bound_port=bound_port))
    await asyncio.wait_for(ready.wait(), timeout=5)
    yield f"ws://127.0.0.1:{bound_port[0]}", engine
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


async def _send_control(ws, msg_type, **fields):
    request_id = fields.pop("request_id", "req-1")
    await ws.send(json.dumps(protocol.control_message(msg_type, request_id, **fields)))
    return json.loads(await ws.recv())


async def test_hello_returns_welcome_with_protocol_version(server):
    url, _engine = server
    async with websockets.connect(url) as ws:
        response = await _send_control(ws, protocol.MSG_HELLO)
        assert response["type"] == protocol.MSG_WELCOME
        assert response["protocol_version"] == protocol.PROTOCOL_VERSION
        assert response["request_id"] == "req-1"


async def test_health_reports_engine_state(server):
    url, _engine = server
    async with websockets.connect(url) as ws:
        response = await _send_control(ws, protocol.MSG_HEALTH)
        assert response["type"] == protocol.MSG_HEALTH_REPORT
        assert response["state"] == "NOT_LOADED"


async def test_load_voice_triggers_engine_load_exactly_once(server, make_wav):
    url, engine = server
    ref = make_wav("ref.wav")
    async with websockets.connect(url) as ws:
        await _send_control(ws, protocol.MSG_LOAD_VOICE, voice_profile_id="p1", reference_paths=[str(ref)])
        await _send_control(ws, protocol.MSG_LOAD_VOICE, voice_profile_id="p1", reference_paths=[str(ref)])
    assert engine.load_count == 1
    assert engine.warmup_count == 1
    assert len(engine.prepare_calls) == 1  # second load_voice was a cache hit


async def test_full_stream_lifecycle_open_process_close(server, make_wav):
    url, _engine = server
    ref = make_wav("ref.wav")
    async with websockets.connect(url) as ws:
        await _send_control(ws, protocol.MSG_LOAD_VOICE, voice_profile_id="p1", reference_paths=[str(ref)])
        opened = await _send_control(ws, protocol.MSG_STREAM_OPEN)
        assert opened["type"] == protocol.MSG_STREAM_OPENED
        assert "session_id" in opened

        chunk = np.linspace(-0.5, 0.5, 800, dtype="float32")
        await ws.send(protocol.encode_audio_frame(0, 22050, chunk))
        raw = await ws.recv()
        assert isinstance(raw, bytes)
        frame = protocol.decode_audio_frame(raw)
        assert frame.sequence == 0
        assert frame.sample_rate == 22050
        assert len(frame.samples) == len(chunk)

        closed = await _send_control(ws, protocol.MSG_STREAM_CLOSE)
        assert closed["type"] == protocol.MSG_STREAM_CLOSED
        assert closed["processed_chunks"] == 1


async def test_multiple_chunks_processed_in_order(server, make_wav):
    url, _engine = server
    ref = make_wav("ref.wav")
    async with websockets.connect(url) as ws:
        await _send_control(ws, protocol.MSG_LOAD_VOICE, voice_profile_id="p1", reference_paths=[str(ref)])
        await _send_control(ws, protocol.MSG_STREAM_OPEN)

        for i in range(4):
            await ws.send(protocol.encode_audio_frame(i, 22050, np.zeros(100, dtype="float32")))
        sequences = []
        for _ in range(4):
            frame = protocol.decode_audio_frame(await ws.recv())
            sequences.append(frame.sequence)
        assert sequences == [0, 1, 2, 3]


async def test_stream_open_without_load_voice_returns_error(server):
    url, _engine = server
    async with websockets.connect(url) as ws:
        response = await _send_control(ws, protocol.MSG_STREAM_OPEN)
        assert response["type"] == protocol.MSG_ERROR


async def test_audio_before_stream_open_returns_error(server):
    url, _engine = server
    async with websockets.connect(url) as ws:
        await ws.send(protocol.encode_audio_frame(0, 22050, np.zeros(10, dtype="float32")))
        response = json.loads(await ws.recv())
        assert response["type"] == protocol.MSG_ERROR
        assert response["code"] == "NO_STREAM_OPEN"


async def test_invalid_binary_frame_returns_error_not_crash(server, make_wav):
    url, _engine = server
    ref = make_wav("ref.wav")
    async with websockets.connect(url) as ws:
        await _send_control(ws, protocol.MSG_LOAD_VOICE, voice_profile_id="p1", reference_paths=[str(ref)])
        await _send_control(ws, protocol.MSG_STREAM_OPEN)

        await ws.send(b"\x01\x02")  # too short to contain a valid header
        response = json.loads(await ws.recv())
        assert response["type"] == protocol.MSG_ERROR
        assert response["code"] == "INVALID_AUDIO_FRAME"

        # connection must still work afterward
        await ws.send(protocol.encode_audio_frame(0, 22050, np.zeros(50, dtype="float32")))
        frame = protocol.decode_audio_frame(await ws.recv())
        assert frame.sequence == 0


async def test_engine_processing_error_is_reported_not_fatal(server, make_wav):
    url, engine = server
    ref = make_wav("ref.wav")
    async with websockets.connect(url) as ws:
        await _send_control(ws, protocol.MSG_LOAD_VOICE, voice_profile_id="p1", reference_paths=[str(ref)])
        await _send_control(ws, protocol.MSG_STREAM_OPEN)

        engine.fail_next_chunk = True
        await ws.send(protocol.encode_audio_frame(0, 22050, np.zeros(50, dtype="float32")))
        response = json.loads(await ws.recv())
        assert response["type"] == protocol.MSG_ERROR
        assert response["code"] == "CONVERSION_FAILED"

        # the session survives — a later chunk still processes fine
        await ws.send(protocol.encode_audio_frame(1, 22050, np.zeros(50, dtype="float32")))
        frame = protocol.decode_audio_frame(await ws.recv())
        assert frame.sequence == 1


async def test_unexpected_disconnect_does_not_corrupt_engine_state(server, make_wav):
    url, engine = server
    ref = make_wav("ref.wav")
    ws = await websockets.connect(url)
    await _send_control(ws, protocol.MSG_LOAD_VOICE, voice_profile_id="p1", reference_paths=[str(ref)])
    await _send_control(ws, protocol.MSG_STREAM_OPEN)
    await ws.close()  # simulate an abrupt client disconnect mid-stream

    await asyncio.sleep(0.1)  # let the server's handler finish cleanup

    # a fresh connection to the same resident engine must work normally
    async with websockets.connect(url) as ws2:
        response = await _send_control(ws2, protocol.MSG_HEALTH)
        assert response["state"] == "READY"


async def test_second_connection_reuses_cached_target_voice(server, make_wav):
    url, engine = server
    ref = make_wav("ref.wav")
    async with websockets.connect(url) as ws1:
        await _send_control(ws1, protocol.MSG_LOAD_VOICE, voice_profile_id="p1", reference_paths=[str(ref)])
    async with websockets.connect(url) as ws2:
        await _send_control(ws2, protocol.MSG_LOAD_VOICE, voice_profile_id="p1", reference_paths=[str(ref)])
    assert len(engine.prepare_calls) == 1


async def test_unload_voice_then_reload_prepares_again(server, make_wav):
    url, engine = server
    ref = make_wav("ref.wav")
    async with websockets.connect(url) as ws:
        await _send_control(ws, protocol.MSG_LOAD_VOICE, voice_profile_id="p1", reference_paths=[str(ref)])
        unloaded = await _send_control(ws, protocol.MSG_UNLOAD_VOICE, voice_profile_id="p1")
        assert unloaded["unloaded"] is True
        await _send_control(ws, protocol.MSG_LOAD_VOICE, voice_profile_id="p1", reference_paths=[str(ref)])
    assert len(engine.prepare_calls) == 2


async def test_shutdown_stops_the_server(server):
    url, _engine = server
    async with websockets.connect(url) as ws:
        response = await _send_control(ws, protocol.MSG_SHUTDOWN)
        assert response["type"] == protocol.MSG_SHUTTING_DOWN

    with pytest.raises((ConnectionRefusedError, OSError, websockets.exceptions.WebSocketException)):
        await asyncio.wait_for(websockets.connect(url), timeout=2)


async def test_stream_open_twice_on_same_connection_is_rejected(server, make_wav):
    url, _engine = server
    ref = make_wav("ref.wav")
    async with websockets.connect(url) as ws:
        await _send_control(ws, protocol.MSG_LOAD_VOICE, voice_profile_id="p1", reference_paths=[str(ref)])
        await _send_control(ws, protocol.MSG_STREAM_OPEN)
        response = await _send_control(ws, protocol.MSG_STREAM_OPEN)
        assert response["type"] == protocol.MSG_ERROR
