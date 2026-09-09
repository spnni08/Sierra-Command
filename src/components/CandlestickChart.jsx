import { useEffect, useRef } from 'react';
import { series, lineSeries, fmt, fmtPct, SYMS } from '../data/mockData';

// Reusable chart: candlestick (kind="candles") or equity line (kind="line").
// Colors come from CSS custom properties on :root / [data-theme] so the
// chart stays theme-aware — neutral grey for up candles, black for down.
export default function CandlestickChart({ symbol, kind = 'candles', n = 72, levels = false, height }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;

    let raf1, raf2;
    const draw = () => {
      const w = cv.clientWidth, h = cv.clientHeight;
      if (!w || !h) return;
      const cs = getComputedStyle(cv.closest('[data-theme]') || document.documentElement);
      const C = k => cs.getPropertyValue(k).trim();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      g.fillStyle = C('--chart');
      g.fillRect(0, 0, w, h);
      const axisW = w > 360 ? 58 : 44;
      const plotW = w - axisW, plotH = h;
      g.font = "10px 'IBM Plex Mono', monospace";
      g.textBaseline = 'middle';

      if (kind === 'line') {
        const s = lineSeries(symbol + n, n, 1);
        const min = Math.min(...s), max = Math.max(...s), pad = (max - min) * 0.12 || 1;
        const lo = min - pad, hi = max + pad;
        const Y = v => plotH - ((v - lo) / (hi - lo)) * plotH;
        g.strokeStyle = C('--grid'); g.lineWidth = 1;
        for (let i = 1; i < 5; i++) { const y = Math.round(plotH * i / 5) + 0.5; g.beginPath(); g.moveTo(0, y); g.lineTo(plotW, y); g.stroke(); }
        g.beginPath();
        s.forEach((v, i) => { const x = (i / (n - 1)) * plotW; i ? g.lineTo(x, Y(v)) : g.moveTo(x, Y(v)); });
        g.lineTo(plotW, plotH); g.lineTo(0, plotH); g.closePath();
        g.fillStyle = C('--accsoft'); g.fill();
        g.beginPath();
        s.forEach((v, i) => { const x = (i / (n - 1)) * plotW; i ? g.lineTo(x, Y(v)) : g.moveTo(x, Y(v)); });
        g.strokeStyle = C('--acc'); g.lineWidth = 1.4; g.stroke();
        g.strokeStyle = C('--line'); g.beginPath(); g.moveTo(plotW + 0.5, 0); g.lineTo(plotW + 0.5, plotH); g.stroke();
        g.fillStyle = C('--txt3'); g.textAlign = 'left';
        for (let i = 0; i <= 4; i++) {
          const v = lo + (hi - lo) * (1 - i / 4), y = plotH * i / 4;
          g.fillText(fmtPct(v), plotW + 7, Math.min(plotH - 7, Math.max(7, y)));
        }
        return;
      }

      const s = series(symbol, n);
      const cfg = SYMS[symbol] || { dec: 2 };
      const volH = h > 200 ? Math.round(h * 0.16) : 0;
      const ch = plotH - volH - 6;
      let min = Infinity, max = -Infinity;
      s.forEach(d => { if (d.l < min) min = d.l; if (d.h > max) max = d.h; });
      const lastC = s[s.length - 1].c;
      const tp = lastC * 1.0207, sl = lastC * 0.9832, entry = lastC * 0.9923;
      if (levels) { min = Math.min(min, sl * 0.999); max = Math.max(max, tp * 1.001); }
      const pad = (max - min) * 0.06 || 1;
      const lo = min - pad, hi = max + pad;
      const Y = v => ch - ((v - lo) / (hi - lo)) * ch;

      g.strokeStyle = C('--grid'); g.lineWidth = 1;
      for (let i = 1; i < 5; i++) { const y = Math.round(ch * i / 5) + 0.5; g.beginPath(); g.moveTo(0, y); g.lineTo(plotW, y); g.stroke(); }
      for (let i = 1; i < 6; i++) { const x = Math.round(plotW * i / 6) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, plotH); g.stroke(); }

      if (volH) {
        let mv = 0; s.forEach(d => { if (d.v > mv) mv = d.v; });
        const bw = plotW / n;
        s.forEach((d, i) => {
          const bh = (d.v / mv) * (volH - 4);
          g.fillStyle = d.c >= d.o ? C('--up') : C('--downedge');
          g.globalAlpha = 0.28;
          g.fillRect(i * bw + bw * 0.15, plotH - bh, Math.max(1, bw * 0.7), bh);
        });
        g.globalAlpha = 1;
      }

      const bw = plotW / n, bodyW = Math.max(1.5, Math.min(11, bw * 0.66));
      s.forEach((d, i) => {
        const x = i * bw + bw / 2;
        const up = d.c >= d.o;
        const fill = up ? C('--up') : C('--down');
        const edge = up ? C('--up') : C('--downedge');
        g.strokeStyle = edge; g.lineWidth = 1;
        g.beginPath(); g.moveTo(Math.round(x) + 0.5, Y(d.h)); g.lineTo(Math.round(x) + 0.5, Y(d.l)); g.stroke();
        const yo = Y(d.o), yc = Y(d.c);
        const top = Math.min(yo, yc), bh = Math.max(1, Math.abs(yc - yo));
        const bx = Math.round(x - bodyW / 2) + 0.5;
        g.fillStyle = fill; g.fillRect(bx, top, bodyW, bh);
        if (!up) { g.strokeRect(bx, top + 0.5, bodyW, Math.max(1, bh - 1)); }
      });

      if (levels) {
        const line = (v, label, dash, col) => {
          const y = Math.round(Y(v)) + 0.5;
          g.save(); g.setLineDash(dash); g.strokeStyle = col; g.lineWidth = 1;
          g.beginPath(); g.moveTo(0, y); g.lineTo(plotW, y); g.stroke(); g.restore();
          g.fillStyle = col; g.fillRect(plotW, y - 7, axisW, 14);
          g.fillStyle = '#fff'; g.textAlign = 'left';
          g.fillText(label, plotW + 4, y);
        };
        g.save();
        g.fillStyle = C('--accsoft'); g.globalAlpha = 0.55;
        g.fillRect(0, Y(tp), plotW, Y(entry) - Y(tp));
        g.restore();
        line(tp, 'TP ' + fmt(tp, 0), [4, 3], C('--acc'));
        line(sl, 'SL ' + fmt(sl, 0), [4, 3], C('--acc2'));
        const ye = Math.round(Y(entry)) + 0.5;
        g.save(); g.setLineDash([2, 2]); g.strokeStyle = C('--txt3');
        g.beginPath(); g.moveTo(0, ye); g.lineTo(plotW, ye); g.stroke(); g.restore();
        g.fillStyle = C('--panel3'); g.fillRect(plotW, ye - 7, axisW, 14);
        g.fillStyle = C('--txt2'); g.textAlign = 'left'; g.fillText('E ' + fmt(entry, 0), plotW + 4, ye);
      }

      g.strokeStyle = C('--line'); g.beginPath(); g.moveTo(plotW + 0.5, 0); g.lineTo(plotW + 0.5, plotH); g.stroke();
      g.fillStyle = C('--txt3'); g.textAlign = 'left';
      for (let i = 0; i <= 4; i++) {
        const v = lo + (hi - lo) * (1 - i / 4), y = Math.min(ch - 7, Math.max(7, ch * i / 4));
        g.fillText(fmt(v, cfg.dec >= 5 ? 5 : (v > 1000 ? 0 : 2)), plotW + 5, y);
      }
      const yl = Math.round(Y(lastC)) + 0.5;
      g.fillStyle = C('--txt'); g.fillRect(plotW, yl - 7, axisW, 14);
      g.fillStyle = C('--chart'); g.fillText(fmt(lastC, cfg.dec >= 5 ? 5 : (lastC > 1000 ? 0 : 2)), plotW + 5, yl);
      g.save(); g.setLineDash([1, 3]); g.strokeStyle = C('--txt3');
      g.beginPath(); g.moveTo(0, yl); g.lineTo(plotW, yl); g.stroke(); g.restore();
    };

    const schedule = () => {
      cancelAnimationFrame(raf1); cancelAnimationFrame(raf2);
      raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(draw); });
    };

    const ro = new ResizeObserver(schedule);
    ro.observe(cv);
    schedule();
    // Redraw on theme change (custom properties change on the [data-theme] host)
    const mo = new MutationObserver(schedule);
    const themeHost = cv.closest('[data-theme]');
    if (themeHost) mo.observe(themeHost, { attributes: true, attributeFilter: ['data-theme'] });

    return () => { ro.disconnect(); mo.disconnect(); cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [symbol, kind, n, levels]);

  return (
    <canvas
      ref={canvasRef}
      style={{ display: 'block', width: '100%', height: height || '100%' }}
    />
  );
}
