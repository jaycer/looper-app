/* Looper — record a loop, then play it back seamlessly forever.
 *
 * Flow:
 *   idle      -> tap green Record  -> recording
 *   recording -> tap red Stop      -> looping (gapless playback)
 *   looping   -> tap Stop loop     -> idle (ready to record again)
 *
 * Cross-platform notes:
 *   - getUserMedia + AudioContext require a user gesture and a secure
 *     context (https:// or http://localhost). iOS Safari especially
 *     needs the AudioContext resumed inside the tap handler.
 *   - MediaRecorder mime types differ (Safari: audio/mp4, Chrome/FF:
 *     audio/webm). We feature-detect the best supported type.
 *   - Looping uses Web Audio (AudioBufferSourceNode.loop = true) for
 *     sample-accurate, gapless repeats — far tighter than <audio loop>.
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
  reset: document.getElementById('resetBtn'),
};

const State = { IDLE: 'idle', RECORDING: 'recording', LOOPING: 'looping' };

let state = State.IDLE;
let audioCtx = null;          // shared AudioContext
let micStream = null;         // active getUserMedia stream
let recorder = null;          // MediaRecorder
let chunks = [];              // recorded blobs
let loopBuffer = null;        // decoded AudioBuffer of the loop
let loopSource = null;        // currently playing AudioBufferSourceNode
let analyser = null;          // for live input meter
let meterRAF = 0;             // requestAnimationFrame handle

/* ------------------------------------------------------------------ */
/* Setup                                                              */
/* ------------------------------------------------------------------ */

function getAudioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
  }
  return audioCtx;
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
    return ''; // let the browser choose its default
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

/* ------------------------------------------------------------------ */
/* State / UI                                                         */
/* ------------------------------------------------------------------ */

function setState(next) {
  state = next;
  els.btn.classList.remove(State.IDLE, State.RECORDING, State.LOOPING);
  els.btn.classList.add(next);

  if (next === State.IDLE) {
    els.label.textContent = 'Record';
    els.btn.setAttribute('aria-label', 'Start recording');
    els.status.textContent = loopBuffer ? 'Loop stopped' : 'Tap to record a loop';
    els.ring.classList.remove('active');
    els.meter.classList.remove('active');
    els.reset.hidden = true;
  } else if (next === State.RECORDING) {
    els.label.textContent = 'Stop';
    els.btn.setAttribute('aria-label', 'Stop recording');
    els.status.textContent = 'Recording…';
    els.ring.classList.remove('active');
    els.meter.classList.add('active');
    els.reset.hidden = true;
  } else if (next === State.LOOPING) {
    els.label.textContent = 'Stop';
    els.btn.setAttribute('aria-label', 'Stop loop');
    els.status.textContent = 'Looping…';
    els.ring.classList.add('active');
    els.meter.classList.remove('active');
    els.reset.hidden = false;
  }
}

function setHint(msg) { els.hint.textContent = msg || ''; }

/* ------------------------------------------------------------------ */
/* Recording                                                          */
/* ------------------------------------------------------------------ */

async function startRecording() {
  const ctx = getAudioContext();
  // iOS requires resume() from within the gesture.
  if (ctx.state === 'suspended') await ctx.resume();

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  // Live input meter
  analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(micStream).connect(analyser);
  startMeter();

  const mimeType = pickMimeType();
  recorder = mimeType ? new MediaRecorder(micStream, { mimeType })
                      : new MediaRecorder(micStream);
  chunks = [];

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = handleRecordingStop;
  recorder.start();

  setState(State.RECORDING);
  setHint('');
}

async function handleRecordingStop() {
  stopMeter();
  stopMic();

  const type = (chunks[0] && chunks[0].type) || pickMimeType() || 'audio/webm';
  const blob = new Blob(chunks, { type });
  chunks = [];

  els.status.textContent = 'Preparing loop…';

  try {
    const arrayBuf = await blob.arrayBuffer();
    loopBuffer = await decodeAudio(arrayBuf);
    startLoop();
  } catch (err) {
    console.error('Decode/playback failed:', err);
    setState(State.IDLE);
    setHint('Could not process the recording. Please try again.');
  }
}

function decodeAudio(arrayBuf) {
  const ctx = getAudioContext();
  // Safari historically only supports the callback form.
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(arrayBuf, resolve, reject);
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}

/* ------------------------------------------------------------------ */
/* Looping playback                                                   */
/* ------------------------------------------------------------------ */

function startLoop() {
  const ctx = getAudioContext();
  stopLoopSource();

  loopSource = ctx.createBufferSource();
  loopSource.buffer = loopBuffer;
  loopSource.loop = true;            // gapless, sample-accurate repeat
  loopSource.connect(ctx.destination);
  loopSource.start();

  setState(State.LOOPING);
  const secs = loopBuffer.duration.toFixed(1);
  setHint(`Loop length: ${secs}s · plays forever until you stop it.`);
}

function stopLoopSource() {
  if (loopSource) {
    try { loopSource.stop(); } catch (_) {}
    try { loopSource.disconnect(); } catch (_) {}
    loopSource = null;
  }
}

/* ------------------------------------------------------------------ */
/* Cleanup helpers                                                    */
/* ------------------------------------------------------------------ */

function stopMic() {
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
}

function startMeter() {
  const data = new Uint8Array(analyser.fftSize);
  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    els.meterFill.style.width = Math.min(100, peak * 140) + '%';
    meterRAF = requestAnimationFrame(tick);
  };
  tick();
}

function stopMeter() {
  if (meterRAF) cancelAnimationFrame(meterRAF);
  meterRAF = 0;
  els.meterFill.style.width = '0%';
  analyser = null;
}

/* ------------------------------------------------------------------ */
/* Main button handler                                                */
/* ------------------------------------------------------------------ */

async function onMainButton() {
  try {
    if (state === State.IDLE) {
      await startRecording();
    } else if (state === State.RECORDING) {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    } else if (state === State.LOOPING) {
      stopLoopSource();
      setState(State.IDLE);
    }
  } catch (err) {
    console.error(err);
    stopMeter();
    stopMic();
    setState(State.IDLE);
    if (err && err.name === 'NotAllowedError') {
      setHint('Microphone permission was denied. Allow mic access and try again.');
    } else {
      setHint('Something went wrong starting the recorder.');
    }
  }
}

function resetToRecord() {
  stopLoopSource();
  loopBuffer = null;
  setState(State.IDLE);
  setHint('');
}

/* ------------------------------------------------------------------ */
/* Init                                                               */
/* ------------------------------------------------------------------ */

function init() {
  const problem = checkSupport();
  if (problem) {
    els.btn.disabled = true;
    els.status.textContent = 'Unsupported';
    setHint(problem);
    return;
  }

  els.btn.addEventListener('click', onMainButton);
  els.reset.addEventListener('click', resetToRecord);

  // Keep things tidy if the user navigates away.
  window.addEventListener('pagehide', () => { stopMic(); stopLoopSource(); });

  setState(State.IDLE);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
}

init();
