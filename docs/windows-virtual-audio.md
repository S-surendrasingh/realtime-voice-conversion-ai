# Windows Virtual Audio Setup (VB-CABLE)

Meeting Mode lets VoiceShift's AI-converted voice show up as a microphone
inside Google Meet, Microsoft Teams, or Slack Huddle. On Windows this
requires **VB-CABLE**, a free virtual audio driver. This document covers
what it is, how to install it, how to confirm VoiceShift sees it, and how
to fix the ways it can go wrong. Per-app microphone selection (Meet/Teams/
Slack) is covered separately in `docs/meeting-apps.md`.

## What VB-CABLE is, and why VoiceShift needs it

VB-CABLE is a free, widely used virtual audio driver from VB-Audio
Software (vb-audio.com). It behaves like a physical audio cable
implemented in software: whatever is played into one end appears,
unchanged, on the other end. It has been a standard tool for streamers,
podcasters, and anyone routing one application's audio into another
application's "microphone" input for well over a decade — this is not an
exotic or unusual requirement, just an unfamiliar one if you haven't
needed it before.

Meeting apps only know how to read audio from a microphone-like input
device — none of them can accept audio directly from another application.
VB-CABLE bridges that gap by installing two devices, not one:

```
Your real microphone
        |
        v
VoiceShift (AI voice conversion)
        |
        v   VoiceShift plays the converted audio out to...
"CABLE Input (VB-Audio Virtual Cable)"     <- an OUTPUT/playback device
        |
        |   VB-CABLE loops the signal internally
        v
"CABLE Output (VB-Audio Virtual Cable)"    <- an INPUT/recording device
        |
        v   Your meeting app reads its "microphone" from...
Google Meet / Microsoft Teams / Slack Huddle
```

`CABLE Input` and `CABLE Output` are two distinct, differently-named
devices. VoiceShift always **writes** to `CABLE Input` (Windows treats it
as a speaker). Your meeting app always **reads** from `CABLE Output`
(Windows treats it as a microphone). Selecting `CABLE Input` as your
meeting app's microphone will not work — that side never has anything to
record, since it's the write end of the cable, not the read end.

## VB-CABLE is not part of VoiceShift

VB-CABLE is a separate, free, third-party download from vb-audio.com.
VoiceShift does not install it, bundle it, or modify it in any way —
VoiceShift only looks for it by device name once it's already on your
system (see "How detection works" below), and then routes audio to it
like it would any other output device. If you uninstall VB-CABLE later,
Meeting Mode simply reports it as not installed; nothing else in
VoiceShift is affected.

## Installing VB-CABLE

1. Go to the official VB-CABLE page at vb-audio.com and download the
   VB-CABLE driver package (a `.zip` containing the installer, typically
   `VBCABLE_Setup_x64.exe` for 64-bit Windows).
2. Extract the zip and run the installer **as Administrator**
   (right-click the `.exe` → "Run as administrator"). VB-CABLE installs a
   system-level audio driver, which requires elevated permissions.
3. If the installer asks you to restart Windows, do so before continuing
   — the new devices may not be usable until the driver is fully loaded.
4. Open VoiceShift, go to **System Check** and click **Run System
   Check** (or go directly to **Audio Devices**). The virtual audio
   driver row should show **Installed**.

## Verifying the install

Two independent checks:

- **Windows Sound settings** — right-click the speaker icon in the
  taskbar → *Sound settings*. Under "Output" you should see `CABLE Input
  (VB-Audio Virtual Cable)`; under "Input" you should see `CABLE Output
  (VB-Audio Virtual Cable)`.
- **VoiceShift's Audio Devices screen** — the *Virtual Microphone* card
  shows a status badge (Ready / Not Installed / Ambiguous), the exact
  device VoiceShift is sending audio to ("VoiceShift sends audio to"),
  and the exact device to select in your meeting app ("Meeting app should
  use"). Click **Re-check** after installing if it still shows "Not
  Installed" — VoiceShift only re-enumerates devices when asked to, not
  continuously in the background.

## Selecting the device in your meeting app

Once VoiceShift's Audio Devices screen shows the virtual microphone as
**Ready**, set your meeting app's microphone to `CABLE Output (VB-Audio
Virtual Cable)`. Leave the meeting app's speaker/output device on your
normal headphones or speakers — VB-CABLE only replaces the microphone
side, never the output side. See `docs/meeting-apps.md` for exact steps
in Google Meet, Microsoft Teams, and Slack Huddle.

## How detection works (for troubleshooting)

VoiceShift identifies VB-CABLE by matching the device labels Windows
reports, not by checking for a specific driver install path. It looks for
a label starting with `CABLE Input` to find the playback side, and a
label starting with `CABLE Output` to find the recording side — falling
back to any device carrying the generic `VB-Audio Virtual Cable` suffix
if the specific prefix isn't present. If VB-CABLE's device names have
been altered (for example, by a third-party audio utility, or a second
virtual-cable product that reuses similar naming), VoiceShift may fail to
detect it, or flag it as ambiguous. This is intentional — VoiceShift never
guesses which unlabeled device is safe to route your converted voice to.

## Troubleshooting

**Virtual audio driver shows "Not Installed" even after installing**
Confirm the devices actually appear in Windows Sound settings first (see
above). If they don't, the driver install did not complete — reinstall as
Administrator and restart Windows. If they do appear there but VoiceShift
still shows "Not Installed", click **Re-check** on the Audio Devices
screen; if that doesn't pick it up, restart VoiceShift.

**VoiceShift shows Ready, but the meeting app hears nothing**
- Confirm VoiceShift's *Output Mode* (Live Voice screen) is set to
  **Meeting Mode**, not *Local Test* — Local Test intentionally plays
  converted audio to your normal speakers instead of `CABLE Input`.
- Check whether another application has claimed `CABLE Input`
  exclusively: Windows Sound settings → `CABLE Input` → *Device
  properties* → *Additional device properties* (opens the classic
  dialog) → *Advanced* tab, and make sure "Allow applications to take
  exclusive control of this device" isn't preventing VoiceShift from
  writing to it while something else holds it open.
- Run **Test Virtual Microphone** on VoiceShift's Audio Devices screen
  and watch the input level meter for `CABLE Output` in Windows Sound
  settings (Input devices → `CABLE Output` → should show activity while
  the test tone plays). This isolates whether the break is
  VoiceShift-to-`CABLE Input`, or `CABLE Output`-to-meeting-app.

**Everything above looks correct, but participants still can't hear you**
Some meeting apps cache the microphone device list for the length of a
call and don't notice a device change made mid-call. Leave and rejoin the
meeting (or fully quit and reopen the app) after selecting `CABLE Output
(VB-Audio Virtual Cable)` as the microphone.

**Multiple VB-CABLE-like devices / VoiceShift shows "Ambiguous"**
This happens if more than one virtual-cable product is installed at once
and both expose "VB-Audio Virtual Cable"-style names (for example VB-CABLE
plus a second product like VB-CABLE A+B). VoiceShift will not guess —
the Audio Devices screen shows a dropdown of every playback-side
candidate it found; pick the one you want Meeting Mode to use. Your
choice is remembered.
