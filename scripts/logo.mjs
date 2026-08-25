/**
 * The dotted sphere of the voice page, frozen into an SVG.
 *
 * The page paints its orb with 2D canvas arcs sixty times a second (`src/voice/page.ts`),
 * so there was no file anywhere to use as a logo. This is the same geometry with the clock
 * stopped: the golden-angle point cloud, the same tilt, and depth doing the whole job of
 * making it read as a ball.
 *
 * Two things differ from the canvas, both because SVG is not a canvas:
 *
 * - The dots are sorted back to front and painted with ordinary alpha instead of the
 *   canvas' additive `lighter`. `mix-blend-mode` would reproduce it in a browser and fall
 *   apart in everything else that opens an SVG, and a logo is opened by far more than
 *   browsers.
 * - The idle breathing is sampled at phase 0. It is not a still frame of nothing: idle
 *   displaces each point by up to 2%, which is what keeps the cloud from looking like a
 *   printed grid.
 *
 * Run: node scripts/logo.mjs
 */

import { writeFileSync } from 'node:fs';

/** The page's own numbers, so the logo and the orb on screen are the same object. */
const SIZE = 340;
const R = SIZE * 0.38;
const TILT = 0.42;
const SPIN = 0.6;
const PHASE = 0;
const BG = '#08090b';

function sphere(dots, weight) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const cs = Math.cos(SPIN);
  const sn = Math.sin(SPIN);
  const ct = Math.cos(TILT);
  const st = Math.sin(TILT);
  const mid = SIZE / 2;

  const drawn = [];
  for (let i = 0; i < dots; i++) {
    const y0 = 1 - (i / (dots - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y0 * y0));
    const a = golden * i;

    // Idle, the same displacement the page applies when nobody is talking.
    const d = 1 + Math.sin(PHASE * 0.18 + i * 0.35) * 0.02;
    const x = Math.cos(a) * r * d;
    const y = y0 * d;
    const z = Math.sin(a) * r * d;

    const rx = x * cs - z * sn;
    const rz = x * sn + z * cs;
    const ry = y * ct - rz * st;
    const rd = y * st + rz * ct;

    const depth = Math.max(0, Math.min(1, (rd + 1) / 2));
    drawn.push({
      cx: mid + rx * R,
      cy: mid + ry * R,
      r: (0.5 + depth * 1.8) * weight.size,
      o: Math.min(1, weight.floor + depth * depth * (1 - weight.floor)),
      depth,
    });
  }

  // Far ones first: without the canvas' additive blending, the paint order is the only
  // thing left that says which dots are in front.
  return drawn.sort((a, b) => a.depth - b.depth);
}

function svg(dots, { disc, weight, ink = '#ffffff' }) {
  const round = (n) => Number(n.toFixed(2));
  const body = sphere(dots, weight)
    .map((p) => `<circle cx="${round(p.cx)}" cy="${round(p.cy)}" r="${round(p.r)}" opacity="${round(p.o)}"/>`)
    .join('\n');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" role="img" aria-label="Jarvis">`,
    '<title>Jarvis</title>',
    disc ? `<circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${SIZE / 2}" fill="${BG}"/>` : '',
    `<g fill="${ink}">`,
    body,
    '</g>',
    '</svg>',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

// 700 dots is what the page draws, and at favicon size they collapse into a grey smudge —
// so the small mark is the same sphere sampled thinner, never the big one scaled down. The
// floor on the opacity is the other half of that: lifting the back of the ball to 0.18 is
// what keeps the dots visible at 32 px, and the same value at 340 px would flatten the
// sphere into a disc of confetti.
const FULL = { size: 1, floor: 0.07 };

writeFileSync('assets/logo.svg', svg(700, { disc: true, weight: FULL }));
writeFileSync('assets/logo-mark.svg', svg(120, { disc: true, weight: { size: 1.7, floor: 0.18 } }));
writeFileSync('assets/logo-transparent.svg', svg(700, { disc: false, weight: FULL }));

// The same cloud in ink, for anything on a light background —a README, a slide, a tab bar—
// where white dots on transparent are simply not there.
writeFileSync('assets/logo-ink.svg', svg(700, { disc: false, ink: BG, weight: FULL }));

console.log('assets/logo.svg, logo-mark.svg, logo-transparent.svg, logo-ink.svg');
