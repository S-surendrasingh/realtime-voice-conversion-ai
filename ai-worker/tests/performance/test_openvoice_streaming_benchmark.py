"""Real OpenVoice ONNX, real resident server, real WebSocket client — same
harness as the Seed-VC streaming benchmark (Phase 3.1), for a genuine
apples-to-apples comparison. Not run by default: `pytest -m performance`.
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

_VENDOR_EXAMPLES = Path(__file__).resolve().parents[2] / "vendor" / "seed-vc" / "examples"
_SOURCE = _VENDOR_EXAMPLES / "source" / "source_s1.wav"
_REFERENCE = _VENDOR_EXAMPLES / "reference" / "s1p1.wav"

pytestmark = [
    pytest.mark.performance,
    pytest.mark.skipif(not _SOURCE.exists(), reason="vendor/seed-vc examples not present"),
]


async def test_realtime_paced_streaming_openvoice(tmp_path):
    settings = Settings(_env_file=None, server_host="127.0.0.1", server_port=0, stream_max_queue_depth=6)
    engine = get_engine(EngineName.OPENVOICE_ONNX, settings)

    ready = asyncio.Event()
    bound_port: list[int] = []
    server_task = asyncio.ensure_future(
        run_server(engine, settings, ready_event=ready, bound_port=bound_port)
    )
    await asyncio.wait_for(ready.wait(), timeout=15)
    url = f"ws://127.0.0.1:{bound_port[0]}"

    audio, sr = sf.read(_SOURCE, dtype="float32")
    frame_ms = 500
    frame_len = int(sr * frame_ms / 1000)
    frames = [audio[i : i + frame_len] for i in range(0, len(audio), frame_len)]

    processed, rejected = 0, 0
    closed_holder: dict = {}
    close_event = asyncio.Event()
    latencies = []
    send_times = {}

    async with websockets.connect(url, max_size=None) as ws:

        async def receiver():
            nonlocal processed, rejected
            async for raw in ws:
                if isinstance(raw, (bytes, bytearray)):
                    frame = protocol.decode_audio_frame(bytes(raw))
                    processed += 1
                    if frame.sequence in send_times:
                        latencies.append((time.monotonic() - send_times[frame.sequence]) * 1000)
                else:
                    msg = json.loads(raw)
                    if msg.get("type") == protocol.MSG_ERROR and msg.get("code") == "BACKPRESSURE":
                        rejected += 1
                    elif msg.get("type") == protocol.MSG_STREAM_CLOSED:
                        closed_holder.update(msg)
                        close_event.set()

        recv_task = asyncio.ensure_future(receiver())
        await ws.send(
            json.dumps(
                protocol.control_message(
                    protocol.MSG_LOAD_VOICE, "l", voice_profile_id="p", reference_paths=[str(_REFERENCE)]
                )
            )
        )
        await ws.send(json.dumps(protocol.control_message(protocol.MSG_STREAM_OPEN, "o")))
        await asyncio.sleep(1)

        start = time.monotonic()
        for i, frame in enumerate(frames):
            send_times[i] = time.monotonic()
            await ws.send(protocol.encode_audio_frame(i, sr, frame))
            await asyncio.sleep(frame_ms / 1000)
        total_wall_clock = time.monotonic() - start

        await asyncio.sleep(5)  # short drain — this engine should already be caught up
        await ws.send(json.dumps(protocol.control_message(protocol.MSG_STREAM_CLOSE, "c")))
        try:
            await asyncio.wait_for(close_event.wait(), timeout=10)
        except asyncio.TimeoutError:
            pass
        recv_task.cancel()

    server_task.cancel()
    try:
        await server_task
    except asyncio.CancelledError:
        pass

    avg_latency = sum(latencies) / len(latencies) if latencies else 0
    print(
        f"\nOPENVOICE STREAMING BENCHMARK ({frame_ms}ms frames, real wall-clock pacing)\n"
        f"  frames sent:          {len(frames)}\n"
        f"  frames processed:     {processed}\n"
        f"  frames rejected (BP): {rejected}\n"
        f"  input duration:       {len(audio) / sr:.1f}s\n"
        f"  wall clock elapsed:   {total_wall_clock:.1f}s\n"
        f"  end-to-end avg latency (send->receive): {avg_latency:.1f}ms\n"
        f"  stream.close metrics: {closed_holder}\n"
    )

    assert processed > 0
    # The honest point of this test: unlike Seed-VC, this engine should keep
    # up with 500ms real-time frame arrival without needing backpressure.
    assert rejected == 0
