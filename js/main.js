import { Tracker, IRIS_MM } from './tracker.js';
import { makeDemoSet, loadFiles } from './stimuli.js';
import { MODES, Stage, runCalibration, runLightReflex, runPaired, runOddball, runOddOne } from './tasks.js';
import { linePlot, barPlot, COLORS } from './plot.js';

const $ = (id) => document.getElementById(id);
const SIM = new URLSearchParams(location.search).has('sim');

const video = $('video'), overlay = $('overlay'), eyesCv = $('eyes');
const tracker = new Tracker(video, { sim: SIM });
const stage = new Stage($('stage'));
const session = {
  meta: { started: new Date().toISOString(), userAgent: navigator.userAgent, simulated: SIM, iris_mm_assumed: IRIS_MM },
  samples: [], events: [], results: [],
};
const rec = { active: false, task: '', trial: -1, phase: '', cond: '', manual: '' };
let mode = 'adult';
let stim = makeDemoSet();

const x = {
  stage, tracker, session, rec, stim,
  get mode() { return mode; },
  get cfg() { return MODES[mode]; },
  get instructed() { return $('instructed').checked; },
  mark(type) { session.events.push({ t: performance.now(), mode, task: rec.task, trial: rec.trial, type, cond: rec.cond }); },
  setBg(v) { stage.bg = v; tracker.simLuma = v / 255; },
};

const status = (msg) => { $('status').textContent = msg; };

// ---- mode toggle -------------------------------------------------------------------------------
function setMode(m) {
  mode = m;
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === m)));
  const c = MODES[m], s = (ms) => `${ms / 1000} s`;
  $('modehint').textContent = m === 'infant'
    ? 'Infant mode: animated attention getters with sound, larger pictures, longer looks, and each looking trial starts when the experimenter presses SPACE. Hold ← / → to key-code looking direction alongside the automatic estimate.'
    : 'Adult mode: fixation cross, written instructions, automatic pacing.';
  $('d-calibration').textContent = `Centre / left / right targets, ${s(c.calibDwell)} each`;
  $('d-plr').textContent = '3 bright flashes; measures the noise floor of this device';
  $('d-paired').textContent = `${c.paired.trials} trials: familiarise ${s(c.paired.fam)}, then new A vs. B for ${s(c.paired.test)}`;
  $('d-oddone').textContent = `${c.oddone.trials} trials: 3 same + 1 different shape for ${s(c.oddone.dur)}, graded dissimilarity`;
  $('instructed').disabled = m === 'infant';
  $('d-oddball').textContent = `${c.oddball.trials} pictures, 20% deviants (same vs. other category), ~${Math.round(c.oddball.trials * (c.oddball.stim + c.oddball.isi) / 1000)} s`;
}
document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

// ---- stimuli -----------------------------------------------------------------------------------
function showThumbs() {
  for (const k of ['A', 'B']) {
    const box = $(`thumbs${k}`);
    box.replaceChildren(...stim[k].map((cv) => {
      const t = document.createElement('canvas');
      t.width = t.height = 112;
      t.getContext('2d').drawImage(cv, 0, 0, 112, 112);
      return t;
    }));
  }
}
async function onFiles(k, input) {
  if (!input.files.length) return;
  try {
    const set = await loadFiles(input.files, $('equalize').checked);
    if (set.length < 2) { status(`Category ${k} needs at least 2 images.`); return; }
    stim[k] = set;
    stim.custom = true;
    showThumbs();
  } catch (e) { status(`Could not read images: ${e.message}`); }
}
$('filesA').addEventListener('change', (e) => onFiles('A', e.target));
$('filesB').addEventListener('change', (e) => onFiles('B', e.target));
$('demo').addEventListener('click', () => { Object.assign(stim, makeDemoSet(), { custom: false }); showThumbs(); });

// ---- live view ---------------------------------------------------------------------------------
const live = [];
let lastUi = 0;

function drawOverlay(s) {
  const W = video.videoWidth, H = video.videoHeight;
  if (!W) return;
  if (overlay.width !== W) { overlay.width = W; overlay.height = H; }
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const ectx = eyesCv.getContext('2d'), half = eyesCv.width / 2;
  ectx.fillStyle = '#f3f2ee';
  ectx.fillRect(0, 0, eyesCv.width, eyesCv.height);
  ctx.lineWidth = Math.max(1, W / 640);
  [...s.eyes].sort((a, b) => a.x - b.x).forEach((e, k) => {
    ctx.strokeStyle = COLORS[0]; ctx.beginPath(); ctx.arc(e.x, e.y, e.R, 0, 2 * Math.PI); ctx.stroke();
    if (e.ok) { ctx.strokeStyle = COLORS[1]; ctx.beginPath(); ctx.arc(e.px, e.py, e.pr, 0, 2 * Math.PI); ctx.stroke(); }
    const span = 3.6 * e.R, sc = half / span;
    ectx.drawImage(video, e.x - span / 2, e.y - span / 2, span, span, k * half, 0, half, eyesCv.height);
    ectx.lineWidth = 1.5;
    ectx.strokeStyle = COLORS[0]; ectx.beginPath(); ectx.arc(k * half + half / 2, eyesCv.height / 2, e.R * sc, 0, 2 * Math.PI); ectx.stroke();
    if (e.ok) {
      ectx.strokeStyle = COLORS[1]; ectx.beginPath();
      ectx.arc(k * half + half / 2 + (e.px - e.x) * sc, eyesCv.height / 2 + (e.py - e.y) * sc, e.pr * sc, 0, 2 * Math.PI); ectx.stroke();
    }
  });
}

