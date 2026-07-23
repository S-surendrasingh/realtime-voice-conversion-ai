import { useCallback, useEffect, useState } from "react";
import type { PersistedSettings } from "@shared/types";

/** Thin React binding over the preload settings bridge (main/settingsStore.ts).
 * Never touches raw audio — only the small preference fields in
 * PersistedSettings. */
export function useSettings() {
  const [settings, setSettings] = useState<PersistedSettings | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.voiceshift.settings.get().then((s) => {
      if (!cancelled) setSettings(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(async (patch: Partial<PersistedSettings>) => {
    const next = await window.voiceshift.settings.set(patch);
    setSettings(next);
    return next;
  }, []);

  return { settings, update };
}
