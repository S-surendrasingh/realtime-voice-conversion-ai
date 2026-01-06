# Using VoiceShift with Meeting Apps

VoiceShift does not integrate with Google Meet, Microsoft Teams, or Slack
Huddle through any API. None of these apps is aware VoiceShift exists —
each just sees one more entry in the operating system's list of
microphones. Meeting Mode works by sending your AI-converted voice to a
standard OS-level virtual audio device (`CABLE Output (VB-Audio Virtual
Cable)` on Windows, `BlackHole 2ch` on macOS); you then select that
device as the microphone inside the meeting app, exactly as you would
select any other microphone. There is no plugin, no browser extension,
and no special "VoiceShift mode" inside any of these apps.

This document assumes the virtual audio driver is already installed and
VoiceShift's Audio Devices screen shows the *Virtual Microphone* card as
**Ready**. If it doesn't, start with `docs/windows-virtual-audio.md` or
`docs/macos-virtual-audio.md` first.

## Before joining a call

Check these three things on VoiceShift, regardless of which meeting app
you're using:

1. **Output Mode is set to Meeting Mode** (Live Voice screen) — not
   Local Test.
2. **Status reads "READY FOR MEETING"** — if it instead reads "NOT
   READY — check Audio Devices", resolve that first; see the
   troubleshooting sections in `docs/windows-virtual-audio.md` /
   `docs/macos-virtual-audio.md`.
3. **Test Virtual Microphone** (Audio Devices screen) has been run at
   least once, with the OS's own input level meter for the device
   responding while the test tone played. This confirms the signal path
   end-to-end before you depend on it live in front of other people —
   VoiceShift itself cannot reliably verify a meeting app is receiving
   audio from inside the app.

## Google Meet

Meet's microphone selector is under the gear/settings icon — both in the
pre-call green room and during a call (bottom-right controls > Settings >
Audio).

1. Set **Microphone** to `CABLE Output (VB-Audio Virtual Cable)`
   (Windows) or `BlackHole 2ch` (macOS).
2. Leave **Speakers** on your normal headphones/speakers.
3. Run VoiceShift's **Test Virtual Microphone** and watch Meet's own
   microphone level indicator — it should respond.
4. Start VoiceShift Live in Meeting Mode, then speak.

Quirk: Meet runs in a browser (or a Chromium-based embed). Browsers only
refresh their device list after microphone permission has been granted to
that site/tab at least once. If you install the virtual audio driver
*after* already granting Meet mic permission, the new device may not
appear in Meet's list until you reload the tab or restart the browser.

## Microsoft Teams

Teams' device settings are under **Settings > Devices**, or the "..."
menu during a call → Audio settings.

1. Set **Microphone** to `CABLE Output (VB-Audio Virtual Cable)`
   (Windows) or `BlackHole 2ch` (macOS).
2. Leave **Speaker** on your normal output.
3. Run **Test Virtual Microphone** and confirm Teams' mic activity
   indicator responds.
4. Start VoiceShift Live in Meeting Mode.

Quirk: Teams often keeps a per-call cached device list — changing the
microphone mid-call may not take effect even though the settings panel
appears to accept it. Leave and rejoin the call if the change doesn't
seem to apply.

## Slack Huddle

Huddle's audio device settings are reachable from the huddle controls
themselves, or globally via Slack's **Preferences > Audio & Video**.

1. Choose `CABLE Output (VB-Audio Virtual Cable)` (Windows) or
   `BlackHole 2ch` (macOS) as the microphone.
2. Leave your normal speakers/headphones as the output.
3. Run **Test Virtual Microphone** and confirm the huddle's mic
   indicator responds.
4. Start VoiceShift Live in Meeting Mode.

Quirk: Slack's global Preferences audio device and a huddle's own in-call
device picker aren't always the same control, depending on Slack's
version and platform. If changing one doesn't seem to take effect, check
the other.

## If a meeting app doesn't seem to hear you

Work through it in this order:

1. Check the OS's own input meter for the virtual device (Windows Sound
   settings, or macOS System Settings > Sound > Input) while running
   **Test Virtual Microphone**. If that's silent, the problem is on the
   VoiceShift-to-virtual-device side — see the troubleshooting section in
   `docs/windows-virtual-audio.md` or `docs/macos-virtual-audio.md`.
2. If the OS meter shows activity but the meeting app still doesn't hear
   you, the device selection in the app itself almost always hasn't
   taken effect yet — rejoin the call, or fully restart the app.
