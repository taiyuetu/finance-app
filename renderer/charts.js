'use strict';

/**
 * 轻量 Canvas 图表库（无第三方依赖）
 * - donut(canvas, items, center)   环形图（支持悬停高亮 + 提示框）
 * - bars(canvas, labels, series)   分组柱状图（支持悬停 + 提示框）
 */
window.Charts = (() => {

  /* ---------- 提示框 ---------- */
  let tipEl = null;
  function tip() {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'chart-tip';
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }
  function showTip(html, x, y) {
    const el = tip();
    el.innerHTML = html;
    el.style.display = 'block';
    const rect = el.getBoundingClientRect();
    let left = x + 14;
    let top = y + 14;
    if (left + rect.width > window.innerWidth - 8) left = x - rect.width - 14;
    if (top + rect.height > window.innerHeight - 8) top = y - rect.height - 14;
    el.style.left = Math.max(8, left) + 'px';
    el.style.top = Math.max(8, top) + 'px';
  }
  function hideTip() {
    if (tipEl) tipEl.style.display = 'none';
  }
  window.addEventListener('scroll', hideTip, true);

  /* ---------- DPR 适配 ---------- */
  function prep(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    return { ctx, w: rect.width, h: rect.height };
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function fmtShort(v) {
    if (Math.abs(v) >= 10000) return (v / 10000).toFixed(v % 10000 === 0 ? 0 : 1) + '万';
    if (Math.abs(v) >= 1000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k';
    return String(Math.round(v));
  }

  /* ---------- 环形图 ---------- */
  function donut(canvas, items, center) {
    const valid = (items || []).filter((d) => d.value > 0);
    const total = valid.reduce((s, d) => s + d.value, 0);
    let hover = -1;

    function draw() {
      const p = prep(canvas);
      if (!p) return;
      const { ctx, w, h } = p;
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) / 2 - 6;

      ctx.font = '13px "Segoe UI","Microsoft YaHei",sans-serif';

      if (total <= 0) {
        ctx.fillStyle = '#cbd5e1';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '13px "Segoe UI","Microsoft YaHei",sans-serif';
        ctx.fillText('暂无支出数据', cx, cy);
        return;
      }

      const sw = R * 0.34;           // 圆环宽度
      const mid = R - sw / 2;        // 圆环中线半径
      let angle = -Math.PI / 2;

      valid.forEach((d, i) => {
        const frac = d.value / total;
        const a0 = angle;
        const a1 = angle + frac * Math.PI * 2;
        angle = a1;

        ctx.beginPath();
        if (hover === i) {
          const midA = (a0 + a1) / 2;
          ctx.arc(cx + Math.cos(midA) * 5, cy + Math.sin(midA) * 5, mid, a0, a1);
        } else {
          ctx.arc(cx, cy, mid, a0, a1);
        }
        ctx.strokeStyle = d.color;
        ctx.lineWidth = sw;
        ctx.lineCap = frac > 0.999 ? 'butt' : 'round';
        ctx.stroke();
      });

      // 中心文字
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px "Segoe UI","Microsoft YaHei",sans-serif';
      ctx.fillText(center.label, cx, cy - 13);
      ctx.fillStyle = '#1e293b';
      ctx.font = '700 21px "Segoe UI","Microsoft YaHei",sans-serif';
      ctx.fillText(fmtShort(total), cx, cy + 9);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '11px "Segoe UI","Microsoft YaHei",sans-serif';
      ctx.fillText('¥', cx, cy + 28);
    }

    canvas.onmousemove = (e) => {
      if (total <= 0) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left - rect.width / 2;
      const y = e.clientY - rect.top - rect.height / 2;
      const R = Math.min(rect.width, rect.height) / 2 - 6;
      const dist = Math.hypot(x, y);
      let next = -1;
      if (dist > R * 0.42 && dist <= R + 8) {
        let a = Math.atan2(y, x) + Math.PI / 2;
        if (a < 0) a += Math.PI * 2;
        let acc = 0;
        for (let i = 0; i < valid.length; i++) {
          acc += (valid[i].value / total) * Math.PI * 2;
          if (a <= acc) { next = i; break; }
        }
      }
      if (next !== hover) { hover = next; draw(); }
      if (next >= 0) {
        const d = valid[next];
        const pct = ((d.value / total) * 100).toFixed(1);
        showTip(
          `<b style="color:${d.color}">●</b> ${d.label}<br>金额：<b>¥${d.value.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</b> · ${pct}%`,
          e.clientX, e.clientY
        );
      } else {
        hideTip();
      }
    };
    canvas.onmouseleave = () => {
      if (hover !== -1) { hover = -1; draw(); }
      hideTip();
    };

    draw();
    canvas.__redraw = draw;
  }

  /* ---------- 分组柱状图 ---------- */
  function bars(canvas, labels, series, opts) {
    opts = opts || {};
    let hover = -1;

    const allVals = series.flatMap((s) => s.values);
    const maxVal = niceMax(Math.max(...allVals, 0));

    function geom(w, h) {
      const padL = 44, padR = 8, padT = 14, padB = 26;
      const plotW = w - padL - padR;
      const plotH = h - padT - padB;
      const groupW = plotW / labels.length;
      const barW = Math.min(26, groupW / (series.length + 1.4));
      return { padL, padR, padT, padB, plotW, plotH, groupW, barW };
    }

    function draw() {
      const p = prep(canvas);
      if (!p) return;
      const { ctx, w, h } = p;
      const g = geom(w, h);

      ctx.font = '11px "Segoe UI","Microsoft YaHei",sans-serif';

      // 网格线 + Y 轴刻度
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let i = 0; i <= 4; i++) {
        const val = (maxVal / 4) * i;
        const y = g.padT + g.plotH - (val / maxVal) * g.plotH;
        ctx.strokeStyle = i === 0 ? '#e2e8f0' : '#f1f5f9';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(g.padL, Math.round(y) + 0.5);
        ctx.lineTo(w - g.padR, Math.round(y) + 0.5);
        ctx.stroke();
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(fmtShort(val), g.padL - 8, y);
      }

      const hasData = allVals.some((v) => v > 0);

      // 柱体
      labels.forEach((lab, i) => {
        const groupX = g.padL + i * g.groupW;
        const totalBarW = series.length * g.barW + (series.length - 1) * 6;
        let x = groupX + (g.groupW - totalBarW) / 2;

        series.forEach((s) => {
          const v = s.values[i] || 0;
          const bh = maxVal > 0 ? (v / maxVal) * g.plotH : 0;
          const y = g.padT + g.plotH - bh;
          if (bh > 0.5) {
            ctx.globalAlpha = hover === -1 || hover === i ? 1 : 0.35;
            ctx.fillStyle = s.color;
            if (bh > 6) {
              roundRect(ctx, x, y, g.barW, bh, 5);
            } else {
              roundRect(ctx, x, y - 3, g.barW, bh + 3, 2);
            }
            ctx.fill();
            ctx.globalAlpha = 1;
          }
          x += g.barW + 6;
        });

        // X 轴标签
        ctx.fillStyle = hover === i ? '#4f46e5' : '#94a3b8';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.font = (hover === i ? '600 ' : '') + '11px "Segoe UI","Microsoft YaHei",sans-serif';
        ctx.fillText(lab, groupX + g.groupW / 2, g.padT + g.plotH + 8);
      });

      if (!hasData) {
        ctx.fillStyle = '#cbd5e1';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '13px "Segoe UI","Microsoft YaHei",sans-serif';
        ctx.fillText('暂无数据', g.padL + g.plotW / 2, g.padT + g.plotH / 2);
      }
    }

    canvas.onmousemove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const g = geom(rect.width, rect.height);
      const x = e.clientX - rect.left;
      const next = x >= g.padL && x < g.padL + g.plotW
        ? Math.min(labels.length - 1, Math.floor((x - g.padL) / g.groupW))
        : -1;
      if (next !== hover) { hover = next; draw(); }
      if (next >= 0) {
        const rows = series.map((s) =>
          `<span style="color:${s.color}">●</span> ${s.name}：<b>¥${(s.values[next] || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</b>`
        ).join('<br>');
        showTip(`<b>${labels[next]}</b><br>${rows}`, e.clientX, e.clientY);
      } else {
        hideTip();
      }
    };
    canvas.onmouseleave = () => {
      if (hover !== -1) { hover = -1; draw(); }
      hideTip();
    };

    draw();
    canvas.__redraw = draw;
  }

  function niceMax(v) {
    if (v <= 0) return 100;
    const exp = Math.floor(Math.log10(v));
    const base = Math.pow(10, exp);
    const f = v / base;
    const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return nf * base;
  }

  function redrawVisible() {
    document.querySelectorAll('canvas.chart').forEach((c) => {
      if (c.__redraw && c.offsetParent !== null) c.__redraw();
    });
  }

  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(redrawVisible, 120);
  });

  return { donut, bars, redrawVisible };
})();
