import { Tracker, IRIS_MM } from './tracker.js';
import { makeDemoSet, loadFiles, loadSet } from './stimuli.js';
import { MODES, Stage, setPxPerDeg, runCalibration, runLightReflex, runPaired, runObjectNovelty, runOddOne, runOddball } from './tasks.js';
import { linePlot, barPlot, COLORS } from './plot.js';

const $ = (id) => document.getElementById(id);
const SIM = new URLSearchParams(location.search).has('sim');
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(`orbit.${k}`)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(`orbit.${k}`, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  del(k) { try { localStorage.removeItem(`orbit.${k}`); } catch (e) { /* private mode */ } },
};

const video = $('video');
const tracker = new Tracker(video, { sim: SIM });
const stage = new Stage($('stage'));
const session = {
  meta: { started: new Date().toISOString(), userAgent: navigator.userAgent, simulated: SIM, iris_mm_assumed: IRIS_MM },
  samples: [], events: [], results: [],
};
const rec = { active: false, task: '', trial: -1, phase: '', cond: '', manual: '' };
let mode = 'adult';
const stim = makeDemoSet();

const x = {
  stage, tracker, session, rec, stim,
  get mode() { return mode; },
  get cfg() { return MODES[mode]; },
  get instructed() { return $('instructed').checked; },
  pairedOverride: null,
  set: null,
  get form() { return $('t-form').value; },
  mark(type) { session.events.push({ t: performance.now(), mode, task: rec.task, trial: rec.trial, type, cond: rec.cond }); },
  setBg(v) { stage.bg = v; tracker.simLuma = v / 255; },
};

const status = (msg) => { $('status').textContent = msg; $('teststatus').textContent = msg; };

// ---- pages -------------------------------------------------------------------------------------
const PAGES = ['welcome', 'setup', 'tests', 'results'];
const FOOT = {
  welcome: '',
  setup: 'When both eyes are green, continue to the tests.',
  tests: 'Tests open full screen. Press Esc or the × to stop one early.',
  results: 'Downloads contain numbers only, never video.',
};
let page = 'welcome';
function go(name) {
  page = name;
  for (const p of PAGES) $(`p-${p}`).hidden = p !== name;
  document.querySelectorAll('.steps button').forEach((b) => (b.dataset.go === name ? b.setAttribute('aria-current', 'step') : b.removeAttribute('aria-current')));
  const i = PAGES.indexOf(name);
  $('back').style.visibility = i > 0 ? 'visible' : 'hidden';
  $('next').style.visibility = i < PAGES.length - 1 ? 'visible' : 'hidden';
  $('next').textContent = name === 'welcome' ? 'Begin set-up' : name === 'setup' ? 'Continue to tests' : 'See results';
  $('foot').textContent = FOOT[name];
  if (name === 'results') renderDetail();
}
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
$('back').addEventListener('click', () => go(PAGES[Math.max(0, PAGES.indexOf(page) - 1)]));
$('next').addEventListener('click', () => go(PAGES[Math.min(PAGES.length - 1, PAGES.indexOf(page) + 1)]));

// ---- participant mode --------------------------------------------------------------------------
function setMode(m) {
  mode = m;
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === m)));
  const c = MODES[m], s = (ms) => `${ms / 1000} s`;
  $('modehint').textContent = m === 'infant'
    ? 'Infant mode: animated attention getters with sound, larger pictures, and each trial starts when you press Space or tap. Hold ← / → to code looking direction by hand.'
    : 'Adult mode: fixation cross, short written instructions, automatic pacing.';
  $('d-calibration').textContent = `Follow a target to five positions. About ${Math.round(8 * c.calibDwell / 1000)} s.`;
  $('d-plr').textContent = 'Three bright flashes. Shows how well this device measures pupil size. 25 s.';
  const pc = { ...c.paired, ...(x.pairedOverride || {}) };
  $('d-object').textContent = `${pc.trials} trials: two views of an object, then a third view beside a different object.`;
  $('d-paired').textContent = `${pc.trials} trials: one picture twice, then beside a new one. About ${Math.round(pc.trials * (1000 + pc.fam + pc.gap + pc.test) / 60000)} min.`;
  $('d-oddone').textContent = `${c.oddone.trials} trials: four shapes, one differs by a graded amount (${s(c.oddone.dur)} each).`;
  $('d-oddball').textContent = `${c.oddball.trials} pictures with rare changes. About ${Math.round(c.oddball.trials * (c.oddball.stim + c.oddball.isi) / 1000)} s.`;
  $('instructed').disabled = m === 'infant';
}
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

