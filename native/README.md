# Looper — Native (Capacitor) shell

This wraps the existing Looper web UI (in the repo root) as a native **iOS** and
**macOS (Mac Catalyst)** app, so we can replace browser audio with a native
low-latency `AVAudioEngine` engine for real musical use.

> **Status: Stage 2 — native audio engine (first cut).** The `LooperAudio`
> Swift plugin (`ios-plugin/`) provides native `AVAudioEngine` record/overdub/
> playback, and `app.js` routes to it automatically when running natively. See
> "Add the native audio plugin" below to wire the Swift files into Xcode.

## Why this architecture

- The UI (HTML/CSS/JS in the repo root) is reused as-is — one UI for web + native.
- A native **audio plugin** (Stage 2) will own *all* audio: recording, the layer
  buffers, mixing, and gapless playback. The webview only sends commands
  (record / stop / overdub / undo / clear) and receives state (layer count,
  level). **Audio never touches the webview**, so latency is fully native.
- iOS and macOS share Core Audio / `AVAudioEngine`, so it's one Swift codebase.
  macOS is reached via **Mac Catalyst** (Capacitor has no separate macOS target).

## Prerequisites (on a Mac)

- macOS with **Xcode** (+ Command Line Tools) and **CocoaPods** (`sudo gem install cocoapods`)
- **Node.js** 18+
- For running on a physical iPhone or TestFlight: an Apple Developer account.
  The iOS Simulator and "My Mac (Catalyst)" run without a paid account.

## Build & run (Stage 1)

```bash
cd native

# 1. Install Capacitor tooling
npm install

# 2. Copy the shared web UI into ./www
npm run sync-web

# 3. Generate the native iOS project (also used for Mac Catalyst)
npx cap add ios

# 4. Add the microphone permission string (required for getUserMedia / capture):
#    Open ios/App/App/Info.plist and add:
#      NSMicrophoneUsageDescription = "Looper records audio to create loops."

# 5. Sync web assets + config into the native project
npm run sync          # = sync-web + cap sync

# 6. Open in Xcode
npx cap open ios
```

In Xcode:

- **iOS:** pick an iPhone Simulator or your connected device and Run.
- **macOS:** select the **"My Mac (Mac Catalyst)"** run destination. Under the
  target's **Signing & Capabilities**, enable **Mac Catalyst**, add the
  **Microphone** entitlement (App Sandbox → Audio Input), and ensure the
  microphone usage string is present. Then Run.

Whenever you change the web UI in the repo root, re-run `npm run sync` (from
`native/`) and rebuild.

## Add the native audio plugin (Stage 2)

The Swift engine lives in **`native/ios-plugin/`** (tracked in git). Add it to
the Xcode **App** target once:

1. In Xcode's Project Navigator, right-click the **`App`** group (the inner one,
   next to `AppDelegate.swift`) → **Add Files to "App"…**
2. Select both files from `native/ios-plugin/`:
   - `LooperAudio.swift`
   - `LooperAudioPlugin.m`
   Check **"Add to targets: App"**, and **UNcheck "Copy items if needed"** so
   Xcode *references* the files in `native/ios-plugin/`. That way a `git pull`
   updates the exact files your build compiles — no stale copies.
3. If Xcode asks to **create an Objective-C bridging header**, click **Create**
   (an empty header is fine — the `.m` registers the plugin via Capacitor's
   macro).

> Already added them *with* "Copy items if needed"? Then Xcode copied them into
> `ios/App/App/` and won't see future edits. Fix it once: select the copied
> `LooperAudio.swift` / `LooperAudioPlugin.m` in Xcode → Delete → **Move to
> Trash**, then re-add from `native/ios-plugin/` with **Copy unchecked**.
4. Build & run. `app.js` detects the native platform and calls the plugin for
   all audio (record / overdub / undo / clear); the meter is driven by `level`
   events from the engine.

The engine uses `.playAndRecord` + `.defaultToSpeaker` with a ~5 ms IO buffer,
loops a mixed buffer gaplessly via `AVAudioPlayerNode`, and aligns overdubs
using the hardware input/output latency (`latencyFrames`). Those values and the
loop-swap are first-cut — expect to fine-tune timing on a real device.

## Roadmap

- **Stage 1 (current):** native iOS + Catalyst shell running the existing UI.
- **Stage 2:** `LooperAudio` Capacitor plugin (Swift + `AVAudioEngine`):
  - `.playAndRecord` + `.defaultToSpeaker`, low IO buffer duration
  - base record, overdub layers, gapless layered playback via `AVAudioPlayerNode`
    looping a mixed buffer
  - **sample-accurate overdub alignment** using `AVAudioSession` input/output
    latency (the key thing the browser can't do)
  - loudspeaker monitoring during overdub (no headphones required)
  - the web `app.js` detects `Capacitor.isNativePlatform()` and routes all
    audio actions to the plugin instead of Web Audio.
- **Later:** Android (Capacitor `android` + Oboe/AAudio), save/load loops,
  metronome/count-in, waveform, per-layer volume.

## Notes

- `native/www`, `native/ios`, and `native/node_modules` are generated and
  git-ignored. The shared UI lives in the repo root; `sync-web` copies it in.
- The service worker is excluded from the native bundle (not needed; avoids
  stale-asset issues across app updates).
