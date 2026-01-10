# Phase 5 — Virtual Microphone Routing (Meeting Mode)

Phase 4 shipped the desktop app with one output path: converted audio
plays through the user's own speakers/headphones (`LocalPlaybackAdapter`).
Phase 5 adds a second path — routing that same converted audio to a
standard OS virtual audio device (VB-CABLE on Windows, BlackHole on
macOS) so a meeting app can select it as a microphone. Nothing about
capture, the AI engine, or the WebSocket protocol changed; this phase is
entirely an extension of the output side.

## The core architectural insight

A "virtual audio device" is, from Web Audio's perspective, just another
entry in `navigator.mediaDevices.enumerateDevices()` with
`kind: "audiooutput"`. `AudioContext.setSinkId()` targets it exactly like
a real speaker. There is nothing platform-specific about the actual
byte-pushing — `VirtualAudioOutputAdapter` is a thin wrapper around the
same `LocalPlaybackAdapter` used for local playback
(`desktop/src/renderer/src/audio/outputAdapter.ts`), pointed at a
different device id. This is why Phase 5 did not need a native addon or
any platform-specific audio code for the actual routing — only for
*detecting* which device to route to and *explaining* the two-sided
naming scheme to the user.

## Output Architecture

```
AudioOutputAdapter (interface, unchanged from Phase 4)
        |
        +-- LocalPlaybackAdapter        (Phase 4 — local speakers/headphones)
        |
        +-- VirtualAudioOutputAdapter   (Phase 5 — wraps LocalPlaybackAdapter,
        |                                pinned to a resolved virtual device id)
        |
        +-- DualOutputAdapter           (Phase 5 — optional local monitoring;
                                          fans the SAME converted PCM to two
                                          adapters, never a second AI pass)
```

