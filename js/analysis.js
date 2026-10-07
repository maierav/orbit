import { IRIS_MM } from './tracker.js';

export function interp(x, xs, ys) {
  if (x <= xs[0]) return ys[0];
  const n = xs.length;
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  return ys[lo] + (ys[hi] - ys[lo]) * (x - xs[lo]) / (xs[hi] - xs[lo]);
}

// Pupil epoch around t0 (ms), resampled to a common grid (s) so sessions/devices with different
// frame rates can be averaged. Returned y is baseline-subtracted estimated mm; null if too few valid samples.
export function epoch(samples, t0, { tmin, tmax, dt = 0.02, minValid = 0.6 }) {
  const lo = t0 + tmin * 1000 - 150, hi = t0 + tmax * 1000 + 150;
  const xs = [], ys = [];
  let total = 0;
  for (const s of samples) {
    if (s.t < lo || s.t > hi) continue;
    total++;
    if (Number.isFinite(s.p) && !s.blink) { xs.push((s.t - t0) / 1000); ys.push(s.p * IRIS_MM); }
  }
  if (xs.length < 5 || xs.length / total < minValid) return null;
  const t = [], raw = [];
  for (let x = tmin; x <= tmax + 1e-9; x += dt) { t.push(x); raw.push(interp(x, xs, ys)); }
  const y = raw.map((_, i) => {
    let a = 0, c = 0;
    for (let k = Math.max(0, i - 2); k <= Math.min(raw.length - 1, i + 2); k++) { a += raw[k]; c++; }
    return a / c;
  });
  let b = 0, nb = 0;
  for (let i = 0; i < t.length; i++) if (t[i] < 0) { b += y[i]; nb++; }
  const base = nb ? b / nb : y[0];
  return { t, y: y.map((v) => v - base), base };
}

export function average(epochs) {
  const n = epochs.length;
  if (!n) return null;
  const t = epochs[0].t, mean = [], sem = [];
  for (let i = 0; i < t.length; i++) {
    let m = 0, v = 0;
    for (const e of epochs) m += e.y[i];
    m /= n;
    for (const e of epochs) v += (e.y[i] - m) ** 2;
    mean.push(m);
    sem.push(n > 1 ? Math.sqrt(v / (n - 1) / n) : 0);
  }
  return { t, mean, sem, n };
}

export function windowMean(t, y, a, b) {
  let s = 0, c = 0;
  for (let i = 0; i < t.length; i++) if (t[i] >= a && t[i] <= b) { s += y[i]; c++; }
  return c ? s / c : NaN;
}

// Looking time (ms) per screen side between t0 and t1, from the automatic gaze estimate and from
// the experimenter's key coding. Each sample is credited with the interval to the next one.
export function lookTimes(samples, t0, t1) {
  const out = { autoL: 0, autoR: 0, manL: 0, manR: 0, tracked: 0, total: t1 - t0 };
  const win = samples.filter((s) => s.t >= t0 && s.t <= t1);
  for (let i = 0; i < win.length; i++) {
    const s = win[i], dt = Math.min(100, (i + 1 < win.length ? win[i + 1].t : t1) - s.t);
    if (s.face && !s.blink && Number.isFinite(s.gx)) {
      out.tracked += dt;
      if (s.side === 'L') out.autoL += dt; else if (s.side === 'R') out.autoR += dt;
    }
    if (s.manual === 'L') out.manL += dt; else if (s.manual === 'R') out.manR += dt;
  }
  return out;
}

// First sustained look to a screen side after t0: the first run of `run` consecutive samples on the same side.
export function firstLook(samples, t0, t1, key = 'side', minLatency = 120, run = 3) {
  let cur = '', n = 0, start = 0;
  for (const s of samples) {
    if (s.t < t0 + minLatency || s.t > t1) continue;
    const v = s[key] === 'L' || s[key] === 'R' ? s[key] : '';
    if (v && v === cur) n++; else { cur = v; n = v ? 1 : 0; start = s.t; }
    if (n >= run) return { side: cur, latency: start - t0 };
  }
  return { side: '', latency: NaN };
}

export const mean = (a) => (a.length ? a.reduce((p, q) => p + q, 0) / a.length : NaN);
