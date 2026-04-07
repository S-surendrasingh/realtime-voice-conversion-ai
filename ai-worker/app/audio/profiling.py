"""Opt-in stage-level timing. Disabled by default (a no-op context manager
with negligible overhead) so normal CLI/production runs never pay for this
or pollute logs — enable explicitly via `Profiler(enabled=True)` for a
profiling run. See docs/phase3-ai-conversion.md "Profiling Results" for
what this was used to measure.
"""

import time
from collections import defaultdict
from contextlib import contextmanager
from dataclasses import dataclass, field


@dataclass
class StageTimings:
    totals: dict = field(default_factory=lambda: defaultdict(float))
    counts: dict = field(default_factory=lambda: defaultdict(int))
    order: list = field(default_factory=list)

    def record(self, name: str, seconds: float) -> None:
        if name not in self.totals:
            self.order.append(name)
        self.totals[name] += seconds
        self.counts[name] += 1

    @property
    def total_seconds(self) -> float:
        return sum(self.totals.values())

    def to_dict(self) -> dict:
        total = self.total_seconds
        return {
            name: {
                "ms": self.totals[name] * 1000,
                "calls": self.counts[name],
                "pct": (self.totals[name] / total * 100) if total else 0.0,
            }
            for name in self.order
        }

    def report(self, chunk_duration_seconds: float | None = None) -> str:
        total = self.total_seconds
        lines = []
        if chunk_duration_seconds is not None:
            lines.append(f"chunk duration: {chunk_duration_seconds * 1000:.0f} ms")
            lines.append("")
        width = max((len(n) for n in self.order), default=10)
        for name in self.order:
            ms = self.totals[name] * 1000
            pct = (self.totals[name] / total * 100) if total else 0.0
            calls = self.counts[name]
            suffix = f" (x{calls})" if calls > 1 else ""
            lines.append(f"{name.ljust(width)}  {ms:8.1f} ms  {pct:5.1f}%{suffix}")
        lines.append(f"{'total'.ljust(width)}  {total * 1000:8.1f} ms")
        return "\n".join(lines)


class Profiler:
    def __init__(self, enabled: bool = False):
        self.enabled = enabled
        self.timings = StageTimings()

    @contextmanager
    def stage(self, name: str):
        if not self.enabled:
            yield
            return
        start = time.perf_counter()
        try:
            yield
        finally:
            self.timings.record(name, time.perf_counter() - start)


NULL_PROFILER = Profiler(enabled=False)
