# macOS Virtual Audio Setup (BlackHole)

Meeting Mode lets VoiceShift's AI-converted voice show up as a microphone
inside Google Meet, Microsoft Teams, or Slack Huddle. On macOS this
requires **BlackHole**, a free, open-source virtual audio driver. This
document covers what it is, how to install it, how to confirm VoiceShift
sees it, and how to fix the ways it can go wrong. Per-app microphone
selection (Meet/Teams/Slack) is covered separately in
`docs/meeting-apps.md`.

## What BlackHole is, and why VoiceShift needs it

BlackHole is a free, open-source virtual audio loopback driver from
Existential Audio (existential.audio). Like VB-CABLE on Windows, it
solves a problem meeting apps have no other way to solve: getting audio
produced by one application (VoiceShift) into another application's
"microphone" input, with no physical cable involved.

The important difference from Windows: BlackHole is **one virtual device
with one name that plays both roles**, not two separate devices. Most
commonly you'll install `BlackHole 2ch` (2-channel/stereo), and it
appears in **both** macOS's list of output devices and its list of input
devices, under the identical label:

```
Your real microphone
        |
        v
VoiceShift (AI voice conversion)
        |
        v   VoiceShift plays the converted audio out to...
"BlackHole 2ch"    <- the SAME device, used as an OUTPUT here
        |
        |   BlackHole loops the signal internally
        v
"BlackHole 2ch"    <- the SAME device, used as an INPUT here
        |
        v   Your meeting app reads its "microphone" from...
Google Meet / Microsoft Teams / Slack Huddle
```

VoiceShift tells the two roles apart the same way macOS does — by which
list a device came from (the output list vs. the input list), not by
name, since the name is identical on both sides. When you're looking at
System Settings or Audio MIDI Setup, don't be surprised to see "BlackHole
2ch" listed twice — that's expected, not a duplicate install.

## BlackHole is not part of VoiceShift

BlackHole is a separate, free, open-source download from
existential.audio. VoiceShift does not bundle it, install it, or modify
it — VoiceShift only looks for it by device name once it's already on
your system, and then routes audio to it like any other output device.
Uninstalling BlackHole simply makes Meeting Mode report it as not
installed; nothing else in VoiceShift is affected.

## Installing BlackHole

Two options:

- **Installer package** — download the BlackHole 2ch installer `.pkg`
  from existential.audio and run it, following its prompts.
- **Homebrew** — `brew install blackhole-2ch` installs the same 2ch
  driver via a Homebrew Cask.

Either way, macOS may prompt you to approve a new system extension:
**System Settings > Privacy & Security**, scroll to the security notice
near the bottom of the page, and click **Allow** for the software from
"Existential Audio Inc." If BlackHole doesn't show up as working right
after install, check this screen first — an unapproved extension fails
silently rather than raising an error. A logout/login or full restart is
sometimes needed afterward for the new device to register with Core
Audio.

## Audio MIDI Setup

macOS's built-in `Audio MIDI Setup.app` (in
`/System/Applications/Utilities/`) is the system utility for viewing and
configuring audio devices — useful for confirming BlackHole installed
correctly, and for the advanced multi-device setups described below.
VoiceShift's Audio Devices screen has a **Setup Guide** button that opens
Audio MIDI Setup directly, rather than leaving you to find it in
Applications yourself.

## Microphone permission (separate from BlackHole)

The first time VoiceShift tries to use your **real** microphone —
regardless of whether you ever turn on Meeting Mode — macOS shows its
standard microphone-access prompt. This is a normal Apple privacy
control, unrelated to BlackHole. The permission text VoiceShift requests
is:

> "VoiceShift AI needs microphone access to capture your voice for live
> AI voice conversion. Audio is processed locally and is never saved
> unless you explicitly enable debug recording in Settings."

If you dismiss or deny this prompt, re-grant it later in **System
Settings > Privacy & Security > Microphone** — find VoiceShift AI in the
list and enable its toggle, then restart VoiceShift for the change to
take effect.

## Verifying BlackHole is installed

- **System Settings > Sound** — check both the "Output" and "Input"
  tabs; `BlackHole 2ch` should appear in both.
- **VoiceShift's Audio Devices screen** — the *Virtual Microphone* card
  shows Ready / Not Installed / Ambiguous, plus the exact device
  VoiceShift sends audio to and the exact device to select in your
  meeting app (both will read `BlackHole 2ch`, since it's the same
  device on both sides). Click **Re-check** if you just installed
  BlackHole and it still shows "Not Installed."

## Troubleshooting

**BlackHole shows "Not Installed" right after installing**
The Core Audio driver sometimes doesn't register until you log out and
back in, or restart the Mac. If it's still not detected afterward,
confirm the system extension was approved (System Settings > Privacy &
Security) and reinstall if needed.

**VoiceShift shows "Ambiguous"**
This happens if more than one BlackHole channel-count variant is
installed at once — for example `BlackHole 2ch` alongside `BlackHole
16ch` or `BlackHole 64ch` (used for more advanced multi-channel routing,
not something VoiceShift needs). VoiceShift will not guess which one to
use for Meeting Mode; the Audio Devices screen lists every candidate it
found so you can pick. `BlackHole 2ch` is the right choice for ordinary
Meeting Mode use.

**No audio reaching the meeting app**
- Confirm VoiceShift's Output Mode (Live Voice screen) is **Meeting
  Mode**, not *Local Test*.
- Run **Test Virtual Microphone** on the Audio Devices screen, and watch
  the input level meter for `BlackHole 2ch` in System Settings > Sound >
  Input while the test tone plays.
- Some meeting apps cache their microphone device list for the length of
  a call — leave and rejoin if you changed the microphone selection
  mid-call.

## Advanced: hearing yourself while also using BlackHole (optional)

VoiceShift's own **Monitor Converted Voice Locally** setting (Settings
screen) already covers the common case: when it's on and Output Mode is
Meeting Mode, VoiceShift plays the same converted audio to both BlackHole
and your normal speakers/headphones at once — no extra setup required,
and it's off by default to avoid feedback if you're not on headphones.

If you need something beyond that — for example, routing BlackHole into a
separate recording app at the same time as your meeting — macOS's Audio
MIDI Setup lets you build a **Multi-Output Device** (sends the same
signal to multiple devices, e.g. BlackHole plus your speakers) or an
**Aggregate Device** (combines multiple devices into one). This is a
macOS-level audio routing feature, unrelated to VoiceShift itself, and
not needed for normal Meeting Mode use.
