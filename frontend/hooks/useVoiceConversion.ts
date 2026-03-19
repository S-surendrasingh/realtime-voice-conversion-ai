"use client";

import { useCallback, useState } from "react";
import * as api from "@/lib/api";
import type { ConversionResult } from "@/types/voice";

export function useVoiceConversion(profileId: string) {
  const [converting, setConverting] = useState(false);
  const [result, setResult] = useState<ConversionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const convert = useCallback(
    async (sourceAudio: File) => {
      setConverting(true);
      setError(null);
      try {
        const outcome = await api.convertVoice(profileId, sourceAudio);
        setResult(outcome);
        return outcome;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Conversion failed.");
        return null;
      } finally {
        setConverting(false);
      }
    },
    [profileId]
  );

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return { converting, result, error, convert, reset };
}