function chip(id, text, warn = false) { const el = $(id); el.textContent = text; el.classList.toggle('warn', warn); }

tracker.onSample((s) => {
  if (rec.active) {
    session.samples.push({
      t: s.t, mode, task: rec.task, trial: rec.trial, phase: rec.phase, cond: rec.cond, face: s.face, blink: s.blink,
      pL: s.pL, pR: s.pR, p: s.p, irisPx: s.irisPx, contrast: s.contrast, h: s.h, yaw: s.yaw, gx: s.gx, side: s.side, manual: rec.manual,
    });
    return;
  }
  live.push({ t: s.t, mm: s.p * IRIS_MM });
  while (live.length && s.t - live[0].t > 10000) live.shift();
  if (!SIM) drawOverlay(s);
  if (s.t - lastUi < 150) return;
  lastUi = s.t;
  chip('chip-fps', `${tracker.fps.toFixed(0)} fps`, tracker.fps < 20);
  chip('chip-iris', s.face ? `iris ${(2 * s.irisPx).toFixed(0)} px` : 'no face', !s.face || s.irisPx < 12);
  chip('chip-pupil', Number.isFinite(s.p) ? `pupil ${(s.p * IRIS_MM).toFixed(2)} mm` : 'pupil –', s.face && !s.blink && !Number.isFinite(s.p));
  chip('chip-gaze', Number.isFinite(s.gx) ? `gaze ${{ L: 'left', R: 'right', C: 'centre' }[s.side]}` : 'gaze: not calibrated');
  linePlot($('live'), {
    hover: false, xlim: [-10, 0], xlabel: 'Time (s)', ylabel: 'mm',
    series: [{ label: 'Pupil', color: COLORS[0], x: live.map((q) => (q.t - s.t) / 1000), y: live.map((q) => q.mm) }],
  });
});

$('start').addEventListener('click', async () => {
  if (tracker.running) return;
  $('start').disabled = true;
  status(SIM ? 'Starting simulated tracker…' : 'Starting camera and loading the face model (first load downloads ~4 MB)…');
  try {
    const res = await tracker.start();
    session.meta.video = res;
    $('camhint').hidden = true;
    chip('chip-res', SIM ? 'simulated' : `${res.width}×${res.height}`, !SIM && res.height < 720);
    status(SIM ? 'Simulation: pupil follows screen brightness, gaze follows the pointer.'
      : 'Tracking. Sit so the iris spans at least ~25 px, with even light on the face and no glare on glasses.');
    $('start').textContent = 'Camera running';
  } catch (e) {
    console.error(e);
    status(`Could not start: ${e.message}`);
    $('start').disabled = false;
  }
});

