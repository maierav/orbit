import { BG, makeGradedPairs, makeNoveltyPairs } from './stimuli.js';
import { lookTimes, centreOffset, firstLook, mean } from './analysis.js';
import { COLORS } from './plot.js';

// Durations in ms; `size` is the stimulus edge as a fraction of min(half screen width, screen height).
export const MODES = {
  adult: {
    attention: false, selfPaced: false, calibDwell: 1600,
    paired: { trials: 24, fam: 5000, test: 5000, gap: 2000, size: 0.9 },
    oddone: { trials: 16, dur: 2500, gap: 1000 },
  },
  infant: {
    attention: true, selfPaced: true, calibDwell: 2200,
    paired: { trials: 8, fam: 10000, test: 8000, gap: 1500, size: 1 },
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
    this.noise = null;
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
    this.noise = null;
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

  // Full-screen background noise from a tileable image, drawn at `scale` screen pixels per noise pixel
  // from a new random offset each time this is called. Pass null to switch it off.
  setNoise(tile, scale = 1) {
    this.noise = tile ? { pattern: this.ctx.createPattern(tile, 'repeat'), scale, ox: Math.floor(Math.random() * tile.width), oy: Math.floor(Math.random() * tile.height) } : null;
  }

  _tick(t) {
    const dpr = window.devicePixelRatio || 1, w = this.cv.clientWidth, h = this.cv.clientHeight;
    if (this.cv.width !== Math.round(w * dpr) || this.cv.height !== Math.round(h * dpr)) {
      this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = gray(this.bg);
    ctx.fillRect(0, 0, w, h);
    if (this.noise) {
      const n = this.noise;
      ctx.save();
      ctx.scale(n.scale, n.scale);
      ctx.translate(-n.ox, -n.oy);
      ctx.fillStyle = n.pattern;
      ctx.fillRect(n.ox, n.oy, w / n.scale + 1, h / n.scale + 1);
      ctx.restore();
    }
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

// Fixation target after Thaler, Schuetz, Goodale & Gegenfurtner (2013, Vision Research 76:31-42): a
// bull's eye combined with a cross hair (outer disc 0.6 deg, inner dot 0.2 deg), which gave the most
// stable fixation of the shapes they compared. `born` (ms) makes it shrink onto its position over
// 400 ms, an addition of ours meant to draw the eyes without any instruction.
let pxPerDeg = 36;
export function setPxPerDeg(v) { if (v > 5 && v < 400) pxPerDeg = v; }
function drawFix(ctx, x, y, bg = BG, born = null) {
  const grow = born == null ? 1 : 1 + 2 * Math.max(0, 1 - (performance.now() - born) / 400);
  const R = 0.3 * pxPerDeg * grow, r = Math.max(1.5, 0.1 * pxPerDeg * grow);
  const ink = bg > 110 ? '#000' : '#fff';
  ctx.fillStyle = ink; ctx.beginPath(); ctx.arc(x, y, R, 0, 2 * Math.PI); ctx.fill();
  ctx.strokeStyle = `rgb(${bg},${bg},${bg})`; ctx.lineWidth = 2 * r;
  ctx.beginPath(); ctx.moveTo(x - R, y); ctx.lineTo(x + R, y); ctx.moveTo(x, y - R); ctx.lineTo(x, y + R); ctx.stroke();
  ctx.fillStyle = ink; ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill();
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
  x.stage.bg = BG;
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

// Novelty preference (visual paired comparison). Two versions share this code:
//   image novelty   the same picture on both sides, a short blank, then that picture beside a new one
//                   (timing defaults follow Manns, Stark & Squire, 2000);
//   object novelty  two different views of one object, a blank, then a third view of it beside a
//                   different object, so a preference must rest on the object and not on the image.
// With the built-in stimulus set every participant given the same form sees the same trials in the same
// order; forms A and B differ only in which object of each pair is the familiar one. Pictures sit on
// full-screen low-contrast noise that is redrawn at every change of display.
async function runNovelty(x, test) {
  const { stage, cfg, rec, session, stim } = x;
  const c = { ...cfg.paired, ...(x.pairedOverride || {}) };
  const object = test === 'object_novelty';
  rec.task = object ? 'object' : 'paired';
  const title = object ? 'Object novelty' : 'Novelty preference';
  await x.setReady;  // the built-in pictures may still be downloading when a test is started quickly
  const set = stim.custom ? null : x.set;
  if (object && !set) return { kind: rec.task, title, lines: ['This test needs the built-in picture set, which is not loaded.'] };

  await intro(x, cfg.attention
    ? [title, 'Press SPACE when the infant looks at the star to start each trial.', 'Optional: hold ← / → while the infant looks at the left / right picture.']
    : [title, 'Pictures appear on the left and right. Simply look at them however you like.', 'Look at the round target whenever it appears.']);

  // Trial list: { studyL, studyR, fam, nov, novelSide } with canvases.
  let plan;
  if (set) {
    const list = set.spec.forms[x.form][test].slice(0, c.trials);
    stage.setDraw((ctx, w, h) => drawText(ctx, w, h, ['Loading pictures…']));
    const pics = await set.load(list.flatMap((t) => [...t.study, t.test_familiar, t.test_novel]));
    plan = list.map((t) => ({ studyL: pics[t.study[0]], studyR: pics[t.study[1]], fam: pics[t.test_familiar], nov: pics[t.test_novel], novelSide: t.novel_side, info: t }));
  } else {
    const pool = stim.custom ? stim.A.map((a, i) => ({ a, b: stim.B[i % stim.B.length] })) : makeNoveltyPairs(c.trials);
    const design = shuffle(Array.from({ length: c.trials }, (_, i) => ({ novelSide: i % 2 ? 'L' : 'R', swap: (i >> 1) % 2 === 1 })));
    plan = design.map((d, i) => {
      const p = pool[i % pool.length], [fam, nov] = d.swap ? [p.b, p.a] : [p.a, p.b];
      return { studyL: fam, studyR: fam, fam, nov, novelSide: d.novelSide, info: { roles_swapped: +d.swap } };
    });
  }
  const nTrials = plan.length;

  const picSize = (w, h) => Math.min(0.32 * w, 0.7 * h) * c.size;
  const pair = (l, r) => (ctx, w, h) => {
    const s = picSize(w, h);
    ctx.drawImage(l, 0.2 * w - s / 2, h / 2 - s / 2, s, s);
    ctx.drawImage(r, 0.8 * w - s / 2, h / 2 - s / 2, s, s);
  };
  let born = 0;
  const centre = (ctx, w, h, t) => (cfg.attention ? drawGetter(ctx, w / 2, h / 2, Math.min(w, h) * 0.1, t) : drawFix(ctx, w / 2, h / 2, BG, born));
  // A new stretch of background noise for every display, so the noise never repeats with a picture.
  const show = (draw) => { if (set) stage.setNoise(set.tile(), picSize(stage.cv.clientWidth, stage.cv.clientHeight) / set.spec.patch_px); born = performance.now(); stage.setDraw(draw); };

  const trials = [], windows = [];
  try {
    for (let i = 0; i < nTrials; i++) {
      const p = plan[i], novelSide = p.novelSide;
      Object.assign(rec, { trial: i, phase: 'attention', cond: '' });
      show(centre);
      if (cfg.attention) chirp();
      if (cfg.selfPaced) await stage.waitKey(); else await stage.wait(1000);

      Object.assign(rec, { phase: 'fam', cond: 'fam' });
      show(pair(p.studyL, p.studyR)); x.mark('fam_on');
      await stage.wait(c.fam);

      Object.assign(rec, { phase: 'gap', cond: '' });
      show(centre); x.mark('fam_off');
      await stage.wait(c.gap);

      Object.assign(rec, { phase: 'test', cond: `novel_${novelSide}` });
      show(novelSide === 'L' ? pair(p.nov, p.fam) : pair(p.fam, p.nov));
      const t0 = performance.now(); x.mark('test_on');
      await stage.wait(c.test);
      const t1 = performance.now(); x.mark('test_off');

      // Per-trial midline correction from where gaze sat on the central target just before the test.
      const off = cfg.attention ? 0 : centreOffset(session.samples, t0 - 600, t0);
      const lt = lookTimes(session.samples, t0, t1, off);
      const share = (l, r) => (l + r > 0 ? (novelSide === 'L' ? l : r) / (l + r) : NaN);
      windows.push({ t0, t1, off, novelSide });
      trials.push({
        trial: i + 1, pair: p.info.pair || '', family: p.info.family || '', familiar: p.info.familiar || '', novel: p.info.novel || '',
        novel_side: novelSide, midline_offset: off,
        auto_novel_ms: novelSide === 'L' ? lt.autoL : lt.autoR, auto_familiar_ms: novelSide === 'L' ? lt.autoR : lt.autoL,
        tracked_frac: lt.tracked / lt.total, novelty_pref: share(lt.autoL, lt.autoR), manual_novelty_pref: share(lt.manL, lt.manR),
      });
    }
  } finally { stage.setNoise(null); }

  // A trial counts only if at least 1 s of the test was classified as left or right.
  const usable = trials.filter((t) => t.auto_novel_ms + t.auto_familiar_ms >= Math.min(1000, 0.25 * c.test) && Number.isFinite(t.novelty_pref));
  const prefs = usable.map((t) => t.novelty_pref), man = trials.map((t) => t.manual_novelty_pref).filter(Number.isFinite);
  const stats = (a) => {
    const m = mean(a), sd = Math.sqrt(mean(a.map((v) => (v - m) ** 2)) * a.length / Math.max(1, a.length - 1));
    return { n: a.length, m, sd, d: (m - 0.5) / sd, t: (m - 0.5) / (sd / Math.sqrt(a.length)) };
  };
  const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : 'n/a');
  const what = object ? 'new object' : 'new picture';
  const lines = [], data = {
    settings: { trials: nTrials, fam_ms: c.fam, gap_ms: c.gap, test_ms: c.test },
    stimulus_set: set ? set.spec.name : (stim.custom ? 'uploaded' : 'placeholder shapes'), form: set ? x.form : '',
  };
  lines.push(set ? `Pictures: built-in set "${set.spec.name}", form ${x.form}, fixed trial order.` : 'Pictures: placeholder shapes in random order.');
  if (prefs.length >= 2) {
    const s = stats(prefs);
    Object.assign(data, { novelty_pref_mean: s.m, novelty_pref_sd: s.sd, d_across_trials: s.d, t_across_trials: s.t, n_usable: s.n });
    lines.push(`Looking at the ${what}: ${(100 * s.m).toFixed(0)}% of looking time (50% = no preference), from ${s.n}/${nTrials} usable trials.`);
    lines.push(`Across trials: SD ${(100 * s.sd).toFixed(0)} points, effect size d = ${f2(s.d)}, t(${s.n - 1}) = ${f2(s.t)}.${object ? '' : ' Lab studies report 59–71%.'}`);
    // How the estimate builds up, to judge how few trials and how short a test would do.
    const steps = [4, 8, 12, 16, 24, 32, 40].filter((k) => k < prefs.length);
    if (steps.length) lines.push(`By number of trials: ${steps.map((k) => { const q = stats(prefs.slice(0, k)); return `${k}: ${(100 * q.m).toFixed(0)}% (t ${f2(q.t)})`; }).join(' · ')}.`);
    const secs = [];
    for (let T = 1000; T < c.test; T += 1000) {
      const part = windows.map((wn) => { const q = lookTimes(session.samples, wn.t0, wn.t0 + T, wn.off); const nv = wn.novelSide === 'L' ? q.autoL : q.autoR; return nv / (q.autoL + q.autoR); }).filter(Number.isFinite);
      if (part.length >= 2) secs.push(`${T / 1000} s: ${(100 * mean(part)).toFixed(0)}%`);
    }
    if (secs.length) lines.push(`Using only the first part of each test: ${secs.join(' · ')}.`);
  } else lines.push('Too few usable trials (gaze not calibrated, or the face was not tracked).');
  lines.push(`Face tracked for ${(100 * mean(trials.map((t) => t.tracked_frac))).toFixed(0)}% of test time.`);
  if (man.length) lines.push(`Key coding: ${(100 * mean(man)).toFixed(0)}% to the ${what} (${man.length} trials).`);

  // Time course of looking at the new item within the test, averaged over trials.
  const bin = 250, tt = [], pm = [], pse = [];
  for (let b = 0; b + bin <= c.test; b += bin) {
    const v = windows.map((wn) => { const q = lookTimes(session.samples, wn.t0 + b, wn.t0 + b + bin, wn.off); const nv = wn.novelSide === 'L' ? q.autoL : q.autoR; return nv / (q.autoL + q.autoR); }).filter(Number.isFinite);
    tt.push((b + bin / 2) / 1000);
    pm.push(v.length ? mean(v) : NaN);
    pse.push(v.length > 1 ? Math.sqrt(mean(v.map((q) => (q - mean(v)) ** 2)) / (v.length - 1)) : 0);
  }
  return {
    kind: rec.task, title, lines, trials, data,
    plot: {
      type: 'line', xlabel: 'Time from test onset (s)', ylabel: `Share of looks at ${what}`, ylim: [0, 1],
      series: [
        { label: what[0].toUpperCase() + what.slice(1), color: COLORS[0], x: tt, y: pm, band: pse },
        { label: 'No preference', color: '#898781', x: [0, c.test / 1000], y: [0.5, 0.5] },
      ],
    },
  };
}
export const runPaired = (x) => runNovelty(x, 'image_novelty');
export const runObjectNovelty = (x) => runNovelty(x, 'object_novelty');

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
    : ['Odd one out', instructed ? 'Four shapes appear. Look at the one that differs from the others.' : 'Four shapes appear. Just look at them however you like.', 'Look at the round target between trials.']);
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
