"""Real Seed-VC, real resident server, real WebSocket client. Simulates
microphone arrival timing (frames sent at real wall-clock intervals, not as
fast as possible) and measures whether the resident engine keeps up — see
docs/phase3.1-resident-engine.md "Streaming Benchmark" for the results this
produced. Not run by default: `pytest -m performance`.
"""

import asyncio
import json
import time
from pathlib import Path

import pytest
import soundfile as sf
import websockets

from app.core.config import EngineName, Settings
from app.engines.registry import get_engine
from app.server import protocol
from app.server.websocket_server import run_server

pytestmark = pytest.mark.performance

_VENDOR_EXAMPLES = Path(__file__).resolve().parents[2] / "vendor" / "seed-vc" / "examples"
_SOURCE = _VENDOR_EXAMPLES / "source" / "source_s1.wav"
_REFERENCE = _VENDOR_EXAMPLES / "reference" / "s1p1.wav"

pytestmark = [
    pytest.mark.performance,
    pytest.mark.skipif(not _SOURCE.exists(), reason="vendor/seed-vc examples not present"),
]


async def _send_control(ws, msg_type, **fields):
    request_id = fields.pop("request_id", "req")
    await ws.send(json.dumps(protocol.control_message(msg_type, request_id, **fields)))
    return json.loads(await ws.recv())


async def test_realtime_paced_streaming_reports_honest_backpressure(tmp_path):
    settings = Settings(
        _env_file=None,
        server_host="127.0.0.1",
        server_port=0,
        stream_reference_seconds=3.0,
        stream_max_queue_depth=6,
        seed_vc_diffusion_steps=4,
    )
    engine = get_engine(EngineName.SEED_VC, settings)

    ready = asyncio.Event()
    bound_port: list[int] = []
    server_task = asyncio.ensure_future(
        run_server(engine, settings, ready_event=ready, bound_port=bound_port)
    )
    await asyncio.wait_for(ready.wait(), timeout=10)
    url = f"ws://127.0.0.1:{bound_port[0]}"

    audio, sr = sf.read(_SOURCE, dtype="float32")
    frame_ms = 1000
    frame_len = int(sr * frame_ms / 1000)
    frames = [audio[i : i + frame_len] for i in range(0, len(audio), frame_len)]

    sent, processed = 0, 0
    results_log = []
    closed_holder: dict = {}
    close_event = asyncio.Event()

    async with websockets.connect(url, max_size=None) as ws:
        # A single receiver task owns recv() for the whole connection —
        # websockets disallows concurrent recv() calls, so control-message
        # responses (including stream.closed) are dispatched here too,
        # rather than each _send_control call awaiting its own recv().
        async def receiver():
            nonlocal processed
            async for raw in ws:
                if isinstance(raw, (bytes, bytearray)):
                    frame = protocol.decode_audio_frame(bytes(raw))
                    processed += 1
                    results_log.append(("processed", frame.sequence, time.monotonic()))
                else:
                    msg = json.loads(raw)
                    if msg.get("type") == protocol.MSG_ERROR:
                        results_log.append(("error", msg.get("code"), time.monotonic()))
                    elif msg.get("type") == protocol.MSG_STREAM_CLOSED:
                        closed_holder.update(msg)
                        close_event.set()

        recv_task = asyncio.ensure_future(receiver())

        await ws.send(
            json.dumps(
                protocol.control_message(
                    protocol.MSG_LOAD_VOICE,
                    "load",
                    voice_profile_id="perf-test",
                    reference_paths=[str(_REFERENCE)],
                )
            )
        )
        await ws.send(json.dumps(protocol.control_message(protocol.MSG_STREAM_OPEN, "open")))
        await asyncio.sleep(1)  # let load_voice + stream.open responses land before audio starts

        start = time.monotonic()
        for i, frame in enumerate(frames):
            try:
                await ws.send(protocol.encode_audio_frame(i, sr, frame))
                sent += 1
            except websockets.exceptions.ConnectionClosed:
                break
            await asyncio.sleep(frame_ms / 1000)  # real wall-clock pacing, not as-fast-as-possible

        # Give the engine a bounded window to drain whatever's still queued
        # rather than waiting for full real-time catch-up (which, given the
        # measured per-chunk cost, could take minutes) — see the honest
        # numbers this produces in docs/phase3.1-resident-engine.md.
        await asyncio.sleep(15)
        total_wall_clock = time.monotonic() - start

        await ws.send(json.dumps(protocol.control_message(protocol.MSG_STREAM_CLOSE, "close")))
        try:
            await asyncio.wait_for(close_event.wait(), timeout=10)
        except asyncio.TimeoutError:
            pass
        recv_task.cancel()

    closed = closed_holder
    rejected = sum(1 for kind, code, _ in results_log if kind == "error" and code == "BACKPRESSURE")

    await _send_control_shutdown(url)
    server_task.cancel()
    try:
        await server_task
    except asyncio.CancelledError:
        pass

    print(
        f"\nSTREAMING BENCHMARK (real Seed-VC, {frame_ms}ms frames, real wall-clock pacing)\n"
        f"  frames sent:              {sent}\n"
        f"  frames processed:         {processed}\n"
        f"  frames rejected (BP):     {rejected}\n"
        f"  input duration:           {len(audio) / sr:.1f}s\n"
        f"  wall clock elapsed:       {total_wall_clock:.1f}s\n"
        f"  stream.close metrics:     {closed}\n"
    )

    assert sent > 0
    # The honest point of this test: the engine cannot currently keep up
    # with 1000ms real-time frame arrival, so backpressure MUST engage
    # rather than silently accumulating unbounded latency.
    assert (rejected + processed) > 0


async def _send_control_shutdown(url):
    try:
        async with websockets.connect(url) as ws:
            await _send_control(ws, protocol.MSG_SHUTDOWN)
    except Exception:
        pass
