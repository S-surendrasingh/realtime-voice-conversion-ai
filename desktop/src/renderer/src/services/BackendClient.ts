/** Typed REST client for the EXISTING backend voice-profile API
 * (backend/app/api/routes/voices.py, voice_samples.py) — no backend
 * behavior is reimplemented here, only typed HTTP calls against the
 * unchanged endpoints. Base URL is configurable (VOICESHIFT_API_URL via
 * main/config.ts -> config:get IPC), defaulting to http://127.0.0.1:8000. */

export type VoiceProfileStatus = "RECORDING" | "PROCESSING" | "READY_FOR_AI_PROCESSING";

export interface VoiceProfile {
  id: string;
  name: string;
  description: string | null;
  status: VoiceProfileStatus;
  consent_confirmed: boolean;
  consent_confirmed_at: string | null;
  created_at: string;
  updated_at: string;
  sample_count: number;
  valid_sample_count: number;
  total_duration_seconds: number;
}

export interface VoiceSample {
  id: string;
  voice_profile_id: string;
  original_filename: string;
  mime_type: string;
  file_size: number;
  duration_seconds: number | null;
  sample_rate: number | null;
  channels: number | null;
  status: "PENDING" | "VALID" | "INVALID";
  validation_error: string | null;
  created_at: string;
  updated_at: string;
}

export class BackendUnavailableError extends Error {
  constructor(url: string, cause?: unknown) {
    super(`Backend unavailable at ${url}${cause instanceof Error ? `: ${cause.message}` : ""}`);
    this.name = "BackendUnavailableError";
  }
}

export class BackendApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BackendApiError";
    this.status = status;
  }
}

export class BackendClient {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      throw new BackendUnavailableError(this.baseUrl, err);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new BackendApiError(response.status, body || response.statusText);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async checkAvailable(): Promise<boolean> {
    try {
      await this.request("/health/ready");
      return true;
    } catch {
      return false;
    }
  }

  listVoiceProfiles(): Promise<VoiceProfile[]> {
    return this.request<VoiceProfile[]>("/voices");
  }

  getVoiceProfile(id: string): Promise<VoiceProfile> {
    return this.request<VoiceProfile>(`/voices/${id}`);
  }

  listVoiceSamples(voiceProfileId: string): Promise<VoiceSample[]> {
    return this.request<VoiceSample[]>(`/voices/${voiceProfileId}/samples`);
  }

  /** Returns only samples the resident engine should be conditioned on —
   * mirrors the same VALID filter backend/app/services/conversion.py
   * already applies for its own offline reference selection. */
  async listReadyVoiceProfiles(): Promise<VoiceProfile[]> {
    const profiles = await this.listVoiceProfiles();
    return profiles.filter((p) => p.status === "READY_FOR_AI_PROCESSING");
  }

  sampleAudioUrl(voiceProfileId: string, sampleId: string): string {
    return `${this.baseUrl}/api/v1/voices/${voiceProfileId}/samples/${sampleId}/audio`;
  }
}
