import {
  controlMessage,
  decodeAudioFrame,
  encodeAudioFrame,
  MSG_ERROR,
  MSG_HEALTH,
  MSG_HELLO,
  MSG_LOAD_VOICE,
  MSG_SHUTDOWN,
  MSG_STREAM_CLOSE,
  MSG_STREAM_OPEN,
  MSG_UNLOAD_VOICE,
  PROTOCOL_VERSION,
  type AudioFrame,
  type EngineErrorMessage,
  type EngineHealthReport,
  type ServerControlMessage,
  type StreamClosedMessage,
  type StreamOpenedMessage,
  type VoiceLoadedMessage,
  type VoiceUnloadedMessage,
} from "@shared/protocol";

export type EngineClientConnectionState = "disconnected" | "connecting" | "connected" | "closed";

export class EngineProtocolError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EngineProtocolError";
    this.code = code;
  }
}

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}-${Date.now()}`;
}

interface PendingRequest {
  resolve: (msg: ServerControlMessage) => void;
  reject: (err: Error) => void;
}

/** Typed WebSocket client for the resident ai-worker engine. Reuses the
 * EXACT existing protocol from ai-worker/app/server/protocol.py (mirrored
 * in src/shared/protocol.ts) — this is not a new protocol, only a typed
 * client for it. Connects only to a caller-supplied ws://127.0.0.1:PORT
 * URL; never assumes a remote host. */
export class EngineClient {
  private ws: WebSocket | null = null;
  private state: EngineClientConnectionState = "disconnected";
  private pending = new Map<string, PendingRequest>();
  private outgoingSequence = 0;
  private audioFrameListeners = new Set<(frame: AudioFrame) => void>();
  // Errors with no request_id (e.g. BACKPRESSURE/NO_STREAM_OPEN/
  // INVALID_AUDIO_FRAME raised from a binary frame, not a control
  // message — see websocket_server.py `_handle_binary`) surface here,
  // since there is no pending request to reject.
  private streamErrorListeners = new Set<(err: EngineErrorMessage) => void>();
  private closeListeners = new Set<() => void>();

  constructor(private readonly url: string) {}

  getState(): EngineClientConnectionState {
    return this.state;
  }

  connect(timeoutMs = 5000): Promise<void> {
    if (this.state === "connected") return Promise.resolve();
    this.state = "connecting";
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.close();
        this.state = "disconnected";
        reject(new Error(`Timed out connecting to engine at ${this.url}`));
      }, timeoutMs);

      ws.addEventListener("open", () => {
        this.sendControl(MSG_HELLO)
          .then((welcome) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const protocolVersion = (welcome as { protocol_version?: number }).protocol_version;
            if (protocolVersion !== PROTOCOL_VERSION) {
              this.state = "disconnected";
              ws.close();
              reject(
                new EngineProtocolError(
                  "PROTOCOL_VERSION_MISMATCH",
                  `Engine speaks protocol v${protocolVersion}, desktop expects v${PROTOCOL_VERSION}`
                )
              );
              return;
            }
            this.state = "connected";
            resolve();
          })
          .catch((err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
          });
      });

      ws.addEventListener("message", (event) => this.handleMessage(event));

      ws.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.state = "disconnected";
        reject(new Error(`Failed to connect to engine at ${this.url}`));
      });

      ws.addEventListener("close", () => {
        this.state = "closed";
        for (const [, req] of this.pending) {
          req.reject(new Error("Connection closed"));
        }
        this.pending.clear();
        for (const cb of this.closeListeners) cb();
      });
    });
  }

  private handleMessage(event: MessageEvent): void {
    if (event.data instanceof ArrayBuffer) {
      let frame: AudioFrame;
      try {
        frame = decodeAudioFrame(event.data);
      } catch {
        // Malformed binary from the engine must never crash the renderer.
        return;
      }
      for (const cb of this.audioFrameListeners) cb(frame);
      return;
    }

    let message: ServerControlMessage & { request_id?: string };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return; // malformed control message — ignore rather than throw
    }

    const requestId = message.request_id;
    if (requestId && this.pending.has(requestId)) {
      const req = this.pending.get(requestId)!;
      this.pending.delete(requestId);
      if (message.type === MSG_ERROR) {
        const err = message as EngineErrorMessage;
        req.reject(new EngineProtocolError(err.code, err.message));
      } else {
        req.resolve(message);
      }
      return;
    }

    // No matching pending request — either a spontaneous engine.error
    // (request_id null, from a binary-frame-triggered failure) or a
    // message for a request_id we no longer track. Either way, surface
    // it as a stream-level error rather than dropping it silently.
    if (message.type === MSG_ERROR) {
      for (const cb of this.streamErrorListeners) cb(message as EngineErrorMessage);
    }
  }

  private sendControl(type: string, fields: Record<string, unknown> = {}): Promise<ServerControlMessage> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Engine connection is not open"));
    }
    const requestId = nextRequestId();
    const message = controlMessage(type, requestId, fields);
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.ws!.send(JSON.stringify(message));
    });
  }

  health(): Promise<EngineHealthReport> {
    return this.sendControl(MSG_HEALTH) as Promise<EngineHealthReport>;
  }

  loadVoice(voiceProfileId: string, referencePaths: string[]): Promise<VoiceLoadedMessage> {
    return this.sendControl(MSG_LOAD_VOICE, {
      voice_profile_id: voiceProfileId,
      reference_paths: referencePaths,
    }) as Promise<VoiceLoadedMessage>;
  }

  unloadVoice(voiceProfileId: string): Promise<VoiceUnloadedMessage> {
    return this.sendControl(MSG_UNLOAD_VOICE, { voice_profile_id: voiceProfileId }) as Promise<VoiceUnloadedMessage>;
  }

  openStream(): Promise<StreamOpenedMessage> {
    return this.sendControl(MSG_STREAM_OPEN) as Promise<StreamOpenedMessage>;
  }

  closeStream(): Promise<StreamClosedMessage> {
    return this.sendControl(MSG_STREAM_CLOSE) as Promise<StreamClosedMessage>;
  }

  shutdown(): Promise<ServerControlMessage> {
    return this.sendControl(MSG_SHUTDOWN);
  }

  /** Sends one chunk of mono float32 PCM as a binary frame. Returns the
   * sequence number assigned — the engine echoes the SAME sequence number
   * back on the converted-audio frame (see websocket_server.py
   * `_on_result`), which the renderer's jitter buffer uses to reorder
   * without a separate correlation map. Returns null if the socket isn't
   * open (caller should treat this as a rejected send, matching backpressure
   * handling for engine-side rejections). */
  sendAudioFrame(sampleRate: number, samples: Float32Array): number | null {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return null;
    const sequence = this.outgoingSequence;
    this.outgoingSequence += 1;
    this.ws.send(encodeAudioFrame(sequence, sampleRate, samples));
    return sequence;
  }

  onAudioFrame(callback: (frame: AudioFrame) => void): () => void {
    this.audioFrameListeners.add(callback);
    return () => this.audioFrameListeners.delete(callback);
  }

  /** Errors not tied to a specific request — covers BACKPRESSURE,
   * NO_STREAM_OPEN, INVALID_AUDIO_FRAME, CONVERSION_FAILED raised while a
   * stream is open (see websocket_server.py `_handle_binary`/`_on_result`). */
  onStreamError(callback: (err: EngineErrorMessage) => void): () => void {
    this.streamErrorListeners.add(callback);
    return () => this.streamErrorListeners.delete(callback);
  }

  onClose(callback: () => void): () => void {
    this.closeListeners.add(callback);
    return () => this.closeListeners.delete(callback);
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
