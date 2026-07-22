import { useCallback, useEffect, useState } from "react";

export type MicPermissionState = "unknown" | "granted" | "denied" | "no-device";

/** Real device enumeration (Step 14) with explicit permission-state
 * handling (Step 15) — granted/denied/no-microphone/changed. Device
 * labels are empty strings until permission is granted (a browser
 * privacy rule, not a bug), so `requestPermission()` re-enumerates right
 * after a successful grant. */
export function useMediaDevices() {
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [permission, setPermission] = useState<MicPermissionState>("unknown");

  const refresh = useCallback(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    setInputDevices(devices.filter((d) => d.kind === "audioinput"));
    setOutputDevices(devices.filter((d) => d.kind === "audiooutput"));
  }, []);

  const requestPermission = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setPermission("granted");
      await refresh();
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotFoundError") {
        setPermission("no-device");
      } else {
        setPermission("denied");
      }
    }
  }, [refresh]);

  useEffect(() => {
    refresh();
    const handleChange = () => refresh();
    navigator.mediaDevices.addEventListener("devicechange", handleChange);
    return () => navigator.mediaDevices.removeEventListener("devicechange", handleChange);
  }, [refresh]);

  return { inputDevices, outputDevices, permission, requestPermission, refresh };
}
