import type { HealthResponse } from "@/types/health";
import type {
  CompleteVoiceProfileResponse,
  ConversionResult,
  VoiceProfile,
  VoiceSample,
} from "@/types/voice";

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function parseJsonOrThrow<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message =
      (body && typeof body === "object" && "message" in body && String(body.message)) ||
      `Request failed with status ${response.status}`;
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json();
}

export async function fetchBackendHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch(`${API_BASE_URL}/api/v1/health`, { signal });
  return parseJsonOrThrow<HealthResponse>(response);
}

export interface CreateVoiceProfileInput {
  name: string;
  description?: string;
  consent_confirmed: boolean;
}

export async function createVoiceProfile(input: CreateVoiceProfileInput): Promise<VoiceProfile> {
  const response = await fetch(`${API_BASE_URL}/api/v1/voices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseJsonOrThrow<VoiceProfile>(response);
}

export async function listVoiceProfiles(): Promise<VoiceProfile[]> {
  const response = await fetch(`${API_BASE_URL}/api/v1/voices`);
  return parseJsonOrThrow<VoiceProfile[]>(response);
}

export async function getVoiceProfile(profileId: string): Promise<VoiceProfile> {
  const response = await fetch(`${API_BASE_URL}/api/v1/voices/${profileId}`);
  return parseJsonOrThrow<VoiceProfile>(response);
}

export async function deleteVoiceProfile(profileId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/v1/voices/${profileId}`, {
    method: "DELETE",
  });
  return parseJsonOrThrow<void>(response);
}

export async function listVoiceSamples(profileId: string): Promise<VoiceSample[]> {
  const response = await fetch(`${API_BASE_URL}/api/v1/voices/${profileId}/samples`);
  return parseJsonOrThrow<VoiceSample[]>(response);
}

export async function uploadVoiceSample(profileId: string, file: File): Promise<VoiceSample> {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(`${API_BASE_URL}/api/v1/voices/${profileId}/samples`, {
    method: "POST",
    body: formData,
  });
  return parseJsonOrThrow<VoiceSample>(response);
}

export async function deleteVoiceSample(profileId: string, sampleId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/v1/voices/${profileId}/samples/${sampleId}`, {
    method: "DELETE",
  });
  return parseJsonOrThrow<void>(response);
}

export async function completeVoiceProfile(
  profileId: string
): Promise<CompleteVoiceProfileResponse> {
  const response = await fetch(`${API_BASE_URL}/api/v1/voices/${profileId}/complete`, {
    method: "POST",
  });
  return parseJsonOrThrow<CompleteVoiceProfileResponse>(response);
}

export async function convertVoice(profileId: string, sourceAudio: File): Promise<ConversionResult> {
  const formData = new FormData();
  formData.append("source_audio", sourceAudio);
  const response = await fetch(`${API_BASE_URL}/api/v1/voices/${profileId}/convert`, {
    method: "POST",
    body: formData,
  });
  return parseJsonOrThrow<ConversionResult>(response);
}

export function conversionAudioUrl(profileId: string, conversionId: string): string {
  return `${API_BASE_URL}/api/v1/voices/${profileId}/conversions/${conversionId}/audio`;
}
