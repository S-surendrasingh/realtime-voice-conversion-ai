import { useCallback, useEffect, useState } from "react";
import { getBackendClient } from "../services/singletons";
import { BackendUnavailableError, type VoiceProfile } from "../services/BackendClient";

interface UseVoiceProfilesResult {
  profiles: VoiceProfile[];
  loading: boolean;
  error: string | null;
  backendUnavailable: boolean;
  refresh: () => Promise<void>;
}

/** All profiles (not just READY ones) — screens decide what to do with
 * status. Voice Profiles screen highlights READY_FOR_AI_PROCESSING per
 * Step 12; Live Voice only allows selecting one of those. */
export function useVoiceProfiles(): UseVoiceProfilesResult {
  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [backendUnavailable, setBackendUnavailable] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setBackendUnavailable(false);
    try {
      const client = await getBackendClient();
      const result = await client.listVoiceProfiles();
      setProfiles(result);
    } catch (err) {
      if (err instanceof BackendUnavailableError) {
        setBackendUnavailable(true);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { profiles, loading, error, backendUnavailable, refresh };
}
