/**
 * The voice client, served as one inline string.
 *
 * No build step, no framework, no CDN: the page is a `<style>` and a `<script>` inside a
 * template literal, and that is a decision rather than laziness. A Tailwind CDN was tried
 * on paper and dropped for the obvious reason — a page whose only job is to talk to this
 * Worker should not stop looking like itself because someone else's host is down.
 *
 * The screen is one orb and nothing else. Everything that used to be on it —transcript,
 * reply, per-stage times, the mode switch, the text box— still exists, one tap away behind
 * the dots. That split is the whole design: the orb is for using it, the panel is for
 * finding out why it did something odd, and the second job must not tax the first.
 *
 * The orb is driven by real numbers, never by a decorative loop. While recording it scales
 * with the microphone's RMS, and while answering it scales with the RMS of the audio being
 * played through an AnalyserNode. So "is it hearing me" and "is it still talking" are
 * answered by the same shape, and a dead microphone shows up as an orb that does not move —
 * which is exactly the failure that cost an afternoon.
 *
 * The wake word is the one thing here that talks to somebody else. Chrome's speech
 * recognition runs on Google's servers, so while that switch is on, everything the
 * microphone hears leaves the machine. It is off by default, it says so on screen the
 * whole time it is on, and it is the reason the pill at the top is red rather than
 * tasteful. Porcupine running locally is the honest long-term answer; this is the one that
 * fits in an afternoon.
 *
 * The token is never in here. It is typed once by a person and kept in that browser's
 * localStorage, so this file can be served to anyone: without a token, /voice answers 401.
 */
