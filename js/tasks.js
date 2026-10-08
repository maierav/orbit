import { BG, makeGradedPairs } from './stimuli.js';
import { IRIS_MM } from './tracker.js';
import { epoch, average, windowMean, lookTimes, firstLook, mean } from './analysis.js';
import { COLORS } from './plot.js';

// Durations in ms; `size` is the stimulus edge as a fraction of min(half screen width, screen height).
export const MODES = {
  adult: {
    attention: false, selfPaced: false, calibDwell: 1600,
    paired: { trials: 8, fam: 4000, test: 4000, gap: 1000, size: 0.7 },
    oddball: { trials: 60, stim: 600, isi: 1600, size: 0.6 },
    oddone: { trials: 16, dur: 2500, gap: 1000 },
  },
  infant: {
    attention: true, selfPaced: true, calibDwell: 2200,
    paired: { trials: 4, fam: 10000, test: 8000, gap: 1500, size: 0.85 },
    oddball: { trials: 30, stim: 1000, isi: 2000, size: 0.85 },
    oddone: { trials: 8, dur: 5000, gap: 1500 },
  },
};

const gray = (v) => `rgb(${v},${v},${v})`;

export class Stage {
  constructor(el) {
    this.el = el;
    this.cv = el.querySelector('canvas');
    this.ctx = this.cv.getContext('2d');
    this.bg = BG;
    this.draw = null;
    this.isOpen = false;
    this._waiters = new Set();
    this._tick = this._tick.bind(this);
    window.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      if (e.key === 'Escape') this.abort();
      else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this._key(); }
    });
    this.cv.addEventListener('pointerdown', () => this._key());
    el.querySelector('#abort').addEventListener('click', () => this.abort());
    document.addEventListener('fullscreenchange', () => {
      if (this.isOpen && this._fs && !document.fullscreenElement) this.abort();
    });
  }

  async open() {
    this.isOpen = true;
    this.bg = BG;
    this.draw = null;
    this.el.hidden = false;
    this._fs = false;
    try { if (this.el.requestFullscreen) { await this.el.requestFullscreen(); this._fs = true; } } catch (e) { /* stays a fixed overlay */ }
    this._raf = requestAnimationFrame(this._tick);
  }

  close() {
    this.isOpen = false;
    cancelAnimationFrame(this._raf);
    this.el.hidden = true;
    this._fs = false;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  setDraw(fn) { this.draw = fn; }

  _tick(t) {
    const dpr = window.devicePixelRatio || 1, w = this.cv.clientWidth, h = this.cv.clientHeight;
    if (this.cv.width !== Math.round(w * dpr) || this.cv.height !== Math.round(h * dpr)) {
      this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = gray(this.bg);
    ctx.fillRect(0, 0, w, h);
    if (this.draw) this.draw(ctx, w, h, t);
    const now = performance.now();
    for (const q of this._waiters) if (q.until != null && now >= q.until) { this._waiters.delete(q); q.res(); }
    if (this.isOpen) this._raf = requestAnimationFrame(this._tick);
  }

  wait(ms) { return new Promise((res, rej) => this._waiters.add({ until: performance.now() + ms, res, rej })); }
  waitKey() { return new Promise((res, rej) => this._waiters.add({ key: true, res, rej })); }
  _key() { for (const q of this._waiters) if (q.key) { this._waiters.delete(q); q.res(); } }
  abort() {
    const ws = [...this._waiters];
    this._waiters.clear();
    for (const q of ws) q.rej(new Error('aborted'));
  }
}

let audio = null;
function chirp() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
    o.frequency.setValueAtTime(600, t);
    o.frequency.exponentialRampToValueAtTime(950, t + 0.25);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(audio.destination);
    o.start(t); o.stop(t + 0.32);
  } catch (e) { /* no audio */ }
}

function drawFix(ctx, x, y, bg = BG) {
  ctx.strokeStyle = bg > 150 ? '#000' : '#fff';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(x - 10, y); ctx.lineTo(x + 10, y); ctx.moveTo(x, y - 10); ctx.lineTo(x, y + 10); ctx.stroke();
}

