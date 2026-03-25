export type BackendConnectionStatus = "checking" | "connected" | "disconnected";

export interface HealthResponse {
  status: string;
}
