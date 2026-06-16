/* Looper — record a loop, then overdub extra layers on top, all playing
 * back seamlessly forever.
 *
 * Flow:
 *   idle        -> tap green Record  -> recording (base loop)
 *   recording   -> tap red Stop      -> looping (gapless playback)
 *   looping     -> tap blue Overdub  -> overdubbing (record a layer on top)
 *   overdubbing -> tap red Done       -> layer added, back to looping
 *   looping     -> Undo layer / New loop
 *
 * Audio model:
 *   - Everything is kept as mono Float32 "layers" at the AudioContext sample
 *     rate, each exactly N frames long (the master loop length set by the
 *     first recording).
 *   - The master loop = the clamped sum of all layers, rendered into an
 *     AudioBuffer and played by an AudioBufferSourceNode with loop = true
 *     (sample-accurate, gapless).
 *   - Overdubbing captures raw mic PCM on a dedicated audio thread via an
 *     AudioWorklet (ScriptProcessor fallback), summing into a new layer
 *     aligned to the current loop phase. When you finish, the layer is added
 *     and the playing source is swapped at the next loop boundary so the new
 *     layer joins in perfect phase.
 *
 * Cross-platform notes:
 *   - getUserMedia + AudioContext require a user gesture and a secure context
 *     (https:// or http://localhost). iOS needs the context resumed in the tap.
 *   - The base loop is captured with MediaRecorder (feature-detected mime
 *     type) and decoded with decodeAudioData (callback + promise forms).
 */

const els = {
  btn: document.getElementById('mainBtn'),
  icon: document.getElementById('btnIcon'),
  label: document.getElementById('btnLabel'),
  status: document.getElementById('status'),
  hint: document.getElementById('hint'),
  ring: document.getElementById('ring'),
  meter: document.getElementById('meter'),
  meterFill: document.getElementById('meterFill'),
  layers: document.getElementById('layers'),
  undo: document.getElementById('undoBtn'),
  reset: document.getElementById('resetBtn'),
  version: document.getElementById('version'),
  debug: document.getElementById('debug'),
  refresh: document.getElementById('refreshBtn'),
};

const VERSION = 'v0.5.9';

const debugLog = [];
function dbg(msg) {
  const line = `${new Date().toLocaleTimeString()} ${msg}`;
  debugLog.push(line);
  if (debugLog.length > 8) debugLog.shift();
  if (els.debug) els.debug.textContent = debugLog.join('\n');
  // eslint-disable-next-line no-console
  console.log('[looper]', msg);
}

// Tap the version badge or debug log to copy its text to the clipboard.
async function copyText(el) {
  const text = el.textContent || '';
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const r = document.createRange();
      r.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      document.execCommand('copy');
    }
    el.classList.add('copied');
    setTimeout(() => el.classList.remove('copied'), 700);
  } catch (_) { /* selection still works as a fallback */ }
}

// Force-fetch the latest build: drop the service worker + its caches, then
// reload with a cache-busting query param so nothing stale is served.
async function hardRefresh() {
  if (els.refresh) els.refresh.textContent = '…';
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (_) { /* best effort */ }
  const u = new URL(location.href);
  u.searchParams.set('v', Date.now().toString());
  location.replace(u.toString());
}

const State = {
  IDLE: 'idle',
  RECORDING: 'recording',
  LOOPING: 'looping',
  OVERDUBBING: 'overdubbing',
};

const MAX_LAYERS = 20;        // safety cap
const BOUNDARY_LEAD = 0.08;   // schedule swaps this far ahead (s)

let state = State.IDLE;
let audioCtx = null;

// Loop data
let layers = [];              // Float32Array[N] per layer (mono)
let frameCount = 0;           // N: loop length in frames
let sampleRate = 48000;
let loopEpoch = 0;            // audioCtx time of loop phase 0
let masterSource = null;      // currently playing AudioBufferSourceNode
let latencyComp = 0;          // seconds, output-path latency compensation