function drawDot(ctx, x, y, t) {
  const r = 14 + 5 * Math.sin(t / 150);
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill();
  ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(x, y, 3, 0, 2 * Math.PI); ctx.fill();
}

// Infant attention getter: a spinning, looming star.
function drawGetter(ctx, x, y, size, t) {
  const r = size * (0.75 + 0.25 * Math.sin(t / 220));
  ctx.save();
  ctx.translate(x, y); ctx.rotate(t / 500);
  ['#eda100', '#e34948', '#2a78d6'].forEach((col, k) => {
    const rr = r * (1 - 0.3 * k);
    ctx.fillStyle = col;
    ctx.beginPath();
    for (let i = 0; i < 16; i++) {
      const a = i * Math.PI / 8, q = i % 2 ? rr * 0.55 : rr;
      ctx[i ? 'lineTo' : 'moveTo'](q * Math.cos(a), q * Math.sin(a));
    }
    ctx.closePath(); ctx.fill();
  });
  ctx.restore();
}

function drawText(ctx, w, h, lines) {
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  lines.forEach((ln, i) => {
    ctx.font = `${i ? 18 : 26}px system-ui, sans-serif`;
    ctx.fillText(ln, w / 2, h / 2 + (i - (lines.length - 1) / 2) * 34, w - 40);
  });
}

async function intro(x, lines) {
  x.rec.phase = 'intro';
  x.setBg(BG);
  x.stage.setDraw((ctx, w, h) => drawText(ctx, w, h, [...lines, 'Press SPACE or tap to start  ·  ESC stops']));
  await x.stage.waitKey();
}

const stimSize = (w, h, f) => Math.min(w / 2, h) * f;
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

export async function runCalibration(x) {
  const { stage, cfg, rec } = x;
  rec.task = 'calibration';
  await intro(x, cfg.attention
    ? ['Gaze calibration', 'A spinning star appears at the centre and towards each edge.', 'Start when the infant is watching the screen.']
    : ['Gaze calibration', 'Follow the dot with your eyes. Keep your head still.']);
  const pts = [];
  const targets = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75], [0.25, 0.5], [0.75, 0.5], [0.5, 0.5]];
  for (const [i, [tx, ty]] of targets.entries()) {
    Object.assign(rec, { trial: i, phase: 'target', cond: `${tx}_${ty}` });
    x.mark('target_on');
    if (cfg.attention) chirp();
    const t0 = performance.now();
    stage.setDraw((ctx, w, h, t) => (cfg.attention ? drawGetter(ctx, tx * w, ty * h, Math.min(w, h) * 0.1, t) : drawDot(ctx, tx * w, ty * h, t)));
    const off = x.tracker.onSample((s) => {
      if (s.face && !s.blink && Number.isFinite(s.h) && s.t - t0 > 0.4 * cfg.calibDwell) pts.push({ x: tx, y: ty, h: s.h, yaw: s.yaw, v: s.v, pitch: s.pitch });
    });
    try { await stage.wait(cfg.calibDwell); } finally { off(); }
  }
  const q = x.tracker.fitCalibration(pts);
  const pct = (v) => (Number.isFinite(v) ? `${(100 * v).toFixed(0)}%` : 'n/a');
  return {
    kind: 'calibration', title: 'Gaze calibration',
    lines: q.ok ? [
      `Left/right: ${pct(q.acc)} of samples on the correct side (${q.n} samples).`,
      `Up/down: ${pct(q.accV)} on the correct side. Vertical gaze from a webcam is much less reliable than horizontal.`,
    ] : [
      `Calibration failed (${Number.isFinite(q.acc) ? `${pct(q.acc)} correct` : 'too few samples'}). Automatic gaze is off; use ←/→ key coding or recalibrate.`,
    ],
    data: q,
  };
}

