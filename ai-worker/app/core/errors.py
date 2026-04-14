from enum import Enum


class AIErrorCode(str, Enum):
    MODEL_NOT_FOUND = "AI_MODEL_NOT_FOUND"
    MODEL_LOAD_FAILED = "AI_MODEL_LOAD_FAILED"
    MODEL_DOWNLOAD_FAILED = "AI_MODEL_DOWNLOAD_FAILED"
    TARGET_VOICE_NOT_READY = "TARGET_VOICE_NOT_READY"
    TARGET_VOICE_PREPARATION_FAILED = "TARGET_VOICE_PREPARATION_FAILED"
    SOURCE_AUDIO_INVALID = "SOURCE_AUDIO_INVALID"
    CONVERSION_FAILED = "CONVERSION_FAILED"
    INVALID_MODEL_OUTPUT = "INVALID_MODEL_OUTPUT"
    INFERENCE_TOO_SLOW = "INFERENCE_TOO_SLOW"
    CACHE_INVALID = "CACHE_INVALID"


class AIEngineError(Exception):
    """Base error for every AI-worker failure mode. `code` is the stable,
    machine-readable identifier callers (the backend, the CLI) branch on;
    `message` is safe to log server-side but is NOT guaranteed safe to
    return verbatim to an external API caller — the backend re-wraps it
    behind its own DomainError before it ever reaches an HTTP response.
    """

    def __init__(self, code: AIErrorCode, message: str, *, recovery_action: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.recovery_action = recovery_action

    def to_dict(self) -> dict:
        return {"code": self.code.value, "message": self.message, "recovery_action": self.recovery_action}