export const VOICE_TEST_PAGE = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Jarvis</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #07080c;
    --fg: #e8eaf0;
    --dim: #6b7280;
    --line: rgba(255,255,255,.07);
    --c1: #4f6ef7; --c2: #8b5cf6; --c3: #22d3ee;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    overflow: hidden;
  }
  /* A very slow wash behind everything, so a still screen never looks frozen. */
  body::before {
    content: ''; position: fixed; inset: -20%;
    background:
      radial-gradient(40% 40% at 22% 28%, rgba(79,110,247,.10), transparent 70%),
      radial-gradient(38% 38% at 78% 72%, rgba(139,92,246,.09), transparent 70%);
    animation: wash 24s ease-in-out infinite alternate;
    pointer-events: none;
  }
  @keyframes wash { to { transform: translate3d(3%, -3%, 0) scale(1.08); } }

  /* ---------- the orb ---------- */
  #stage { position: relative; width: 280px; height: 280px; display: grid; place-items: center; }

  #halo {
    position: absolute; width: 300px; height: 300px; border-radius: 50%;
    background: radial-gradient(circle, var(--c1) 0%, transparent 62%);
    opacity: .30; filter: blur(46px);
    transform: scale(calc(1 + var(--l, 0) * .45));
    transition: transform .1s ease-out, opacity .5s ease, background .8s ease;
  }

  #ring {
    position: absolute; width: 248px; height: 248px; border-radius: 50%;
    background: conic-gradient(from 0deg, transparent 0 62%, var(--c3) 78%, transparent 92%);
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 0);
            mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 0);
    opacity: 0; transition: opacity .45s ease;
    animation: spin 1.5s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  #orb {
    position: relative; width: 220px; height: 220px; border-radius: 50%;
    border: 0; padding: 0; cursor: pointer; overflow: hidden;
    background: #0b0d13;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.08), 0 24px 60px -20px rgba(0,0,0,.9);
    transform: scale(calc(1 + var(--l, 0) * .17));
    transition: transform .1s cubic-bezier(.22,1,.36,1);
    touch-action: none; -webkit-user-select: none; user-select: none;
  }
  #orb:disabled { cursor: not-allowed; }
  #orb:focus-visible { outline: 2px solid var(--c3); outline-offset: 6px; }

  #skin { position: absolute; inset: 0; animation: breathe 6s ease-in-out infinite; }
  @keyframes breathe { 50% { transform: scale(1.05); } }

  .blob { position: absolute; inset: -35%; border-radius: 50%; filter: blur(26px); mix-blend-mode: screen; }
  .b1 { background: radial-gradient(circle at 34% 32%, var(--c1), transparent 58%); animation: drift 11s ease-in-out infinite; }
  .b2 { background: radial-gradient(circle at 68% 40%, var(--c2), transparent 56%); animation: drift 15s ease-in-out infinite reverse; }
  .b3 { background: radial-gradient(circle at 46% 74%, var(--c3), transparent 54%); animation: drift 19s ease-in-out infinite; }
  .b4 { background: radial-gradient(circle at 74% 70%, var(--c1), transparent 50%); animation: drift 23s ease-in-out infinite reverse; opacity: .75; }
  @keyframes drift {
    0%   { transform: rotate(0deg)   translate3d(0, 0, 0)      scale(1); }
    33%  { transform: rotate(120deg) translate3d(7%, -5%, 0)   scale(1.12); }
    66%  { transform: rotate(240deg) translate3d(-5%, 6%, 0)   scale(.92); }
    100% { transform: rotate(360deg) translate3d(0, 0, 0)      scale(1); }
  }
  /* The glass: a highlight up top and a dark rim, so it reads as a sphere and not a disc. */
  #sheen {
    position: absolute; inset: 0; border-radius: 50%; pointer-events: none;
    background:
      radial-gradient(58% 46% at 34% 22%, rgba(255,255,255,.16), transparent 60%),
      radial-gradient(100% 100% at 50% 120%, rgba(0,0,0,.55), transparent 62%);
  }

  /* ---------- states ---------- */
  body[data-state="listening"] { --c1: #22d3ee; --c2: #3b82f6; --c3: #34d399; }
  body[data-state="thinking"]  { --c1: #f59e0b; --c2: #ec4899; --c3: #a78bfa; }
  body[data-state="speaking"]  { --c1: #34d399; --c2: #22d3ee; --c3: #60a5fa; }
  body[data-state="error"]     { --c1: #f43f5e; --c2: #fb7185; --c3: #f59e0b; }

  body[data-state="thinking"] #ring { opacity: .9; }
  body[data-state="thinking"] #skin { animation-duration: 2.6s; }
  body[data-state="listening"] #halo { opacity: .5; }
  body[data-state="speaking"]  #halo { opacity: .5; }
  body[data-state="error"] #orb { animation: shake .45s ease; }
  @keyframes shake { 25% { transform: translateX(-7px); } 75% { transform: translateX(7px); } }

  /* ---------- chrome ---------- */
  #status {
    margin-top: 30px; min-height: 22px; font-size: 14px; color: var(--dim);
    letter-spacing: .01em; text-align: center; transition: color .3s ease;
  }
  body[data-state="error"] #status { color: #fb7185; }

  #wake {
    position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
    display: none; align-items: center; gap: 9px;
    padding: 7px 15px 7px 12px; border-radius: 999px;
    border: 1px solid rgba(244,63,94,.32); background: rgba(244,63,94,.09);
    color: #fda4af; font: inherit; font-size: 12px; cursor: pointer;
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  }
  #wake.on { display: flex; }
  #wake i { width: 7px; height: 7px; border-radius: 50%; background: #f43f5e; animation: blink 1.6s infinite; }
  @keyframes blink { 50% { opacity: .2; } }

  #dots {
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    border: 0; background: none; color: #333947; cursor: pointer;
    font-size: 20px; line-height: 1; letter-spacing: 3px; padding: 10px 16px;
    transition: color .25s ease;
  }
  #dots:hover { color: var(--dim); }

  /* ---------- panel ---------- */
  /* The panel covers the bottom of the screen, and the button that opens it lives there
     too — so once open it was hiding its own switch. Hence the backdrop and the handle:
     three ways out (tap outside, drag the handle, Escape) instead of one that was buried. */
  #panelBack {
    position: fixed; inset: 0; z-index: 4;
    background: rgba(4,5,8,.55);
    opacity: 0; pointer-events: none; transition: opacity .35s ease;
  }
  #panelBack.open { opacity: 1; pointer-events: auto; }

  #panelHandle {
    display: block; width: 100%; padding: 0 0 14px; border: 0; background: none; cursor: pointer;
  }
  #panelHandle::before {
    content: ''; display: block; width: 42px; height: 4px; margin: 0 auto;
    border-radius: 999px; background: #2a2f3a; transition: background .2s ease;
  }
  #panelHandle:hover::before { background: #3d4657; }

  #panel {
    position: fixed; inset: auto 0 0 0; z-index: 5;
    max-height: 82vh; overflow-y: auto;
    padding: 22px 20px 28px;
    background: rgba(10,12,17,.92);
    -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px);
    border-top: 1px solid var(--line);
    border-radius: 20px 20px 0 0;
    transform: translateY(101%);
    transition: transform .38s cubic-bezier(.22,1,.36,1);
  }
  #panel.open { transform: translateY(0); }
  #panelInner { max-width: 520px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
  #panel h2 {
    margin: 0 0 6px; font-size: 10px; font-weight: 600; letter-spacing: .14em;
    text-transform: uppercase; color: #4b5263;
  }
  #panel p { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 14px; }
  .empty { color: #e8a33d; font-style: italic; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; color: #9aa1b1; }
  td { padding: 3px 0; }
  td:last-child { text-align: right; font-variant-numeric: tabular-nums; color: var(--fg); }
  td.slow { color: #e8a33d; }

  .seg { display: flex; gap: 6px; }
  .seg button {
    flex: 1; padding: 9px; font: inherit; font-size: 13px; cursor: pointer;
    border-radius: 10px; border: 1px solid var(--line); background: transparent; color: var(--dim);
    transition: color .2s, border-color .2s, background .2s;
  }
  .seg button.on { color: var(--fg); border-color: rgba(255,255,255,.18); background: rgba(255,255,255,.04); }

  input {
    width: 100%; padding: 12px 14px; font: inherit; font-size: 14px;
    border-radius: 12px; border: 1px solid var(--line);
    background: rgba(255,255,255,.03); color: var(--fg); outline: none;
    transition: border-color .2s;
  }
  input:focus { border-color: rgba(255,255,255,.2); }
  .field { display: flex; gap: 8px; }
  .field input { flex: 1; }
  .btn {
    padding: 12px 18px; font: inherit; font-size: 14px; cursor: pointer;
    border-radius: 12px; border: 1px solid var(--line);
    background: rgba(255,255,255,.04); color: var(--fg);
    transition: background .2s, border-color .2s;
  }
  .btn:hover { background: rgba(255,255,255,.08); }
  .btn.yes { border-color: rgba(52,211,153,.4); }
  .btn.no  { border-color: rgba(244,63,94,.35); }
  .link { border: 0; background: none; color: #4b5263; font: inherit; font-size: 12px; cursor: pointer; padding: 0; }
  .link:hover { color: var(--dim); }

  /* ---------- confirmation ---------- */
  #confirm {
    position: fixed; inset: 0; z-index: 10; display: grid; place-items: center;
    padding: 24px; background: rgba(5,6,9,.72);
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
    opacity: 0; pointer-events: none; transition: opacity .3s ease;
  }
  #confirm.open { opacity: 1; pointer-events: auto; }
  #confirmBox {
    width: 100%; max-width: 420px; padding: 22px;
    border-radius: 18px; border: 1px solid var(--line); background: #0d1017;
    transform: translateY(12px) scale(.98); transition: transform .3s cubic-bezier(.22,1,.36,1);
  }
  #confirm.open #confirmBox { transform: none; }
  #confirmText { margin: 0 0 18px; white-space: pre-wrap; }
  #confirmBox .field { gap: 10px; }
  #confirmBox .btn { flex: 1; }

  /* ---------- token gate ---------- */
  #setup { width: 100%; max-width: 380px; padding: 0 20px; display: flex; flex-direction: column; gap: 12px; }
  #setup p { margin: 0; font-size: 13px; color: var(--dim); }

  .hidden { display: none !important; }

  @media (prefers-reduced-motion: reduce) {
    body::before, #skin, .blob, #ring { animation: none !important; }
    #orb, #halo { transition: none; }
  }
</style>
</head>
<body data-state="idle">

<div id="setup" class="hidden">
  <h1 style="margin:0;font-size:17px;font-weight:600">Jarvis</h1>
  <p>Pega el token. Se guarda solo en este navegador y no viaja en la URL.</p>
  <input id="token" type="password" autocomplete="off" placeholder="VOICE_API_TOKEN">
  <button class="btn" id="save">Entrar</button>
</div>

<div id="app" class="hidden">
  <div id="stage">
    <div id="halo"></div>
    <div id="ring"></div>
    <button id="orb" aria-label="Hablar">
      <div id="skin">
        <span class="blob b1"></span><span class="blob b2"></span>
        <span class="blob b3"></span><span class="blob b4"></span>
      </div>
      <span id="sheen"></span>
    </button>
  </div>
  <div id="status">Toca para hablar</div>
</div>

<button id="wake"><i></i><span id="wakeLabel">Escuchando · di «oye Jarvis»</span></button>

<button id="dots" class="hidden" aria-label="Detalles">···</button>

<div id="panelBack"></div>

<div id="panel">
  <button id="panelHandle" aria-label="Cerrar"></button>
  <div id="panelInner">
    <div>
      <h2>Te he oído</h2>
      <p id="heard" class="empty">—</p>
    </div>
    <div>
      <h2>Respuesta</h2>
      <p id="said" class="empty">—</p>
    </div>
    <div id="noticeBox" class="hidden">
      <h2>Aviso</h2>
      <p id="notice" style="color:#e8a33d">—</p>
    </div>
    <div id="timesBox" class="hidden">
      <h2>Tiempos</h2>
      <table id="times"></table>
    </div>
    <div>
      <h2>Escucha por voz</h2>
      <div class="seg"><button id="wakeToggle">Desactivada</button></div>
      <p id="wakeHint" style="margin-top:9px;font-size:12px;color:#4b5263;line-height:1.5">
        Di «oye Jarvis» y empieza a grabar sola. Solo funciona en Chrome, y mientras esté
        activa el audio del micrófono pasa continuamente por los servidores de Google.
      </p>
    </div>
    <div>
      <h2>Modo</h2>
      <div class="seg">
        <button id="modeToggle">Tocar y hablar</button>
        <button id="modeHold">Mantener pulsado</button>
      </div>
    </div>
    <div>
      <h2>Escribir en vez de hablar</h2>
      <div class="field">
        <input id="say" type="text" autocomplete="off" placeholder="Escríbelo y pulsa Enter">
        <button class="btn" id="send">Enviar</button>
      </div>
    </div>
    <button class="link" id="forget">Olvidar el token de este navegador</button>
    <button class="btn" id="panelClose">Cerrar</button>
  </div>
</div>

<div id="confirm">
  <div id="confirmBox">
    <h2 style="margin:0 0 8px;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#4b5263">Confirma</h2>
    <p id="confirmText"></p>
    <div class="field">
      <button class="btn no" id="no">Cancelar</button>
      <button class="btn yes" id="yes">Confirmar</button>
    </div>
  </div>
</div>

<script>
(function () {
  'use strict';
  var KEY = 'jarvis.voice.token';
  var MODE_KEY = 'jarvis.voice.mode';
  var $ = function (id) { return document.getElementById(id); };

  var token = '', mode = 'toggle';
  var recorder = null, chunks = [], stream = null, recording = false, busy = false;
  var recordStartedAt = 0, lastRecordMs = 0, heardSomething = false, localText = '';
  var pendingToken = '';

  // ---- state ------------------------------------------------------------
  // One place decides what the orb looks like and what the line under it says. Every
  // path through the app ends here, which is why there is no state the user cannot name.
  function setState(state, text) {
    document.body.dataset.state = state;
    if (text !== undefined) $('status').textContent = text;
  }
  function level(value) {
    document.body.style.setProperty('--l', String(Math.max(0, Math.min(1, value))));
  }

  // ---- token ------------------------------------------------------------
  try { token = localStorage.getItem(KEY) || ''; } catch (e) {}
  gate(!token);
  $('save').onclick = function () {
    var value = $('token').value.trim();
    if (!value) return;
    token = value;
    try { localStorage.setItem(KEY, value); } catch (e) {}
    $('token').value = '';
    gate(false);
  };
  $('token').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); $('save').click(); }
    e.stopPropagation();
  });
  $('forget').onclick = function () { closePanel(); forgetToken(); };

  function gate(needed) {
    $('setup').classList.toggle('hidden', !needed);
    $('app').classList.toggle('hidden', needed);
    $('dots').classList.toggle('hidden', needed);
  }
  function forgetToken() {
    token = '';
    try { localStorage.removeItem(KEY); } catch (e) {}
    gate(true);
  }

  // ---- panel ------------------------------------------------------------
  function openPanel() {
    $('panel').classList.add('open');
    $('panelBack').classList.add('open');
  }
  function closePanel() {
    $('panel').classList.remove('open');
    $('panelBack').classList.remove('open');
  }
  function togglePanel() {
    if ($('panel').classList.contains('open')) closePanel(); else openPanel();
  }

  $('dots').onclick = togglePanel;
  $('panelHandle').onclick = closePanel;
  $('panelClose').onclick = closePanel;
  // The backdrop is what makes tapping anywhere outside work, and it also stops a tap
  // meant to dismiss the panel from landing on the orb and starting a recording.
  $('panelBack').onclick = closePanel;
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closePanel(); hideConfirm(); }
  });

  // ---- mode -------------------------------------------------------------
  try { mode = localStorage.getItem(MODE_KEY) || 'toggle'; } catch (e) {}
  setMode(mode);
  $('modeToggle').onclick = function () { setMode('toggle'); };
  $('modeHold').onclick = function () { setMode('hold'); };
  function setMode(next) {
    mode = next === 'hold' ? 'hold' : 'toggle';
    try { localStorage.setItem(MODE_KEY, mode); } catch (e) {}
    $('modeToggle').classList.toggle('on', mode === 'toggle');
    $('modeHold').classList.toggle('on', mode === 'hold');
    if (!recording && !busy) idle();
  }
  function idle() {
    var hint = mode === 'hold' ? 'Mantén pulsado para hablar' : 'Toca para hablar';
    setState('idle', wakeOn ? 'Di «oye Jarvis»' : hint);
    level(0);
    // The cooldown is not politeness: re-arming the instant the reply ends catches its
    // own tail through the speakers and wakes the assistant up with its own voice.
    if (wakeOn) { clearTimeout(wakeTimer); wakeTimer = setTimeout(arm, WAKE_COOLDOWN_MS); }
  }

  // ---- microphone level and silence -------------------------------------
  // An RMS over the raw samples, with the room's own noise measured during the first
  // quarter second instead of a fixed threshold: a fixed one works on the desk it was
  // tuned on and nowhere else.
  var SILENCE_MS = 1400;
  var CALIBRATE_MS = 250;
  var MIN_RECORD_MS = 900;
  var MAX_RECORD_MS = 30000;
  // Nobody said anything. Without this a tap —or a false wake— records the full 30 s of
  // nothing before finding out, and the orb sits there looking like it is working.
  var NO_SPEECH_MS = 3500;
  var micCtx = null, micAnalyser = null, meterTimer = null;

  function startMeter() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { heardSomething = true; return; }
    try {
      micCtx = new Ctx();
      var source = micCtx.createMediaStreamSource(stream);
      micAnalyser = micCtx.createAnalyser();
      micAnalyser.fftSize = 1024;
      source.connect(micAnalyser);
    } catch (e) { micAnalyser = null; heardSomething = true; return; }

    var read = reader(micAnalyser);
    var startedAt = Date.now(), noise = 0, samples = 0, threshold = 0.02;
    var lastLoud = Date.now();

    meterTimer = setInterval(function () {
      if (!recording || !micAnalyser) return;
      var rms = read();
      var elapsed = Date.now() - startedAt;
      level(rms * 5);

      if (elapsed < CALIBRATE_MS) { noise += rms; samples++; return; }
      if (samples) { threshold = Math.max(0.02, (noise / samples) * 3 + 0.008); samples = 0; }

      if (rms > threshold) { heardSomething = true; lastLoud = Date.now(); }
      // The hard cap applies in both modes: a recorder nobody stopped is how you get a
      // 413 and a bill instead of an answer.
      if (elapsed > MAX_RECORD_MS) { stop(); return; }
      if (mode !== 'hold' && !heardSomething && elapsed > NO_SPEECH_MS) { stop(); return; }
      // Cutting on silence only makes sense when there is no finger on the button, and
      // never before MIN_RECORD_MS: a pause for breath after the first word would send
      // half a sentence, which comes back as an answer to a question nobody asked.
      if (mode === 'toggle' && heardSomething && elapsed > MIN_RECORD_MS &&
          Date.now() - lastLoud > SILENCE_MS) stop();
    }, 70);
  }

  function stopMeter() {
    clearInterval(meterTimer); meterTimer = null; micAnalyser = null;
    if (micCtx) { try { micCtx.close(); } catch (e) {} micCtx = null; }
    level(0);
  }

  /** One RMS reader, whichever of the two APIs this browser has. */
  function reader(analyser) {
    var floats = typeof analyser.getFloatTimeDomainData === 'function';
    var buf = floats ? new Float32Array(analyser.fftSize) : new Uint8Array(analyser.fftSize);
    return function () {
      if (floats) analyser.getFloatTimeDomainData(buf);
      else analyser.getByteTimeDomainData(buf);
      var sum = 0;
      for (var i = 0; i < buf.length; i++) {
        var v = floats ? buf[i] : (buf[i] - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / buf.length);
    };
  }

  // ---- recording --------------------------------------------------------
  // MediaRecorder does not emit ogg/wav: it is Opus-in-WebM on Chrome and Firefox and
  // AAC-in-MP4 on Safari. Both are accepted by the endpoint, so nothing is converted
  // here — the browser's own container is sent as-is with its Content-Type.
  function pickMime() {
    var candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < candidates.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  async function start() {
    if (busy || recording || !token) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      setState('error', 'Este navegador no graba audio.');
      return;
    }
    if (!(await ensureStream())) {
      setState('error', 'Sin permiso de micrófono.');
      return;
    }
    var mime = pickMime();
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    chunks = [];
    heardSomething = false;
    recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = function () { send(new Blob(chunks, { type: recorder.mimeType })); };
    recorder.start();
    recording = true;
    recordStartedAt = Date.now();
    startMeter();
    setState('listening', mode === 'hold' ? 'Te escucho…' : 'Te escucho… calla y lo envío');
  }

  /**
   * One microphone stream for the whole session.
   *
   * Held open rather than acquired per turn so that a wake word can start recording in
   * milliseconds instead of after a permission round trip — by then the first word of the
   * request is gone. Echo cancellation is not optional here: with the wake listener on, the
   * assistant's own reply comes back through the speakers and re-triggers it.
   */
  async function ensureStream() {
    if (stream) return true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      return true;
    } catch (e) { return false; }
  }

  function stop() {
    if (!recording) return;
    recording = false;
    lastRecordMs = Date.now() - recordStartedAt;
    stopMeter();
    try { recorder.stop(); } catch (e) {}
  }

  // ---- the turn ---------------------------------------------------------
  async function send(blob) {
    // Nothing above the noise floor means a muted microphone, and sending it anyway is
    // worse than useless: Whisper answers silence with the subtitle credits it was
    // trained on, and the assistant then replies to a sentence nobody said.
    if (!heardSomething || !blob.size) {
      setState('error', 'No he oído nada. ¿Está el micrófono encendido?');
      setTimeout(idle, 2600);
      return;
    }
    localText = '';
    await turn(function () {
      return fetch('/voice', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': blob.type || 'audio/webm' },
        body: blob
      });
    }, blob.size);
  }

  async function sendText() {
    var text = $('say').value.trim();
    if (!text || busy) return;
    $('say').value = '';
    localText = text;
    closePanel();
    await turn(function () {
      return fetch('/voice', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text })
      });
    }, 0);
  }

  async function confirmPending(action) {
    hideConfirm();
    await turn(function () {
      return fetch('/voice/confirm', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: pendingToken, action: action })
      });
    }, 0);
  }

  /** Everything that is the same for a spoken turn, a typed one and a confirmation. */
  async function turn(request, bytes) {
    busy = true;
    $('orb').disabled = true;
    var startedAt = Date.now();
    var ticker = setInterval(function () {
      setState('thinking', 'Pensando… ' + ((Date.now() - startedAt) / 1000).toFixed(1) + ' s');
      // A slow wander while the model works, so the orb never looks stuck.
      level(0.25 + Math.sin(Date.now() / 420) * 0.12);
    }, 90);
    setState('thinking', 'Pensando…');

    try {
      var response = await request();
      clearInterval(ticker);
      await handle(response, Date.now() - startedAt, bytes);
    } catch (e) {
      clearInterval(ticker);
      setState('error', 'No se pudo llegar al servidor.');
      setTimeout(idle, 2600);
    } finally {
      busy = false;
      $('orb').disabled = false;
    }
  }

  async function handle(response, clientMs, bytes) {
    if (response.status === 401) {
      forgetToken();
      setState('error', 'Token rechazado.');
      return;
    }
    if (!response.ok) {
      var problem = await response.json().catch(function () { return {}; });
      setState('error', problem.error || ('Error ' + response.status));
      setTimeout(idle, 3200);
      return;
    }

    var header = function (name) {
      var raw = response.headers.get(name);
      try { return raw ? decodeURIComponent(raw) : ''; } catch (e) { return raw || ''; }
    };

    var heard = response.headers.has('X-Jarvis-Transcript') ? header('X-Jarvis-Transcript') : localText;
    var reply = header('X-Jarvis-Reply');
    var notice = header('X-Jarvis-Notice');
    fill('heard', heard, '(vacío — no se transcribió nada)');
    fill('said', reply, '(sin respuesta)');
    $('noticeBox').classList.toggle('hidden', !notice);
    $('notice').textContent = notice;
    renderTimes(parseTiming(response.headers.get('Server-Timing')), clientMs, bytes);

    pendingToken = response.headers.get('X-Jarvis-Confirm-Token') || '';
    var needsConfirm = response.headers.get('X-Jarvis-Kind') === 'confirm' && pendingToken;

    var type = response.headers.get('Content-Type') || '';
    if (type.indexOf('audio') === 0) {
      await play(await response.blob(), needsConfirm, reply);
    } else {
      // No audio: the reply survives on screen, and the panel opens itself because that
      // is the only place it is legible.
      setState('error', notice || 'Respuesta sin audio. Mira los detalles.');
      openPanel();
      if (needsConfirm) showConfirm(reply);
    }
  }

  function fill(id, text, fallback) {
    var node = $(id);
    node.textContent = text || fallback;
    node.classList.toggle('empty', !text);
  }

  // ---- playback ---------------------------------------------------------
  // The audio is routed through an AnalyserNode so the orb moves with the actual voice
  // instead of a canned animation. It is the same reader the microphone uses, so both
  // ends of a turn are measured the same way.
  function play(blob, needsConfirm, reply) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(blob);
      var audio = new Audio(url);
      var ctx = null, raf = 0;

      function cleanup() {
        cancelAnimationFrame(raf);
        URL.revokeObjectURL(url);
        if (ctx) { try { ctx.close(); } catch (e) {} }
        level(0);
      }
      function done() {
        cleanup();
        if (needsConfirm) showConfirm(reply); else idle();
        resolve();
      }

      audio.onended = done;
      audio.onerror = function () { cleanup(); setState('error', 'El audio no se pudo reproducir.'); setTimeout(idle, 2600); resolve(); };

      setState('speaking', 'Hablando…');
      audio.play().then(function () {
        try {
          var Ctx = window.AudioContext || window.webkitAudioContext;
          ctx = new Ctx();
          var analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          ctx.createMediaElementSource(audio).connect(analyser);
          analyser.connect(ctx.destination);
          var read = reader(analyser);
          var tick = function () { level(read() * 4.5); raf = requestAnimationFrame(tick); };
          tick();
        } catch (e) { /* Without the analyser it still plays; it just does not dance. */ }
      }).catch(function () {
        cleanup();
        setState('error', 'El navegador bloqueó el audio. Toca la pantalla y repite.');
        setTimeout(idle, 3200);
        resolve();
      });
    });
  }

  // ---- confirmation -----------------------------------------------------
  // The one thing that is never decided by voice alone. It is a modal and not a line in
  // a panel on purpose: nothing destructive should be one careless tap away.
  function showConfirm(text) {
    $('confirmText').textContent = text;
    $('confirm').classList.add('open');
    setState('idle', 'Esperando tu confirmación');
  }
  function hideConfirm() { $('confirm').classList.remove('open'); }
  $('yes').onclick = function () { confirmPending('ok'); };
  $('no').onclick = function () { confirmPending('cancel'); };

  // ---- timings ----------------------------------------------------------
  // "stt;dur=1240, agent;dur=2980" -> { stt: 1240, agent: 2980 }
  function parseTiming(raw) {
    var out = {};
    if (!raw) return out;
    raw.split(',').forEach(function (part) {
      var name = part.trim().split(';')[0];
      var value = /dur=([0-9.]+)/.exec(part);
      if (name && value) out[name.trim()] = Math.round(parseFloat(value[1]));
    });
    return out;
  }

  function renderTimes(server, clientMs, bytes) {
    var rows = [
      ['transcripción', server.stt],
      ['agente', server.agent],
      ['síntesis de voz', server.tts],
      ['servidor', server.total],
      // Everything the server did not spend: upload, download and the handshakes.
      // Derived and not reported, because it is the only tramo the Worker cannot see.
      ['red', server.total !== undefined ? clientMs - server.total : undefined],
      ['total', clientMs]
    ];
    var html = '';
    rows.forEach(function (row) {
      if (row[1] === undefined || isNaN(row[1])) return;
      html += '<tr><td>' + row[0] + '</td><td' + (row[1] > 4000 ? ' class="slow"' : '') + '>' + row[1] + ' ms</td></tr>';
    });
    if (bytes) {
      // Duration and size together, because separately neither says much: 7 s in 2 KB is
      // a microphone that captured silence.
      html += '<tr><td>audio</td><td>' + (lastRecordMs / 1000).toFixed(1) + ' s · ' +
              Math.round(bytes / 1024) + ' KB</td></tr>';
    }
    $('times').innerHTML = html;
    $('timesBox').classList.toggle('hidden', !html);
  }

  // ---- wake word --------------------------------------------------------
  // Chrome's SpeechRecognition is used ONLY to spot the phrase. What you then say is
  // recorded and transcribed by our own pipeline, exactly like a tapped turn: the two are
  // the same code path from here on, so a bug can only ever be in one of them.
  var WAKE_KEY = 'jarvis.voice.wake';
  var WAKE_COOLDOWN_MS = 900;
  var WAKE_MAX_TURNS = 40;
  // The name comes back mangled in a dozen ways and none of them are worth losing a turn
  // over. The leading word is what keeps the false positives down: "jarvis" on its own
  // comes up in conversation, "oye jarvis" does not.
  var WAKE_RE = /\\b(oye|hola|hey|eh|ok|okay)\\s+(jarvis|yarvis|jarvi|jarbis|jervis|harvis|garvis|charvis|travis|arvis)\\b/;
  var recognition = null, wakeOn = false, wakeTurns = 0, wakeTimer = null;

  function wakeSupported() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }

  function normalise(text) {
    return text.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase();
  }

  function buildRecognition() {
    var Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    var r = new Rec();
    r.lang = 'es-ES';
    r.continuous = true;
    // Interim results are the point: waiting for a final one adds a second to every wake.
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onresult = function (e) {
      if (busy || recording) return;
      for (var i = e.resultIndex; i < e.results.length; i++) {
        if (WAKE_RE.test(normalise(e.results[i][0].transcript))) { woken(); return; }
      }
    };

    r.onerror = function (e) {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (e.error === 'network') {
        // Brave, Vivaldi and plain Chromium have the object but not Google's key. The
        // failure is at runtime, not at feature detection, so it has to be said out loud.
        setWake(false);
        setState('error', 'Este navegador no tiene reconocimiento de voz. Usa Chrome.');
        return;
      }
      setWake(false);
      setState('error', 'La escucha se ha caído (' + e.error + ').');
    };

    r.onend = function () {
      // Chrome ends recognition on its own after about a minute of silence. Without this
      // the wake word just quietly stops working and nothing on screen says so.
      if (!wakeOn) return;
      clearTimeout(wakeTimer);
      wakeTimer = setTimeout(arm, 250);
    };

    return r;
  }

  function arm() {
    if (!wakeOn || busy || recording || !recognition) return;
    try { recognition.start(); } catch (e) { /* already running */ }
  }

  function woken() {
    if (busy || recording) return;
    wakeTurns++;
    if (wakeTurns > WAKE_MAX_TURNS) {
      setWake(false);
      setState('error', 'Tope de turnos de esta sesión. Vuelve a activar la escucha.');
      return;
    }
    // abort() and not stop(): stop() waits for a final result, and by then the first word
    // of the actual request is already gone.
    try { recognition.abort(); } catch (e) {}
    start();
  }

  async function setWake(on) {
    if (on && !wakeSupported()) {
      setState('error', 'Este navegador no tiene reconocimiento de voz. Usa Chrome.');
      return;
    }
    if (on && !(await ensureStream())) {
      setState('error', 'Sin permiso de micrófono.');
      return;
    }

    wakeOn = on;
    wakeTurns = 0;
    try { localStorage.setItem(WAKE_KEY, on ? '1' : '0'); } catch (e) {}
    $('wake').classList.toggle('on', on);
    $('wakeToggle').classList.toggle('on', on);
    $('wakeToggle').textContent = on ? 'Activada' : 'Desactivada';

    clearTimeout(wakeTimer);
    if (on) {
      if (!recognition) recognition = buildRecognition();
      arm();
    } else if (recognition) {
      try { recognition.abort(); } catch (e) {}
    }
    if (!busy && !recording) idle();
  }

  $('wakeToggle').onclick = function () { setWake(!wakeOn); };
  $('wake').onclick = function () { setWake(false); };
  if (!wakeSupported()) {
    $('wakeToggle').disabled = true;
    $('wakeHint').textContent = 'Este navegador no tiene reconocimiento de voz. Hace falta Chrome.';
  }

  // ---- input ------------------------------------------------------------
  // Pointer events cover mouse, touch and pen at once. In hold mode pointerleave matters:
  // dragging off the orb while holding must stop the recorder, or it runs to the cap.
  var orb = $('orb');
  function press() { if (mode === 'hold') start(); else if (recording) stop(); else start(); }
  function release() { if (mode === 'hold') stop(); }

  orb.addEventListener('pointerdown', function (e) { e.preventDefault(); press(); });
  orb.addEventListener('pointerup', function (e) { e.preventDefault(); release(); });
  orb.addEventListener('pointerleave', release);
  orb.addEventListener('pointercancel', release);
  orb.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  document.addEventListener('keydown', function (e) {
    if (e.code !== 'Space' || e.repeat) return;
    if (document.activeElement === $('say') || document.activeElement === $('token')) return;
    e.preventDefault();
    press();
  });
  document.addEventListener('keyup', function (e) {
    if (e.code === 'Space' && document.activeElement !== $('say')) { e.preventDefault(); release(); }
  });

  $('send').onclick = sendText;
  $('say').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); sendText(); }
    e.stopPropagation();
  });

  idle();

  // Resume the listener when it was left on. It is the user's own saved choice and the
  // red pill says so from the first frame — but the browser can refuse to start a
  // recogniser with no gesture behind it, so a failure here is silent and reversible.
  try {
    if (localStorage.getItem(WAKE_KEY) === '1' && token && wakeSupported()) setWake(true);
  } catch (e) {}
})();
</script>
</body>
</html>`;
