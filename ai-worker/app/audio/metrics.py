import threading
from contextlib import contextmanager
from dataclasses import dataclass

import psutil


def compute_rtf(processing_time_seconds: float, source_duration_seconds: float) -> float:
    if source_duration_seconds <= 0:
        return float("inf")
    return processing_time_seconds / source_duration_seconds


@dataclass
class LatencyStats:
    count: int
    avg_ms: float
    p95_ms: float
    min_ms: float
    max_ms: float

    @classmethod
    def from_seconds(cls, latencies_seconds: list[float]) -> "LatencyStats":
        if not latencies_seconds:
            return cls(count=0, avg_ms=0.0, p95_ms=0.0, min_ms=0.0, max_ms=0.0)
        ms = sorted(v * 1000 for v in latencies_seconds)
        p95_index = min(int(round(0.95 * (len(ms) - 1))), len(ms) - 1)
        return cls(
            count=len(ms),
            avg_ms=sum(ms) / len(ms),
            p95_ms=ms[p95_index],
            min_ms=ms[0],
            max_ms=ms[-1],
        )


class _RssSampler:
    def __init__(self, interval_seconds: float = 0.05):
        self._interval = interval_seconds
        self._process = psutil.Process()
        self._peak_rss_bytes = 0
        self._cpu_samples: list[float] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        self._process.cpu_percent(None)  # prime the counter, per psutil docs
        while not self._stop.wait(self._interval):
            self._peak_rss_bytes = max(self._peak_rss_bytes, self._process.memory_info().rss)
            self._cpu_samples.append(self._process.cpu_percent(None))

    def start(self) -> None:
        self._peak_rss_bytes = self._process.memory_info().rss
        self._thread.start()

    def stop(self) -> tuple[float, float]:
        self._stop.set()
        self._thread.join(timeout=2 * self._interval)
        peak_mb = self._peak_rss_bytes / (1024 * 1024)
        avg_cpu = sum(self._cpu_samples) / len(self._cpu_samples) if self._cpu_samples else 0.0
        return peak_mb, avg_cpu


@contextmanager
def track_resource_usage():
    """Yields a dict that is filled in with {"peak_rss_mb", "avg_cpu_percent"}
    once the `with` block exits. Sampled on a background thread rather than
    just before/after, since a single before/after RSS snapshot would miss
    a transient peak in the middle of inference.
    """
    sampler = _RssSampler()
    result: dict = {}
    sampler.start()
    try:
        yield result
    finally:
        peak_mb, avg_cpu = sampler.stop()
        result["peak_rss_mb"] = peak_mb
        result["avg_cpu_percent"] = avg_cpu
