"use client";

import { useCallback, useEffect, useState } from "react";
import * as api from "@/lib/api";
import type { VoiceProfile } from "@/types/voice";

export function useVoiceProfiles() {
  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listVoiceProfiles();
      setProfiles(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load voice profiles.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const data = await api.listVoiceProfiles();
        if (cancelled) return;
        setProfiles(data);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load voice profiles.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return { profiles, loading, error, refresh };
}
