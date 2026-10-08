// Camera -> face/iris landmarks -> pupil radius (as a fraction of iris radius) + horizontal gaze.
// Everything runs in the browser; frames are never stored or transmitted.

const MP_VERSION = '0.10.14';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

export const IRIS_MM = 11.7;     // population-mean horizontal visible iris diameter
const MIN_CONTRAST = 5;          // gray levels between pupil and iris for a sample to count
const MIN_IRIS_PX = 5;           // iris radius below which pupil measurement is skipped
const BLINK_THR = 0.4;

const EYES = [
  { c: 468, ring: [469, 470, 471, 472] },
  { c: 473, ring: [474, 475, 476, 477] },
];
const CORNERS = [[33, 133], [362, 263]];

function median(a) {
  a.sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}

// img: RGBA pixel array (w x h); (cx, cy): landmark iris centre; R: iris radius, all in pixels.
// Returns the pupil radius from the steepest dark->light step of an angular-median radial profile.
// The red channel is used because it gives the best pupil/iris contrast for dark irises.
export function measurePupil(img, w, h, cx, cy, R) {
  const at = (x, y) => img[(y * w + x) << 2];
  const bil = (x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) return NaN;
    const fx = x - x0, fy = y - y0;
    return at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy)
      + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
  };

  // Refine the centre: centroid of the darkest fifth of pixels in the inner iris.
  const r0 = Math.max(2, 0.5 * R), xs = [], ys = [], vs = [];
  for (let y = Math.max(0, Math.floor(cy - r0)); y <= Math.min(h - 1, Math.ceil(cy + r0)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r0)); x <= Math.min(w - 1, Math.ceil(cx + r0)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r0 * r0) { xs.push(x); ys.push(y); vs.push(at(x, y)); }
    }
  }
  if (vs.length < 9) return null;
  const thr = Float32Array.from(vs).sort()[Math.floor(0.2 * vs.length)];
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < vs.length; i++) if (vs[i] <= thr) { sx += xs[i]; sy += ys[i]; n++; }
  let px = sx / n, py = sy / n;
  const sh = Math.hypot(px - cx, py - cy), maxSh = 0.3 * R;
  if (sh > maxSh) { px = cx + (px - cx) * maxSh / sh; py = cy + (py - cy) * maxSh / sh; }

  // Radial profile over the left and right sectors, which the eyelids rarely cover.
  const step = 0.25, np = Math.floor(1.25 * R / step) + 1;
  const angs = [];
  for (let a = -30; a <= 50; a += 5) angs.push(a * Math.PI / 180, (180 - a) * Math.PI / 180);
  const cos = angs.map(Math.cos), sin = angs.map(Math.sin);
  let prof = new Float32Array(np), len = np;
  const buf = [];
  for (let i = 0; i < np; i++) {
    const r = i * step;
    buf.length = 0;
    for (let k = 0; k < angs.length; k++) {
      const v = bil(px + r * cos[k], py + r * sin[k]);
      if (!Number.isNaN(v)) buf.push(v);
    }
    if (buf.length < angs.length / 2) { len = i; break; }
    prof[i] = median(buf);
  }
  if (len * step < 0.8 * R) return null;
  prof = prof.subarray(0, len);

  // Joint least-squares fit of two blurred steps: pupil->iris at r1 and iris->sclera at r2. Fitting the
  // limbus explicitly matters at webcam resolution, where its much larger step bleeds into the iris and
  // would otherwise be mistaken for the pupil edge (worst for dark irises).
  const nf = Math.min(len, Math.floor(1.2 * R / step) + 1);
  const a0 = Math.ceil(0.12 * R / step), a1 = Math.floor(0.75 * R / step);
  const b0 = Math.ceil(0.85 * R / step), b1 = Math.min(nf - 1, Math.floor(1.15 * R / step));
  if (b1 <= b0) return null;
  let ty = 0, tyy = 0;
  for (let i = 0; i < nf; i++) { ty += prof[i]; tyy += prof[i] * prof[i]; }
  const fitAt = (tab, c1, c2) => {
    let s1 = 0, s2 = 0, s11 = 0, s22 = 0, s12 = 0, s1y = 0, s2y = 0;
    for (let i = 0; i < nf; i++) {
      const u = tab[i - c1 + nf], v = tab[i - c2 + nf], y = prof[i];
      s1 += u; s2 += v; s11 += u * u; s22 += v * v; s12 += u * v; s1y += u * y; s2y += v * y;
    }
    const w = solve3([[nf, s1, s2], [s1, s11, s12], [s2, s12, s22]], [ty, s1y, s2y]);
    if (!w || w[1] <= 0 || w[2] <= 0) return null;
    return { sse: tyy - (w[0] * ty + w[1] * s1y + w[2] * s2y), step1: w[1] };
  };
  const stride = Math.max(1, Math.round(R / 12));
  let best = null;
  for (const blur of [0.8, 1.4, 2.2].map((b) => b * Math.max(1, R / 12))) {
    const tab = new Float32Array(2 * nf + 1);
    for (let k = -nf; k <= nf; k++) tab[k + nf] = 1 / (1 + Math.exp(-1.7 * k * step / blur));
    for (let c1 = a0; c1 <= a1; c1 += stride) {
      for (let c2 = b0; c2 <= b1; c2 += stride) {
        const f = fitAt(tab, c1, c2);
        if (f && (!best || f.sse < best.sse)) best = { ...f, c1, c2, tab };
      }
    }
  }
  if (!best) return null;
  if (stride > 1) {
    const { tab, c1: m1, c2: m2 } = best;
    for (let c1 = Math.max(a0, m1 - stride); c1 <= Math.min(a1, m1 + stride); c1++) {
      for (let c2 = Math.max(b0, m2 - stride); c2 <= Math.min(b1, m2 + stride); c2++) {
        const f = fitAt(tab, c1, c2);
        if (f && f.sse < best.sse) best = { ...f, c1, c2, tab };
      }
    }
  }
  let sub = 0;
  const lo = best.c1 > a0 ? fitAt(best.tab, best.c1 - 1, best.c2) : null, hi = best.c1 < a1 ? fitAt(best.tab, best.c1 + 1, best.c2) : null;
  if (lo && hi) {
    const den = lo.sse - 2 * best.sse + hi.sse;
    if (den > 0) sub = Math.max(-1, Math.min(1, 0.5 * (lo.sse - hi.sse) / den));
  }
  // A fit that ends on a search bound has not found a pupil edge.
  const atBound = best.c1 - a0 < 1 || a1 - best.c1 < 1;
  return { r: (best.c1 + sub) * step, cx: px, cy: py, contrast: best.step1, limbus: best.c2 * step, atBound };
}

