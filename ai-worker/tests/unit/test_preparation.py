from pathlib import Path

from app.core.config import Settings
from app.voices.models import ReferenceSample
from app.voices.preparation import select_references


def _sample(name: str, duration: float) -> ReferenceSample:
    return ReferenceSample(path=Path(name), duration_seconds=duration)


def test_selects_up_to_max_reference_samples():
    settings = Settings(_env_file=None, max_reference_samples=2, max_reference_duration_seconds=1000)
    samples = [_sample("a.wav", 10), _sample("b.wav", 10), _sample("c.wav", 10)]
    selected = select_references(samples, settings)
    assert len(selected) == 2


def test_respects_duration_budget():
    settings = Settings(_env_file=None, max_reference_samples=10, max_reference_duration_seconds=25)
    samples = [_sample("a.wav", 20), _sample("b.wav", 20), _sample("c.wav", 20)]
    selected = select_references(samples, settings)
    assert sum(s.duration_seconds for s in selected) <= 25 or len(selected) == 1


def test_selection_is_deterministic_regardless_of_input_order():
    settings = Settings(_env_file=None, max_reference_samples=2, max_reference_duration_seconds=1000)
    samples = [_sample("c.wav", 10), _sample("a.wav", 10), _sample("b.wav", 10)]
    result1 = select_references(samples, settings)
    result2 = select_references(list(reversed(samples)), settings)
    assert [s.path for s in result1] == [s.path for s in result2]


def test_always_returns_at_least_one_sample_if_any_exist():
    settings = Settings(_env_file=None, max_reference_samples=5, max_reference_duration_seconds=1)
    samples = [_sample("a.wav", 50)]
    selected = select_references(samples, settings)
    assert len(selected) == 1


def test_empty_input_returns_empty():
    settings = Settings(_env_file=None)
    assert select_references([], settings) == []
