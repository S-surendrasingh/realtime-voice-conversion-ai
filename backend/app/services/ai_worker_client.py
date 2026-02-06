"""Subprocess bridge to ai-worker/ (a separate Python runtime/package — see
docs/phase3-ai-conversion.md). This module knows nothing about voice
profiles, storage, or the database; it only runs the CLI and parses its
JSON result. app/services/conversion.py is the caller that bridges that to
domain concepts.
"""

import json
import logging
import subprocess
from pathlib import Path

from app.core.config import Settings

logger = logging.getLogger(__name__)


class AIWorkerInvocationError(Exception):
    """Raised for anything that isn't a clean, parseable JSON result from
    the AI worker — missing interpreter, timeout, crash, malformed output.
    A well-formed `{"status": "failed", "error": {...}}` result is NOT this
    exception; it's a normal return value the caller inspects."""


def _run(settings: Settings, args: list[str]) -> dict:
    cmd = [settings.ai_worker_python_path, "-m", "app.main", "--engine", settings.ai_engine, *args]
    try:
        completed = subprocess.run(
            cmd,
            cwd=settings.ai_worker_dir,
            capture_output=True,
            text=True,
            timeout=settings.ai_conversion_timeout_seconds,
        )
    except FileNotFoundError as exc:
        raise AIWorkerInvocationError(
            f"AI worker interpreter not found at {settings.ai_worker_python_path!r} "
            "(has `ai-worker/.venv` been set up? see ai-worker/README.md)"
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise AIWorkerInvocationError(
            f"AI worker did not finish within {settings.ai_conversion_timeout_seconds}s"
        ) from exc

    if completed.returncode != 0:
        logger.error(
            "AI worker command %s exited %s\nstdout=%s\nstderr=%s",
            args[:1],
            completed.returncode,
            completed.stdout,
            completed.stderr,
        )

    last_line = next(
        (line for line in reversed(completed.stdout.strip().splitlines()) if line.strip()), None
    )
    if last_line is None:
        raise AIWorkerInvocationError(
            f"AI worker produced no output (exit {completed.returncode}); see server logs"
        )
    try:
        return json.loads(last_line)
    except json.JSONDecodeError as exc:
        raise AIWorkerInvocationError(
            "AI worker produced malformed output; see server logs"
        ) from exc


def prepare_target_voice(
    settings: Settings, *, reference_files: list[Path], artifact_path: Path
) -> dict:
    args = ["prepare", "--output", str(artifact_path)]
    for ref in reference_files:
        args += ["--reference", str(ref)]
    return _run(settings, args)


def convert(
    settings: Settings, *, source_path: Path, prepared_voice_path: Path, output_path: Path
) -> dict:
    return _run(
        settings,
        [
            "convert",
            "--source",
            str(source_path),
            "--prepared-voice",
            str(prepared_voice_path),
            "--output",
            str(output_path),
        ],
    )
