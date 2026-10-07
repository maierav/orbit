// Minimal canvas charts on a white surface: line (with SEM bands, shaded spans, crosshair tooltip) and bar.

export const COLORS = ['#2a78d6', '#eb6834', '#1baf7a'];
const INK = '#0b0b0b', MUTED = '#898781', GRID = '#e1e0d9', AXIS = '#c3c2b7';
const PAD = { l: 52, r: 14, t: 10, b: 34 };

function ticks(lo, hi, n = 5) {
  const span = hi - lo || 1, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.abs(v) < 1e-12 ? 0 : v);
  return { out, digits: Math.max(0, -Math.floor(Math.log10(step))) };
}

function setup(cv) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return null;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.font = '11px system-ui, sans-serif';
  return { ctx, w, h };
}

function frame(ctx, w, h, xr, yr, spec) {
  const X = (x) => PAD.l + (x - xr[0]) / (xr[1] - xr[0]) * (w - PAD.l - PAD.r);
  const Y = (y) => h - PAD.b - (y - yr[0]) / (yr[1] - yr[0]) * (h - PAD.t - PAD.b);
  ctx.lineWidth = 1;
  const yt = ticks(yr[0], yr[1], 4);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const v of yt.out) {
    ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(PAD.l, Y(v) + 0.5); ctx.lineTo(w - PAD.r, Y(v) + 0.5); ctx.stroke();
    ctx.fillStyle = MUTED; ctx.fillText(v.toFixed(yt.digits), PAD.l - 6, Y(v));
  }
  ctx.strokeStyle = AXIS; ctx.beginPath(); ctx.moveTo(PAD.l, h - PAD.b + 0.5); ctx.lineTo(w - PAD.r, h - PAD.b + 0.5); ctx.stroke();
  ctx.fillStyle = MUTED; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  if (spec.xlabel) ctx.fillText(spec.xlabel, (PAD.l + w - PAD.r) / 2, h - 4);
  if (spec.ylabel) {
    ctx.save(); ctx.translate(11, (PAD.t + h - PAD.b) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(spec.ylabel, 0, 0); ctx.restore();
  }
  return { X, Y };
}

function tip(text, e) {
  const el = document.getElementById('tip');
  if (!el) return;
  if (!text) { el.hidden = true; return; }
  el.textContent = text;
  el.hidden = false;
  el.style.left = `${Math.min(window.innerWidth - el.offsetWidth - 8, e.clientX + 14)}px`;
  el.style.top = `${e.clientY + 14}px`;
}

function range(vals, pad = 0.08) {
  let lo = Infinity, hi = -Infinity;
  for (const v of vals) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!Number.isFinite(lo)) return [0, 1];
  if (hi - lo < 1e-9) { lo -= 0.5; hi += 0.5; }
  const p = (hi - lo) * pad;
  return [lo - p, hi + p];
}

