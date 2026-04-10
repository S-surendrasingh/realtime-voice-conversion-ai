from app.benchmark.runner import ChunkSizeResult, OfflineBenchmarkResult

REALTIME_RTF_GATE = 1.0
PREFERRED_RTF_GATE = 0.70


def format_offline_report(result: OfflineBenchmarkResult) -> str:
    live_feasible = result.rtf < REALTIME_RTF_GATE
    lines = [
        "SYSTEM",
        f"  OS               {result.system.os}",
        f"  CPU              {result.system.cpu_model}",
        f"  Logical cores    {result.system.logical_cores}",
        f"  RAM              {result.system.ram_total_gb:.1f} GB",
        f"  Python           {result.system.python_version}",
        "",
        "MODEL",
        f"  Name             {result.engine_name}",
        f"  Version          {result.model_version or 'n/a'}",
        f"  Device           {result.device}",
        "",
        "REFERENCE",
        f"  Duration         {result.reference_duration_seconds:.2f}s",
        f"  Samples          {result.reference_sample_count}",
        f"  Preparation time {result.reference_prep_seconds:.3f}s",
        "",
        "SOURCE",
        f"  Duration         {result.source_duration_seconds:.2f}s",
        "",
        "INFERENCE",
        f"  Model load time  {result.model_load_seconds:.3f}s",
        f"  Warmup time      {result.warmup_seconds:.3f}s",
        f"  Conversion time  {result.conversion_seconds:.3f}s",
        f"  RTF              {result.rtf:.3f}",
        f"  Peak RAM         {result.peak_rss_mb:.1f} MB",
        f"  Average CPU      {result.avg_cpu_percent:.1f}%",
        f"  Output duration  {result.output_duration_seconds:.2f}s",
        "",
        "RESULT",
        "  Offline conversion:    PASS",
        f"  Realtime feasibility:  {'PASS' if live_feasible else 'NOT YET PASSING'} (RTF {result.rtf:.3f}, gate < {REALTIME_RTF_GATE})",
    ]
    return "\n".join(lines)


def format_chunked_report(results: list[ChunkSizeResult]) -> str:
    lines = [f"{'chunk_ms':>9} {'avg_ms':>8} {'p95_ms':>8} {'rtf':>7} {'gate<1.0':>9} {'gate<0.7':>9}"]
    for r in results:
        lines.append(
            f"{r.chunk_ms:>9} {r.latency.avg_ms:>8.1f} {r.latency.p95_ms:>8.1f} {r.rtf:>7.3f} "
            f"{'PASS' if r.rtf < 1.0 else 'FAIL':>9} {'PASS' if r.rtf < 0.70 else 'FAIL':>9}"
        )
    best = min(results, key=lambda r: r.rtf) if results else None
    if best:
        lines.append("")
        lines.append(
            f"Best chunk size: {best.chunk_ms}ms (RTF {best.rtf:.3f}, avg latency {best.latency.avg_ms:.1f}ms)"
        )
    return "\n".join(lines)
