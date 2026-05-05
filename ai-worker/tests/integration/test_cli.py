"""Exercises `python -m app.main` as a real subprocess with the passthrough
engine — this is the exact boundary the backend's ai_worker_client.py
depends on, so testing it as a subprocess (not by importing main() in-process)
is deliberate: it catches argument-parsing and stdout-contract bugs that an
in-process call could hide.
"""

import json
import subprocess
import sys

import pytest

pytestmark = pytest.mark.integration


def _run(args, cwd):
    return subprocess.run(
        [sys.executable, "-m", "app.main", "--engine", "passthrough", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=30,
    )


def _last_json_line(stdout: str) -> dict:
    line = next(line for line in reversed(stdout.strip().splitlines()) if line.strip())
    return json.loads(line)


@pytest.fixture
def project_root():
    from pathlib import Path

    return Path(__file__).resolve().parents[2]


def test_convert_end_to_end(project_root, make_wav, tmp_path):
    source = make_wav("source.wav", duration_seconds=2.0)
    reference = make_wav("ref.wav", duration_seconds=3.0, seed=1)
    output = tmp_path / "out.wav"

    result = _run(
        ["convert", "--source", str(source), "--reference", str(reference), "--output", str(output)],
        cwd=project_root,
    )

    assert result.returncode == 0, result.stderr
    body = _last_json_line(result.stdout)
    assert body["status"] == "completed"
    assert output.exists()


def test_convert_with_prepared_voice_skips_prepare(project_root, make_wav, tmp_path):
    reference = make_wav("ref.wav", duration_seconds=3.0, seed=2)
    artifact = tmp_path / "artifact.json"
    prepare_result = _run(
        ["prepare", "--reference", str(reference), "--output", str(artifact)], cwd=project_root
    )
    assert prepare_result.returncode == 0, prepare_result.stderr

    source = make_wav("source.wav", duration_seconds=2.0, seed=3)
    output = tmp_path / "out.wav"
    result = _run(
        ["convert", "--source", str(source), "--prepared-voice", str(artifact), "--output", str(output)],
        cwd=project_root,
    )

    assert result.returncode == 0, result.stderr
    assert output.exists()


def test_convert_without_reference_or_prepared_voice_fails_cleanly(project_root, make_wav, tmp_path):
    source = make_wav("source.wav", duration_seconds=2.0)
    result = _run(
        ["convert", "--source", str(source), "--output", str(tmp_path / "out.wav")], cwd=project_root
    )

    assert result.returncode != 0
    body = _last_json_line(result.stdout)
    assert body["status"] == "failed"


def test_chunked_convert_end_to_end(project_root, make_wav, tmp_path):
    source = make_wav("source.wav", duration_seconds=2.0)
    reference = make_wav("ref.wav", duration_seconds=3.0, seed=4)
    output = tmp_path / "chunked.wav"

    result = _run(
        [
            "chunked-convert",
            "--source",
            str(source),
            "--reference",
            str(reference),
            "--artifact",
            str(tmp_path / "artifact.json"),
            "--output",
            str(output),
            "--chunk-ms",
            "200",
        ],
        cwd=project_root,
    )

    assert result.returncode == 0, result.stderr
    body = _last_json_line(result.stdout)
    assert body["status"] == "completed"
    assert body["chunks"] > 0
    assert output.exists()


def test_health_check(project_root):
    result = _run(["health-check"], cwd=project_root)
    assert result.returncode == 0, result.stderr
    body = _last_json_line(result.stdout)
    assert body["device"] == "cpu"
    assert body["engine"] == "passthrough"


def test_benchmark_end_to_end(project_root, make_wav, tmp_path):
    source = make_wav("source.wav", duration_seconds=2.0)
    reference = make_wav("ref.wav", duration_seconds=3.0, seed=5)

    result = _run(
        [
            "benchmark",
            "--source",
            str(source),
            "--reference",
            str(reference),
            "--output",
            str(tmp_path / "out.wav"),
            "--artifact",
            str(tmp_path / "artifact.json"),
        ],
        cwd=project_root,
    )

    assert result.returncode == 0, result.stderr
    assert "Realtime feasibility" in result.stdout
