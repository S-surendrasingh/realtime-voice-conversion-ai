import logging

from app.core.logging import configure_logging, log_device_banner


def test_configure_logging_sets_level_from_settings():
    configure_logging()
    assert logging.getLogger().level in (logging.INFO, logging.DEBUG)


def test_log_device_banner_states_cpu_only(caplog):
    with caplog.at_level(logging.INFO, logger="app.device"):
        log_device_banner()
    messages = "\n".join(caplog.messages)
    assert "AI Device: CPU" in messages
    assert "CUDA: disabled" in messages
    assert "GPU required: no" in messages
