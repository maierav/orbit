// Stimulus sets: two categories (A, B) of square canvases, optionally matched in mean luminance and RMS contrast.
// Matching is done on gamma-encoded pixel values, not on photometric luminance.

export const STIM_PX = 384;
export const BG = 128;
const TARGET_SD = 38;

function mulberry32(a) {
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function blank() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = STIM_PX;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = `rgb(${BG},${BG},${BG})`;
  ctx.fillRect(0, 0, STIM_PX, STIM_PX);
  return [cv, ctx];
}

// If the image has a uniform background (as object renders do), the background is set to the screen gray
// and only the object is rescaled: object mean = screen gray, whole-image RMS contrast = sd. Otherwise
// the whole image is rescaled.
export function equalize(cv, mean = BG, sd = TARGET_SD) {
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const im = ctx.getImageData(0, 0, cv.width, cv.height), d = im.data, n = d.length / 4;
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) g[i] = 0.2126 * d[4 * i] + 0.7152 * d[4 * i + 1] + 0.0722 * d[4 * i + 2];
  const corner = g[0], obj = new Uint8Array(n);
  let nObj = 0;
  for (let i = 0; i < n; i++) if (Math.abs(g[i] - corner) > 1.5) { obj[i] = 1; nObj++; }
  if (n - nObj < 0.05 * n || nObj < 0.01 * n) { obj.fill(1); nObj = n; }
  // Two passes, because clipping to 0..255 shifts the statistics slightly.
  for (let pass = 0; pass < 2; pass++) {
    let m = 0, v = 0;
    for (let i = 0; i < n; i++) if (obj[i]) m += g[i];
    m /= nObj;
    for (let i = 0; i < n; i++) if (obj[i]) v += (g[i] - m) ** 2;
    const k = sd / (Math.sqrt(v / n) || 1);
    for (let i = 0; i < n; i++) g[i] = obj[i] ? Math.min(255, Math.max(0, (g[i] - m) * k + mean)) : mean;
  }
  for (let i = 0; i < n; i++) { d[4 * i] = d[4 * i + 1] = d[4 * i + 2] = Math.round(g[i]); d[4 * i + 3] = 255; }
  ctx.putImageData(im, 0, 0);
  return cv;
}

function rfShape(comps) {
  const [cv, ctx] = blank();
  const c = STIM_PX / 2, r0 = 0.3 * STIM_PX;
  ctx.beginPath();
  for (let i = 0; i <= 360; i++) {
    const th = i * Math.PI / 180;
    let r = 1;
    for (const k of comps) r += k.a * Math.cos(k.f * th + k.ph);
    ctx[i ? 'lineTo' : 'moveTo'](c + r0 * r * Math.cos(th), c + r0 * r * Math.sin(th));
  }
  const gr = ctx.createRadialGradient(c - 0.1 * r0, c - 0.15 * r0, 0.1 * r0, c, c, 1.4 * r0);
  gr.addColorStop(0, 'rgb(205,205,205)');
  gr.addColorStop(1, 'rgb(60,60,60)');
  ctx.fillStyle = gr;
  ctx.fill();
  return equalize(cv);
}

const randComps = (freqs, rng) => freqs.map((f) => ({ f, a: 0.1 + 0.08 * rng(), ph: 2 * Math.PI * rng() }));

// Placeholder categories: A = smooth 2-3 lobed blobs, B = 6-8 lobed shapes.
export function makeDemoSet(n = 6, seed = 7) {
  const rng = mulberry32(seed);
  const A = [], B = [];
  for (let i = 0; i < n; i++) {
    A.push(rfShape(randComps([2 + (i % 2), 3 + (i % 2)], rng)));
    B.push(rfShape(randComps([6 + (i % 3), 7 + (i % 3)], rng)));
  }
  return { A, B };
}

// Placeholder for stimulus pairs with known dissimilarity: each pair is a base shape and the same
// shape with an added 7-lobe component whose amplitude sets the dissimilarity level.
export const DEMO_LEVELS = [0.02, 0.05, 0.1, 0.18];
export function makeGradedPairs(nPerLevel = 4, seed = 11) {
  const rng = mulberry32(seed), pairs = [];
  for (let i = 0; i < nPerLevel; i++) {
    for (const level of DEMO_LEVELS) {
      const base = randComps([2 + (i % 2), 3 + (i % 2)], rng), ph = 2 * Math.PI * rng();
      pairs.push({ a: rfShape(base), b: rfShape([...base, { f: 7, a: level, ph }]), level });
    }
  }
  return pairs;
}

export async function loadFiles(files, doEqualize) {
  const out = [];
  for (const f of files) {
    const bmp = await createImageBitmap(f);
    const [cv, ctx] = blank();
    const sc = Math.max(STIM_PX / bmp.width, STIM_PX / bmp.height);
    ctx.drawImage(bmp, (STIM_PX - bmp.width * sc) / 2, (STIM_PX - bmp.height * sc) / 2, bmp.width * sc, bmp.height * sc);
    out.push(doEqualize ? equalize(cv) : cv);
  }
  return out;
}

export function imageStats(cv) {
  const d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data;
  let m = 0, v = 0;
  const n = d.length / 4;
  for (let i = 0; i < n; i++) m += 0.2126 * d[4 * i] + 0.7152 * d[4 * i + 1] + 0.0722 * d[4 * i + 2];
  m /= n;
  for (let i = 0; i < n; i++) v += (0.2126 * d[4 * i] + 0.7152 * d[4 * i + 1] + 0.0722 * d[4 * i + 2] - m) ** 2;
  return { mean: m, sd: Math.sqrt(v / n) };
}
