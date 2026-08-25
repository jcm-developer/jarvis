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
import { deflateSync } from 'node:zlib';

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
// A route for the icon would be the first exception.
//
// The full 700 dot cloud, the same image as assets/avatar-512.png, and that is a choice
// made with its cost known: at 16 px every dot lands on less than a pixel, gets averaged
// into the disc behind it and the tab reads as a dark circle. A version drawn with 18 fat
// dots is legible there and is a different picture; this one is the picture, everywhere.
//
// It costs 36 kB of base64 in the HTML, 6 kB once Cloudflare gzips it.
//
// Regenerate with `node scripts/logo.mjs` — do not hand-edit src/voice/icon.ts.
const icon = svg(700, { disc: true, tight: true, weight: FULL });
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



/* ------------------------------- raster ---------------------------------- */

/**
 * The same sphere as pixels, because one surface refuses vectors.
 *
 * Chrome's "install as an app" dialog does not read the SVG favicon: it takes its icon from
 * the web app manifest, and a manifest icon has to be a raster. Without one the dialog falls
 * back to drawing the first letter of the title in a grey box, which is the J that started
 * this.
 *
 * So there is a PNG encoder in here, hand-written like the rest of the clients in this
 * project, for the same reason: `sharp` or `canvas` would be a build dependency and a
 * postinstall compile step for something that is 60 lines of zlib and CRC. It draws with 3x
 * supersampling —the alternative is a ball of jagged dots— onto an opaque background, so the
 * PNG needs no alpha channel.
 */
function raster(dots, weight, size, ss = 3) {
  const w = size * ss;
  const px = new Float64Array(w * w); // coverage, 0..1, of white over the background
  const scale = w / SIZE;

  for (const p of sphere(dots, weight)) {
    const cx = p.cx * scale;
    const cy = p.cy * scale;
    const r = p.r * scale;
    const from = Math.max(0, Math.floor(cy - r));
    const to = Math.min(w - 1, Math.ceil(cy + r));

    for (let y = from; y <= to; y++) {
      const dy = y + 0.5 - cy;
      const half = Math.sqrt(Math.max(0, r * r - dy * dy));
      const x0 = Math.max(0, Math.floor(cx - half));
      const x1 = Math.min(w - 1, Math.ceil(cx + half));
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        if (dx * dx + dy * dy > r * r) continue;
        const i = y * w + x;
        // Painted back to front like the SVG, so the same `over` compositing applies.
        px[i] = px[i] * (1 - p.o) + p.o;
      }
    }
  }

  // The disc, and the corners outside it. A square PNG is what a manifest wants; the corners
  // are the page background so an installed window has no seam around the icon.
  const bg = [parseInt(BG.slice(1, 3), 16), parseInt(BG.slice(3, 5), 16), parseInt(BG.slice(5, 7), 16)];
  const rgb = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) sum += px[(y * ss + sy) * w + (x * ss + sx)];
      }
      const cover = sum / (ss * ss);
      const at = (y * size + x) * 3;
      for (let c = 0; c < 3; c++) rgb[at + c] = Math.round(bg[c] * (1 - cover) + 255 * cover);
    }
  }
  return png(rgb, size);
}

/** Minimal PNG: one IDAT of filter-0 scanlines, which is all a flat icon needs. */
function png(rgb, size) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour, no alpha

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// The app icons. 512 is what Chrome's install dialog shows and what Telegram wants for a
// profile photo; 192 is the one an installed shortcut uses. Both are written as files —a
// person uploads them by hand— and inlined into the source, because a manifest icon has to
// be a URL and the Worker has no filesystem to read at runtime.
const ICON_512 = raster(700, FULL, 512);
const ICON_192 = raster(700, FULL, 192);

writeFileSync('assets/avatar-512.png', ICON_512);
writeFileSync('assets/avatar-192.png', ICON_192);
writeFileSync(
  'src/voice/app-icons.ts',
  [
    '/**',
    ' * The sphere as PNG, for the two places that will not take the SVG: the web app',
    ' * manifest and anything that installs the page as an app.',
    ' *',
    ' * GENERATED by scripts/logo.mjs. Do not edit by hand.',
    ' */',
    '',
    `export const APP_ICON_512 = '${ICON_512.toString('base64')}';`,
    '',
    `export const APP_ICON_192 = '${ICON_192.toString('base64')}';`,
    '',
  ].join('\n'),
);



/**
 * The same PNGs wrapped in an ICO, for the one case that is not a browser: a Windows
 * shortcut whose icon is changed by hand from its properties dialog. Windows has taken PNG
 * inside ICO since Vista, so this is a header, four directory entries and the files.
 */
function ico(sizes) {
  const images = sizes.map((size) => ({ size, png: raster(700, FULL, size) }));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, png: data }) => {
    const entry = Buffer.alloc(16);
    // 0 means 256 in a byte-wide field, which is the whole reason 256 is the largest ICO.
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32BE(0, 8);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

writeFileSync('assets/jarvis.ico', ico([256, 48, 32, 16]));

console.log('assets/ (svg, png, ico) and src/voice/ (icon.ts, app-icons.ts)');