// Capture plumbing
let micStream = null;
let recorder = null;          // MediaRecorder (base loop only)
let chunks = [];
let scriptNode = null;        // ScriptProcessor (overdub capture, fallback)
let captureNode = null;       // AudioWorkletNode (overdub capture, preferred)
let workletReady = false;     // has the worklet module been loaded?
let micSourceNode = null;
let silentSink = null;        // zero-gain node so the script node runs silently
let meterAnalyser = null;
let meterRAF = 0;
let overdubLayer = null;      // Float32Array[N] being recorded
let overdubStarting = false;  // true while overdub capture is being set up

/* ------------------------------------------------------------------ */
/* Native (Capacitor) audio bridge                                     */
/* ------------------------------------------------------------------ */
// In the native shell we route all audio to the AVAudioEngine plugin instead
// of Web Audio. In the browser these stay null and the Web Audio path runs.
const Cap = window.Capacitor;
const nativePlatform = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
// Resolve the plugin via either API: registerPlugin (modern) or Plugins (legacy).
let Native = null;
if (nativePlatform) {
  try { if (typeof Cap.registerPlugin === 'function') Native = Cap.registerPlugin('LooperAudio'); } catch (_) {}
  if (!Native && Cap.Plugins) Native = Cap.Plugins.LooperAudio || null;
}
// Only take the native audio path if the plugin is actually present.
const isNative = nativePlatform && !!Native;
let nativeReady = false;      // has the engine been prepared (perms + session)?
let nativeLayers = 0;         // layer count reported by the native engine

// Layer count for the UI, from whichever engine is active.
function layerCount() { return isNative ? nativeLayers : layers.length; }

/* ------------------------------------------------------------------ */
/* Setup helpers                                                       */
/* ------------------------------------------------------------------ */

// iOS 16.4+ exposes navigator.audioSession. Hint the platform that we want
// to keep playback on the loud speaker while the mic is open during overdub.
function setAudioSession(type) {
  try {
    const s = navigator.audioSession;
    if (s) {
      s.type = type;
      dbg(`audioSession=${type} -> ${s.type}`);
    } else {
      dbg('no navigator.audioSession');
    }
  } catch (e) {
    dbg('audioSession err: ' + (e && e.message));
  }
}

function getAudioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    sampleRate = audioCtx.sampleRate;
    // Compensate for the output path delay so overdubs don't land late.
    latencyComp = audioCtx.outputLatency || audioCtx.baseLatency || 0;
    audioCtx.addEventListener('statechange', () => {
      const st = audioCtx.state;
      dbg(`ctx statechange: ${st}`);
      // iOS fires 'interrupted' when the mic toggles the audio session.
      // Resume right away instead of waiting for an app-switch to recover.
      if (st === 'interrupted') {
        audioCtx.resume().catch(() => {});
      } else if (st === 'running' && frameCount > 0 && layers.length > 0 &&
                 (state === State.LOOPING || state === State.OVERDUBBING)) {
        // The interruption tears down the playing source — rebuild it.
        restartPlaybackNow();
      }
    });
  }
  return audioCtx;
}

// Drive the context back to 'running' (handles iOS 'interrupted'/'suspended').
async function resumeCtx() {
  const ctx = getAudioContext();
  for (let i = 0; i < 6 && ctx.state !== 'running'; i++) {
    try { await ctx.resume(); } catch (_) {}
    if (ctx.state !== 'running') await new Promise((r) => setTimeout(r, 60));
  }
  return ctx.state === 'running';
}

function pickMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',           // Safari / iOS
    'audio/aac',
    'audio/ogg;codecs=opus',
  ];
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
    return '';
  }
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

function checkSupport() {
  const secure = window.isSecureContext ||
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return 'This browser does not support microphone recording.';
  }
  if (typeof MediaRecorder === 'undefined') {
    return 'This browser does not support MediaRecorder.';
  }
  if (!secure) {
    return 'Microphone needs a secure connection (https or localhost).';
  }
  return null;
}

