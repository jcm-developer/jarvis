/**
 * The test client, served as one inline string.
 *
 * No build step, no framework, no dependency: a page that needs `npm run build` to answer
 * "where do the seconds go" is a page that will be out of date the first time it matters.
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
    <button id="talk">Mantén pulsado para hablar</button>
    <div id="status"><span id="dot"></span><span id="statusText">Listo.</span></div>

    <div id="confirm" class="card hidden">
      <h2>Necesita confirmación</h2>
      <p id="confirmText"></p>
      <div class="row" style="margin-top:10px">
        <button class="yes" id="yes">Confirmar</button>
        <button class="no" id="no">Cancelar</button>
      </div>
    </div>

    <div id="heardCard" class="card hidden"><h2>Te he oído</h2><p id="heard"></p></div>
    <div id="saidCard" class="card hidden"><h2>Respuesta</h2><p id="said"></p></div>
    <div id="noticeCard" class="card hidden"><h2>Aviso</h2><p id="notice" class="muted"></p></div>
    <div id="timesCard" class="card hidden"><h2>Tiempos</h2><table id="times"></table></div>
  </div>

  <footer>Mantén pulsado, habla, suelta.<br>Los tiempos también quedan en <code>wrangler tail</code>.</footer>
</div>
<script>
(function () {
  'use strict';
  var KEY = 'jarvis.voice.token';
  var $ = function (id) { return document.getElementById(id); };
  var token = '';
  var recorder = null, chunks = [], stream = null, recording = false, busy = false;

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
    $('talk').classList.add('rec');
    status('Grabando…', 'rec');
  }

  function stop() {
    if (!recording) return;
    recording = false;
    $('talk').classList.remove('rec');
    try { recorder.stop(); } catch (e) {}
  }

  // ---- the turn ---------------------------------------------------------
  async function send(blob) {
    if (!blob.size) { status('No se grabó nada.', 'err'); return; }
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
    show('heard', 'heardCard', header('X-Jarvis-Transcript'));
    show('said', 'saidCard', header('X-Jarvis-Reply'));
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
    if (bytes) html += '<tr><td>audio enviado</td><td>' + Math.round(bytes / 1024) + ' KB</td></tr>';
    $('times').innerHTML = html;
    $('timesCard').classList.toggle('hidden', !html);
  }

  // ---- push to talk -----------------------------------------------------
  // Pointer events cover mouse, touch and pen at once. pointerleave matters: dragging
  // off the button while holding must stop the recorder, or it runs until the tab closes.
  var talk = $('talk');
  talk.addEventListener('pointerdown', function (e) { e.preventDefault(); start(); });
  talk.addEventListener('pointerup', function (e) { e.preventDefault(); stop(); });
  talk.addEventListener('pointerleave', stop);
  talk.addEventListener('pointercancel', stop);
  talk.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  // Space bar, for testing with both hands free.
  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space' && !e.repeat && document.activeElement !== $('token')) { e.preventDefault(); start(); }
  });
  document.addEventListener('keyup', function (e) {
    if (e.code === 'Space') { e.preventDefault(); stop(); }
  });

  $('yes').onclick = function () { confirm('ok'); };
  $('no').onclick = function () { confirm('cancel'); };
})();
</script>
</body>
</html>`;