export async function runLightReflex(x) {
  const { stage, rec, session } = x;
  rec.task = 'plr';
  await intro(x, ['Light-reflex check', 'Keep the room lights on and look at the central cross.', 'The screen will flash bright three times (25 s).']);
  const DARK = 25, BRIGHT = 255, ON = 2000, OFF = 5000, onsets = [];
  stage.setDraw((ctx, w, h) => drawFix(ctx, w / 2, h / 2, stage.bg));
  Object.assign(rec, { trial: -1, phase: 'dark', cond: '' });
  x.setBg(DARK);
  await stage.wait(4000);
  for (let i = 0; i < 3; i++) {
    Object.assign(rec, { trial: i, phase: 'bright' });
    x.setBg(BRIGHT); onsets.push(performance.now()); x.mark('flash_on');
    await stage.wait(ON);
    rec.phase = 'dark';
    x.setBg(DARK); x.mark('flash_off');
    await stage.wait(OFF);
  }
  const eps = onsets.map((t0) => epoch(session.samples, t0, { tmin: -1, tmax: 6 })).filter(Boolean);
  const avg = average(eps);
  if (!avg) return { kind: 'plr', title: 'Light-reflex check', lines: ['Too few valid pupil samples. Move closer, add light on the face, and try again.'] };
  let k = 0;
  avg.t.forEach((t, i) => { if (t > 0.2 && t < 3.5 && avg.mean[i] < avg.mean[k]) k = i; });
  const base = mean(eps.map((e) => e.base)), amp = -avg.mean[k];
  const noise = Math.sqrt(mean(avg.t.map((t, i) => (t < 0 ? avg.mean[i] ** 2 : NaN)).filter(Number.isFinite)));
  return {
    kind: 'plr', title: 'Light-reflex check',
    lines: [
      `Baseline pupil ≈ ${base.toFixed(2)} mm (assuming an ${IRIS_MM} mm iris); ${eps.length}/3 flashes usable.`,
      `Peak constriction ${amp.toFixed(2)} mm (${(100 * amp / base).toFixed(0)}%) at ${avg.t[k].toFixed(2)} s after flash onset.`,
      `Pre-flash noise of the averaged trace: ${noise.toFixed(3)} mm RMS.`,
      eps.length === 3 && amp > 4 * noise ? 'The reflex is clearly resolved on this device.'
        : 'Not reliable: flashes were lost or the response is not clearly above the noise, so do not trust the numbers above.',
    ],
    plot: {
      type: 'line', xlabel: 'Time from flash onset (s)', ylabel: 'Pupil change (est. mm)', zero: true, shades: [[0, ON / 1000]],
      series: [{ label: 'Mean of flashes', color: COLORS[0], x: avg.t, y: avg.mean, band: avg.sem }],
    },
    data: { baseline_mm: base, constriction_mm: amp, latency_s: avg.t[k], noise_rms_mm: noise, n: eps.length },
  };
}

