import type { AppPlatform, VirtualAudioProvider } from "@shared/types";
import type { VirtualDeviceStatus } from "@shared/virtualAudio";

interface NamePatterns {
  /** Matches OUTPUT device labels — where VoiceShift plays converted audio
   * (Step 6: VoiceShift writes to the PLAYBACK side). */
  isPlayback: (label: string) => boolean;
  /** Matches INPUT device labels — purely for reporting the name the user
   * should pick in their meeting app (Step 6: meeting apps read from the
   * RECORDING side). VoiceShift never selects this itself. */
  isRecording: (label: string) => boolean;
}

const CABLE_INPUT_PREFIX = /^cable input/i;
const CABLE_OUTPUT_PREFIX = /^cable output/i;
const VB_AUDIO_GENERIC = /vb-audio virtual cable/i;

const NAME_PATTERNS: Record<Exclude<VirtualAudioProvider, "none">, NamePatterns> = {
  // VB-CABLE ships as two DIFFERENTLY named devices: "CABLE Input" (an
  // output/playback device) and "CABLE Output" (an input/recording
  // device), both also carrying a shared "(VB-Audio Virtual Cable)"
  // vendor suffix. Not one fragile exact string: the "CABLE Input"/"CABLE
  // Output" prefix is the primary, reliable signal (Step 5); the generic
  // "VB-Audio Virtual Cable" suffix is only used as a fallback, and MUST
  // exclude a label that already matches the OTHER side's prefix — that
  // suffix appears on both device names, so used unconditionally it would
  // wrongly match "CABLE Output" as a playback candidate too.
  "vb-cable": {
    isPlayback: (label) => CABLE_INPUT_PREFIX.test(label) || (VB_AUDIO_GENERIC.test(label) && !CABLE_OUTPUT_PREFIX.test(label)),
    isRecording: (label) => CABLE_OUTPUT_PREFIX.test(label) || (VB_AUDIO_GENERIC.test(label) && !CABLE_INPUT_PREFIX.test(label)),
  },
  // BlackHole is a loopback device: ONE physical driver that shows up as
  // BOTH an output entry and an input entry sharing the same label (e.g.
  // "BlackHole 2ch") — unlike VB-CABLE's two distinctly-named devices, so
  // no directional prefix exists to disambiguate; scoping by device kind
  // (input list vs output list) at the call site is what keeps this
  // correct.
  blackhole: {
    isPlayback: (label) => /blackhole/i.test(label),
    isRecording: (label) => /blackhole/i.test(label),
  },
};

function matchDevices(devices: MediaDeviceInfo[], predicate: (label: string) => boolean): MediaDeviceInfo[] {
  return devices.filter((d) => d.label && predicate(d.label));
}

export function providerForPlatform(platform: AppPlatform): Exclude<VirtualAudioProvider, "none"> | null {
  if (platform === "win32") return "vb-cable";
  if (platform === "darwin") return "blackhole";
  return null;
}

/** Pure, synchronous detection over an already-enumerated device list — no
 * I/O of its own, easily unit tested with fake MediaDeviceInfo arrays.
 * Never fabricates a device id: `ready` is only true when a real
 * playback-side device was actually found. */
export function detectVirtualDevice(
  platform: AppPlatform,
  inputDevices: MediaDeviceInfo[],
  outputDevices: MediaDeviceInfo[],
  preferredDeviceId: string | null = null
): VirtualDeviceStatus {
  const provider = providerForPlatform(platform);
  if (!provider) {
    return {
      platform,
      provider: "none",
      installed: false,
      ambiguous: false,
      candidates: [],
      playbackDeviceId: null,
      playbackDeviceName: null,
      meetingInputName: null,
      ready: false,
    };
  }

  const patterns = NAME_PATTERNS[provider];
  const playbackCandidates = matchDevices(outputDevices, patterns.isPlayback);
  const recordingCandidates = matchDevices(inputDevices, patterns.isRecording);

  const installed = playbackCandidates.length > 0;
  const candidates = playbackCandidates.map((d) => ({ deviceId: d.deviceId, label: d.label }));

  let chosen: MediaDeviceInfo | null = null;
  let ambiguous = false;
  if (playbackCandidates.length === 1) {
    chosen = playbackCandidates[0];
  } else if (playbackCandidates.length > 1) {
    const preferred = preferredDeviceId
      ? playbackCandidates.find((d) => d.deviceId === preferredDeviceId)
      : undefined;
    if (preferred) {
      chosen = preferred;
    } else {
      ambiguous = true;
    }
  }

  return {
    platform,
    provider,
    installed,
    ambiguous,
    candidates,
    playbackDeviceId: chosen?.deviceId ?? null,
    playbackDeviceName: chosen?.label ?? null,
    meetingInputName: recordingCandidates[0]?.label ?? null,
    ready: chosen !== null,
  };
}