// ---- pictures ----------------------------------------------------------------------------------
function showThumbs() {
  for (const k of ['A', 'B']) {
    $(`thumbs${k}`).replaceChildren(...stim[k].map((cv) => {
      const t = document.createElement('canvas');
      t.width = t.height = 96;
      t.getContext('2d').drawImage(cv, 0, 0, 96, 96);
      return t;
    }));
  }
}
async function onFiles(k, input) {
  if (!input.files.length) return;
  try {
    const set = await loadFiles(input.files, $('equalize').checked);
    if (set.length < 2) { status(`Set ${k} needs at least 2 images.`); return; }
    stim[k] = set;
    stim.custom = true;
    showThumbs();
  } catch (e) { status(`Could not read images: ${e.message}`); }
}
$('filesA').addEventListener('change', (e) => onFiles('A', e.target));
$('filesB').addEventListener('change', (e) => onFiles('B', e.target));
$('demo').addEventListener('click', () => { Object.assign(stim, makeDemoSet(), { custom: false }); showThumbs(); });
$('stimbtn').addEventListener('click', () => $('dlg-stim').showModal());

// ---- novelty-preference timing ---------------------------------------------------------------
function timingFields() {
  const c = { ...MODES[mode].paired, ...(x.pairedOverride || {}) };
  $('t-fam').value = c.fam / 1000; $('t-gap').value = c.gap / 1000; $('t-test').value = c.test / 1000; $('t-trials').value = c.trials;
  $('timinginfo').textContent = `About ${(c.trials * (1000 + c.fam + c.gap + c.test) / 60000).toFixed(1)} minutes in total.`;
}
$('timingbtn').addEventListener('click', () => { timingFields(); $('dlg-timing').showModal(); });
for (const id of ['t-fam', 't-gap', 't-test', 't-trials']) {
  $(id).addEventListener('change', () => {
    const v = (k, lo, hi) => Math.min(hi, Math.max(lo, +$(k).value || lo));
    x.pairedOverride = { fam: 1000 * v('t-fam', 0.5, 30), gap: 1000 * v('t-gap', 0.3, 60), test: 1000 * v('t-test', 0.5, 30), trials: 4 * Math.round(v('t-trials', 4, 80) / 4) };
    timingFields(); setMode(mode);
  });
}
$('timingreset').addEventListener('click', () => { x.pairedOverride = null; timingFields(); setMode(mode); });
document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

// ---- units: screen scale and viewing distance --------------------------------------------------
const CARD_MM = 85.6, DEFAULT_PX_PER_MM = 96 / 25.4;
let pxPerMm = store.get('pxPerMm') || DEFAULT_PX_PER_MM;
let scaleCalibrated = !!store.get('pxPerMm');
const focalKey = () => `focalK:${tracker.cameraLabel}:${video.videoWidth}x${video.videoHeight}`;
const deg = (frac, extentPx, distMm) => Math.atan((frac - 0.5) * extentPx / pxPerMm / distMm) * 180 / Math.PI;

function unitsInfo() {
  const w = window.innerWidth / pxPerMm / 10;
  $('scaleinfo').textContent = `${scaleCalibrated ? 'Calibrated' : 'Not calibrated (assuming a standard 96 dpi screen)'}: this window is about ${w.toFixed(1)} cm wide.`;
  $('distinfo').textContent = tracker.focalCalibrated ? 'Calibrated for this camera.' : 'Using a typical webcam field of view (about ±15% uncertain).';
}
function drawCard() {
  const w = +$('cardslider').value;
  $('cardbox').style.width = `${w}px`;
  $('cardbox').style.height = `${w * 53.98 / CARD_MM}px`;
}
$('cardslider').addEventListener('input', () => {
  drawCard();
  pxPerMm = +$('cardslider').value / CARD_MM;
  scaleCalibrated = true;
  store.set('pxPerMm', pxPerMm);
  unitsInfo();
});
$('unitsbtn').addEventListener('click', () => {
  $('cardslider').value = Math.round(pxPerMm * CARD_MM);
  drawCard(); unitsInfo();
  $('dlg-units').showModal();
});
$('distset').addEventListener('click', () => {
  const cm = +$('distcm').value;
  if (!(cm >= 15 && cm <= 150)) { $('distinfo').textContent = 'Enter a distance between 15 and 150 cm.'; return; }
  if (!tracker.running || !tracker.calibrateDistance(cm * 10)) { $('distinfo').textContent = 'Start the camera and face it first.'; return; }
  store.set(focalKey(), tracker.focalK);
  unitsInfo();
});
$('unitsreset').addEventListener('click', () => {
  store.del('pxPerMm'); store.del(focalKey());
  pxPerMm = DEFAULT_PX_PER_MM; scaleCalibrated = false; tracker.focalCalibrated = false;
  $('cardslider').value = Math.round(pxPerMm * CARD_MM);
  drawCard(); unitsInfo();
});

