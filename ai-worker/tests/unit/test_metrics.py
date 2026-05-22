from app.audio.metrics import LatencyStats, compute_rtf, track_resource_usage


def test_compute_rtf_basic():
    assert compute_rtf(6.0, 10.0) == 0.6


def test_compute_rtf_not_realtime():
    assert compute_rtf(15.0, 10.0) == 1.5


def test_compute_rtf_zero_duration_is_infinite():
    assert compute_rtf(1.0, 0.0) == float("inf")


def test_latency_stats_from_empty():
    stats = LatencyStats.from_seconds([])
    assert stats.count == 0
    assert stats.avg_ms == 0.0


def test_latency_stats_basic():
    stats = LatencyStats.from_seconds([0.1, 0.2, 0.3])
    assert stats.count == 3
    assert stats.min_ms == 100.0
    assert stats.max_ms == 300.0
    assert stats.avg_ms == 200.0


def test_latency_stats_p95_is_near_the_top_of_the_distribution():
    latencies = [i / 1000 for i in range(1, 101)]  # 1ms..100ms
    stats = LatencyStats.from_seconds(latencies)
    assert stats.p95_ms >= 94.0


def test_track_resource_usage_fills_in_peak_rss_and_cpu():
    with track_resource_usage() as usage:
        _ = [x * x for x in range(100000)]
    assert "peak_rss_mb" in usage
    assert usage["peak_rss_mb"] > 0
    assert "avg_cpu_percent" in usage
