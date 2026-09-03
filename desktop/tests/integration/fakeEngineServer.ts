import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";
import {
  controlMessage,
  decodeAudioFrame,
  encodeAudioFrame,
  errorMessage,
  MSG_HEALTH,
  MSG_HELLO,
  MSG_LOAD_VOICE,
  MSG_SHUTDOWN,
  MSG_STREAM_CLOSE,
  MSG_STREAM_OPEN,
  MSG_UNLOAD_VOICE,
  MSG_HEALTH_REPORT,
  MSG_VOICE_LOADED,
  MSG_VOICE_UNLOADED,
  MSG_STREAM_OPENED,
  MSG_STREAM_CLOSED,
  MSG_SHUTTING_DOWN,
  MSG_WELCOME,
  PROTOCOL_VERSION,
} from "../../src/shared/protocol";

/** A minimal, deterministic stand-in for ai-worker's real resident engine
 * (websocket_server.py), used to test the real EngineClient against real
 * WebSocket + real protocol framing WITHOUT loading OpenVoice. Validates
 * architecture, not model quality — see Step 53. */
export class FakeEngineServer {
  private wss: WebSocketServer | null = null;
  private streamOpen = false;
  public backpressureAfter: number | null = null;
  private framesSinceOpen = 0;

  async start(): Promise<number> {
    this.wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    this.wss.on("connection", (ws) => this.handleConnection(ws));
    await new Promise<void>((resolve) => this.wss!.once("listening", resolve));
    const address = this.wss.address();
    if (typeof address === "string" || address === null) throw new Error("Failed to bind fake engine server");
    return address.port;
  }

  private handleConnection(ws: WsWebSocket): void {
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        this.handleBinary(ws, data as Buffer);
      } else {
        this.handleControl(ws, data.toString());
      }
    });
  }

  private handleBinary(ws: WsWebSocket, data: Buffer): void {
    if (!this.streamOpen) {
      ws.send(JSON.stringify(errorMessage(null, "NO_STREAM_OPEN", "Send stream.open before audio frames")));
      return;
    }
    this.framesSinceOpen += 1;
    if (this.backpressureAfter !== null && this.framesSinceOpen > this.backpressureAfter) {
      ws.send(JSON.stringify(errorMessage(null, "BACKPRESSURE", "queue full")));
      return;
    }
    const frame = decodeAudioFrame(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    );
    // Deterministic "conversion": invert sign. Lets tests assert exactly
    // what came back without depending on any real model.
    const converted = new Float32Array(frame.samples.length);
    for (let i = 0; i < frame.samples.length; i++) converted[i] = -frame.samples[i];
    ws.send(Buffer.from(encodeAudioFrame(frame.sequence, frame.sampleRate, converted)));
  }

  private handleControl(ws: WsWebSocket, raw: string): void {
    const message = JSON.parse(raw) as { type: string; request_id?: string; [key: string]: unknown };
    const { type, request_id: requestId } = message;

    if (type === MSG_HELLO) {
      ws.send(JSON.stringify(controlMessage(MSG_WELCOME, requestId, { protocol_version: PROTOCOL_VERSION })));
    } else if (type === MSG_HEALTH) {
      ws.send(
        JSON.stringify(
          controlMessage(MSG_HEALTH_REPORT, requestId, {
            state: "READY",
            device: "cpu",
            engine: "openvoice_onnx",
            model: "tone_clone_model.onnx",
            model_version: "openvoice-v2-onnx",
            configured: true,
            loaded: true,
            detail: null,
          })
        )
      );
    } else if (type === MSG_LOAD_VOICE) {
      ws.send(
        JSON.stringify(
          controlMessage(MSG_VOICE_LOADED, requestId, {
            voice_profile_id: message.voice_profile_id,
            prepared_voice_id: "fake-prepared-voice-1",
          })
        )
      );
    } else if (type === MSG_UNLOAD_VOICE) {
      ws.send(
        JSON.stringify(
          controlMessage(MSG_VOICE_UNLOADED, requestId, { voice_profile_id: message.voice_profile_id, unloaded: true })
        )
      );
    } else if (type === MSG_STREAM_OPEN) {
      this.streamOpen = true;
      this.framesSinceOpen = 0;
      ws.send(JSON.stringify(controlMessage(MSG_STREAM_OPENED, requestId, { session_id: "fake-session-1" })));
    } else if (type === MSG_STREAM_CLOSE) {
      this.streamOpen = false;
      ws.send(
        JSON.stringify(
          controlMessage(MSG_STREAM_CLOSED, requestId, {
            queue_depth: 0,
            dropped_chunks: 0,
            processed_chunks: this.framesSinceOpen,
            avg_processing_latency_ms: 5,
            end_to_end_estimated_latency_ms: 0,
          })
        )
      );
    } else if (type === MSG_SHUTDOWN) {
      ws.send(JSON.stringify(controlMessage(MSG_SHUTTING_DOWN, requestId)));
    } else {
      ws.send(JSON.stringify(errorMessage(requestId ?? null, "BAD_REQUEST", `Unknown message type: ${type}`)));
    }
  }

  url(port: number): string {
    return `ws://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.wss?.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