export async function runPaired(x) {
  const { stage, cfg, rec, session, stim } = x;
  const c = cfg.paired, { A, B } = stim;
  rec.task = 'paired';
  await intro(x, cfg.attention
    ? ['Preferential looking', 'Press SPACE when the infant looks at the star to start each trial.', 'Optional: hold ← / → while the infant looks at the left / right picture.']
    : ['Preferential looking', 'Just look at the pictures however you like.']);
  const sides = shuffle(Array.from({ length: c.trials }, (_, i) => (i % 2 ? 'L' : 'R')));
  const pair = (l, r) => (ctx, w, h) => {
    const s = stimSize(w, h, c.size);
    ctx.drawImage(l, 0.25 * w - s / 2, h / 2 - s / 2, s, s);
    ctx.drawImage(r, 0.75 * w - s / 2, h / 2 - s / 2, s, s);
  };
  const centre = (ctx, w, h, t) => (cfg.attention ? drawGetter(ctx, w / 2, h / 2, Math.min(w, h) * 0.1, t) : drawFix(ctx, w / 2, h / 2));
  const trials = [];
  for (let i = 0; i < c.trials; i++) {
    const fam = A[i % A.length], novA = A[(i + 1) % A.length], novB = B[i % B.length], bSide = sides[i];
    Object.assign(rec, { trial: i, phase: 'attention', cond: '' });
    stage.setDraw(centre);
    if (cfg.attention) chirp();
    if (cfg.selfPaced) await stage.waitKey(); else await stage.wait(c.gap);

    Object.assign(rec, { phase: 'fam', cond: 'fam' });
    stage.setDraw(pair(fam, fam)); x.mark('fam_on');
    await stage.wait(c.fam);

    Object.assign(rec, { phase: 'gap', cond: '' });
    stage.setDraw(centre); x.mark('fam_off');
    await stage.wait(c.gap);

    Object.assign(rec, { phase: 'test', cond: `B_${bSide}` });
    stage.setDraw(bSide === 'L' ? pair(novB, novA) : pair(novA, novB));
    const t0 = performance.now(); x.mark('test_on');
    await stage.wait(c.test);
    const t1 = performance.now(); x.mark('test_off');

    const lt = lookTimes(session.samples, t0, t1);
    const pref = (b, a) => (a + b > 0 ? b / (a + b) : NaN);
    trials.push({
      trial: i + 1, b_side: bSide,
      auto_B_ms: bSide === 'L' ? lt.autoL : lt.autoR, auto_A_ms: bSide === 'L' ? lt.autoR : lt.autoL,
      manual_B_ms: bSide === 'L' ? lt.manL : lt.manR, manual_A_ms: bSide === 'L' ? lt.manR : lt.manL,
      tracked_frac: lt.tracked / lt.total,
      auto_pref_B: pref(bSide === 'L' ? lt.autoL : lt.autoR, bSide === 'L' ? lt.autoR : lt.autoL),
      manual_pref_B: pref(bSide === 'L' ? lt.manL : lt.manR, bSide === 'L' ? lt.manR : lt.manL),
    });
  }
  const fin = (k) => trials.map((t) => t[k]).filter(Number.isFinite);
  const auto = fin('auto_pref_B'), man = fin('manual_pref_B');
  const useMan = !auto.length && man.length > 0;
  const lines = [
    auto.length ? `Automatic gaze: mean preference for the other-category picture = ${mean(auto).toFixed(2)} (${auto.length}/${c.trials} trials; 0.50 = no preference).`
      : 'Automatic gaze: no usable trials (gaze not calibrated or face not tracked).',
    `Face tracked for ${(100 * mean(fin('tracked_frac'))).toFixed(0)}% of test time.`,
  ];
  if (man.length) lines.push(`Key coding: mean preference = ${mean(man).toFixed(2)} (${man.length} trials).`);
  return {
    kind: 'paired', title: 'Preferential looking', lines, trials,
    plot: {
      type: 'bar', labels: trials.map((t) => `T${t.trial}`), values: trials.map((t) => (useMan ? t.manual_pref_B : t.auto_pref_B)),
      ylabel: 'Share of looking at category B', xlabel: `Test trial (${useMan ? 'key coding' : 'automatic gaze'})`, ylim: [0, 1], ref: 0.5, color: COLORS[0],
    },
    data: { mean_auto_pref_B: mean(auto), mean_manual_pref_B: mean(man) },
  };
}

