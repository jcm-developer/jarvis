/**
 * The voice client, served as one inline string.
 *
 * No build step, no framework, no CDN: the page is a `<style>` and a `<script>` inside a
 * template literal. A page whose only job is to talk to this Worker should not stop
 * looking like itself because someone else's host is down.
 *
 * ---------------------------------------------------------------------------
 * The orb is a port, not an import, and the distinction is worth writing down.
 *
 * The look comes from Jakub Antalik's `thinking-orbs` (MIT, orbs.jakubantalik.com):
 * dotted spheres drawn with plain 2D canvas arcs — no ctx.filter, no SVG filters, no
 * WebGL — so the pixels come out the same in every browser. That constraint is the good
 * idea and it is copied here deliberately.
 *
 * It is not installed because it is a React component, and this page has neither React
 * nor a bundler: pulling both in to render one canvas would cost more than the canvas.
 * So the technique is reimplemented in about fifty lines of vanilla JS.
 *
 * What the reimplementation buys is the thing an import could not give: the states are
 * fed by real numbers. The points bristle outwards with the microphone's RMS while you
 * talk and run in latitude waves with the amplitude of the reply while it talks back, so
 * a dead microphone is a sphere that sits perfectly still — which is exactly the failure
 * that cost an afternoon.
 * ---------------------------------------------------------------------------
 *
 * The screen is that orb and nothing else. Transcript, reply, per-stage times, the mode
 * switch and the text box all still exist, one tap away behind the dots.
 *
 * The wake word is the one thing here that talks to somebody else. Chrome's speech
 * recognition runs on Google's servers, so while that switch is on, everything the
 * microphone hears leaves the machine. It is off by default and says so on screen the
 * whole time it is on, which is why the pill is red rather than tasteful.
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
    --bg: #08090b;
    --fg: #e9eaed;
    --dim: #6b7280;
    --line: rgba(255,255,255,.07);
    /* The sphere is monochrome, like the reference. Colour only ever appears as a breath
       of it in the bloom behind, which is what keeps the dots reading as dots. */
    --accent: #8f9bb3;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { height: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    overflow: hidden;
  }

  /* ---------- the room ---------- */
  /* One aura behind the sphere, colour-shifted by state. It uses background-color under a
     radial mask instead of a gradient, and that is not a detail: background-color
     interpolates on a transition and a gradient does not, so the room cross-fades rather
     than snapping. */
  #aura {
    position: fixed; top: 50%; left: 50%; width: 760px; height: 760px;
    margin: -380px 0 0 -380px; border-radius: 50%;
    background-color: var(--accent); opacity: .10; filter: blur(90px);
    -webkit-mask: radial-gradient(circle, #000 0%, transparent 68%);
            mask: radial-gradient(circle, #000 0%, transparent 68%);
    pointer-events: none; z-index: 0;
    transform: scale(calc(1 + var(--l, 0) * .22));
    transition: background-color 1.4s ease, opacity 1.4s ease, transform .18s ease-out;
    animation: sway 30s ease-in-out infinite alternate;
  }
  @keyframes sway { to { transform: translate3d(3%, -4%, 0) scale(1.1); } }

  #motes { position: fixed; inset: 0; pointer-events: none; overflow: hidden; z-index: 1; }
  .mote {
    position: absolute; width: 2px; height: 2px; border-radius: 50%;
    background: #fff; opacity: 0; animation: rise linear infinite;
  }
  @keyframes rise {
    0%   { transform: translate3d(0, 30px, 0); opacity: 0; }
    14%  { opacity: .26; }
    84%  { opacity: .14; }
    100% { transform: translate3d(16px, -102vh, 0); opacity: 0; }
  }

  /* Film grain, painted into a canvas at load so the page still ships zero assets. */
  #grain {
    position: fixed; inset: -60px; pointer-events: none; z-index: 3;
    opacity: .04; animation: grain 7s steps(5) infinite;
  }
  @keyframes grain {
    0%   { transform: translate3d(0, 0, 0); }
    20%  { transform: translate3d(-9px, 5px, 0); }
    40%  { transform: translate3d(7px, -7px, 0); }
    60%  { transform: translate3d(-5px, -9px, 0); }
    80%  { transform: translate3d(9px, 7px, 0); }
  }

  /* ---------- the orb ---------- */
  #stage { position: relative; width: 320px; height: 320px; display: grid; place-items: center; z-index: 2; }

  #bloom {
    position: absolute; width: 340px; height: 340px; border-radius: 50%;
    background: radial-gradient(circle, var(--accent) 0%, transparent 62%);
    opacity: .2; filter: blur(46px);
    transform: scale(calc(1 + var(--l, 0) * .3));
    transition: transform .14s ease-out, opacity .8s ease, background .9s ease;
  }

  #orb {
    position: relative; width: 320px; height: 320px;
    border: 0; padding: 0; background: none; cursor: pointer;
    touch-action: none; -webkit-user-select: none; user-select: none;
    transition: transform .2s cubic-bezier(.22,1,.36,1);
  }
  #orb:disabled { cursor: not-allowed; }
  #orb:focus-visible { outline: 1px solid rgba(255,255,255,.25); outline-offset: 4px; border-radius: 50%; }
  #orb.pop { animation: pop .6s cubic-bezier(.22,1,.36,1); }
  @keyframes pop { 35% { transform: scale(1.08); } }
  #sphere { display: block; width: 100%; height: 100%; }

  .ripple {
    position: absolute; left: 50%; top: 50%; width: 210px; height: 210px;
    margin: -105px 0 0 -105px; border-radius: 50%;
    border: 1px solid rgba(255,255,255,.2); pointer-events: none;
    animation: ripple 1.7s cubic-bezier(.16,1,.3,1) forwards;
  }
  @keyframes ripple {
    from { transform: scale(.9); opacity: .45; }
    to   { transform: scale(2); opacity: 0; }
  }

  /* ---------- states ---------- */
  /* Colour is a whisper here. The states are told apart by how the points behave, the way
     the reference does it, not by repainting the sphere. */
  body[data-state="listening"] { --accent: #7dd3fc; }
  body[data-state="thinking"]  { --accent: #c4b5fd; }
  body[data-state="speaking"]  { --accent: #86efac; }
  body[data-state="error"]     { --accent: #fda4af; }
  body[data-state="thinking"] #bloom { opacity: .28; }
  body[data-state="error"] #orb { animation: shake .45s ease; }
  @keyframes shake { 25% { transform: translateX(-7px); } 75% { transform: translateX(7px); } }

  /* ---------- chrome ---------- */
  #status {
    margin-top: 2px; min-height: 22px; font-size: 14px; color: var(--dim);
    letter-spacing: .01em; text-align: center;
    transition: color .3s ease, opacity .16s ease, transform .16s ease;
  }
  body[data-state="error"] #status { color: #fb7185; }

  #wake {
    position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
    display: none; align-items: center; gap: 9px;
    padding: 7px 15px 7px 12px; border-radius: 999px;
    border: 1px solid rgba(244,63,94,.32); background: rgba(244,63,94,.09);
    color: #fda4af; font: inherit; font-size: 12px; cursor: pointer; z-index: 6;
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  }
  #wake.on { display: flex; animation: pillglow 3.2s ease-in-out infinite; }
  @keyframes pillglow { 50% { box-shadow: 0 0 24px -5px rgba(244,63,94,.55); } }
  #wake i { width: 7px; height: 7px; border-radius: 50%; background: #f43f5e; animation: blink 1.6s infinite; }
  @keyframes blink { 50% { opacity: .2; } }

  #dots {
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    border: 0; background: none; color: #333947; cursor: pointer;
    padding: 10px 16px; transition: color .25s ease;
  }
  #dots:hover { color: var(--dim); }
  #dots span {
    display: inline-block; width: 4px; height: 4px; margin: 0 3px;
    border-radius: 50%; background: currentColor; animation: bob 1.9s ease-in-out infinite;
  }
  #dots span:nth-child(2) { animation-delay: .16s; }
  #dots span:nth-child(3) { animation-delay: .32s; }
  @keyframes bob { 50% { transform: translateY(-5px); } }

  /* ---------- panel ---------- */
  /* The panel covers the bottom of the screen, and the button that opens it lives there
     too — so once open it was hiding its own switch. Hence the backdrop and the handle:
     four ways out instead of one that was buried. */
  #panelBack {
    position: fixed; inset: 0; z-index: 4; background: rgba(4,5,8,.6);
    opacity: 0; pointer-events: none; transition: opacity .35s ease;
  }
  #panelBack.open { opacity: 1; pointer-events: auto; }

  #panelHandle { display: block; width: 100%; padding: 0 0 14px; border: 0; background: none; cursor: pointer; }
  #panelHandle::before {
    content: ''; display: block; width: 42px; height: 4px; margin: 0 auto;
    border-radius: 999px; background: #2a2f3a; transition: background .2s ease;
  }
  #panelHandle:hover::before { background: #3d4657; }

  #panel {
    position: fixed; inset: auto 0 0 0; z-index: 5;
    max-height: 82vh; overflow-y: auto; padding: 22px 20px 28px;
    background: rgba(10,12,17,.93);
    -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px);
    border-top: 1px solid var(--line); border-radius: 20px 20px 0 0;
    transform: translateY(101%);
    transition: transform .38s cubic-bezier(.22,1,.36,1);
  }
  #panel.open { transform: translateY(0); }
  #panel.open #panelInner > * { animation: rise-in .5s cubic-bezier(.22,1,.36,1) backwards; }
  #panel.open #panelInner > *:nth-child(1) { animation-delay: .05s; }
  #panel.open #panelInner > *:nth-child(2) { animation-delay: .09s; }
  #panel.open #panelInner > *:nth-child(3) { animation-delay: .13s; }
  #panel.open #panelInner > *:nth-child(4) { animation-delay: .17s; }
  #panel.open #panelInner > *:nth-child(5) { animation-delay: .21s; }
  #panel.open #panelInner > *:nth-child(6) { animation-delay: .25s; }
  #panel.open #panelInner > *:nth-child(7) { animation-delay: .29s; }
  #panel.open #panelInner > *:nth-child(8) { animation-delay: .33s; }
  @keyframes rise-in { from { opacity: 0; transform: translateY(16px); } }

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
    position: relative; overflow: hidden;
    padding: 12px 18px; font: inherit; font-size: 14px; cursor: pointer;
    border-radius: 12px; border: 1px solid var(--line);
    background: rgba(255,255,255,.04); color: var(--fg);
    transition: background .2s, border-color .2s;
  }
  /* A light sweeping across the button on hover. Transform only, so it costs nothing. */
  .btn::after {
    content: ''; position: absolute; inset: 0;
    background: linear-gradient(105deg, transparent 32%, rgba(255,255,255,.13) 50%, transparent 68%);
    transform: translateX(-130%); transition: transform .65s cubic-bezier(.22,1,.36,1);
  }
  .btn:hover::after { transform: translateX(130%); }
  .btn:hover { background: rgba(255,255,255,.08); }
  .btn.yes { border-color: rgba(52,211,153,.4); }
  .btn.no  { border-color: rgba(244,63,94,.35); }
  .link { border: 0; background: none; color: #4b5263; font: inherit; font-size: 12px; cursor: pointer; padding: 0; }
  .link:hover { color: var(--dim); }

  /* ---------- confirmation ---------- */
  #confirm {
    position: fixed; inset: 0; z-index: 10; display: grid; place-items: center;
    padding: 24px; background: rgba(5,6,9,.74);
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
  #confirm.open #confirmBox > * { animation: rise-in .45s cubic-bezier(.22,1,.36,1) backwards; }
  #confirm.open #confirmBox > *:nth-child(2) { animation-delay: .06s; }
  #confirm.open #confirmBox > *:nth-child(3) { animation-delay: .12s; }
  #confirmText { margin: 0 0 18px; white-space: pre-wrap; }
  #confirmBox .field { gap: 10px; }
  #confirmBox .btn { flex: 1; }

  /* ---------- token gate ---------- */
  #setup { width: 100%; max-width: 380px; padding: 0 20px; display: flex; flex-direction: column; gap: 12px; }
  #setup p { margin: 0; font-size: 13px; color: var(--dim); }

  .hidden { display: none !important; }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; }
    #orb, #bloom, #aura { transition: none !important; }
    #motes, #grain { display: none; }
  }
