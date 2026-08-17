/**
 * TypeScript mirror of the resident-engine IPC protocol defined in
 * `ai-worker/app/server/protocol.py`. This is NOT a new protocol — every
 * constant, field name, and byte layout here must match that module and
 * the live wire behavior of `ai-worker/app/server/websocket_server.py`
 * exactly (verified by hand round-trip during Phase 4 audit: engine.hello
 * -> engine.welcome, engine.health -> engine.health_report against a real
 * running `python -m app.main --engine openvoice_onnx serve`).
 *
 * If ai-worker's protocol.py ever changes, update this file to match —
 * never let the two drift, and never invent a second protocol.
 */

export const PROTOCOL_VERSION = 1 as const;

export const MSG_HELLO = "engine.hello" as const;
export const MSG_WELCOME = "engine.welcome" as const;
export const MSG_HEALTH = "engine.health" as const;
export const MSG_HEALTH_REPORT = "engine.health_report" as const;
export const MSG_LOAD_VOICE = "engine.load_voice" as const;
export const MSG_VOICE_LOADED = "engine.voice_loaded" as const;
export const MSG_UNLOAD_VOICE = "engine.unload_voice" as const;
export const MSG_VOICE_UNLOADED = "engine.voice_unloaded" as const;
export const MSG_STREAM_OPEN = "stream.open" as const;
export const MSG_STREAM_OPENED = "stream.opened" as const;
export const MSG_STREAM_CLOSE = "stream.close" as const;
export const MSG_STREAM_CLOSED = "stream.closed" as const;
export const MSG_STREAM_METRICS = "stream.metrics" as const;
export const MSG_SHUTDOWN = "engine.shutdown" as const;
export const MSG_SHUTTING_DOWN = "engine.shutting_down" as const;
export const MSG_ERROR = "engine.error" as const;

// -- control message payload shapes (server -> client) ----------------------

export type EngineStateName =
  | "NOT_LOADED"
  | "LOADING"
  | "WARMING_UP"
  | "READY"
  | "CONVERTING"
  | "STREAMING"
  | "ERROR"
  | "SHUTTING_DOWN";

export interface EngineHealthReport {
  version: 1;
  type: typeof MSG_HEALTH_REPORT;
  request_id?: string;
  state: EngineStateName;
  device: string;
  engine: string;
  model: string | null;
  model_version: string | null;
  configured: boolean;
  loaded: boolean;
  detail: string | null;
}

export interface WelcomeMessage {
  version: 1;
  type: typeof MSG_WELCOME;
  request_id?: string;
  protocol_version: number;
}

export interface VoiceLoadedMessage {
  version: 1;
  type: typeof MSG_VOICE_LOADED;
  request_id?: string;
  voice_profile_id: string;
  prepared_voice_id: string;
}

export interface VoiceUnloadedMessage {
  version: 1;
  type: typeof MSG_VOICE_UNLOADED;
  request_id?: string;
  voice_profile_id: string;
  unloaded: boolean;
}

export interface StreamOpenedMessage {
  version: 1;
  type: typeof MSG_STREAM_OPENED;
  request_id?: string;
  session_id: string;
}

export interface StreamMetrics {
  queue_depth: number;
  dropped_chunks: number;
  processed_chunks: number;
  avg_processing_latency_ms: number;
  end_to_end_estimated_latency_ms: number;
}

export interface StreamClosedMessage extends StreamMetrics {
  version: 1;
  type: typeof MSG_STREAM_CLOSED;
  request_id?: string;
}

export interface ShuttingDownMessage {
  version: 1;
  type: typeof MSG_SHUTTING_DOWN;
  request_id?: string;
}

export type EngineErrorCode =
  | "NO_STREAM_OPEN"
  | "INVALID_AUDIO_FRAME"
  | "BACKPRESSURE"
  | "CONVERSION_FAILED"
  | "INVALID_MESSAGE"
  | "BAD_REQUEST"
  | string;

export interface EngineErrorMessage {
  version: 1;
  type: typeof MSG_ERROR;
  request_id?: string | null;
  code: EngineErrorCode;
  message: string;
}

export type ServerControlMessage =
  | WelcomeMessage
  | EngineHealthReport
  | VoiceLoadedMessage
  | VoiceUnloadedMessage
  | StreamOpenedMessage
  | StreamClosedMessage
  | ShuttingDownMessage
  | EngineErrorMessage;

// -- control message payload shapes (client -> server) -----------------------

export interface LoadVoiceRequest {
  version: 1;
  type: typeof MSG_LOAD_VOICE;
  request_id: string;
  voice_profile_id: string;
  reference_paths: string[];
}

export interface UnloadVoiceRequest {
  version: 1;
  type: typeof MSG_UNLOAD_VOICE;
  request_id: string;
  voice_profile_id: string;
}

export interface SimpleRequest {
  version: 1;
  type:
    | typeof MSG_HELLO
    | typeof MSG_HEALTH
    | typeof MSG_STREAM_OPEN
    | typeof MSG_STREAM_CLOSE
    | typeof MSG_SHUTDOWN;
  request_id: string;
}

export type ClientControlMessage = LoadVoiceRequest | UnloadVoiceRequest | SimpleRequest;

export function errorMessage(
  requestId: string | null | undefined,
  code: EngineErrorCode,
  message: string
): EngineErrorMessage {
  return controlMessage(MSG_ERROR, requestId ?? undefined, { code, message }) as EngineErrorMessage;
}

export function controlMessage<T extends Record<string, unknown>>(
  type: string,
  requestId: string | undefined,
  fields: T = {} as T
): { version: 1; type: string; request_id?: string } & T {
  const message = { version: PROTOCOL_VERSION, type, ...fields } as {
    version: 1;
    type: string;
    request_id?: string;
  } & T;
  if (requestId !== undefined) {
    message.request_id = requestId;
  }
  return message;
}

// -- binary audio frame ------------------------------------------------------
// 4 bytes sequence (uint32 LE) + 4 bytes sample_rate (uint32 LE) + raw
// float32 LE PCM samples. Identical layout both directions. Matches
// `_HEADER = struct.Struct("<II")` in ai-worker/app/server/protocol.py.

export const AUDIO_FRAME_HEADER_BYTES = 8;

export interface AudioFrame {
  sequence: number;
  sampleRate: number;
  samples: Float32Array;
}

export function encodeAudioFrame(sequence: number, sampleRate: number, samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(AUDIO_FRAME_HEADER_BYTES + samples.length * 4);
  const view = new DataView(buffer);
  view.setUint32(0, sequence, true);
  view.setUint32(4, sampleRate, true);
  new Float32Array(buffer, AUDIO_FRAME_HEADER_BYTES).set(samples);
  return buffer;
}

export function decodeAudioFrame(data: ArrayBuffer): AudioFrame {
  if (data.byteLength < AUDIO_FRAME_HEADER_BYTES) {
    throw new Error(`Binary frame too short: ${data.byteLength} bytes (need at least ${AUDIO_FRAME_HEADER_BYTES})`);
  }
  const view = new DataView(data);
  const sequence = view.getUint32(0, true);
  const sampleRate = view.getUint32(4, true);
  // .slice() copies so the returned Float32Array isn't a view into a buffer
  // that may be reused/detached by the transport (WebSocket delivers a
  // fresh ArrayBuffer per message in practice, but copying keeps this
  // function's contract independent of that detail).
  const samples = new Float32Array(data.slice(AUDIO_FRAME_HEADER_BYTES));
  return { sequence, sampleRate, samples };
}