async function openMic() {
  const ctx = getAudioContext();
  if (ctx.state !== 'running') await resumeCtx();
  // Must be a capture-compatible category, or getUserMedia throws
  // "AudioSession category is not compatible with audio capture" (e.g. if a
  // prior overdub left the session in 'playback').
  setAudioSession('play-and-record');
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  return micStream;
}

function stopMic() {
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
}

/* ------------------------------------------------------------------ */
/* UI / state                                                          */
/* ------------------------------------------------------------------ */

function setState(next) {
  state = next;
  els.btn.classList.remove('idle', 'recording', 'overdub', 'overdubbing');

  if (next === State.IDLE) {
    els.btn.classList.add('idle');
    els.label.textContent = 'Record';
    els.btn.setAttribute('aria-label', 'Start recording');
    els.status.textContent = 'Tap to record a loop';
    els.ring.classList.remove('active');
    els.meter.classList.remove('active');
  } else if (next === State.RECORDING) {
    els.btn.classList.add('recording');
    els.label.textContent = 'Stop';
    els.btn.setAttribute('aria-label', 'Stop recording');
    els.status.textContent = 'Recording…';
    els.ring.classList.remove('active');
    els.meter.classList.add('active');
  } else if (next === State.LOOPING) {
    els.btn.classList.add('overdub');
    els.label.textContent = 'Overdub';
    els.btn.setAttribute('aria-label', 'Overdub a new layer');
    els.status.textContent = 'Looping';
    els.ring.classList.add('active');
    els.meter.classList.remove('active');
  } else if (next === State.OVERDUBBING) {
    els.btn.classList.add('overdubbing');
    els.label.textContent = 'Done';
    els.btn.setAttribute('aria-label', 'Finish overdub layer');
    els.status.textContent = 'Overdubbing…';
    els.ring.classList.add('active');
    els.meter.classList.add('active');
  }

  updateControls();
}

function updateControls() {
  const looping = state === State.LOOPING;
  els.reset.hidden = !(looping || state === State.OVERDUBBING);
  els.undo.hidden = !(looping && layerCount() >= 1);

  const n = layerCount();
  if (n > 0 && state !== State.IDLE && state !== State.RECORDING) {
    els.layers.hidden = false;
    els.layers.textContent = `${n} ${n === 1 ? 'layer' : 'layers'}`;
  } else {
    els.layers.hidden = true;
  }
}

function setHint(msg) { els.hint.textContent = msg || ''; }

/* ------------------------------------------------------------------ */
/* Master buffer / playback                                            */
/* ------------------------------------------------------------------ */