// ---- camera ------------------------------------------------------------------------------------
async function fillCameras() {
  const cams = await tracker.listCameras(), sel = $('camsel'), cur = sel.value;
  sel.replaceChildren(new Option('Default (front)', ''), ...cams.map((c, i) => new Option(c.label || `Camera ${i + 1}`, c.deviceId)));
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
}
async function startCamera() {
  $('camtoggle').disabled = true;
  status(SIM ? 'Starting simulated tracker…' : 'Starting the camera and loading the face model…');
  try {
    const res = await tracker.start({ deviceId: $('camsel').value, height: +$('ressel').value });
    if (!res) return;
    session.meta.video = res;
    const k = store.get(focalKey());
    if (k) { tracker.focalK = k; tracker.focalCalibrated = true; }
    chip('chip-res', SIM ? 'simulated' : `${res.width}×${res.height}`, !SIM && res.height < 720);
    status(SIM ? 'Simulation: pupil follows screen brightness, gaze follows the pointer.' : '');
    $('camtoggle').textContent = 'Stop camera';
    $('camtoggle').classList.remove('primary');
    await fillCameras();
  } catch (e) {
    console.error(e);
    status(e.name === 'NotAllowedError' ? 'Camera access was refused. Allow it in the browser settings and try again.' : `Could not start the camera: ${e.message}`);
  } finally { $('camtoggle').disabled = false; }
}
function stopCamera() {
  tracker.stop();
  $('camtoggle').textContent = 'Start camera';
  $('camtoggle').classList.add('primary');
  status('');
  setEyes(false, false, false);
  $('guide').textContent = 'Camera is off';
  $('guidesub').textContent = 'Sit facing the screen with even light on your face, then start the camera.';
}
$('camtoggle').addEventListener('click', () => (tracker.running ? stopCamera() : startCamera()));
for (const id of ['camsel', 'ressel']) {
  $(id).addEventListener('change', async () => { if (tracker.running && !rec.active) { tracker.stop(); await startCamera(); } });
}

// ---- eye signal indicators and live views ------------------------------------------------------
let view = 'off';
document.querySelectorAll('#viewseg button').forEach((b) => b.addEventListener('click', () => {
  view = b.dataset.view;
  document.querySelectorAll('#viewseg button').forEach((q) => q.setAttribute('aria-checked', String(q === b)));
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== view; });
}));

function setEyes(face, okL, okR) {
  // Shown mirrored, like the camera view: the participant's left eye is on the left.
  for (const [sel, ok] of [['[data-eye="L"]', okL], ['[data-eye="R"]', okR]]) {
    document.querySelectorAll(`#eyebig ${sel}, #eyemini ${sel}`).forEach((el) => {
      el.classList.toggle('on', ok);
      el.classList.toggle('face', face && !ok);
    });
  }
}
function chip(id, text, warn = false) { const el = $(id); el.textContent = text; el.classList.toggle('warn', warn); }

function guidance(s, okL, okR) {
  if (!s.face) return ['No face found', 'Sit centred in front of the camera.'];
  if (2 * s.irisPx < 22) return ['Please move closer', 'The eyes are too small in the image to measure.'];
  if (s.distMm < 250) return ['Please move back a little', 'You are very close to the camera.'];
  if (!okL && !okR) return ['Finding your eyes…', 'More even light on the face helps. Avoid a bright window behind or beside you.'];
  if (!okL || !okR) return ['One eye acquired', 'Reduce glare or shadow on the other eye, or turn slightly towards the light.'];
  return ['Both eyes acquired', 'Hold this position. You can continue to the tests.'];
}