// Raw (unannotated, native-resolution) crops of both eyes, saved locally for tuning the pupil fit.
let lastEyes = [];
tracker.onSample((s) => { if (s.eyes.length === 2) lastEyes = s.eyes; });
$('snap').addEventListener('click', () => {
  if (!lastEyes.length || !video.videoWidth) { status('No eyes tracked yet.'); return; }
  const span = Math.round(4 * Math.max(lastEyes[0].R, lastEyes[1].R)), cv = document.createElement('canvas');
  cv.width = 2 * span; cv.height = span;
  const ctx = cv.getContext('2d');
  [...lastEyes].sort((a, b) => a.x - b.x).forEach((e, k) => ctx.drawImage(video, Math.round(e.x - span / 2), Math.round(e.y - span / 2), span, span, k * span, 0, span, span));
  cv.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `orbit_eyes_irisR${lastEyes[0].R.toFixed(1)}px.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, 'image/png');
});

// ---- tasks -------------------------------------------------------------------------------------
window.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') rec.manual = 'L'; else if (e.key === 'ArrowRight') rec.manual = 'R'; });
window.addEventListener('keyup', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') rec.manual = ''; });

// Tracking-quality covariates for one task run (the analogue of EEG signal-quality covariates).
function quality(t0) {
  const ss = session.samples.filter((q) => q.t >= t0), n = ss.length;
  if (n < 2) return null;
  const avg = (k) => { const v = ss.map((q) => q[k]).filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  return {
    n_samples: n, fps: 1000 * (n - 1) / (ss[n - 1].t - ss[0].t),
    face_frac: ss.filter((q) => q.face).length / n, pupil_valid_frac: ss.filter((q) => Number.isFinite(q.p)).length / n,
    blink_frac: ss.filter((q) => q.blink).length / n, iris_radius_px: avg('irisPx'), pupil_iris_contrast: avg('contrast'),
  };
}

function showResult(r) {
  const list = $('resultlist');
  if (!session.results.length) list.replaceChildren();
  session.results.push({ kind: r.kind, mode, time: new Date().toISOString(), lines: r.lines, data: r.data, trials: r.trials, quality: r.quality });
  const box = document.createElement('div');
  box.className = 'result';
  const h = document.createElement('h3');
  h.textContent = `${r.title} · ${mode.toUpperCase()} · ${new Date().toLocaleTimeString()}`;
  box.append(h);
  let cv = null;
  if (r.plot) {
    if (r.plot.type === 'line' && r.plot.series.length > 1) {
      const lg = document.createElement('div');
      lg.className = 'legend';
      for (const q of r.plot.series) {
        const sp = document.createElement('span'), sw = document.createElement('i');
        sw.style.background = q.color;
        sp.append(sw, q.label);
        lg.append(sp);
      }
      box.append(lg);
    }
    cv = document.createElement('canvas');
    cv.className = 'plot';
    box.append(cv);
  }
  const ul = document.createElement('ul');
  for (const ln of r.lines) { const li = document.createElement('li'); li.textContent = ln; ul.append(li); }
  box.append(ul);
  list.prepend(box);
  if (cv) {
    const render = () => (r.plot.type === 'bar' ? barPlot(cv, r.plot) : linePlot(cv, r.plot));
    render();
    window.addEventListener('resize', render);
  }
}

const TASKS = {
  calibration: { fn: runCalibration },
  plr: { fn: runLightReflex },
  paired: { fn: runPaired, gaze: true },
  oddone: { fn: runOddOne, gaze: true },
  oddball: { fn: runOddball },
};

async function runTask(name) {
  if (!tracker.running) { status('Start the camera first.'); return; }
  if (rec.active) return;
  const out = [];
  await stage.open();
  rec.active = true;
  try {
    if (TASKS[name].gaze && !tracker.calib) out.push(await runCalibration(x));
    const t0 = performance.now(), res = await TASKS[name].fn(x);
    res.quality = quality(t0);
    out.push(res);
    status('Done.');
  } catch (e) {
    if (e.message === 'aborted') status('Task stopped.');
    else { console.error(e); status(`Task failed: ${e.message}`); }
  } finally {
    Object.assign(rec, { active: false, task: '', trial: -1, phase: '', cond: '' });
    x.setBg(128);
    tracker.simLuma = 0.5;
    stage.close();
  }
  out.forEach(showResult);
}
document.querySelectorAll('[data-task]').forEach((b) => b.addEventListener('click', () => runTask(b.dataset.task)));

// ---- export ------------------------------------------------------------------------------------
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const num = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '');
const stamp = () => session.meta.started.replace(/[:.]/g, '-');

$('dl-samples').addEventListener('click', () => {
  const rows = ['t_ms,mode,task,trial,phase,cond,face,blink,pupil_ratio_L,pupil_ratio_R,pupil_ratio,pupil_mm_est,iris_radius_px,contrast,gaze_h,head_yaw,gaze_x,side,manual'];
  for (const s of session.samples) {
    rows.push([num(s.t, 1), s.mode, s.task, s.trial, s.phase, s.cond, +s.face, +s.blink, num(s.pL, 4), num(s.pR, 4), num(s.p, 4),
      num(s.p * IRIS_MM, 3), num(s.irisPx, 2), num(s.contrast, 1), num(s.h, 4), num(s.yaw, 4), num(s.gx, 3), s.side, s.manual].join(','));
  }
  download(`orbit_samples_${stamp()}.csv`, rows.join('\n'), 'text/csv');
});
$('dl-events').addEventListener('click', () => {
  const rows = ['t_ms,mode,task,trial,type,cond'];
  for (const e of session.events) rows.push([num(e.t, 1), e.mode, e.task, e.trial, e.type, e.cond].join(','));
  download(`orbit_events_${stamp()}.csv`, rows.join('\n'), 'text/csv');
});
$('dl-summary').addEventListener('click', () => {
  download(`orbit_summary_${stamp()}.json`, JSON.stringify({ meta: session.meta, results: session.results }, null, 2), 'application/json');
});

setMode('adult');
showThumbs();
if (SIM) status('Simulation mode (?sim): no camera is used.');
window.__pupillook = { tracker, session, stage, rec };
