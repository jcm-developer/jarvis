/**
 * The test client, served as one inline string.
 *
 * No build step, no framework, no dependency: a page that needs `npm run build` to answer
 * "where do the seconds go" is a page that will be out of date the first time it matters.
 *
 * Two ways in, and the default is the comfortable one: press once and talk, and the
 * recorder cuts itself after about a second and a half of silence. Hold-to-talk is still
 * there for a noisy room, where that detector is the thing getting in the way.
 *
 * It is an instrument and not a demo. Everything on screen is a reading — the transcript
 * so a bad answer can be blamed on the STT instead of the model, the reply text so a
 * failed synthesis still leaves something to read, and the per-stage times because that is
 * the deliverable of this phase. `red` is the interesting one and it is derived, not
 * reported: the client's total minus the server's total is everything that happened on the
 * wire, which is precisely the number a hosted STT/TTS is being judged on.
 *
 * The token is never in here. It is typed once by a person and kept in that browser's
 * localStorage, so this file can be served to anyone: without a token, /voice answers 401.
 */
export const VOICE_TEST_PAGE = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Jarvis — voz</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    margin: 0; min-height: 100vh; padding: 24px 16px 40px;
    background: #0f1115; color: #e6e8ec;
    font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    display: flex; flex-direction: column; align-items: center; gap: 20px;
  }
  h1 { font-size: 15px; font-weight: 600; margin: 0; color: #8b93a7; letter-spacing: .04em; }
  .wrap { width: 100%; max-width: 560px; display: flex; flex-direction: column; gap: 16px; }
  #talk {
    width: 100%; padding: 34px 16px; border-radius: 14px; border: 1px solid #2a2f3a;
    background: #171b23; color: #e6e8ec; font: inherit; font-size: 17px; font-weight: 600;
    cursor: pointer; touch-action: none; user-select: none; transition: background .12s, border-color .12s;
  }
  #talk:disabled { opacity: .4; cursor: not-allowed; }
  #talk.rec { background: #3a1620; border-color: #7d2437; }
  #status { display: flex; align-items: center; gap: 10px; font-size: 14px; color: #8b93a7; min-height: 22px; }
  #dot { width: 9px; height: 9px; border-radius: 50%; background: #4b5263; flex: none; }
  #dot.rec { background: #e0415f; animation: pulse 1s infinite; }
  #dot.busy { background: #d99b28; animation: pulse 1s infinite; }
  #dot.play { background: #3ba55d; }
  #dot.err { background: #e0415f; }
  @keyframes pulse { 50% { opacity: .25; } }
  .card { border: 1px solid #232833; border-radius: 12px; padding: 12px 14px; background: #12151c; }
  .card h2 { margin: 0 0 6px; font-size: 11px; font-weight: 600; text-transform: uppercase;
             letter-spacing: .09em; color: #6b7386; }
  .card p { margin: 0; white-space: pre-wrap; word-break: break-word; }
  .muted { color: #6b7386; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  td { padding: 3px 0; }
  td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
  td.slow { color: #e8a33d; }
  .row { display: flex; gap: 10px; }
  .row button {
    flex: 1; padding: 12px; border-radius: 10px; border: 1px solid #2a2f3a;
    background: #171b23; color: #e6e8ec; font: inherit; cursor: pointer;
  }
  .row button.yes { border-color: #2f6b45; }
  .row button.no  { border-color: #6b2f3a; }
  input {
    width: 100%; padding: 11px 12px; border-radius: 10px; border: 1px solid #2a2f3a;
    background: #0b0d12; color: #e6e8ec; font: inherit;
  }
  .log { display: flex; flex-direction: column; gap: 10px; max-height: 46vh; overflow-y: auto; }
  .turn { display: flex; flex-direction: column; gap: 2px; }
  .turn b { font-size: 10px; font-weight: 600; letter-spacing: .09em; text-transform: uppercase; }
  .turn.me b { color: #5b8dd9; }
  .turn.bot b { color: #4a9d6b; }
  .turn.me span, .turn.bot span { white-space: pre-wrap; word-break: break-word; }
  .turn.empty span { color: #e8a33d; font-style: italic; }
  .composer { display: flex; gap: 8px; }
  .composer input { flex: 1; }
  .composer button { padding: 11px 16px; border-radius: 10px; border: 1px solid #2a2f3a;
                     background: #171b23; color: #e6e8ec; font: inherit; cursor: pointer; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .head button { border: 0; background: none; color: #4b5263; font: inherit; font-size: 11px;
                 cursor: pointer; padding: 0; }
  .modes { display: flex; gap: 8px; }
  .modes button {
    flex: 1; padding: 9px; border-radius: 9px; border: 1px solid #232833;
    background: #12151c; color: #6b7386; font: inherit; font-size: 13px; cursor: pointer;
  }
  .modes button.on { border-color: #3d4657; color: #e6e8ec; background: #171b23; }
  #level { height: 4px; border-radius: 2px; background: #1a1e26; overflow: hidden; }
  #levelFill { height: 100%; width: 0; background: #3ba55d; transition: width .08s linear; }
  .hidden { display: none; }
  footer { font-size: 12px; color: #4b5263; text-align: center; }
  footer a { color: #6b7386; }
</style>
</head>
<body>
<div class="wrap">
  <h1>JARVIS · CANAL DE VOZ</h1>

  <div id="setup" class="card hidden">
    <h2>Token</h2>
    <p class="muted" style="margin-bottom:8px">Se guarda solo en este navegador. No viaja en la URL.</p>
    <input id="token" type="password" autocomplete="off" placeholder="VOICE_API_TOKEN">
    <div class="row" style="margin-top:10px"><button id="save">Guardar</button></div>
  </div>

  <div id="app" class="hidden">
    <div class="modes">
      <button id="modeToggle">Pulsar y hablar</button>
      <button id="modeHold">Mantener pulsado</button>
    </div>
    <button id="talk">Pulsa para hablar</button>
    <div id="level"><div id="levelFill"></div></div>
    <div id="status"><span id="dot"></span><span id="statusText">Listo.</span></div>

    <div id="confirm" class="card hidden">
      <h2>Necesita confirmación</h2>
      <p id="confirmText"></p>
      <div class="row" style="margin-top:10px">
        <button class="yes" id="yes">Confirmar</button>
        <button class="no" id="no">Cancelar</button>
      </div>
    </div>

    <div class="composer">
      <input id="say" type="text" autocomplete="off" placeholder="…o escríbelo aquí y pulsa Enter">
      <button id="send">Enviar</button>
    </div>

    <div id="logCard" class="card hidden">
      <div class="head"><h2>Conversación</h2><button id="clearLog">limpiar vista</button></div>
      <div id="log" class="log"></div>
    </div>

    <div id="noticeCard" class="card hidden"><h2>Aviso</h2><p id="notice" class="muted"></p></div>
    <div id="timesCard" class="card hidden"><h2>Tiempos</h2><table id="times"></table></div>
  </div>

  <footer>La barra espaciadora hace lo mismo que el botón.<br>Los tiempos también quedan en <code>wrangler tail</code>.</footer>
</div>
<script>
(function () {
  'use strict';
  var KEY = 'jarvis.voice.token';
  var $ = function (id) { return document.getElementById(id); };
  var token = '';
  var recorder = null, chunks = [], stream = null, recording = false, busy = false;
  var recordStartedAt = 0, lastRecordMs = 0;

  // ---- token ------------------------------------------------------------
  try { token = localStorage.getItem(KEY) || ''; } catch (e) { token = ''; }
  showToken(!token);
  $('save').onclick = function () {
    var value = $('token').value.trim();
    if (!value) return;
    token = value;
    try { localStorage.setItem(KEY, value); } catch (e) {}
    $('token').value = '';
    showToken(false);
  };
  function showToken(needed) {
    $('setup').classList.toggle('hidden', !needed);
    $('app').classList.toggle('hidden', needed);
  }
  function forgetToken() {
    token = '';
    try { localStorage.removeItem(KEY); } catch (e) {}
    showToken(true);
  }

  // ---- conversation log -------------------------------------------------
  // The transcript of every turn, kept on screen. It is the answer to the question this
  // page exists for: when the assistant says it has nothing to note down, the only way to
  // tell a bad recording from a bad answer is to read what it actually heard.
  //
  // It survives a reload because the interesting case —"it has been doing this all
  // afternoon"— is exactly the one you lose by refreshing. It is a VIEW: clearing it
  // clears the screen and not the conversation, which lives in Supabase and is shared with
  // Telegram. /reset over Telegram is what forgets it for real.
  var LOG_KEY = 'jarvis.voice.log';
  var LOG_MAX = 40;
  var log = [];
  try { log = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch (e) { log = []; }
  if (!Array.isArray(log)) log = [];
  renderLog();

  $('clearLog').onclick = function () {
    log = [];
    try { localStorage.removeItem(LOG_KEY); } catch (e) {}
    renderLog();
  };

  function pushTurn(who, text) {
    log.push({ who: who, text: text || '', at: Date.now() });
    if (log.length > LOG_MAX) log = log.slice(-LOG_MAX);
    try { localStorage.setItem(LOG_KEY, JSON.stringify(log)); } catch (e) {}
    renderLog();
  }

  // Built with createElement and textContent, never innerHTML: half of what goes in here
  // is written by a model and the other half by whatever the STT thought it heard.
  function renderLog() {
    var box = $('log');
    box.textContent = '';
    log.forEach(function (turn) {
      var empty = !turn.text;
      var row = document.createElement('div');
      row.className = 'turn ' + (turn.who === 'me' ? 'me' : 'bot') + (empty ? ' empty' : '');
      var who = document.createElement('b');
      var when = new Date(turn.at);
      who.textContent = (turn.who === 'me' ? 'Tú' : 'Jarvis') + ' · ' +
        String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0');
      var body = document.createElement('span');
      body.textContent = empty ? '(vacío — no se transcribió nada)' : turn.text;
      row.appendChild(who);
      row.appendChild(body);
      box.appendChild(row);
    });
    $('logCard').classList.toggle('hidden', log.length === 0);
    box.scrollTop = box.scrollHeight;
  }

  // ---- status -----------------------------------------------------------
  var ticker = null;
  function status(text, kind) {
    $('statusText').textContent = text;
    $('dot').className = kind || '';
  }
  function busyFrom(startedAt) {
    clearInterval(ticker);
    ticker = setInterval(function () {
      status('Pensando… ' + ((Date.now() - startedAt) / 1000).toFixed(1) + ' s', 'busy');
    }, 100);
  }
  function stopTicker() { clearInterval(ticker); ticker = null; }

  function show(id, cardId, text) {
    $(id).textContent = text || '';
    $(cardId).classList.toggle('hidden', !text);
  }

  // ---- modes ------------------------------------------------------------
  // Two ways in, because holding a button is fine at a desk and miserable anywhere else.
  // 'toggle' is the default and it does not even need the second press: the recorder cuts
  // itself when you stop talking. 'hold' stays for a noisy room, where that detector is
  // precisely the thing getting in the way.
  var MODE_KEY = 'jarvis.voice.mode';
  var mode = 'toggle';
  try { mode = localStorage.getItem(MODE_KEY) || 'toggle'; } catch (e) {}
  setMode(mode);
  $('modeToggle').onclick = function () { setMode('toggle'); };
  $('modeHold').onclick = function () { setMode('hold'); };
  function setMode(next) {
    mode = next === 'hold' ? 'hold' : 'toggle';
    try { localStorage.setItem(MODE_KEY, mode); } catch (e) {}
    $('modeToggle').classList.toggle('on', mode === 'toggle');
    $('modeHold').classList.toggle('on', mode === 'hold');
    label();
  }
  function label() {
    $('talk').textContent = recording
      ? (mode === 'hold' ? 'Suelta para enviar' : 'Pulsa para parar')
      : (mode === 'hold' ? 'Mantén pulsado para hablar' : 'Pulsa para hablar');
  }

  // ---- level and silence ------------------------------------------------
  // An RMS over the raw samples, with the room's own noise measured during the first
  // quarter second instead of a fixed threshold: a fixed one works on the desk it was
  // tuned on and nowhere else. The bar is not decoration either — "is it hearing me" is
  // the first question when nothing comes back, and this answers it without a round trip.
  var SILENCE_MS = 1400;
  var CALIBRATE_MS = 250;
  // Nothing is cut before this. Without it, a pause for breath right after the first word
  // sends half a sentence, which comes back as an answer to a question nobody asked.
  var MIN_RECORD_MS = 900;
  var MAX_RECORD_MS = 30000;
  var audioCtx = null, analyser = null, meterTimer = null;

  function startMeter() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try {
      audioCtx = new Ctx();
      var source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
    } catch (e) { analyser = null; return; }

    var floats = typeof analyser.getFloatTimeDomainData === 'function';
    var buf = floats ? new Float32Array(analyser.fftSize) : new Uint8Array(analyser.fftSize);
    var startedAt = Date.now(), noise = 0, samples = 0, threshold = 0.02;
    var spoke = false, lastLoud = Date.now();

    meterTimer = setInterval(function () {
      if (!recording || !analyser) return;
      if (floats) analyser.getFloatTimeDomainData(buf);
      else analyser.getByteTimeDomainData(buf);

      var sum = 0;
      for (var i = 0; i < buf.length; i++) {
        var v = floats ? buf[i] : (buf[i] - 128) / 128;
        sum += v * v;
      }
      var rms = Math.sqrt(sum / buf.length);
      var elapsed = Date.now() - startedAt;
      $('levelFill').style.width = Math.min(100, Math.round(rms * 600)) + '%';

      if (elapsed < CALIBRATE_MS) { noise += rms; samples++; return; }
      if (samples) { threshold = Math.max(0.02, (noise / samples) * 3 + 0.008); samples = 0; }

      if (rms > threshold) { spoke = true; lastLoud = Date.now(); }
      // The hard cap applies in both modes: a recorder nobody stopped is how you get a
      // 413 and a bill instead of an answer.
      if (elapsed > MAX_RECORD_MS) { stop(); return; }
      // Cutting on silence only makes sense when there is no finger on the button.
      if (mode === 'toggle' && spoke && elapsed > MIN_RECORD_MS && Date.now() - lastLoud > SILENCE_MS) stop();
    }, 80);
  }

  function stopMeter() {
    clearInterval(meterTimer);
    meterTimer = null;
    analyser = null;
    $('levelFill').style.width = '0%';
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
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
      status('Este navegador no graba audio.', 'err');
      return;
    }
    try {
      if (!stream) stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      status('Sin permiso de micrófono.', 'err');
      return;
    }
    var mime = pickMime();
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    chunks = [];
    recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = function () { send(new Blob(chunks, { type: recorder.mimeType })); };
    recorder.start();
    recording = true;
    recordStartedAt = Date.now();
    $('talk').classList.add('rec');
    label();
    startMeter();
    status(mode === 'toggle' ? 'Grabando… se corta sola al callar.' : 'Grabando…', 'rec');
  }

  function stop() {
    if (!recording) return;
    recording = false;
    lastRecordMs = Date.now() - recordStartedAt;
    $('talk').classList.remove('rec');
    stopMeter();
    label();
    try { recorder.stop(); } catch (e) {}
  }

  // ---- the turn ---------------------------------------------------------
  async function send(blob) {
    if (!blob.size) { status('No se grabó nada.', 'err'); return; }
    localText = '';
    busy = true;
    $('talk').disabled = true;
    $('confirm').classList.add('hidden');
    var startedAt = Date.now();
    busyFrom(startedAt);
    try {
      var response = await fetch('/voice', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': blob.type || 'audio/webm' },
        body: blob
      });
      await handle(response, Date.now() - startedAt, blob.size);
    } catch (e) {
      stopTicker();
      status('No se pudo llegar al servidor.', 'err');
    } finally {
      busy = false;
      $('talk').disabled = false;
    }
  }

  async function confirm(action) {
    busy = true;
    $('confirm').classList.add('hidden');
    var startedAt = Date.now();
    busyFrom(startedAt);
    try {
      var response = await fetch('/voice/confirm', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: pendingToken, action: action })
      });
      await handle(response, Date.now() - startedAt, 0);
    } catch (e) {
      stopTicker();
      status('No se pudo llegar al servidor.', 'err');
    } finally { busy = false; }
  }

  var pendingToken = '';
  // What we know we sent. On a spoken turn it stays empty —only the STT knows— and on a
  // typed one it is what rescues the log when the request never comes back.
  var localText = '';

  // A typed turn takes the microphone out of the loop. Same endpoint, same history, same
  // agent: the only thing that changes is that there is no STT to blame.
  async function sendText() {
    var text = $('say').value.trim();
    if (!text || busy) return;
    $('say').value = '';
    localText = text;
    busy = true;
    $('talk').disabled = true;
    $('confirm').classList.add('hidden');
    var startedAt = Date.now();
    busyFrom(startedAt);
    try {
      var response = await fetch('/voice', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text })
      });
      await handle(response, Date.now() - startedAt, 0);
    } catch (e) {
      stopTicker();
      pushTurn('me', text);
      status('No se pudo llegar al servidor.', 'err');
    } finally {
      busy = false;
      $('talk').disabled = false;
    }
  }

  $('send').onclick = sendText;
  $('say').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); sendText(); }
    // Otherwise the space bar inside the box would start recording.
    e.stopPropagation();
  });

  async function handle(response, clientMs, bytes) {
    stopTicker();
    if (response.status === 401) { forgetToken(); status('Token rechazado.', 'err'); return; }
    if (!response.ok) {
      var problem = await response.json().catch(function () { return { error: 'Error ' + response.status }; });
      status(problem.error || ('Error ' + response.status), 'err');
      return;
    }

    var header = function (name) {
      var raw = response.headers.get(name);
      try { return raw ? decodeURIComponent(raw) : ''; } catch (e) { return raw || ''; }
    };
    // The user's turn goes in even when it is empty: a blank line labelled as such is the
    // whole diagnosis when the answer is "no tengo nada que apuntar".
    pushTurn('me', response.headers.has('X-Jarvis-Transcript') ? header('X-Jarvis-Transcript') : localText);
    pushTurn('bot', header('X-Jarvis-Reply'));
    show('notice', 'noticeCard', header('X-Jarvis-Notice'));

    var server = parseTiming(response.headers.get('Server-Timing'));
    renderTimes(server, clientMs, bytes);

    pendingToken = response.headers.get('X-Jarvis-Confirm-Token') || '';
    if (response.headers.get('X-Jarvis-Kind') === 'confirm' && pendingToken) {
      $('confirmText').textContent = header('X-Jarvis-Reply');
      $('confirm').classList.remove('hidden');
    }

    var type = response.headers.get('Content-Type') || '';
    if (type.indexOf('audio') === 0) {
      var url = URL.createObjectURL(await response.blob());
      var audio = new Audio(url);
      audio.onended = function () { URL.revokeObjectURL(url); status('Listo.', ''); };
      audio.onerror = function () { URL.revokeObjectURL(url); status('El audio no se pudo reproducir.', 'err'); };
      status('Hablando…', 'play');
      audio.play().catch(function () { status('Pulsa para reproducir (el navegador bloqueó el audio).', 'err'); });
    } else {
      status('Respuesta sin audio.', 'err');
    }
  }

  // "stt;dur=1240, agent;dur=2980" -> { stt: 1240, agent: 2980 }
  function parseTiming(raw) {
    var out = {};
    if (!raw) return out;
    raw.split(',').forEach(function (part) {
      var bits = part.trim().split(';');
      var value = /dur=([0-9.]+)/.exec(part);
      if (bits[0] && value) out[bits[0].trim()] = Math.round(parseFloat(value[1]));
    });
    return out;
  }

  function renderTimes(server, clientMs, bytes) {
    var rows = [
      ['transcripción', server.stt],
      ['agente (modelo + tools)', server.agent],
      ['síntesis de voz', server.tts],
      ['servidor, total', server.total],
      // Everything the server did not spend: upload, download and the two TLS handshakes.
      // Derived and not reported, because it is the only tramo the Worker cannot see.
      ['red (ida y vuelta)', server.total !== undefined ? clientMs - server.total : undefined],
      ['cliente, total', clientMs]
    ];
    var html = '';
    rows.forEach(function (row) {
      if (row[1] === undefined || isNaN(row[1])) return;
      var slow = row[1] > 4000 ? ' class="slow"' : '';
      html += '<tr><td>' + row[0] + '</td><td' + slow + '>' + row[1] + ' ms</td></tr>';
    });
    if (bytes) {
      // Duration and size together, because separately neither says much: 8 s in 3 KB is a
      // microphone that captured silence, and 0.4 s is the auto-stop cutting too early.
      html += '<tr><td>audio grabado</td><td>' + (lastRecordMs / 1000).toFixed(1) + ' s · ' +
              Math.round(bytes / 1024) + ' KB</td></tr>';
    }
    $('times').innerHTML = html;
    $('timesCard').classList.toggle('hidden', !html);
  }

  // ---- push to talk -----------------------------------------------------
  // Pointer events cover mouse, touch and pen at once. pointerleave matters: dragging
  // off the button while holding must stop the recorder, or it runs until the tab closes.
  // Pointer events cover mouse, touch and pen at once. In hold mode pointerleave matters:
  // dragging off the button while holding must stop the recorder, or it runs to the cap.
  var talk = $('talk');
  function press() { if (mode === 'hold') start(); else if (recording) stop(); else start(); }
  function release() { if (mode === 'hold') stop(); }

  talk.addEventListener('pointerdown', function (e) { e.preventDefault(); press(); });
  talk.addEventListener('pointerup', function (e) { e.preventDefault(); release(); });
  talk.addEventListener('pointerleave', release);
  talk.addEventListener('pointercancel', release);
  talk.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  // Space bar does whatever the button does, for testing with both hands free.
  document.addEventListener('keydown', function (e) {
    if (e.code !== 'Space' || e.repeat || document.activeElement === $('token')) return;
    e.preventDefault();
    press();
  });
  document.addEventListener('keyup', function (e) {
    if (e.code === 'Space') { e.preventDefault(); release(); }
  });

  $('yes').onclick = function () { confirm('ok'); };
  $('no').onclick = function () { confirm('cancel'); };
})();
</script>
</body>
</html>`;