function buildMasterBuffer() {
  const ctx = getAudioContext();
  const buf = ctx.createBuffer(1, frameCount, sampleRate);
  const out = buf.getChannelData(0);
  for (let l = 0; l < layers.length; l++) {
    const layer = layers[l];
    for (let i = 0; i < frameCount; i++) out[i] += layer[i];
  }
  // Prevent clipping from summed layers.
  for (let i = 0; i < frameCount; i++) {
    const v = out[i];
    out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return buf;
}

function loopLength() { return frameCount / sampleRate; }

// Next loop boundary (phase 0) at least `lead` seconds in the future.
function nextBoundary(lead) {
  const ctx = getAudioContext();
  const L = loopLength();
  const k = Math.ceil((ctx.currentTime + lead - loopEpoch) / L);
  return loopEpoch + k * L;
}

// Start fresh playback now (used when the base loop is first created).
function startPlaybackNow() {
  const ctx = getAudioContext();
  loopEpoch = ctx.currentTime + 0.12;
  const src = ctx.createBufferSource();
  src.buffer = buildMasterBuffer();
  src.loop = true;
  src.connect(ctx.destination);
  src.start(loopEpoch, 0);
  masterSource = src;
}

// Swap to a freshly built master at the next boundary, keeping phase.
function swapMasterAtBoundary() {
  const ctx = getAudioContext();
  const tb = nextBoundary(BOUNDARY_LEAD);
  const src = ctx.createBufferSource();
  src.buffer = buildMasterBuffer();
  src.loop = true;
  src.connect(ctx.destination);
  src.start(tb, 0);
  if (masterSource) {
    try { masterSource.stop(tb); } catch (_) {}
  }
  masterSource = src;
}

// Immediately (re)start playback with a fresh source + epoch. Used to recover
// after opening the mic, which can interrupt/kill the playing source on iOS.
function restartPlaybackNow() {
  const ctx = getAudioContext();
  const startAt = ctx.currentTime + 0.06;
  const src = ctx.createBufferSource();
  src.buffer = buildMasterBuffer();
  src.loop = true;
  src.connect(ctx.destination);
  src.start(startAt, 0);
  if (masterSource) {
    try { masterSource.stop(); } catch (_) {}
    try { masterSource.disconnect(); } catch (_) {}
  }
  masterSource = src;
  loopEpoch = startAt;
}

function stopPlayback() {
  if (masterSource) {
    try { masterSource.stop(); } catch (_) {}
    try { masterSource.disconnect(); } catch (_) {}
    masterSource = null;
  }
}

/* ------------------------------------------------------------------ */
/* Base loop recording (MediaRecorder)                                 */
/* ------------------------------------------------------------------ */

async function startRecording() {
  await openMic();
  const ctx = getAudioContext();

  meterAnalyser = ctx.createAnalyser();
  meterAnalyser.fftSize = 1024;
  ctx.createMediaStreamSource(micStream).connect(meterAnalyser);
  startMeter();

  const mimeType = pickMimeType();
  recorder = mimeType ? new MediaRecorder(micStream, { mimeType })
                      : new MediaRecorder(micStream);
  chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = handleBaseRecordingStop;
  recorder.start();

  setState(State.RECORDING);
  setHint('');
}

async function handleBaseRecordingStop() {
  stopMeter();
  // Close the mic and switch to the playback category so iOS routes output
  // to the loud main speaker (an open/record session uses the quiet earpiece).
  stopMic();
  setAudioSession('playback');

  const type = (chunks[0] && chunks[0].type) || pickMimeType() || 'audio/webm';
  const blob = new Blob(chunks, { type });
  chunks = [];

  els.status.textContent = 'Preparing loop…';
  try {
    const decoded = await decodeAudio(await blob.arrayBuffer());
    const mono = toMono(decoded);
    frameCount = mono.length;
    sampleRate = audioCtx.sampleRate;
    layers = [mono];
    startPlaybackNow();
    setState(State.LOOPING);
    setHint(`Loop: ${loopLength().toFixed(1)}s · tap Overdub to layer on top.`);
    ensureWorklet(audioCtx); // warm up the capture worklet so the first overdub is snappy
  } catch (err) {
    console.error('Decode/playback failed:', err);
    resetAll();
    setHint('Could not process the recording. Please try again.');
  }
}

function decodeAudio(arrayBuf) {
  const ctx = getAudioContext();
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(arrayBuf, resolve, reject);
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}

// Downmix any AudioBuffer to a single mono Float32Array.
function toMono(audioBuffer) {
  const len = audioBuffer.length;
  const chs = audioBuffer.numberOfChannels;
  const out = new Float32Array(len);
  for (let c = 0; c < chs; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += data[i];
  }
  if (chs > 1) for (let i = 0; i < len; i++) out[i] /= chs;
  return out;
}

/* ------------------------------------------------------------------ */
/* Overdub recording (AudioWorklet, with ScriptProcessor fallback)     */
/* ------------------------------------------------------------------ */

async function ensureWorklet(ctx) {
  if (workletReady) return true;
  if (!ctx.audioWorklet) return false;
  try {
    await ctx.audioWorklet.addModule('capture-worklet.js');
    workletReady = true;
    return true;
  } catch (e) {
    dbg('worklet load failed: ' + (e && e.message));
    return false;
  }
}

async function startOverdub() {
  const ctx = getAudioContext();

  // Optimistic UI: flip to the recording state instantly so the tap feels
  // immediate, then do the (slow on iOS) mic acquisition in the background.
  overdubStarting = true;
  setState(State.OVERDUBBING);
  setHint(micStream ? 'Recording layer…' : 'Starting…');

  dbg(`overdub start: ctx=${ctx.state} mic=${!!micStream} playing=${!!masterSource}`);
  if (!micStream) await openMic();  // first overdub acquires the mic (slow on iOS)
  await resumeCtx();
  // The loop keeps playing through the mic transition (we set play-and-record
  // before getUserMedia, so iOS no longer interrupts) — no restart, no click.
  dbg(`overdub ready: ctx=${ctx.state} mic=${!!micStream} playing=${!!masterSource}`);

  micSourceNode = ctx.createMediaStreamSource(micStream);

  meterAnalyser = ctx.createAnalyser();
  meterAnalyser.fftSize = 1024;
  micSourceNode.connect(meterAnalyser);

  // Muted sink so the capture node ticks without monitoring the mic to the
  // speaker (avoids feedback); the worklet/script node produces no output.
  silentSink = ctx.createGain();
  silentSink.gain.value = 0;
  silentSink.connect(ctx.destination);

  const haveWorklet = await ensureWorklet(ctx);
  if (haveWorklet) {
    captureNode = new AudioWorkletNode(ctx, 'capture-processor');
    captureNode.port.onmessage = (e) => {
      if (e.data && e.data.type === 'layer') finalizeOverdub(e.data.buffer);
    };
    captureNode.port.postMessage({ type: 'start', frameCount, loopEpoch, latencyComp });
    micSourceNode.connect(captureNode);
    captureNode.connect(silentSink);
    dbg('capture: AudioWorklet');
  } else {
    // Fallback: ScriptProcessor on the main thread (older browsers).
    overdubLayer = new Float32Array(frameCount);
    scriptNode = ctx.createScriptProcessor(4096, 1, 1);
    scriptNode.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const L = loopLength();
      let phase = (ctx.currentTime - loopEpoch - latencyComp) % L;
      if (phase < 0) phase += L;
      let idx = Math.floor(phase * sampleRate) % frameCount;
      for (let i = 0; i < input.length; i++) {
        overdubLayer[idx] += input[i];
        if (++idx >= frameCount) idx = 0;
      }
    };
    micSourceNode.connect(scriptNode);
    scriptNode.connect(silentSink);
    dbg('capture: ScriptProcessor (fallback)');
  }

  overdubStarting = false;
  startMeter();
  setHint('Recording layer… 🎧 use headphones to hear the loop while the mic is on. Tap Done to add it.');
}

