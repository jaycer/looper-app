# Looper

A dead-simple audio looper that runs on **iOS, macOS, and Android** — anywhere
with a modern browser. Record a loop, then hear it play back seamlessly, forever.

It's a **Progressive Web App (PWA)**: one codebase, no app store, installs to the
home screen like a native app.

## How it works

- **Tap the green Record button** → it turns red and starts recording from the mic.
- **Tap the red Stop button** → the recording immediately begins looping, gapless,
  over and over.
- **Tap Stop (amber)** or **New loop** → stop playback and you're ready to record again.

Under the hood:

- `getUserMedia` + `MediaRecorder` capture the audio.
- The **Web Audio API** (`AudioBufferSourceNode` with `loop = true`) plays it back
  with sample-accurate, gapless repeats — much tighter than `<audio loop>`.
- Mime types and the `decodeAudioData` callback/promise forms are feature-detected
  so it works on Safari/iOS (`audio/mp4`) as well as Chrome/Firefox (`audio/webm`).

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