function drawCamera(s) {
  const W = video.videoWidth, H = video.videoHeight, cv = $('camview');
  if (!W) return;
  const sc = Math.min(1, 960 / W);
  if (cv.width !== Math.round(W * sc)) { cv.width = Math.round(W * sc); cv.height = Math.round(H * sc); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(-sc, 0, 0, sc, cv.width, 0);
  ctx.drawImage(video, 0, 0);
  ctx.lineWidth = 2 / sc;
  for (const e of s.eyes) {
    ctx.strokeStyle = COLORS[0]; ctx.beginPath(); ctx.arc(e.x, e.y, e.R, 0, 2 * Math.PI); ctx.stroke();
    if (e.ok) { ctx.strokeStyle = COLORS[1]; ctx.beginPath(); ctx.arc(e.px, e.py, e.pr, 0, 2 * Math.PI); ctx.stroke(); }
  }
}
function drawEyes(s) {
  const cv = $('eyes'), ctx = cv.getContext('2d'), half = cv.width / 2;
  ctx.fillStyle = '#f6f7f9';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.imageSmoothingEnabled = false;
  [...s.eyes].sort((a, b) => a.x - b.x).forEach((e, k) => {
    const span = 3.6 * e.R, sc = half / span;
    ctx.drawImage(video, e.x - span / 2, e.y - span / 2, span, span, k * half, 0, half, cv.height);
    ctx.lineWidth = 2;
    ctx.strokeStyle = COLORS[0]; ctx.beginPath(); ctx.arc(k * half + half / 2, cv.height / 2, e.R * sc, 0, 2 * Math.PI); ctx.stroke();
    if (e.ok) {
      ctx.strokeStyle = COLORS[1]; ctx.beginPath();
      ctx.arc(k * half + half / 2 + (e.px - e.x) * sc, cv.height / 2 + (e.py - e.y) * sc, e.pr * sc, 0, 2 * Math.PI); ctx.stroke();
    }
  });
}

const hist = [], okHist = { L: [], R: [] };
let lastUi = 0, lastEyes = [], lastDist = NaN;

// Gaze in degrees of visual angle from the screen centre, for the pooled estimate and each eye.
function addDegrees(s) {
  const d = s.distMm;
  s.gxDeg = deg(s.gx, window.innerWidth, d);
  s.gyDeg = deg(s.gy, window.innerHeight, d);
  for (const e of [s.eyeL, s.eyeR]) {
    if (!e) continue;
    e.gxDeg = deg(e.gx, window.innerWidth, d);
    e.gyDeg = deg(e.gy, window.innerHeight, d);
  }
}

tracker.onSample((s) => {
  addDegrees(s);
  if (Number.isFinite(s.distMm)) lastDist = s.distMm;
  if (s.eyes.length === 2) lastEyes = s.eyes;
  if (rec.active) {
    session.samples.push({
      t: s.t, mode, task: rec.task, trial: rec.trial, phase: rec.phase, cond: rec.cond, face: s.face, blink: s.blink,
      pL: s.pL, pR: s.pR, p: s.p, irisPx: s.irisPx, contrast: s.contrast, h: s.h, yaw: s.yaw, v: s.v, pitch: s.pitch,
      gx: s.gx, gy: s.gy, gxDeg: s.gxDeg, gyDeg: s.gyDeg, distMm: s.distMm, side: s.side, manual: rec.manual,
    });
    return;
  }
  for (const [k, v] of [['L', s.pL], ['R', s.pR]]) { okHist[k].push(Number.isFinite(v)); if (okHist[k].length > 12) okHist[k].shift(); }
  const frac = (a) => a.filter(Boolean).length / Math.max(1, a.length);
  const okL = frac(okHist.L) >= 0.6, okR = frac(okHist.R) >= 0.6;
  const L = s.eyeL || {}, R = s.eyeR || {};
  hist.push({ t: s.t, xL: L.gxDeg, xR: R.gxDeg, yL: L.gyDeg, yR: R.gyDeg, hL: L.h, hR: R.h, vL: L.v, vR: R.v, pL: s.pL * IRIS_MM, pR: s.pR * IRIS_MM });
  while (hist.length && s.t - hist[0].t > 10000) hist.shift();

  if (page === 'setup' && !SIM) {
    if (view === 'camera') drawCamera(s);
    else if (view === 'eyes') drawEyes(s);
  }
  if (s.t - lastUi < 150) return;
  lastUi = s.t;
  setEyes(s.face, okL, okR);
  if (!tracker.running) return;
  const [g1, g2] = guidance(s, okL, okR);
  $('guide').textContent = g1;
  $('guidesub').textContent = g2;
  chip('chip-fps', `${tracker.fps.toFixed(0)} fps`, tracker.fps < 20);
  chip('chip-dist', s.face ? `distance ≈ ${(s.distMm / 10).toFixed(0)} cm${tracker.focalCalibrated ? '' : ' (uncalibrated)'}` : 'distance –');
  chip('chip-iris', s.face ? `iris ${(2 * s.irisPx).toFixed(0)} px` : 'iris –', s.face && 2 * s.irisPx < 30);
  chip('chip-pupil', Number.isFinite(s.p) ? `pupil ≈ ${(s.p * IRIS_MM).toFixed(1)} mm` : 'pupil –');
  if (page !== 'setup') return;
  const tt = hist.map((q) => (q.t - s.t) / 1000);
  const two = (a, b) => [
    { label: 'Left eye', color: COLORS[0], x: tt, y: hist.map((q) => q[a]) },
    { label: 'Right eye', color: COLORS[1], x: tt, y: hist.map((q) => q[b]) },
  ];
  if (view === 'position') {
    const cal = !!tracker.calib;
    $('posunit').textContent = cal ? 'Degrees from the screen centre' : 'Uncalibrated: iris position within the eye opening. Run the gaze calibration for degrees.';
    linePlot($('posx'), { hover: false, xlim: [-10, 0], ylabel: cal ? 'Horizontal (deg)' : 'Horizontal', series: cal ? two('xL', 'xR') : two('hL', 'hR') });
    linePlot($('posy'), { hover: false, xlim: [-10, 0], xlabel: 'Time (s)', ylabel: cal ? 'Vertical (deg)' : 'Vertical', series: cal ? two('yL', 'yR') : two('vL', 'vR') });
  } else if (view === 'pupil') {
    linePlot($('live'), { hover: false, xlim: [-10, 0], xlabel: 'Time (s)', ylabel: 'Pupil diameter (est. mm)', series: two('pL', 'pR') });
  }
});

// Unprocessed, native-resolution crops of both eyes, saved locally for tuning the pupil fit.
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

// ---- tests -------------------------------------------------------------------------------------
window.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') rec.manual = 'L'; else if (e.key === 'ArrowRight') rec.manual = 'R'; });
window.addEventListener('keyup', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') rec.manual = ''; });

// Tracking-quality and viewing-geometry covariates for one test run.
function quality(t0) {
  const ss = session.samples.filter((q) => q.t >= t0), n = ss.length;
  if (n < 2) return null;
  const avg = (k) => { const v = ss.map((q) => q[k]).filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const dist = avg('distMm'), wMm = window.innerWidth / pxPerMm;
  return {
    n_samples: n, fps: 1000 * (n - 1) / (ss[n - 1].t - ss[0].t),
    face_frac: ss.filter((q) => q.face).length / n, pupil_valid_frac: ss.filter((q) => Number.isFinite(q.p)).length / n,
    blink_frac: ss.filter((q) => q.blink).length / n, iris_radius_px: avg('irisPx'), pupil_iris_contrast: avg('contrast'),
    distance_mm: dist, distance_calibrated: tracker.focalCalibrated, screen_width_mm: wMm, screen_scale_calibrated: scaleCalibrated,
    screen_width_deg: dist ? 2 * Math.atan(wMm / 2 / dist) * 180 / Math.PI : null,
  };
}

const TASKS = {
  calibration: { fn: runCalibration },
  plr: { fn: runLightReflex },
  paired: { fn: runPaired, gaze: true },
  object: { fn: runObjectNovelty, gaze: true },
  oddone: { fn: runOddOne, gaze: true },
  oddball: { fn: runOddball },
};

async function runTask(name) {
  if (!tracker.running) { status('The camera is off. Start it on the Set up page first.'); return; }
  if (rec.active) return;
  const out = [];
  // Size the fixation target in degrees from the screen scale and the current viewing distance.
  const dmm = hist.length && Number.isFinite(lastDist) ? lastDist : 500;
  setPxPerDeg(pxPerMm * dmm * Math.tan(Math.PI / 180));
  $('stage').classList.toggle('nored', $('nored').checked);
  await stage.open();
  rec.active = true;
  try {
    if (TASKS[name].gaze && !tracker.calib) out.push(await runCalibration(x));
    const t0 = performance.now(), res = await TASKS[name].fn(x);
    res.quality = quality(t0);
    if (res.quality) res.quality.display_no_red = $('nored').checked;
    out.push(res);
    status('');
  } catch (e) {
    if (e.message === 'aborted') status('Test stopped.');
    else { console.error(e); status(`Test failed: ${e.message}`); }
  } finally {
    Object.assign(rec, { active: false, task: '', trial: -1, phase: '', cond: '' });
    x.setBg(128);
    tracker.simLuma = 0.5;
    stage.close();
  }
  for (const r of out) session.results.push({ ...r, mode, time: new Date() });
  if (out.length) { selected = session.results.length - 1; renderList(); go('results'); }
}
document.querySelectorAll('[data-task]').forEach((b) => b.addEventListener('click', () => runTask(b.dataset.task)));

// ---- results -----------------------------------------------------------------------------------
let selected = -1;
function renderList() {
  const list = $('runlist');
  if (!session.results.length) return;
  list.replaceChildren(...session.results.map((r, i) => {
    const b = document.createElement('button'), sm = document.createElement('small');
    b.type = 'button';
    b.append(r.title);
    sm.textContent = `${r.mode === 'infant' ? 'Infant' : 'Adult'} · ${r.time.toLocaleTimeString()}`;
    b.append(sm);
    if (i === selected) b.setAttribute('aria-current', 'true');
    b.addEventListener('click', () => { selected = i; renderList(); renderDetail(); });
    return b;
  }).reverse());
}
function renderDetail() {
  const r = session.results[selected], box = $('rundetail');
  if (!r) return;
  const h = document.createElement('h3');
  h.textContent = `${r.title} · ${r.mode === 'infant' ? 'Infant' : 'Adult'} · ${r.time.toLocaleTimeString()}`;
  const parts = [h];
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
      parts.push(lg);
    }
    cv = document.createElement('canvas');
    cv.className = 'plot';
    parts.push(cv);
  }
  const ul = document.createElement('ul');
  for (const ln of r.lines) { const li = document.createElement('li'); li.textContent = ln; ul.append(li); }
  parts.push(ul);
  box.replaceChildren(...parts);
  if (cv) (r.plot.type === 'bar' ? barPlot : linePlot)(cv, r.plot);
}
window.addEventListener('resize', () => { if (page === 'results') renderDetail(); });

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
  const rows = ['t_ms,mode,task,trial,phase,cond,face,blink,pupil_ratio_L,pupil_ratio_R,pupil_ratio,pupil_mm_est,iris_radius_px,contrast,gaze_h,head_yaw,gaze_v,head_pitch,gaze_x,gaze_y,gaze_x_deg,gaze_y_deg,distance_mm,side,manual'];
  for (const s of session.samples) {
    rows.push([num(s.t, 1), s.mode, s.task, s.trial, s.phase, s.cond, +s.face, +s.blink, num(s.pL, 4), num(s.pR, 4), num(s.p, 4),
      num(s.p * IRIS_MM, 3), num(s.irisPx, 2), num(s.contrast, 1), num(s.h, 4), num(s.yaw, 4), num(s.v, 4), num(s.pitch, 4),
      num(s.gx, 3), num(s.gy, 3), num(s.gxDeg, 2), num(s.gyDeg, 2), num(s.distMm, 0), s.side, s.manual].join(','));
  }
  download(`orbit_samples_${stamp()}.csv`, rows.join('\n'), 'text/csv');
});
$('dl-events').addEventListener('click', () => {
  const rows = ['t_ms,mode,task,trial,type,cond'];
  for (const e of session.events) rows.push([num(e.t, 1), e.mode, e.task, e.trial, e.type, e.cond].join(','));
  download(`orbit_events_${stamp()}.csv`, rows.join('\n'), 'text/csv');
});
$('dl-summary').addEventListener('click', () => {
  const results = session.results.map((r) => ({ kind: r.kind, mode: r.mode, time: r.time.toISOString(), lines: r.lines, data: r.data, trials: r.trials, quality: r.quality }));
  const meta = { ...session.meta, screen_px_per_mm: pxPerMm, screen_scale_calibrated: scaleCalibrated, distance_calibrated: tracker.focalCalibrated };
  download(`orbit_summary_${stamp()}.json`, JSON.stringify({ meta, results }, null, 2), 'application/json');
});

setMode('adult');
showThumbs();
loadSet('stimuli/set1').then((set) => { x.set = set; $('setinfo').textContent = `Built-in picture set "${set.spec.name}" is loaded (${set.spec.pairs.length} object pairs on low-contrast noise).`; })
  .catch(() => { $('setinfo').textContent = 'No built-in picture set found; the novelty test will use placeholder shapes.'; });
go('welcome');
if (SIM) status('Simulation mode (?sim): no camera is used.');
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', fillCameras);
window.__orbit = { tracker, session, stage, rec };
