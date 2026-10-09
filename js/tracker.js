// Camera -> face/iris landmarks -> gaze direction, blinks and viewing distance.
// Everything runs in the browser; frames are never stored or transmitted.

const MP_VERSION = '0.10.14';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

export const IRIS_MM = 11.7;     // population-mean horizontal visible iris diameter
const MIN_IRIS_PX = 5;           // iris radius below which an eye is too small in the image to use
const BLINK_THR = 0.4;

const EYES = [
  { c: 468, ring: [469, 470, 471, 472] },
  { c: 473, ring: [474, 475, 476, 477] },
];
const CORNERS = [[33, 133], [362, 263]];

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
    this.focalK = DEFAULT_FOCAL_K;
    this.focalCalibrated = false;
    this.cameraLabel = '';
    this._gen = 0;
    this._irisEma = [null, null];
    this._g = null;
    this._last = 0;
    this._fracs = [];
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
      t, face: false, blink: false, irisPx: NaN,
      h: NaN, yaw: NaN, v: NaN, pitch: NaN, gx: NaN, gy: NaN, side: '', distMm: NaN, eyes: [], eyeL: null, eyeR: null,
    };
  }

  _tickFps(now) {
    if (this._last) this.fps = this.fps ? 0.9 * this.fps + 0.1 * (1000 / (now - this._last)) : 1000 / (now - this._last);
    this._last = now;
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
      const eye = { x: c.x, y: c.y, R, ok: !s.blink && R >= MIN_IRIS_PX, h: NaN, v: NaN, gx: NaN, gy: NaN };

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

  // Simulation (?sim=1): gaze follows the pointer.
  _simTick(now) {
    const dt = this._last ? now - this._last : 33;
    this._tickFps(now);
    const noise = () => (Math.random() + Math.random() + Math.random() - 1.5) * 2;
    const s = this._blank(now);
    s.face = true;
    s.blink = (now % 5200) < 150;
    s.irisPx = 30;
    s.distMm = 550;
    s.gx = s.h = this._mouse.x + 0.02 * noise();
    s.gy = s.v = this._mouse.y + 0.02 * noise();
    s.yaw = 0; s.pitch = 0;
    s.side = s.gx < 0.45 ? 'L' : s.gx > 0.55 ? 'R' : 'C';
    const eye = (dx) => ({ ok: !s.blink, gx: s.gx + dx + 0.01 * noise(), gy: s.gy + 0.01 * noise(), R: 30 });
    s.eyeL = eye(-0.004); s.eyeR = eye(0.004);
    this._emit(s);
  }
}