`stores/liveVoiceStore.ts`'s dependency `createOutputAdapter(mode,
virtualDeviceId)` is the only place that knows which concrete class to
construct (`services/singletons.ts` for the real wiring) — the state
machine itself only ever calls the `AudioOutputAdapter` interface.

## Device Detection

`audio/virtualDeviceDetection.ts` is pure, synchronous, and unit-tested
against real device-name patterns:

- **Windows (VB-CABLE)**: two *differently-named* devices — `CABLE Input
  (VB-Audio Virtual Cable)` (an output device; VoiceShift plays here) and
  `CABLE Output (VB-Audio Virtual Cable)` (an input device; the meeting
  app reads here). The naming is the reverse of what it sounds like at
  first glance — VoiceShift writes to the **Input**, the meeting app
  reads from the **Output** — see `docs/windows-virtual-audio.md` for the
  full explanation. Matching requires the `CABLE Input`/`CABLE Output`
  prefix to correctly assign a label to only one side; a naive substring
  match on the shared `(VB-Audio Virtual Cable)` suffix would misclassify
  both devices as candidates for both roles (a real bug caught by
  `tests/unit/virtualDeviceDetection.test.ts`, fixed before this shipped).
- **macOS (BlackHole)**: one physical driver appearing as both an output
  entry and an input entry sharing the *same* label (typically `BlackHole
  2ch`) — VoiceShift plays to the output-kind entry, the meeting app reads
  from the input-kind entry; the device-kind list itself (not a name
  prefix) is what disambiguates here.

`VirtualDeviceStatus` (`shared/virtualAudio.ts`) is the result shape,
matching the Phase 5 spec's example exactly (`installed`,
`playbackDeviceName`, `meetingInputName`, `ready`). `ready` is only ever
true once a real device id was resolved — never inferred from the AI
engine being ready, and ambiguous multiple-candidate cases (e.g. both
`BlackHole 2ch` and `BlackHole 16ch` installed) require the user to
disambiguate via `PersistedSettings.preferredVirtualDeviceId` (Audio
Devices screen) rather than guessing.

## Platform Adapters

`audio/virtualAudioAdapters.ts`: `WindowsVirtualAudioAdapter`,
`MacOSVirtualAudioAdapter`, `UnsupportedVirtualAudioAdapter` (Linux and
anything else) all implement `VirtualAudioIntegration` — `isSupported()`,
`getStatus(...)` (delegates to the detection module above),
`getSetupInstructions()`, `getSettingsAction()`. `getVirtualAudioIntegration(platform)`
is the factory (Step 14) — no `if (process.platform === ...)` scattered
through screens; every screen goes through this one factory function.

`getSettingsAction()` returns a **fixed action key**
(`"windows-sound-settings"` / `"macos-audio-midi-setup"`), never a raw
path or command string. `main/ipcHandlers.ts`'s
`openSystemAudioSettings()` is the only place that maps a key to an
actual `shell.openExternal`/`shell.openPath` call — the renderer can never
smuggle an arbitrary shell command through this IPC channel (Step 12/54).

## Meeting Mode Readiness Gate (Step 21)

`liveVoiceStore.startLive()` resolves `outputMode` from store state
(itself initialized from `PersistedSettings.outputMode`, changeable live
on the Live Voice screen). When `outputMode === "meeting"`, the store:

1. Enumerates devices and computes `VirtualDeviceStatus` **before**
   connecting to the engine or touching the microphone.
2. Fails immediately with a specific, actionable message
   (not-installed / ambiguous / not-ready) if the device isn't resolved —
   never opens a half-configured Live session.
3. Only once genuinely ready does it proceed to CONNECTING, and after
   `stream.open`, constructs the output adapter and awaits
   `ensureRouted()` (a real `setSinkId()` call) — if THAT fails (device
   removed between the check and this point, or `setSinkId` unsupported),
   the session still fails cleanly rather than silently falling back to
   local speakers.

## Device Hot-Plug (Step 32)

While LIVE in Meeting Mode, the store subscribes to
`navigator.mediaDevices`'s `devicechange` event
(`LiveVoiceDeps.watchDeviceChanges`). On any change, it re-runs detection;
if the previously-routed device is no longer present, the session fails
safely (mic/output/engine connection all torn down via the same
`cleanupResources()` path every other failure mode uses) rather than
continuing to claim Meeting Mode is live with nowhere for the audio to
go. Local Mode never subscribes to this watcher at all.

## Optional Local Monitoring (Step 29/30)

`PersistedSettings.localMonitoringEnabled`, off by default. When on (and
only in Meeting Mode), `services/singletons.ts`'s `createOutputAdapter`
wraps the `VirtualAudioOutputAdapter` and a second, independent
`LocalPlaybackAdapter` in a `DualOutputAdapter` — both receive the exact
same converted `Float32Array` per chunk. There is only ever one AI
conversion pass; this is purely an output-side fan-out.

## UI Changes

- **System Check**: added rows for the virtual driver (Installed / Not
  Installed / Checking…), `<Provider> Output`, `Meeting Microphone`, and
  `Meeting Mode` itself — each independently computed, so a ready AI
  engine never implies a ready Meeting Mode (verified by a dedicated test
  in `tests/components/SystemCheckScreen.test.tsx`).
- **Audio Devices**: new "Virtual Microphone" card — provider, status,
  the exact two device names (VoiceShift's playback target and the
  meeting-app-facing name), a candidate picker when ambiguous, "Test
  Virtual Microphone," and an expandable Setup Guide.
- **Live Voice**: "Output Mode" (Local Test / Meeting Mode) radio row in
  Setup; when Meeting Mode is selected, a live virtual-mic status row, a
  READY FOR MEETING / NOT READY line, and its own "Test Virtual Mic"
  button. The LIVE indicator reads `● LIVE — VIRTUAL MICROPHONE ACTIVE`
  during a Meeting Mode session (Step 38) — the same unmistakable pattern
  Phase 4 used for the plain `● LIVE` indicator.

## Test Virtual Microphone (Step 22/23)

A short (~1s), safe-level (peak gain 0.2, faded in/out) 440Hz test tone
played to the resolved virtual playback device via the same
`setSinkId()` mechanism as real conversion output. There is no reliable,
non-brittle, cross-platform way for VoiceShift itself to verify the
signal reached the *recording* side of the loopback — building that would
mean OS-specific low-level audio capture code the spec explicitly warned
against (Step 23). Verification is therefore guided-manual: the UI tells
the user to check their OS input level meter or their meeting app's own
microphone test after running it.

## Meeting App Guides (Step 24-27)

`components/MeetingSetupGuide.tsx` renders install instructions (from the
platform adapter) plus per-app steps for Google Meet, Microsoft Teams,
and Slack Huddle — explicitly framed as "select this OS device as your
microphone," never as an API integration, matching Step 25-27's exact
constraint. Longer, standalone versions of the same guidance live in
`docs/windows-virtual-audio.md`, `docs/macos-virtual-audio.md`, and
`docs/meeting-apps.md`.

## Packaging & Distribution

- **Python engine bundling** (Step 43): `main/engineProcessManager.ts`
  gained `resolvePackagedEnginePythonPath`/`resolvePackagedEngineCwd`,
  resolving to `resources/voiceshift-engine/<platform>/voiceshift-engine[.exe]`.
  `main/config.ts` branches on `app.isPackaged` to pick dev vs. packaged
  paths automatically. **The packaged executable itself does not exist
  yet** — this only ensures the path-resolution logic is correct and
  tested (`tests/main/engineProcessManager.test.ts`) so that once a
  standalone engine build exists (e.g. via PyInstaller), no further
  `EngineProcessManager` code changes are needed.
- **Windows**: `electron-builder.yml`'s `win` target (NSIS) is
  configured; VB-CABLE is never bundled (Step 45) — see
  `docs/windows-virtual-audio.md` for the separate-install rationale.
- **macOS**: `hardenedRuntime: true` with
  `build/entitlements.mac.plist` (JIT, microphone, outbound network) and
  an `NSMicrophoneUsageDescription` in `extendInfo`. **No real code
  signing or notarization is configured** — both require a real Apple
  Developer ID and notarization credentials that don't exist in this
  environment; the entitlements/hardened-runtime config is the correct
  shape for when signing is added, not proof it's done. BlackHole is
  never bundled, for the same reason as VB-CABLE.
- **Verified in this session**: `npm run build:unpack` (Linux target)
  ran electron-builder end-to-end for real, downloading the actual
  Electron distribution and producing a working `release/linux-unpacked`
  directory — this proves the `electron-builder.yml` config (including
  the new `mac`/entitlements additions) parses and the packaging pipeline
  itself works. It does **not** prove a Windows or macOS build, which
  were never attempted (no such machine available).
- **Model distribution**: unchanged from Phase 4's documented options
  (first-run download / installer-bundled / separate package) — see
  `docs/phase4-desktop.md`. Not revisited in Phase 5, which only touched
  the desktop app's own packaging, not `ai-worker`'s model-loading
  behavior.

## Third-Party Driver Licensing (Step 45)

| Driver | License | Source | Bundled by VoiceShift? |
|---|---|---|---|
| VB-CABLE | Free (donationware), redistribution terms not confirmed permissive | vb-audio.com | No — user installs separately |
| BlackHole | Open source (GPL-3.0 for BlackHole 2ch/16ch) | existential.audio / GitHub | No — user installs separately |

Neither driver's redistribution terms were verified as permitting
bundling, so both remain separate, user-initiated installs — the safer
default per Step 45's explicit preference.