// Stop capturing. With the worklet, the layer comes back asynchronously and
// finalizeOverdub() runs from the port message; with the fallback we call it
// directly using the layer accumulated on the main thread.
function finishOverdub() {
  stopMeter();
  if (captureNode) {
    captureNode.port.postMessage({ type: 'stop' }); // -> 'layer' message
  } else {
    const layer = overdubLayer;
    overdubLayer = null;
    finalizeOverdub(layer);
  }
}

function finalizeOverdub(layerData) {
  // layerData is an ArrayBuffer (worklet) or a Float32Array (fallback) or null.
  if (captureNode) { try { captureNode.disconnect(); } catch (_) {} captureNode = null; }
  if (scriptNode) {
    scriptNode.onaudioprocess = null;
    try { scriptNode.disconnect(); } catch (_) {}
    scriptNode = null;
  }
  if (micSourceNode) { try { micSourceNode.disconnect(); } catch (_) {} micSourceNode = null; }
  if (silentSink) { try { silentSink.disconnect(); } catch (_) {} silentSink = null; }

  let layer = null;
  if (layerData instanceof Float32Array) layer = layerData;
  else if (layerData) layer = new Float32Array(layerData);
  if (layer && layer.length === frameCount) layers.push(layer);
  overdubLayer = null;

  // Keep the mic open (and the session in play-and-record) so the next
  // overdub starts instantly. Fold the new layer in seamlessly at the next
  // loop boundary. The mic is released on New loop / reset.
  swapMasterAtBoundary();

  setState(State.LOOPING);
  setHint('🎧 Mic stays on for instant overdubs — loop is quiet on the phone speaker. New loop turns it off.');
}