</style>
</head>
<body data-state="idle">

<div id="aura"></div>
<div id="motes"></div>
<div id="grain"></div>

<div id="setup" class="hidden">
  <h1 style="margin:0;font-size:17px;font-weight:600">Jarvis</h1>
  <p>Pega el token. Se guarda solo en este navegador y no viaja en la URL.</p>
  <input id="token" type="password" autocomplete="off" placeholder="VOICE_API_TOKEN">
  <button class="btn" id="save">Entrar</button>
</div>

<div id="app" class="hidden">
  <div id="stage">
    <div id="bloom"></div>
    <button id="orb" aria-label="Hablar"><canvas id="sphere"></canvas></button>
  </div>
  <div id="status">Toca para hablar</div>
</div>

<button id="wake"><i></i><span id="wakeLabel">Escuchando · di «oye Jarvis»</span></button>

<button id="dots" class="hidden" aria-label="Detalles"><span></span><span></span><span></span></button>

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
  var wakeOn = false, wakeTimer = null;

  // ---- the dotted sphere ------------------------------------------------
  // Ported from Jakub Antalik's thinking-orbs (MIT). Two things are taken from it: the
  // shape —points on a sphere, drawn as flat 2D arcs with no filters at all, which is why
  // it looks identical in every browser— and the idea that a state is a way of moving
  // rather than a colour.
  //
  // The points are spread by the golden angle. A latitude/longitude grid is the obvious
  // alternative and it is wrong: it crowds the poles, and the crowding is the first thing
  // the eye picks up on a spinning ball.
  var DOTS = 700;
  var sphere = $('sphere'), sctx = sphere.getContext('2d');
  var points = [], jitter = [];
  var spin = 0, phase = 0, energy = 0, targetEnergy = 0;

  (function buildSphere() {
    var golden = Math.PI * (3 - Math.sqrt(5));
    for (var i = 0; i < DOTS; i++) {
      var y = 1 - (i / (DOTS - 1)) * 2;
      var r = Math.sqrt(Math.max(0, 1 - y * y));
      var a = golden * i;
      points.push([Math.cos(a) * r, y, Math.sin(a) * r]);
      // A fixed per-point offset, so bristling and scattering look organic and not uniform.
      jitter.push(0.55 + Math.random());
    }
  })();

  function paintSphere() {
    var css = sphere.clientWidth || 320;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    if (sphere.width !== Math.round(css * dpr)) {
      sphere.width = sphere.height = Math.round(css * dpr);
    }
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.clearRect(0, 0, css, css);

    var state = document.body.dataset.state;
    var mid = css / 2, R = css * 0.3;

    // The audio drives this, smoothed here rather than at the source so both ends of a
    // turn —microphone and reply— reach the sphere through the same filter.
    energy += (targetEnergy - energy) * 0.16;
    spin += state === 'thinking' ? 0.012 : 0.004;
    phase += 0.055;

    var cs = Math.cos(spin), sn = Math.sin(spin);
    var ct = Math.cos(0.42), st = Math.sin(0.42);

    sctx.globalCompositeOperation = 'lighter';
    sctx.fillStyle = '#ffffff';

    for (var i = 0; i < DOTS; i++) {
      var p = points[i], x = p[0], y = p[1], z = p[2];

      // Each state is a different displacement of the same sphere.
      var d;
      if (state === 'listening') {
        // Bristling: every point pushed out by how loud you are.
        d = 1 + energy * 0.5 * jitter[i];
      } else if (state === 'speaking') {
        // Latitude waves running pole to pole with the amplitude of the reply.
        d = 1 + Math.sin(y * 6.5 + phase) * energy * 0.42;
      } else if (state === 'thinking') {
        // Scatter and regroup, each point on its own phase.
        d = 1 + (Math.sin(phase * 0.55 + i * 0.9) * 0.5 + 0.5) * 0.4 * jitter[i];
      } else {
        // Breathing: barely there, but enough that the sphere is never quite still.
        d = 1 + Math.sin(phase * 0.18 + i * 0.35) * 0.02;
      }
      x *= d; y *= d; z *= d;

      var rx = x * cs - z * sn, rz = x * sn + z * cs;
      var ry = y * ct - rz * st, rd = y * st + rz * ct;

      // Depth does the whole job of making it a ball: nearer points are bigger and
      // brighter, and there is no shading anywhere else.
      var depth = (rd + 1) / 2;
      sctx.globalAlpha = 0.045 + depth * depth * 0.72;
      sctx.beginPath();
      sctx.arc(mid + rx * R, mid + ry * R, 0.4 + depth * 1.5, 0, 6.2832);
      sctx.fill();
    }

    sctx.globalAlpha = 1;
    sctx.globalCompositeOperation = 'source-over';
    requestAnimationFrame(paintSphere);
  }
  paintSphere();

  /** A ring pushed outwards from the orb. Removes itself; nothing accumulates. */
  function ripple() {
    var node = document.createElement('div');
    node.className = 'ripple';
    $('stage').appendChild(node);
    setTimeout(function () { node.remove(); }, 1800);
  }

  // ---- decor ------------------------------------------------------------
  (function buildDecor() {
    var motes = $('motes');
    for (var i = 0; i < 14; i++) {
      var mote = document.createElement('span');
      mote.className = 'mote';
      mote.style.left = (Math.random() * 100) + '%';
      mote.style.bottom = '-10px';
      mote.style.animationDuration = (28 + Math.random() * 28) + 's';
      mote.style.animationDelay = (-Math.random() * 45) + 's';
      motes.appendChild(mote);
    }

    // Grain painted once into a canvas. A texture that ships as an asset would be the only
    // file this page needs; a texture it draws itself is not a file at all.
    try {
      var canvas = document.createElement('canvas');
      canvas.width = canvas.height = 96;
      var g = canvas.getContext('2d');
      var img = g.createImageData(96, 96);
      for (var d = 0; d < img.data.length; d += 4) {
        var v = 190 + Math.random() * 65;
        img.data[d] = img.data[d + 1] = img.data[d + 2] = v;
        img.data[d + 3] = 26;
      }
      g.putImageData(img, 0, 0);
      $('grain').style.backgroundImage = 'url(' + canvas.toDataURL() + ')';
    } catch (e) { $('grain').style.display = 'none'; }
  })();

  // ---- state ------------------------------------------------------------
  var lastState = '';
  function setState(state, text) {
    var changed = state !== lastState;
    lastState = state;
    document.body.dataset.state = state;
    if (text === undefined) return;

    var status = $('status');
    // The counter while thinking rewrites this line ten times a second. Cross-fading that
    // would be a strobe, so only a real change of state gets the transition.
    if (!changed) { status.textContent = text; return; }
    status.style.opacity = '0';
    status.style.transform = 'translateY(5px)';
    setTimeout(function () {
      status.textContent = text;
      status.style.opacity = '';
      status.style.transform = '';
    }, 150);
  }

  function level(value) {
    var v = Math.max(0, Math.min(1, value));
    targetEnergy = v;
    document.body.style.setProperty('--l', String(v));
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
  function openPanel() { $('panel').classList.add('open'); $('panelBack').classList.add('open'); }
  function closePanel() { $('panel').classList.remove('open'); $('panelBack').classList.remove('open'); }
  function togglePanel() { if ($('panel').classList.contains('open')) closePanel(); else openPanel(); }

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
    // The cooldown is not politeness: re-arming the instant the reply ends catches its own
    // tail through the speakers and wakes the assistant up with its own voice.
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
  // nothing before finding out, and the sphere sits there looking like it is working.
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
      // The hard cap applies in both modes: a recorder nobody stopped is how you get a 413
      // and a bill instead of an answer.
      if (elapsed > MAX_RECORD_MS) { stop(); return; }
      if (mode !== 'hold' && !heardSomething && elapsed > NO_SPEECH_MS) { stop(); return; }
      // Cutting on silence only makes sense when there is no finger on the button, and
      // never before MIN_RECORD_MS: a pause for breath after the first word would send half
      // a sentence, which comes back as an answer to a question nobody asked.
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
  // AAC-in-MP4 on Safari. Both are accepted by the endpoint, so nothing is converted here
  // — the browser's own container is sent as-is with its Content-Type.
  function pickMime() {
    var candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < candidates.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  /**
   * One microphone stream for the whole session.
   *
   * Held open rather than acquired per turn so that a wake word can start recording in
   * milliseconds instead of after a permission round trip — by then the first word of the
   * request is gone. Echo cancellation is not optional here: with the wake listener on,
   * the assistant's own reply comes back through the speakers and re-triggers it.
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
    ripple();
    setState('listening', mode === 'hold' ? 'Te escucho…' : 'Te escucho… calla y lo envío');
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
    // worse than useless: Whisper answers silence with the subtitle credits it was trained
    // on, and the assistant then replies to a sentence nobody said.
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
      // A slow wander while the model works, so the sphere never looks stuck.
      level(0.28 + Math.sin(Date.now() / 430) * 0.14);
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
      // No audio: the reply survives on screen, and the panel opens itself because that is
      // the only place it is legible.
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
  // The audio is routed through an AnalyserNode so the sphere moves with the actual voice
  // instead of a canned animation. It is the same reader the microphone uses, so both ends
  // of a turn are measured the same way.
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
      audio.onerror = function () {
        cleanup();
        setState('error', 'El audio no se pudo reproducir.');
        setTimeout(idle, 2600);
        resolve();
      };

      setState('speaking', 'Hablando…');
      ripple();
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
        } catch (e) { /* Without the analyser it still plays; it just does not move. */ }
      }).catch(function () {
        cleanup();
        setState('error', 'El navegador bloqueó el audio. Toca la pantalla y repite.');
        setTimeout(idle, 3200);
        resolve();
      });
    });
  }

  // ---- confirmation -----------------------------------------------------
  // The one thing that is never decided by voice alone. It is a modal and not a line in a
  // panel on purpose: nothing destructive should be one careless tap away.
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
      // Everything the server did not spend: upload, download and the handshakes. Derived
      // and not reported, because it is the only tramo the Worker cannot see.
      ['red', server.total !== undefined ? clientMs - server.total : undefined],
      ['total', clientMs]
    ];
    var html = '';
    rows.forEach(function (row) {
      if (row[1] === undefined || isNaN(row[1])) return;
      html += '<tr><td>' + row[0] + '</td><td' + (row[1] > 4000 ? ' class="slow"' : '') + '>' + row[1] + ' ms</td></tr>';
    });
    if (bytes) {
      // Duration and size together, because separately neither says much: 7 s in 2 KB is a
      // microphone that captured silence.
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
  var recognition = null, wakeTurns = 0;

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
    // The pop is the receipt for the wake word: you said the name and something happened,
    // before any text has had time to appear.
    $('orb').classList.remove('pop');
    void $('orb').offsetWidth;
    $('orb').classList.add('pop');
    setTimeout(function () { $('orb').classList.remove('pop'); }, 650);
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

  // Resume the listener when it was left on. It is the user's own saved choice and the red
  // pill says so from the first frame — but the browser can refuse to start a recogniser
  // with no gesture behind it, so a failure here is silent and reversible.
  try {
    if (localStorage.getItem(WAKE_KEY) === '1' && token && wakeSupported()) setWake(true);
  } catch (e) {}
})();
</script>
</body>
</html>`;
