from dataclasses import asdict, dataclass

from app.engines.base import ConversionMetrics


@dataclass
class ConversionResult:
    """The CLI's ground-truth result shape — printed as the last stdout
    line of `convert`/`chunked-convert` and optionally written to
    --result-json. The backend (a separate process/runtime) parses exactly
    this shape and layers its own conversion_id/voice_profile_id/output_url
    on top; nothing here is backend-specific.
    """

    status: str
    engine: str
    model_version: str | None
    device: str
    source_duration_seconds: float
    processing_time_seconds: float
    rtf: float
    output_duration_seconds: float
    output_sample_rate: int
    output_path: str
    prepared_voice_id: str
    peak_rss_mb: float | None = None
    error: dict | None = None

    @classmethod
    def from_metrics(
        cls,
        metrics: ConversionMetrics,
        *,
        engine: str,
        model_version: str | None,
        device: str,
        output_path: str,
    ) -> "ConversionResult":
        return cls(
            status="completed",
            engine=engine,
            model_version=model_version,
            device=device,
            source_duration_seconds=metrics.source_duration_seconds,
            processing_time_seconds=metrics.processing_time_seconds,
            rtf=metrics.rtf,
            output_duration_seconds=metrics.output_duration_seconds,
            output_sample_rate=metrics.output_sample_rate,
            output_path=output_path,
            prepared_voice_id=metrics.prepared_voice_id,
            peak_rss_mb=metrics.peak_rss_mb,
        )

    @classmethod
    def failed(cls, *, engine: str, device: str, error: dict) -> "ConversionResult":
        return cls(
            status="failed",
            engine=engine,
            model_version=None,
            device=device,
            source_duration_seconds=0.0,
            processing_time_seconds=0.0,
            rtf=float("inf"),
            output_duration_seconds=0.0,
            output_sample_rate=0,
            output_path="",
            prepared_voice_id="",
            error=error,
        )

    def to_dict(self) -> dict:
        return asdict(self)