/* ------------------------------------------------------------------ */
/* Layer management                                                    */
/* ------------------------------------------------------------------ */

function undoLayer() {
  if (state !== State.LOOPING || layers.length === 0) return;
  layers.pop();
  if (layers.length === 0) {
    resetAll();
    setHint('');
  } else {
    swapMasterAtBoundary();
    setState(State.LOOPING);
  }
}

function resetAll() {
  stopPlayback();
  stopMeter();
  if (captureNode) { try { captureNode.disconnect(); } catch (_) {} captureNode = null; }
  if (scriptNode) { scriptNode.onaudioprocess = null; try { scriptNode.disconnect(); } catch (_) {} scriptNode = null; }
  if (micSourceNode) { try { micSourceNode.disconnect(); } catch (_) {} micSourceNode = null; }
  if (silentSink) { try { silentSink.disconnect(); } catch (_) {} silentSink = null; }
  stopMic();
  layers = [];
  overdubLayer = null;
  frameCount = 0;
  setState(State.IDLE);
}

/* ------------------------------------------------------------------ */
/* Meter                                                               */
/* ------------------------------------------------------------------ */

function startMeter() {
  const data = new Uint8Array(meterAnalyser.fftSize);
  const tick = () => {
    if (!meterAnalyser) return;
    meterAnalyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    // scaleX is composited (no layout/paint), unlike animating width.
    els.meterFill.style.transform = 'scaleX(' + Math.min(1, peak * 1.4) + ')';
    meterRAF = requestAnimationFrame(tick);
  };
  tick();
}

function stopMeter() {
  if (meterRAF) cancelAnimationFrame(meterRAF);
  meterRAF = 0;
  els.meterFill.style.transform = 'scaleX(0)';
  meterAnalyser = null;
}

/* ------------------------------------------------------------------ */
/* Button handlers                                                     */
/* ------------------------------------------------------------------ */

// Native engine: the UI state machine is shared; only the audio calls differ.
async function onMainButtonNative() {
  if (state === State.IDLE) {
    if (!nativeReady) {
      setHint('Starting…');
      const p = await Native.prepare();
      nativeReady = true;
      dbg(`prepared sr=${p && p.sampleRate} ch=${p && p.inputChannels} lat=${p && p.latencyFrames}`);
    }
    await Native.startRecord();
    nativeLayers = 0;
    setState(State.RECORDING);
    setHint('');
  } else if (state === State.RECORDING) {
    const r = await Native.stopRecord();
    nativeLayers = r.layers || 1;
    dbg(`loop ${r.frames}f ${(r.seconds || 0).toFixed(2)}s`);
    setState(State.LOOPING);
    setHint(`Loop: ${(r.seconds || 0).toFixed(1)}s · tap Overdub to layer on top.`);
  } else if (state === State.OVERDUBBING) {
    const r = await Native.finishOverdub();
    nativeLayers = (r && r.layers) || nativeLayers;
    setState(State.LOOPING);
    setHint('');
  } else if (state === State.LOOPING) {
    if (nativeLayers >= MAX_LAYERS) { setHint(`Layer limit reached (${MAX_LAYERS}).`); return; }
    setState(State.OVERDUBBING);   // optimistic — native startOverdub is fast
    setHint('Recording layer… tap Done to add it.');
    await Native.startOverdub();
  }
}

async function onMainButton() {
  try {
    if (isNative) { await onMainButtonNative(); return; }
    if (state === State.IDLE) {
      await startRecording();
    } else if (state === State.RECORDING) {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    } else if (state === State.LOOPING) {
      if (layers.length >= MAX_LAYERS) {
        setHint(`Layer limit reached (${MAX_LAYERS}).`);
        return;
      }
      await startOverdub();
    } else if (state === State.OVERDUBBING) {
      if (overdubStarting) return; // ignore Done until capture is actually live
      finishOverdub();
    }
  } catch (err) {
    console.error(err);
    dbg(`error: ${err && err.name}: ${err && err.message}`);
    handleError(err);
  }
}