// Odd-one-out: three copies of one shape and one different shape in a row. Because webcam gaze is only
// reliable for left vs. right, looks are scored by screen half (chance = 0.5), not by item.
export async function runOddOne(x) {
  const { stage, cfg, rec, session, stim } = x;
  const c = cfg.oddone, instructed = x.instructed && !cfg.attention;
  rec.task = 'oddone';
  const pool = stim.custom
    ? stim.A.map((a, i) => ({ a, b: stim.B[i % stim.B.length], level: 'uploaded' }))
    : makeGradedPairs(Math.ceil(c.trials / 4));
  const pairs = shuffle(Array.from({ length: c.trials }, (_, i) => pool[i % pool.length]));
  const slots = shuffle(Array.from({ length: c.trials }, (_, i) => i % 4));
  await intro(x, cfg.attention
    ? ['Odd one out', 'Press SPACE when the infant looks at the star to start each trial.', 'Optional: hold ← / → while the infant looks at the left / right half.']
    : ['Odd one out', instructed ? 'Four shapes appear. Look at the one that differs from the others.' : 'Four shapes appear. Just look at them however you like.', 'Look at the cross between trials.']);
  const centre = (ctx, w, h, t) => (cfg.attention ? drawGetter(ctx, w / 2, h / 2, Math.min(w, h) * 0.1, t) : drawFix(ctx, w / 2, h / 2));
  const trials = [];
  for (let i = 0; i < c.trials; i++) {
    const { a, b, level } = pairs[i], slot = slots[i], oddSide = slot < 2 ? 'L' : 'R';
    // Half the trials swap roles so neither shape is odd more often.
    const [common, odd] = i % 2 ? [b, a] : [a, b];
    Object.assign(rec, { trial: i, phase: 'attention', cond: '' });
    stage.setDraw(centre);
    if (cfg.attention) chirp();
    if (cfg.selfPaced) await stage.waitKey(); else await stage.wait(c.gap);

    // Size jitter, so the odd item cannot be found from a pixel-level mismatch alone.
    const jit = Array.from({ length: 4 }, () => 0.8 + 0.2 * Math.random());
    Object.assign(rec, { phase: 'array', cond: `odd${slot}_lvl${level}` });
    stage.setDraw((ctx, w, h) => {
      for (let k = 0; k < 4; k++) {
        const s = Math.min(0.21 * w, 0.6 * h) * jit[k];
        ctx.drawImage(k === slot ? odd : common, (k + 0.5) / 4 * w - s / 2, h / 2 - s / 2, s, s);
      }
    });
    const t0 = performance.now(); x.mark('array_on');
    await stage.wait(c.dur);
    const t1 = performance.now(); x.mark('array_off');

    const lt = lookTimes(session.samples, t0, t1), fl = firstLook(session.samples, t0, t1), flm = firstLook(session.samples, t0, t1, 'manual', 0, 2);
    const share = (l, r) => (l + r > 0 ? (oddSide === 'L' ? l : r) / (l + r) : NaN);
    trials.push({
      trial: i + 1, level, odd_slot: slot, odd_side: oddSide,
      first_look_side: fl.side, first_look_correct: fl.side ? +(fl.side === oddSide) : NaN, first_look_latency_ms: fl.latency,
      dwell_share_odd: share(lt.autoL, lt.autoR),
      manual_first_correct: flm.side ? +(flm.side === oddSide) : NaN, manual_dwell_share_odd: share(lt.manL, lt.manR),
      tracked_frac: lt.tracked / lt.total,
    });
  }
  const fin = (rows, k) => rows.map((t) => t[k]).filter(Number.isFinite);
  const levels = [...new Set(trials.map((t) => t.level))].sort((p, q) => p - q);
  const byLevel = levels.map((lv) => {
    const rows = trials.filter((t) => t.level === lv);
    return { level: lv, n: rows.length, first: mean(fin(rows, 'first_look_correct')), dwell: mean(fin(rows, 'dwell_share_odd')) };
  });
  const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : 'n/a');
  const lines = [
    `Instruction: ${instructed ? '"look at the odd one"' : 'none (free viewing)'}. Looks are scored by screen half; chance = 0.50.`,
    `First look to the odd side: ${f2(mean(fin(trials, 'first_look_correct')))} (${fin(trials, 'first_look_correct').length}/${c.trials} trials), mean latency ${f2(mean(fin(trials, 'first_look_latency_ms')) / 1000)} s.`,
    `Dwell share on the odd side: ${f2(mean(fin(trials, 'dwell_share_odd')))}.`,
    ...byLevel.map((q) => `Dissimilarity ${q.level}: first look ${f2(q.first)}, dwell share ${f2(q.dwell)} (${q.n} trials).`),
  ];
  const man = fin(trials, 'manual_dwell_share_odd');
  if (man.length) lines.push(`Key coding: dwell share ${mean(man).toFixed(2)}, first look ${mean(fin(trials, 'manual_first_correct')).toFixed(2)} (${man.length} trials).`);
  return {
    kind: 'oddone', title: 'Odd one out', lines, trials,
    plot: {
      type: 'bar', labels: byLevel.map((q) => String(q.level)), values: byLevel.map((q) => q.dwell),
      ylabel: 'Dwell share on odd side', xlabel: 'Shape dissimilarity (added-component amplitude)', ylim: [0, 1], ref: 0.5, color: COLORS[0],
    },
    data: { instructed, by_level: byLevel },
  };
}