function solve3(A, y) {
  const M = A.map((row, i) => [...row, y[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

// Linear least squares for y = b0 + b1*u + b2*w with a small ridge on the slopes.
function fit2(rows) {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], y = [0, 0, 0];
  for (const [u, w, t] of rows) {
    const row = [1, u, w];
    for (let i = 0; i < 3; i++) { y[i] += row[i] * t; for (let j = 0; j < 3; j++) A[i][j] += row[i] * row[j]; }
  }
  A[1][1] += 1e-5; A[2][2] += 1e-5;
  return solve3(A, y);
}

// Viewing distance from apparent iris size: distance = K / (iris diameter as a fraction of image width),
// K = IRIS_MM / (2 tan(horizontal field of view / 2)). The default assumes a 60 degree field of view;
// calibrateDistance() replaces it with a value measured for the actual camera.
const DEFAULT_FOCAL_K = IRIS_MM / (2 * Math.tan(30 * Math.PI / 180));

export class Tracker {
  constructor(video, { sim = false } = {}) {
    this.video = video;
    this.sim = sim;
    this.listeners = new Set();
    this.running = false;
    this.calib = null;
    this.fps = 0;
    this.simLuma = 0.5;
    this.focalK = DEFAULT_FOCAL_K;
    this.focalCalibrated = false;
    this.cameraLabel = '';
    this._gen = 0;
    this._irisEma = [null, null];
    this._g = null;
    this._last = 0;
    this._fracs = [];
    this._pc = document.createElement('canvas');
    this._pctx = this._pc.getContext('2d', { willReadFrequently: true });
    this._simP = 0.38;
    this._simK = [];
    this._mouse = { x: 0.5, y: 0.5 };
    if (sim) window.addEventListener('pointermove', (e) => { this._mouse = { x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight }; });
  }

  onSample(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(s) { for (const fn of this.listeners) fn(s); }

  async listCameras() {
    if (this.sim || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  }

  // opts: { deviceId, height } - height is the requested vertical resolution (720, 1080, 2160).
  async start({ deviceId = '', height = 1080 } = {}) {
    const gen = ++this._gen;
    this._last = 0; this.fps = 0;
    if (this.sim) {
      this.calib = { b: [0, 1, 0], c: [0, 1, 0] };
      this.running = true;
      this._simTimer = setInterval(() => this._simTick(performance.now()), 33);
      return { width: 0, height: 0, label: 'Simulated camera' };
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser does not give web pages camera access (HTTPS is required).');
    const video = { width: { ideal: Math.round(height * 16 / 9) }, height: { ideal: height }, frameRate: { ideal: 30 } };
    if (deviceId) video.deviceId = { exact: deviceId }; else video.facingMode = 'user';
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
    this.video.srcObject = this.stream;
    await this.video.play();
    if (!this.landmarker) {
      const mp = await import(`${MP_BASE}/vision_bundle.mjs`);
      const fileset = await mp.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
      const make = (delegate) => mp.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
      });
      // Some phones and older GPUs cannot run the model on the GPU.
      try { this.landmarker = await make('GPU'); } catch (e) { this.landmarker = await make('CPU'); }
    }
    if (gen !== this._gen) return null;
    this.running = true;
    const v = this.video;
    if (v.requestVideoFrameCallback) {
      const cb = (now) => { if (gen !== this._gen) return; this._process(now); v.requestVideoFrameCallback(cb); };
      v.requestVideoFrameCallback(cb);
    } else {
      let lastT = -1;
      const cb = (now) => {
        if (gen !== this._gen) return;
        if (v.currentTime !== lastT) { lastT = v.currentTime; this._process(now); }
        requestAnimationFrame(cb);
      };
      requestAnimationFrame(cb);
    }
    const track = this.stream.getVideoTracks()[0];
    this.cameraLabel = track ? track.label : '';
    return { width: v.videoWidth, height: v.videoHeight, label: this.cameraLabel };
  }

  stop() {
    this._gen++;
    this.running = false;
    clearInterval(this._simTimer);
    if (this.stream) { for (const t of this.stream.getTracks()) t.stop(); this.stream = null; }
    if (!this.sim) this.video.srcObject = null;
    this._irisEma = [null, null]; this._g = null; this._fracs = [];
    this._emit(this._blank(performance.now()));
  }

  _blank(t) {
    return {
      t, face: false, blink: false, pL: NaN, pR: NaN, p: NaN, irisPx: NaN, contrast: NaN,
      h: NaN, yaw: NaN, v: NaN, pitch: NaN, gx: NaN, gy: NaN, side: '', distMm: NaN, eyes: [], eyeL: null, eyeR: null,
    };
  }

  _tickFps(now) {
    if (this._last) this.fps = this.fps ? 0.9 * this.fps + 0.1 * (1000 / (now - this._last)) : 1000 / (now - this._last);
    this._last = now;
  }

  _crop(cx, cy, half) {
    const v = this.video, W = v.videoWidth, H = v.videoHeight, size = 2 * half + 1;
    const sx = Math.min(W - 2, Math.max(0, Math.round(cx) - half));
    const sy = Math.min(H - 2, Math.max(0, Math.round(cy) - half));
    const sw = Math.min(size, W - sx), sh = Math.min(size, H - sy);
    if (this._pc.width < size) { this._pc.width = size; this._pc.height = size; }
    this._pctx.drawImage(v, sx, sy, sw, sh, 0, 0, sw, sh);
    return { d: this._pctx.getImageData(0, 0, sw, sh).data, sw, sh, sx, sy };
  }

  _process(now) {
    const v = this.video, W = v.videoWidth, H = v.videoHeight;
    if (!W) return;
    let res;
    try { res = this.landmarker.detectForVideo(v, now); } catch (e) { return; }
    this._tickFps(now);
    const s = this._blank(now);
    const lm = res.faceLandmarks && res.faceLandmarks[0];
    if (!lm) { this._irisEma = [null, null]; this._g = null; this._emit(s); return; }
    s.face = true;

    const cats = res.faceBlendshapes && res.faceBlendshapes[0] ? res.faceBlendshapes[0].categories : [];
    let blink = 0;
    for (const c of cats) if (c.categoryName === 'eyeBlinkLeft' || c.categoryName === 'eyeBlinkRight') blink = Math.max(blink, c.score);
    s.blink = blink > BLINK_THR;

    const P = (i) => ({ x: lm[i].x * W, y: lm[i].y * H });
    // Position of p along (u) and below (w) the line a->b, in units of |ab|; a is the image-left point.
    const along = (p, a, b) => {
      if (a.x > b.x) [a, b] = [b, a];
      const ax = b.x - a.x, ay = b.y - a.y, n = ax * ax + ay * ay;
      return { u: ((p.x - a.x) * ax + (p.y - a.y) * ay) / n, w: ((p.y - a.y) * ax - (p.x - a.x) * ay) / n };
    };
    const mids = CORNERS.map(([a, b]) => { const p = P(a), q = P(b); return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }; });
    EYES.forEach((def, k) => {
      const c = P(def.c);
      let Rraw = 0;
      for (const i of def.ring) { const q = P(i); Rraw += Math.hypot(q.x - c.x, q.y - c.y) / def.ring.length; }
      const R = this._irisEma[k] = this._irisEma[k] == null ? Rraw : 0.9 * this._irisEma[k] + 0.1 * Rraw;
      const eye = { x: c.x, y: c.y, R, pr: NaN, px: c.x, py: c.y, ok: false, ratio: NaN, contrast: NaN, h: NaN, v: NaN, gx: NaN, gy: NaN };

      if (!s.blink && R >= MIN_IRIS_PX) {
        const cr = this._crop(c.x, c.y, Math.ceil(1.5 * R) + 2);
        const m = measurePupil(cr.d, cr.sw, cr.sh, c.x - cr.sx, c.y - cr.sy, R);
        if (m) {
          eye.pr = m.r; eye.px = m.cx + cr.sx; eye.py = m.cy + cr.sy; eye.contrast = m.contrast;
          eye.ratio = m.r / R;
          eye.ok = m.contrast >= MIN_CONTRAST && !m.atBound;
        }
      }

      // Iris position relative to the eye corners: h along the corner-to-corner axis, v below it.
      const d0 = Math.hypot(c.x - mids[0].x, c.y - mids[0].y), d1 = Math.hypot(c.x - mids[1].x, c.y - mids[1].y);
      const [a, b] = CORNERS[d0 <= d1 ? 0 : 1].map(P);
      const q = along(c, a, b);
      eye.h = q.u; eye.v = q.w;
      s.eyes.push(eye);
    });

    // The camera frame is unmirrored, so the subject's left eye has the larger image x.
    const [eR, eL] = s.eyes[0].x < s.eyes[1].x ? [s.eyes[0], s.eyes[1]] : [s.eyes[1], s.eyes[0]];
    s.eyeL = eL; s.eyeR = eR;
    if (eL.ok && eR.ok && Math.abs(eL.ratio - eR.ratio) > 0.15) (eL.contrast < eR.contrast ? eL : eR).ok = false;
    s.pL = eL.ok ? eL.ratio : NaN;
    s.pR = eR.ok ? eR.ratio : NaN;
    const ok = [eL, eR].filter((e) => e.ok);
    if (ok.length) {
      s.p = ok.reduce((a, e) => a + e.ratio, 0) / ok.length;
      s.contrast = ok.reduce((a, e) => a + e.contrast, 0) / ok.length;
    }
    s.irisPx = (eL.R + eR.R) / 2;
    const frac = 2 * s.irisPx / W;
    s.distMm = this.focalK / frac;
    this._fracs.push(frac);
    if (this._fracs.length > 30) this._fracs.shift();

    s.h = (eL.h + eR.h) / 2;
    s.v = (eL.v + eR.v) / 2;
    const head = along(P(1), P(33), P(263));
    s.yaw = head.u - 0.5;
    s.pitch = head.w;

    if (this.calib && !s.blink) {
      const { b, c } = this.calib;
      const gaze = (h, vv) => ({ x: b[0] + b[1] * h + b[2] * s.yaw, y: c ? c[0] + c[1] * vv + c[2] * s.pitch : NaN });
      const g = gaze(s.h, s.v);
      this._g = this._g == null ? g : { x: 0.65 * this._g.x + 0.35 * g.x, y: 0.65 * this._g.y + 0.35 * g.y };
      s.gx = this._g.x; s.gy = this._g.y;
      s.side = s.gx < 0.45 ? 'L' : s.gx > 0.55 ? 'R' : 'C';
      for (const e of [eL, eR]) { const q = gaze(e.h, e.v); e.gx = q.x; e.gy = q.y; }
    }
    this._emit(s);
  }

  // Sets the camera constant from a distance measured with a ruler, using the recent iris size.
  calibrateDistance(mm) {
    if (!this._fracs.length) return false;
    const f = [...this._fracs].sort((a, b) => a - b)[this._fracs.length >> 1];
    this.focalK = mm * f;
    this.focalCalibrated = true;
    return true;
  }

  // pts: [{x, y: target position as fractions of screen width and height, h, yaw, v, pitch}]
  fitCalibration(pts) {
    if (this.sim) return { ok: true, acc: 1, accV: 1, n: pts.length };
    if (pts.length < 20) return { ok: false, acc: NaN, accV: NaN, n: pts.length };
    const b = fit2(pts.map((p) => [p.h, p.yaw, p.x])), c = fit2(pts.map((p) => [p.v, p.pitch, p.y]));
    if (!b) return { ok: false, acc: NaN, accV: NaN, n: pts.length };
    const score = (w, f1, f2, t) => {
      let hit = 0, tot = 0;
      for (const p of pts) {
        if (p[t] === 0.5) continue;
        tot++; if ((w[0] + w[1] * p[f1] + w[2] * p[f2] < 0.5) === (p[t] < 0.5)) hit++;
      }
      return tot ? hit / tot : NaN;
    };
    const acc = score(b, 'h', 'yaw', 'x'), accV = c ? score(c, 'v', 'pitch', 'y') : NaN;
    const ok = acc >= 0.75;
    if (ok) { this.calib = { b, c }; this._g = null; }
    return { ok, acc, accV, n: pts.length };
  }

  // Simulation (?sim=1): pupil follows screen luminance plus event-evoked dilations; gaze follows the pointer.
  simEvent(amp) { if (this.sim) this._simK.push({ t0: performance.now(), amp }); }

  _simTick(now) {
    const dt = this._last ? now - this._last : 33;
    this._tickFps(now);
    const target = 0.46 - 0.16 * this.simLuma;
    this._simP += (target - this._simP) * (1 - Math.exp(-dt / 450));
    let ev = 0;
    this._simK = this._simK.filter((k) => now - k.t0 < 4000);
    for (const k of this._simK) {
      const x = (now - k.t0) / 930;
      ev += k.amp * Math.pow(x, 10.1) * Math.exp(10.1 * (1 - x));
    }
    const noise = () => (Math.random() + Math.random() + Math.random() - 1.5) * 2;
    const s = this._blank(now);
    s.face = true;
    s.blink = (now % 5200) < 150;
    if (!s.blink) { s.p = s.pL = s.pR = this._simP + ev + 0.004 * noise(); s.contrast = 40; }
    s.irisPx = 30;
    s.distMm = 550;
    s.gx = s.h = this._mouse.x + 0.02 * noise();
    s.gy = s.v = this._mouse.y + 0.02 * noise();
    s.yaw = 0; s.pitch = 0;
    s.side = s.gx < 0.45 ? 'L' : s.gx > 0.55 ? 'R' : 'C';
    const eye = (dx) => ({ ok: !s.blink, gx: s.gx + dx + 0.01 * noise(), gy: s.gy + 0.01 * noise(), ratio: s.p, R: 30 });
    s.eyeL = eye(-0.004); s.eyeR = eye(0.004);
    this._emit(s);
  }
}
