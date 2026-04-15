import logging
import sys

from app.core.config import get_settings


def configure_logging() -> None:
    settings = get_settings()
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        # stderr, not stdout: the CLI contract (see app/main.py) is that
        # stdout's last line is always exactly one JSON result — logging
        # must never be able to land there.
        stream=sys.stderr,
        force=True,
    )


def log_device_banner() -> None:
    """Printed on every engine load so CPU-only operation is always visible
    in logs, never just implied by the absence of an error."""
    logger = logging.getLogger("app.device")
    logger.info("AI Device: CPU")
    logger.info("CUDA: disabled")
    logger.info("GPU required: no")