// 80% standards; deviants never within the first 3 trials and always >= 2 standards apart.
function oddballSequence(n) {
  let nDev = 2 * Math.round(0.1 * n);
  while (nDev > 0 && n - 1 - (3 + 3 * (nDev - 1)) < 0) nDev -= 2;
  const seq = Array(n).fill('standard');
  const extra = Array(nDev).fill(0), slack = n - 1 - (3 + 3 * (nDev - 1));
  for (let i = 0; i < slack; i++) { const k = Math.floor(Math.random() * (nDev + 1)); if (k < nDev) extra[k]++; }
  const kinds = shuffle(Array.from({ length: nDev }, (_, i) => (i % 2 ? 'within' : 'across')));
  let pos = 3;
  for (let k = 0; k < nDev; k++) { pos += extra[k] + (k ? 3 : 0); seq[pos] = kinds[k]; }
  return seq;
}

export async function runOddball(x) {
  const { stage, cfg, rec, session, stim } = x;
  const c = cfg.oddball, { A, B } = stim;
  rec.task = 'oddball';
  await intro(x, cfg.attention
    ? ['Pupil oddball', 'Pictures appear at the centre; no response is needed.', `About ${Math.round(c.trials * (c.stim + c.isi) / 1000)} s.`]
    : ['Pupil oddball', 'Keep looking at the central cross. No response is needed.', `About ${Math.round(c.trials * (c.stim + c.isi + 100) / 1000)} s. Try to blink between pictures.`]);
  const seq = oddballSequence(c.trials), onsets = [];
  const simAmp = { standard: 0.002, within: 0.008, across: 0.02 };
  let kW = 0, kB = 0;
  const fix = (ctx, w, h) => { if (!cfg.attention) drawFix(ctx, w / 2, h / 2); };
  stage.setDraw(fix);
  Object.assign(rec, { trial: -1, phase: 'isi', cond: '' });
  await stage.wait(1500);
  for (let i = 0; i < seq.length; i++) {
    const cond = seq[i];
    const img = cond === 'standard' ? A[0] : cond === 'within' ? A[1 + (kW++ % (A.length - 1))] : B[kB++ % B.length];
    Object.assign(rec, { trial: i, phase: 'stim', cond });
    const jit = 0.8 + 0.2 * Math.random();
    stage.setDraw((ctx, w, h) => { const s = stimSize(w, h, c.size) * jit; ctx.drawImage(img, w / 2 - s / 2, h / 2 - s / 2, s, s); fix(ctx, w, h); });
    onsets.push({ t: performance.now(), cond }); x.mark('stim_on');
    x.tracker.simEvent(simAmp[cond]);
    await stage.wait(c.stim);
    rec.phase = 'isi';
    stage.setDraw(fix); x.mark('stim_off');
    await stage.wait(c.isi + 200 * Math.random());
  }
  const conds = [['standard', 'Standard (repeated A)'], ['within', 'Deviant, same category (new A)'], ['across', 'Deviant, other category (B)']];
  const series = [], lines = [], data = {};
  conds.forEach(([key, label], k) => {
    const all = onsets.filter((o) => o.cond === key);
    const avg = average(all.map((o) => epoch(session.samples, o.t, { tmin: -0.2, tmax: 2 })).filter(Boolean));
    if (!avg) { lines.push(`${label}: no usable epochs (0/${all.length}).`); return; }
    const m = windowMean(avg.t, avg.mean, 0.5, 1.5);
    data[key] = { n: avg.n, mean_mm_0p5_1p5s: m };
    lines.push(`${label}: ${m >= 0 ? '+' : ''}${m.toFixed(3)} mm mean change 0.5–1.5 s (${avg.n}/${all.length} epochs).`);
    series.push({ label, color: COLORS[k], x: avg.t, y: avg.mean, band: avg.sem });
  });
  if (data.within && data.across) lines.push(`Category effect (other − same category deviant): ${(data.across.mean_mm_0p5_1p5s - data.within.mean_mm_0p5_1p5s).toFixed(3)} mm.`);
  return {
    kind: 'oddball', title: 'Pupil oddball', lines, data,
    plot: series.length ? { type: 'line', xlabel: 'Time from picture onset (s)', ylabel: 'Pupil change (est. mm)', zero: true, shades: [[0, c.stim / 1000]], series } : null,
  };
}