function handleError(err) {
  stopMeter();
  stopMic();
  if (err && err.name === 'NotAllowedError') {
    setHint('Microphone permission was denied. Allow mic access and try again.');
  } else {
    setHint('Something went wrong with the microphone.');
  }
  // Drop back to a safe state: keep an existing loop if we have one.
  if (layers.length > 0 && frameCount > 0) {
    setState(State.LOOPING);
  } else {
    resetAll();
  }
}

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

function init() {
  if (els.version) {
    els.version.textContent = VERSION + (nativePlatform ? (Native ? ' • native' : ' • shell') : '');
  }
  dbg(`engine=${isNative ? 'native' : 'web'} platform=${nativePlatform} plugin=${!!Native} reg=${!!(Cap && Cap.registerPlugin)}`);
  try { dbg('plugins: ' + Object.keys((Cap && Cap.Plugins) || {}).join(',')); } catch (_) {}

  // Tap the version badge or debug log to copy (selection also works).
  if (els.version) els.version.addEventListener('click', () => copyText(els.version));
  if (els.debug) els.debug.addEventListener('click', () => copyText(els.debug));
  if (els.refresh) els.refresh.addEventListener('click', hardRefresh);

  // The native engine doesn't use Web Audio / MediaRecorder, so only gate the
  // browser path on those APIs.
  if (!isNative) {
    const problem = checkSupport();
    if (problem) {
      els.btn.disabled = true;
      els.status.textContent = 'Unsupported';
      setHint(problem);
      return;
    }
  }

  els.btn.addEventListener('click', onMainButton);
  els.undo.addEventListener('click', () => { if (isNative) undoNative(); else undoLayer(); });
  els.reset.addEventListener('click', () => {
    if (isNative) {
      Native.clear().catch(() => {});
      nativeLayers = 0;
      setState(State.IDLE);
      setHint('');
    } else {
      resetAll();
      setHint('');
    }
  });

  if (isNative) {
    // Native engine streams input level for the meter.
    Native.addListener('level', (d) => {
      const peak = (d && d.peak) || 0;
      els.meterFill.style.transform = 'scaleX(' + Math.min(1, peak * 1.4) + ')';
    });
  }

  window.addEventListener('pagehide', () => { stopPlayback(); stopMic(); });

  setState(State.IDLE);

  registerServiceWorker();
}

async function undoNative() {
  try {
    const r = await Native.undo();
    nativeLayers = (r && r.layers) || 0;
    if (nativeLayers === 0) { setState(State.IDLE); setHint(''); }
    else setState(State.LOOPING);
  } catch (_) { /* ignore */ }
}

// Register the SW and reveal the Update button when a newer build installs.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // In the native (Capacitor) shell, assets are bundled — skip the SW so it
  // can't serve stale content across app updates.
  if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) return;
  window.addEventListener('load', async () => {
    try {
      // A controller already present at registration means a previous SW
      // controls this page, so any new worker is an *update* (not first install).
      const hadController = !!navigator.serviceWorker.controller;

      const reg = await navigator.serviceWorker.register('sw.js');

      const consider = (sw) => {
        if (!sw || !hadController) return;
        const check = () => {
          if (sw.state === 'installed' || sw.state === 'activated') showUpdate();
        };
        check();                                   // may already be past 'installed'
        sw.addEventListener('statechange', check);
      };

      consider(reg.waiting);
      consider(reg.installing);
      reg.addEventListener('updatefound', () => consider(reg.installing));

      // Check for new deploys promptly: now, on a short interval, and on focus.
      const poll = () => reg.update().catch(() => {});
      poll();
      setInterval(poll, 15000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
      window.addEventListener('focus', poll);
    } catch (_) { /* SW optional */ }
  });
}

function showUpdate() {
  if (els.refresh && els.refresh.hidden) {
    els.refresh.hidden = false;
    els.refresh.classList.add('attention');
    dbg('update available');
  }
}

init();
