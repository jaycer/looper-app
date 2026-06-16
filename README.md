# Looper

A dead-simple audio looper that runs on **iOS, macOS, and Android** — anywhere
with a modern browser. Record a loop, then hear it play back seamlessly, forever.

It's a **Progressive Web App (PWA)**: one codebase, no app store, installs to the
home screen like a native app.

## How it works

- **Tap the green Record button** → it turns red and starts recording the base loop.
- **Tap the red Stop button** → the recording immediately begins looping, gapless,
  over and over.
- **Tap the blue Overdub button** → record another layer on top while the loop plays;
  tap **Done** and your layer joins the loop in perfect phase.
- **Undo layer** removes the most recent layer; **New loop** clears everything.

Under the hood:

- `getUserMedia` + `MediaRecorder` capture the base loop.
- Audio is kept as mono **layers** (Float32, one per overdub). The master loop is the
  clamped sum of all layers, rendered into an `AudioBuffer` and played by an
  `AudioBufferSourceNode` with `loop = true` for sample-accurate, gapless repeats.
- **Overdubs** capture raw mic PCM via a `ScriptProcessor`, summed into a new layer
  aligned to the current loop phase (with output-latency compensation). When you
  finish, the playing source is swapped at the next loop boundary so the new layer
  joins seamlessly.
- Mime types and the `decodeAudioData` callback/promise forms are feature-detected
  so it works on Safari/iOS (`audio/mp4`) as well as Chrome/Firefox (`audio/webm`).

> **Tip:** For the tightest overdub timing, use headphones. Recording through phone
> speakers can bleed the loop back into the mic and (on Bluetooth) adds latency.

## Running it

The microphone requires a **secure context** — `https://` or `localhost`.

### Locally

```bash
# from the project root
python3 -m http.server 8000
# then open http://localhost:8000 on this machine
```

`localhost` counts as secure, so the mic works without HTTPS on your own machine.

### On your phone (iOS / Android)

Phones won't grant mic access over plain `http://` on a LAN IP — you need HTTPS.
The easiest path is to host the static files anywhere with HTTPS:

- **GitHub Pages**: push this repo and enable Pages (Settings → Pages → deploy from
  branch). You'll get an `https://<user>.github.io/looper-app/` URL that works on
  every device.
- Or any static host (Netlify, Vercel, Cloudflare Pages, etc.).

Then open the URL on the phone, allow microphone access, and optionally
**Add to Home Screen** to install it as an app.

## Browser support

- iOS Safari 14.3+ (MediaRecorder), macOS Safari, Chrome, Edge, Firefox.
- Requires microphone permission and a secure context.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup and PWA meta tags |
| `styles.css` | UI / button states |
| `app.js` | Recording + looping logic |
| `manifest.webmanifest` | PWA install metadata |
| `sw.js` | Service worker for offline / installability |
| `icons/` | App icons (SVG + PNG) |
