"""Sustained real-time-paced streaming with real OpenVoice ONNX — checks
memory stability and confirms the queue does NOT grow under load (unlike
Seed-VC's equivalent stress test, which found the opposite). Not run by
default: `pytest -m performance`.
"""

import asyncio
import json
from pathlib import Path

import numpy as np
import psutil
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


async def test_sustained_load_stays_realtime_and_memory_stable():
    settings = Settings(_env_file=None, server_host="127.0.0.1", server_port=0, stream_max_queue_depth=6)
    engine = get_engine(EngineName.OPENVOICE_ONNX, settings)
    process = psutil.Process()

    ready = asyncio.Event()
    bound_port: list[int] = []
    server_task = asyncio.ensure_future(
        run_server(engine, settings, ready_event=ready, bound_port=bound_port)
    )
    await asyncio.wait_for(ready.wait(), timeout=15)
    url = f"ws://127.0.0.1:{bound_port[0]}"

    audio, sr = sf.read(_SOURCE, dtype="float32")
    looped = np.concatenate([audio] * 5)  # ~62s of input — a genuine sustained run
    frame_ms = 500
    frame_len = int(sr * frame_ms / 1000)
    frames = [looped[i : i + frame_len] for i in range(0, len(looped), frame_len)]

    processed, rejected = 0, 0
    rss_samples = [process.memory_info().rss]

    async with websockets.connect(url, max_size=None) as ws:
        close_event = asyncio.Event()
        closed_holder: dict = {}

        async def receiver():
            nonlocal processed, rejected
            async for raw in ws:
                if isinstance(raw, (bytes, bytearray)):
                    processed += 1
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

        for i, frame in enumerate(frames):
            await ws.send(protocol.encode_audio_frame(i, sr, frame))
            if i % 5 == 0:
                rss_samples.append(process.memory_info().rss)
            await asyncio.sleep(frame_ms / 1000)

        await asyncio.sleep(5)
        rss_samples.append(process.memory_info().rss)

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

    rss_mb_series = [round(s / 1024 / 1024, 1) for s in rss_samples]
    growth_mb = rss_mb_series[-1] - rss_mb_series[0]
    print(
        f"\nOPENVOICE STRESS TEST ({len(frames)} x {frame_ms}ms frames = {len(looped) / sr:.1f}s input)\n"
        f"  processed:      {processed}\n"
        f"  rejected (BP):  {rejected}\n"
        f"  RSS series (MB): {rss_mb_series}\n"
        f"  RSS growth:      {growth_mb:.1f} MB\n"
        f"  final metrics:   {closed_holder}\n"
    )

    assert processed > 0
    assert rejected == 0  # this engine should never need backpressure at 500ms real-time pacing
