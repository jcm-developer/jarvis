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

/** The dots grouped into depth bands, back to front, radius and opacity on the group. */
function bands(drawn, round, count = 7) {
  const out = [];
  for (let band = 0; band < count; band++) {
    const from = band / count;
    const to = (band + 1) / count;
    const inside = drawn.filter((p) => p.depth >= from && (band === count - 1 ? p.depth <= to : p.depth < to));
    if (inside.length === 0) continue;

    // Only the opacity moves to the group. `r` stays on every circle even though the band
    // shares one value: it is a geometry property, and inheriting it from a `<g>` is SVG 2
    // and not something every renderer that opens a favicon agrees on.
    const r = round(inside.reduce((sum, p) => sum + p.r, 0) / inside.length);
    const o = round(inside.reduce((sum, p) => sum + p.o, 0) / inside.length);
    const dots = inside
      .map((p) => `<circle cx="${round(p.cx)}" cy="${round(p.cy)}" r="${r}"/>`)
      .join('');
    out.push(`<g opacity="${o}">${dots}</g>`);
  }
  return out.join('');
}

function svg(dots, { disc, weight, ink = '#ffffff', tight = false }) {
  // One decimal is a tenth of a pixel on a 340 unit canvas. Invisible at any size the mark
  // is used at, and it takes a third off a file that gets inlined into every page load.
  const round = (n) => Number(n.toFixed(tight ? 1 : 2));
  const join = tight ? '' : '\n';
  const drawn = sphere(dots, weight);

  // Full size, every dot carries its own radius and opacity. Tight, they are quantised into
  // depth bands that hang the two off a `<g>`: it halves the text, and the difference it
  // makes is a fraction of a pixel of radius on a mark that is read at 32.
  const body = tight
    ? bands(drawn, round)
    : drawn
        .map((p) => `<circle cx="${round(p.cx)}" cy="${round(p.cy)}" r="${round(p.r)}" opacity="${round(p.o)}"/>`)
        .join(join);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}"${
      tight ? '' : ` width="${SIZE}" height="${SIZE}" role="img" aria-label="Jarvis"`
    }>`,
    // A favicon is never read out and never has a tooltip: the title is weight with no job.
    tight ? '' : '<title>Jarvis</title>',
    disc ? `<circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${SIZE / 2}" fill="${disc === true ? BG : disc}"/>` : '',
    `<g fill="${ink}">`,
    body,
    '</g>',
    '</svg>',
  ]
    .filter((line) => line !== '')
    .join(join);
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

// The favicon of /voice, and it is generated into the source rather than served as a file.
//
// That is the page's own rule and not a shortcut: it ships zero assets —even the film grain
// is painted into a canvas at load— so that serving it is one response and there is no
// second request to get wrong, cache wrong or 404 in a browser that already has the HTML.
// A route for the icon would be the first exception, and the whole icon is 3 kB of text that
// gzips to almost nothing.
//
// 18 dots and not the 700 of the page, and the number is the whole design of this file.
//
// A favicon is read at 16 px, where the sphere is 16 pixels across and every dot of the real
// cloud lands on less than one of them. Anything under a pixel gets averaged into the disc
// behind it, so 700 white dots on black come out as black — which is exactly what the tab
// showed. The dots have to be fat enough to own a pixel each, and once they are that fat
// only about twenty of them fit. So the small mark is not the logo shrunk: it is the same
// sphere, the same tilt and the same depth, sampled down to the dots that survive.
//
// Regenerate with `node scripts/logo.mjs` — do not hand-edit src/voice/icon.ts.
const icon = svg(18, { disc: true, tight: true, weight: { size: 13, floor: 0.78 } });
writeFileSync(
  'src/voice/icon.ts',
  [
    '/**',
    ' * The dotted sphere as the tab icon, inlined so the page still ships zero assets.',
    ' *',
    ' * GENERATED by scripts/logo.mjs. Do not edit by hand: change the constants in the',
    ' * script and run `node scripts/logo.mjs`.',
    ' */',
    '',
    // Base64 and not percent-encoding: an SVG is mostly quotes, angle brackets and spaces,
    // and escaping every one of them comes out longer than the 4/3 of base64 — 8 kB against
    // 6. It also cannot be broken by a stray character inside an HTML attribute.
    `export const VOICE_ICON =\n  'data:image/svg+xml;base64,${Buffer.from(icon, 'utf8').toString('base64')}';`,
    '',
  ].join('\n'),
);

console.log('assets/logo*.svg and src/voice/icon.ts');
