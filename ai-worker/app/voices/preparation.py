"""Deterministic Person-A reference selection. Runs inside the AI worker
(not the backend) because "how much reference audio, and how many clips"
is a property of the model, not of the enrollment domain — a different
engine could have a different budget without the backend needing to know.
"""

from app.core.config import Settings
from app.voices.models import ReferenceSample


def select_references(samples: list[ReferenceSample], settings: Settings) -> list[ReferenceSample]:
    """Picks up to `max_reference_samples` samples, stopping once their
    combined duration would exceed `max_reference_duration_seconds`.
    Deterministic: samples are first sorted by path so the same input set
    always yields the same selection (and therefore the same cache key) —
    duration/quality is not used as a ranking signal here since the backend
    only ever hands over samples already marked VALID by AudioValidationService.
    """
    ordered = sorted(samples, key=lambda s: str(s.path))
    selected: list[ReferenceSample] = []
    total_duration = 0.0
    for sample in ordered:
        if len(selected) >= settings.max_reference_samples:
            break
        if selected and total_duration + sample.duration_seconds > settings.max_reference_duration_seconds:
            continue
        selected.append(sample)
        total_duration += sample.duration_seconds
    if not selected and ordered:
        selected = [ordered[0]]  # always return at least one sample if any exist
    return selected
