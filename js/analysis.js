// Looking time (ms) per screen side between t0 and t1, from the automatic gaze estimate and from
// the experimenter's key coding. Each sample is credited with the interval to the next one.
export function lookTimes(samples, t0, t1, off = 0) {
  const out = { autoL: 0, autoR: 0, manL: 0, manR: 0, tracked: 0, total: t1 - t0 };
  const win = samples.filter((s) => s.t >= t0 && s.t <= t1);
  for (let i = 0; i < win.length; i++) {
    const s = win[i], dt = Math.min(100, (i + 1 < win.length ? win[i + 1].t : t1) - s.t);
    if (s.face && !s.blink && Number.isFinite(s.gx)) {
      out.tracked += dt;
      const gx = s.gx - off;
      if (gx < 0.45) out.autoL += dt; else if (gx > 0.55) out.autoR += dt;
    }
    if (s.manual === 'L') out.manL += dt; else if (s.manual === 'R') out.manR += dt;
  }
  return out;
}

// Horizontal gaze offset from the screen centre while the participant fixates a central cross
// (median over t0..t1, limited to +-0.15 of screen width); used to re-centre the following trial.
export function centreOffset(samples, t0, t1) {
  const v = samples.filter((s) => s.t >= t0 && s.t <= t1 && s.face && !s.blink && Number.isFinite(s.gx)).map((s) => s.gx).sort((p, q) => p - q);
  if (v.length < 5) return 0;
  return Math.max(-0.15, Math.min(0.15, v[v.length >> 1] - 0.5));
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
