"""A bounded, backpressure-aware wrapper around one VoiceConversionEngine
StreamSession. See docs/phase3.1-resident-engine.md "Backpressure" for the
policy this implements: a full queue is surfaced to the caller as an
explicit error, never a silent drop and never unbounded accumulation.
"""

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

import numpy as np

from app.engines.base import StreamSession

logger = logging.getLogger("app.server.session")

_MAX_LATENCY_SAMPLES = 200  # bounded so a long-lived session can't leak memory here


@dataclass
class SessionMetrics:
    dropped_chunks: int = 0
    processed_chunks: int = 0
    processing_latencies_ms: list = field(default_factory=list)

    def record_latency(self, ms: float) -> None:
        self.processing_latencies_ms.append(ms)
        if len(self.processing_latencies_ms) > _MAX_LATENCY_SAMPLES:
            self.processing_latencies_ms.pop(0)

    def to_dict(self, queue_depth: int) -> dict:
        latencies = self.processing_latencies_ms
        avg = sum(latencies) / len(latencies) if latencies else 0.0
        return {
            "queue_depth": queue_depth,
            "dropped_chunks": self.dropped_chunks,
            "processed_chunks": self.processed_chunks,
            "avg_processing_latency_ms": avg,
            # A simple, honest estimate — not a guarantee — of how far behind
            # real-time this session currently is: queued chunks x recent
            # average processing time.
            "end_to_end_estimated_latency_ms": queue_depth * avg,
        }


class BackpressureError(Exception):
    """The session's bounded queue is full. Policy: reject new input
    explicitly rather than silently drop speech or let latency grow
    unbounded — the caller decides what to do (pause capture, warn, etc.)."""


class ResidentStreamSession:
    def __init__(self, stream: StreamSession, session_id: str, max_queue_depth: int = 4):
        self._stream = stream
        self.session_id = session_id
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=max_queue_depth)
        self.metrics = SessionMetrics()
        self._closed = False

    @property
    def queue_depth(self) -> int:
        return self._queue.qsize()

    def metrics_snapshot(self) -> dict:
        return self.metrics.to_dict(self.queue_depth)

    async def submit(self, sequence: int, sample_rate: int, samples: np.ndarray) -> None:
        if self._queue.full():
            self.metrics.dropped_chunks += 1
            raise BackpressureError(
                f"session {self.session_id} queue is full (max {self._queue.maxsize}) — "
                "input rejected, not dropped silently"
            )
        await self._queue.put((sequence, sample_rate, samples))

    async def run(
        self, on_result: Callable[[int, np.ndarray | None, Exception | None], Awaitable[None]]
    ) -> None:
        """Background consumer: one chunk at a time, off the event loop
        thread (process_chunk is a blocking, CPU-bound call)."""
        loop = asyncio.get_running_loop()
        while True:
            item = await self._queue.get()
            if item is None:  # close() sentinel
                break
            sequence, sample_rate, samples = item
            start = time.monotonic()
            try:
                result = await loop.run_in_executor(None, self._stream.process, samples, sample_rate)
            except Exception as exc:  # noqa: BLE001 - reported to the client, not swallowed
                logger.exception("session %s: chunk %s failed", self.session_id, sequence)
                await on_result(sequence, None, exc)
                continue
            self.metrics.record_latency((time.monotonic() - start) * 1000)
            self.metrics.processed_chunks += 1
            await on_result(sequence, result, None)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self._queue.put(None)
        self._stream.close()
