export type VoiceProfileStatus =
  | "DRAFT"
  | "RECORDING"
  | "PROCESSING"
  | "READY_FOR_AI_PROCESSING"
  | "FAILED"
  | "ARCHIVED";

export type VoiceSampleStatus = "UPLOADED" | "VALIDATING" | "VALID" | "INVALID" | "DELETED";

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
  status: VoiceSampleStatus;
  validation_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CompleteVoiceProfileResponse {
  id: string;
  status: VoiceProfileStatus;
  valid_sample_count: number;
  message: string;
}

export interface ConversionResult {
  conversion_id: string;
  voice_profile_id: string;
  status: string;
  source_duration_seconds: number;
  processing_time_seconds: number;
  rtf: number;
  model: string | null;
  device: string;
  output_url: string;
}