// spec: { series: [{label, color, x, y, band}], xlabel, ylabel, shades: [[x0, x1]], zero, ylim, hover }
export function linePlot(cv, spec, cross = null) {
  const s = setup(cv);
  if (!s) return;
  const { ctx, w, h } = s;
  const xr = spec.xlim || range(spec.series.flatMap((q) => q.x), 0);
  const yv = spec.series.flatMap((q) => (q.band ? q.y.flatMap((v, i) => [v - q.band[i], v + q.band[i]]) : q.y));
  const yr = spec.ylim || range(spec.zero ? [...yv, 0] : yv);
  const { X, Y } = frame(ctx, w, h, xr, yr, spec);
  const xt = ticks(xr[0], xr[1], 6);
  ctx.fillStyle = MUTED; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const v of xt.out) ctx.fillText(v.toFixed(xt.digits), X(v), h - PAD.b + 5);

  for (const [a, b] of spec.shades || []) {
    ctx.fillStyle = 'rgba(137,135,129,0.14)';
    ctx.fillRect(X(Math.max(a, xr[0])), PAD.t, X(Math.min(b, xr[1])) - X(Math.max(a, xr[0])), h - PAD.t - PAD.b);
  }
  if (spec.zero && yr[0] < 0 && yr[1] > 0) {
    ctx.strokeStyle = AXIS; ctx.beginPath(); ctx.moveTo(PAD.l, Y(0) + 0.5); ctx.lineTo(w - PAD.r, Y(0) + 0.5); ctx.stroke();
  }
  ctx.save();
  ctx.beginPath(); ctx.rect(PAD.l, PAD.t, w - PAD.l - PAD.r, h - PAD.t - PAD.b); ctx.clip();
  for (const q of spec.series) {
    if (q.band) {
      ctx.fillStyle = q.color + '2e';
      ctx.beginPath();
      q.x.forEach((x, i) => ctx[i ? 'lineTo' : 'moveTo'](X(x), Y(q.y[i] + q.band[i])));
      for (let i = q.x.length - 1; i >= 0; i--) ctx.lineTo(X(q.x[i]), Y(q.y[i] - q.band[i]));
      ctx.fill();
    }
    ctx.strokeStyle = q.color; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false;
    q.x.forEach((x, i) => {
      if (!Number.isFinite(q.y[i])) { pen = false; return; }
      ctx[pen ? 'lineTo' : 'moveTo'](X(x), Y(q.y[i]));
      pen = true;
    });
    ctx.stroke();
  }
  if (cross != null) {
    ctx.strokeStyle = MUTED; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X(cross) + 0.5, PAD.t); ctx.lineTo(X(cross) + 0.5, h - PAD.b); ctx.stroke();
  }
  ctx.restore();

  if (spec.hover === false || cv._hover) { cv._spec = spec; return; }
  cv._spec = spec;
  cv._hover = true;
  cv.addEventListener('pointermove', (e) => {
    const sp = cv._spec, r = cv.getBoundingClientRect();
    const xr2 = sp.xlim || range(sp.series.flatMap((q) => q.x), 0);
    const x = xr2[0] + (e.clientX - r.left - PAD.l) / (r.width - PAD.l - PAD.r) * (xr2[1] - xr2[0]);
    if (x < xr2[0] || x > xr2[1]) { tip(null); linePlot(cv, sp); return; }
    const lines = [];
    let snap = x;
    for (const q of sp.series) {
      let bi = 0;
      for (let i = 1; i < q.x.length; i++) if (Math.abs(q.x[i] - x) < Math.abs(q.x[bi] - x)) bi = i;
      snap = q.x[bi];
      if (Number.isFinite(q.y[bi])) lines.push(`${q.label}: ${q.y[bi].toFixed(3)}`);
    }
    linePlot(cv, sp, snap);
    tip(`${sp.xlabel || 'x'} ${snap.toFixed(2)}\n${lines.join('\n')}`, e);
  });
  cv.addEventListener('pointerleave', () => { tip(null); linePlot(cv, cv._spec); });
}

// spec: { labels, values, color, ylabel, xlabel, ref, ylim }
export function barPlot(cv, spec) {
  const s = setup(cv);
  if (!s) return;
  const { ctx, w, h } = s;
  const n = spec.values.length;
  const yr = spec.ylim || range([...spec.values, 0]);
  const { Y } = frame(ctx, w, h, [0, 1], yr, spec);
  const slot = (w - PAD.l - PAD.r) / n, bw = Math.min(36, slot - 2);
  const rects = [];
  spec.values.forEach((v, i) => {
    const cx = PAD.l + slot * (i + 0.5);
    ctx.fillStyle = MUTED; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(spec.labels[i], cx, h - PAD.b + 5);
    if (!Number.isFinite(v)) return;
    const y0 = Y(Math.max(0, yr[0])), y1 = Y(v);
    ctx.fillStyle = spec.color || COLORS[0];
    ctx.beginPath();
    ctx.roundRect(cx - bw / 2, Math.min(y0, y1), bw, Math.abs(y1 - y0), y1 < y0 ? [4, 4, 0, 0] : [0, 0, 4, 4]);
    ctx.fill();
    rects.push({ x0: cx - slot / 2, x1: cx + slot / 2, text: `${spec.labels[i]}: ${v.toFixed(2)}` });
  });
  if (spec.ref != null) {
    ctx.strokeStyle = INK; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(PAD.l, Y(spec.ref) + 0.5); ctx.lineTo(w - PAD.r, Y(spec.ref) + 0.5); ctx.stroke();
    ctx.setLineDash([]);
  }
  cv._rects = rects;
  if (cv._hover) return;
  cv._hover = true;
  cv.addEventListener('pointermove', (e) => {
    const x = e.clientX - cv.getBoundingClientRect().left;
    const hit = cv._rects.find((q) => x >= q.x0 && x < q.x1);
    tip(hit ? hit.text : null, e);
  });
  cv.addEventListener('pointerleave', () => tip(null));
}
