"""Versioned local-IPC protocol for the resident streaming engine (Phase
3.1). Full narrative documentation for Phase 4 (Electron) integrators lives
in docs/phase3.1-resident-engine.md — this module is the executable
source of truth for the wire format that document describes.

Control messages are JSON text frames, always shaped
{"version": PROTOCOL_VERSION, "type": "...", "request_id": "..."}. Audio
is NEVER JSON/base64 — every audio chunk is a binary frame with a small
fixed header (see encode_audio_frame/decode_audio_frame) followed by raw
float32 little-endian PCM samples.
"""

import struct
from dataclasses import dataclass

import numpy as np

PROTOCOL_VERSION = 1

# -- control message type names ------------------------------------------

MSG_HELLO = "engine.hello"
MSG_WELCOME = "engine.welcome"
MSG_HEALTH = "engine.health"
MSG_HEALTH_REPORT = "engine.health_report"
MSG_LOAD_VOICE = "engine.load_voice"
MSG_VOICE_LOADED = "engine.voice_loaded"
MSG_UNLOAD_VOICE = "engine.unload_voice"
MSG_VOICE_UNLOADED = "engine.voice_unloaded"
MSG_STREAM_OPEN = "stream.open"
MSG_STREAM_OPENED = "stream.opened"
MSG_STREAM_CLOSE = "stream.close"
MSG_STREAM_CLOSED = "stream.closed"
MSG_STREAM_METRICS = "stream.metrics"
MSG_SHUTDOWN = "engine.shutdown"
MSG_SHUTTING_DOWN = "engine.shutting_down"
MSG_ERROR = "engine.error"

# -- binary audio frame header --------------------------------------------
# 4 bytes sequence number (uint32 LE) + 4 bytes sample_rate (uint32 LE),
# followed by raw float32 LE PCM samples. Kept intentionally tiny — this is
# a local loopback transport, not a network protocol that needs versioning
# resilience baked into every frame (the JSON handshake already carries
# PROTOCOL_VERSION).
_HEADER = struct.Struct("<II")
_HEADER_SIZE = _HEADER.size


@dataclass(frozen=True)
class AudioFrame:
    sequence: int
    sample_rate: int
    samples: np.ndarray  # float32, mono


def encode_audio_frame(sequence: int, sample_rate: int, samples: np.ndarray) -> bytes:
    pcm = np.ascontiguousarray(samples, dtype="float32")
    return _HEADER.pack(sequence, sample_rate) + pcm.tobytes()


def decode_audio_frame(data: bytes) -> AudioFrame:
    if len(data) < _HEADER_SIZE:
        raise ValueError(f"Binary frame too short: {len(data)} bytes (need at least {_HEADER_SIZE})")
    sequence, sample_rate = _HEADER.unpack_from(data, 0)
    samples = np.frombuffer(data, dtype="float32", offset=_HEADER_SIZE).copy()
    return AudioFrame(sequence=sequence, sample_rate=sample_rate, samples=samples)


def control_message(msg_type: str, request_id: str | None = None, **fields) -> dict:
    message = {"version": PROTOCOL_VERSION, "type": msg_type}
    if request_id is not None:
        message["request_id"] = request_id
    message.update(fields)
    return message


def error_message(request_id: str | None, code: str, message: str) -> dict:
    return control_message(MSG_ERROR, request_id, code=code, message=message)
