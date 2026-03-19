"use client";

import { useCallback, useEffect, useState } from "react";
import * as api from "@/lib/api";
import type { VoiceProfile, VoiceSample } from "@/types/voice";

async function fetchProfileWithSamples(
  profileId: string
): Promise<{ profile: VoiceProfile; samples: VoiceSample[] }> {
  const [profile, samples] = await Promise.all([
    api.getVoiceProfile(profileId),
    api.listVoiceSamples(profileId),
  ]);
  return { profile, samples };
}

export function useVoiceProfile(profileId: string) {
  const [profile, setProfile] = useState<VoiceProfile | null>(null);
  const [samples, setSamples] = useState<VoiceSample[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [completing, setCompleting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { profile, samples } = await fetchProfileWithSamples(profileId);
      setProfile(profile);
      setSamples(samples);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load voice profile.");
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const { profile, samples } = await fetchProfileWithSamples(profileId);
        if (cancelled) return;
        setProfile(profile);
        setSamples(samples);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load voice profile.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  const uploadSample = useCallback(
    async (file: File) => {
      setUploading(true);
      setError(null);
      try {
        await api.uploadVoiceSample(profileId, file);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to upload sample.");
      } finally {
        setUploading(false);
      }
    },
    [profileId, refresh]
  );

  const deleteSample = useCallback(
    async (sampleId: string) => {
      setError(null);
      try {
        await api.deleteVoiceSample(profileId, sampleId);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete sample.");
      }
    },
    [profileId, refresh]
  );

  const complete = useCallback(async () => {
    setCompleting(true);
    setError(null);
    try {
      await api.completeVoiceProfile(profileId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to complete enrollment.");
    } finally {
      setCompleting(false);
    }
  }, [profileId, refresh]);

  return {
    profile,
    samples,
    loading,
    error,
    uploading,
    completing,
    uploadSample,
    deleteSample,
    complete,
    refresh,
  };
}
