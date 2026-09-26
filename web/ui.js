/* Precision Bench · 共享 UI 套件
   - 统一 ECharts 主题与图表基座
   - Toast / 确认框 / 弹窗 / 抽屉
   - 面板菜单（全屏 / 导出 PNG）
   - 命令面板（⌘K）
   - 通用格式化与表格排序 */
(function () {
  'use strict';

  /* 调色板从 CSS 变量读取，与 style.css 单源同步 */
  const _css = getComputedStyle(document.documentElement);
  const _v = (n, fb) => (_css.getPropertyValue(n) || fb).trim() || fb;
  const C = {
    tx1: _v('--tx-1', '#f0f2f5'), tx2: _v('--tx-2', '#9aa3b5'), tx3: _v('--tx-3', '#7f899d'),
    line: _v('--line', 'rgba(148,163,184,.10)'), line2: _v('--line-2', 'rgba(148,163,184,.16)'),
    acc: _v('--acc', '#f0b429'), acc2: _v('--acc-hi', '#ffc84d'),
    ok: _v('--ok', '#34d399'), warn: _v('--warn', '#f59e0b'), bad: _v('--bad', '#f06464'), info: _v('--info', '#6aa5f7'),
    yellow: _v('--warn', '#f59e0b'),
    tr1: _v('--tr-1', '#f0b429'), tr2: _v('--tr-2', '#fcd34d'), tr3: _v('--tr-3', '#7395be'),
    tr4: _v('--tr-4', '#b45309'), tr5: _v('--tr-5', '#9687c5'),
    /* 琥珀主系列 + 冷色辅助，语义色垫底防撞 */
    series: [
      _v('--tr-1', '#f0b429'), _v('--tr-2', '#fcd34d'), _v('--tr-3', '#7395be'),
      _v('--tr-4', '#b45309'), _v('--tr-5', '#9687c5'),
      _v('--bad', '#f06464'), _v('--warn', '#f59e0b'), _v('--info', '#6aa5f7'),
    ],
    bg0: _v('--bg-0', '#0e1014'), bg1: _v('--bg-1', '#12151b'),
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const _nfCache = new Map();
  const nf = (nd) => {
    if (!_nfCache.has(nd)) _nfCache.set(nd, new Intl.NumberFormat('zh-CN', { minimumFractionDigits: nd, maximumFractionDigits: nd }));
    return _nfCache.get(nd);
  };
  const fmt = (v, nd = 0) => (v == null || Number.isNaN(Number(v)) ? '–' : nf(nd).format(Number(v)));
  const pct = (v) => (v == null ? '–' : (v * 100).toFixed(1) + '%');
  /* 毫秒自适应：≥1s 显示秒，否则按量级选小数位 —— 判定块/读数/表格共用 */
  const fmtTimeParts = (ms) => {
    if (ms == null || ms === '' || Number.isNaN(Number(ms))) return { v: '–', u: '' };
    const n = Number(ms);
    const a = Math.abs(n);
    if (a >= 10000) return { v: nf(1).format(n / 1000), u: 's' };
    if (a >= 1000) return { v: nf(2).format(n / 1000), u: 's' };
    if (a >= 100) return { v: nf(0).format(n), u: 'ms' };
    if (a >= 10) return { v: nf(1).format(n), u: 'ms' };
    if (a >= 1) return { v: nf(2).format(n), u: 'ms' };
    if (a === 0) return { v: '0', u: 'ms' };
    return { v: nf(2).format(n), u: 'ms' };
  };
  const fmtTime = (ms) => {
    const p = fmtTimeParts(ms);
    return p.u ? `${p.v} ${p.u}` : p.v;
  };
  const _tfHMS = new Intl.DateTimeFormat('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const _tfHM = new Intl.DateTimeFormat('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  const _dtf = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const tstr = (ts) => _tfHMS.format(new Date(ts * 1000));
  const hm = (ts) => _tfHM.format(new Date(ts * 1000));
  const dtstr = (ts) => _dtf.format(new Date(ts * 1000));
  const nowTime = () => _tfHMS.format(new Date());

  /* ---------- ECharts 主题 · 精密检定台 ---------- */
  echarts.registerTheme('llmbench', {
    color: C.series,
    backgroundColor: 'transparent',
    textStyle: { color: C.tx1, fontSize: 12, fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' },
    title: { textStyle: { color: C.tx1, fontSize: 13, fontWeight: 600 } },
    line: {
      lineStyle: { width: 2, cap: 'round', join: 'round', shadowColor: 'rgba(0,0,0,.35)', shadowBlur: 4, shadowOffsetY: 1 },
      symbol: 'none', smooth: 0.25,
    },
    categoryAxis: {
      axisLine: { lineStyle: { color: C.line2 } }, axisTick: { show: false },
      axisLabel: { color: C.tx2, fontSize: 12, fontFamily: 'ui-monospace, monospace' }, splitLine: { show: false },
    },
    valueAxis: {
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: C.tx2, fontSize: 12, fontFamily: 'ui-monospace, monospace' },
      splitLine: { lineStyle: { color: 'rgba(148,163,184,.08)' } },
    },
    legend: { textStyle: { color: C.tx2, fontSize: 11 } },
    tooltip: {
      backgroundColor: 'rgba(23,27,35,.97)',
      borderColor: 'rgba(240,180,41,.35)',
      borderWidth: 1,
      textStyle: { color: C.tx1, fontSize: 12 },
      extraCssText: 'border-radius:6px;box-shadow:0 8px 28px rgba(0,0,0,.55);backdrop-filter:blur(10px);',
    },
  });

  const AXIS = { color: C.tx2, fontSize: 12, fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' };
  const SPLIT = { lineStyle: { color: 'rgba(148,163,184,.08)', width: 1 } };
  const GRAT = { show: true, lineStyle: { color: 'rgba(148,163,184,.08)', width: 1 } };
  const MINOR = { show: true, lineStyle: { color: 'rgba(148,163,184,.04)', width: 1 } };
  const GRID = { left: 56, right: 18, top: 26, bottom: 30 };

  const grad = (hex, a1 = 0.22, a2 = 0) => new echarts.graphic.LinearGradient(0, 0, 0, 1, [
    { offset: 0, color: hexA(hex, a1) }, { offset: 1, color: hexA(hex, a2) },
  ]);
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function tooltip(unit = '', nd = 1) {
    const fmtVal = (raw) => {
      const n = Number(raw);
      if (Number.isNaN(n)) return '';
      // 时间轴：自适应 ms/s，避免全程 “1234 ms”
      if (unit === 'ms') {
        const p = fmtTimeParts(n);
        return p.u ? `${p.v} ${p.u}` : p.v;
      }
      return n.toFixed(nd);
    };
    return {
    backgroundColor: 'rgba(23,27,35,.97)', borderColor: 'rgba(240,180,41,.35)', borderWidth: 1,
    padding: [10, 12], textStyle: { color: C.tx1, fontSize: 12, fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' },
    extraCssText: 'border-radius:6px;box-shadow:0 8px 28px rgba(0,0,0,.55);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);',
      trigger: 'axis',
      axisPointer: {
        type: 'cross',
        crossStyle: { color: C.tr1, width: 1 },
        lineStyle: { color: 'rgba(240,180,41,.4)', type: 'dashed', width: 1 },
        label: { backgroundColor: 'rgba(30,35,45,.97)', color: C.tx1, fontSize: 11, borderRadius: 4, padding: [3, 7], fontFamily: 'ui-monospace, monospace', borderColor: 'rgba(240,180,41,.35)', borderWidth: 1 },
      },
      formatter: (ps) => {
        if (!ps || !ps.length) return '';
        let h = `<div style="color:${C.tx3};margin-bottom:7px;font-size:11px">${ps[0].axisValueLabel || ''}</div>`;
        ps.filter((p) => p.value != null && p.seriesName && !p.seriesName.startsWith('_')).forEach((p) => {
          let v = Array.isArray(p.value) ? p.value[1] : p.value;
          if (v == null || Number.isNaN(v)) return;
          const shown = fmtVal(v);
          h += `<div style="display:flex;align-items:center;gap:9px;min-width:180px;line-height:1.9">
            <span style="width:8px;height:8px;border-radius:50%;background:${p.color};flex:none"></span>
            <span style="color:${C.tx2}">${p.seriesName}</span>
            <b style="margin-left:auto;font-variant-numeric:tabular-nums;font-family:inherit;font-weight:500">${shown}${unit && unit !== 'ms' ? ` <span style="color:${C.tx3};font-weight:400">${unit}</span>` : ''}</b></div>`;
        });
        return h;
      },
    };
  }

  /* 轴标小数位按数据跨度自适应：跨度大用整数，跨度小才加小数。
     否则 ECharts 会输出 318.4 / 21.88 这种又长又挤、还重复的标签。
     unit='ms' 时轴名与标签走 fmtTime 自适应（秒级数据不再全是千位 ms）。 */
  function axisLabelFor(values, unit = '') {
    const vs = (values || []).filter((v) => typeof v === 'number' && isFinite(v));
    if (!vs.length) return AXIS;
    if (unit === 'ms') {
      const maxAbs = Math.max(...vs.map((v) => Math.abs(v)));
      const u = maxAbs >= 1000 ? 's' : 'ms';
      const scale = u === 's' ? 1000 : 1;
      const span = (Math.max(...vs) - Math.min(...vs)) / scale;
      const nd = span >= 100 ? 0 : span >= 10 ? 0 : span >= 1 ? 1 : span >= 0.1 ? 2 : 3;
      return {
        ...AXIS, hideOverlap: true, name: u,
        formatter: (v) => `${+(Number(v / scale).toFixed(nd))} ${u}`,
      };
    }
    const span = Math.max(...vs) - Math.min(...vs);
    const nd = span >= 100 ? 0 : span >= 10 ? 0 : span >= 1 ? 1 : span >= 0.1 ? 2 : 3;
    // +toFixed 去掉多余的尾随 0（122.0 → 122），否则短面板上标签又长又挤
    return { ...AXIS, hideOverlap: true,
             formatter: (v) => `${+(Number(v).toFixed(nd))}${unit}` };
  }

  const base = (extra = {}) => ({
    backgroundColor: 'transparent', animation: false, grid: GRID, textStyle: { fontSize: 12 },
    xAxis: { type: 'value', nameTextStyle: { color: C.tx3, fontSize: 11 }, axisLabel: AXIS, axisLine: { lineStyle: { color: C.line2 } }, axisTick: { show: true, length: 3, lineStyle: { color: C.line2 } }, splitLine: GRAT, minorTick: { show: true, splitNumber: 5 }, minorSplitLine: MINOR },
    yAxis: { type: 'value', scale: true, splitNumber: 4, nameTextStyle: { color: C.tx3, fontSize: 11 }, axisLabel: AXIS, axisLine: { show: false }, axisTick: { show: true, length: 3, lineStyle: { color: C.line2 } }, splitLine: GRAT, minorTick: { show: true, splitNumber: 5 }, minorSplitLine: MINOR },
    ...extra,
  });

  function initChart(el) {
    if (!el) return null;
    const c = echarts.init(el, 'llmbench');
    if (window.ResizeObserver) {
      let raf = 0;
      const ro = new ResizeObserver(() => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => { try { c.resize(); } catch (e) { /* disposed */ } });
      });
      ro.observe(el);
    }
    return c;
  }

  function noData(el, text = 'No data') {
    const inst = echarts.getInstanceByDom(el);
    if (!inst) return;
    inst.clear();
    inst.setOption({
      backgroundColor: 'transparent',
      graphic: [
        { type: 'text', left: 'center', top: 'middle', style: { text, fill: C.tx2, fontSize: 13, fontWeight: 500 } },
        { type: 'text', left: 'center', top: 'middle', style: { text: '\n\n本次运行暂无可用样本', fill: C.tx4, fontSize: 11 } },
      ],
      xAxis: { show: false }, yAxis: { show: false }, series: [],
    }, true);
  }

  /* ---------- Toast ---------- */
  function toast(msg, type = 'info', ms) {
    if (ms == null) ms = type === 'err' ? 8000 : type === 'warn' ? 4500 : 3200;
    const box = $('toasts');
    if (!box) return;
    while (box.children.length >= 4) box.firstChild.remove();
    const el = document.createElement('div');
    el.className = `toast t-${type}`;
    const icon = type === 'ok' ? '✓' : type === 'err' ? '✕' : type === 'warn' ? '!' : 'i';
    el.innerHTML = `<span class="tico">${icon}</span><span>${esc(msg)}</span><button class="tx" type="button" aria-label="关闭">×</button>`;
    box.appendChild(el);
    let t = setTimeout(dismiss, ms);
    function dismiss() { el.classList.add('out'); setTimeout(() => el.remove(), 220); }
    function pause() { clearTimeout(t); }
    function resume() { clearTimeout(t); t = setTimeout(dismiss, 1200); }
    el.addEventListener('mouseenter', pause);
    el.addEventListener('mouseleave', resume);
    el.addEventListener('click', (e) => { clearTimeout(t); dismiss(); });
    el.querySelector('.tx')?.addEventListener('click', (e) => { e.stopPropagation(); clearTimeout(t); dismiss(); });
  }

  /* 按钮三段式：idle → busy(spinner+文案) → idle，保留原文案 */
  function setBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) {
      if (btn.dataset.busy === '1') return;
      btn.dataset.busy = '1';
      btn.dataset.orig = btn.textContent;
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      btn.classList.add('is-busy');
      if (label) btn.textContent = label;
    } else if (btn.dataset.busy === '1') {
      delete btn.dataset.busy;
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      btn.classList.remove('is-busy');
      if (btn.dataset.orig != null) { btn.textContent = btn.dataset.orig; delete btn.dataset.orig; }
    }
  }

  /* ---------- 通用弹窗 ---------- */
  let lastFocus = null;
  function openModal(title, html) {
    lastFocus = document.activeElement;
    $('modalTitle').textContent = title; $('modalBody').innerHTML = html; $('modal').hidden = false;
    $('modalClose')?.focus();
  }
  function closeModal() {
    if ($('modal').hidden) return;
    $('modal').hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }

  /* ---------- 确认框 ---------- */
  let confirmResolve = null;
  function confirmBox(msg, title = '确认操作', danger = true) {
    lastFocus = document.activeElement;
    $('confirmTitle').textContent = title;
    $('confirmMsg').textContent = msg;
    $('confirmYes').className = danger ? 'danger' : 'primary';
    $('confirm').hidden = false;
    $('confirmYes')?.focus();
    return new Promise((res) => { confirmResolve = res; });
  }
  function settleConfirm(v) {
    if ($('confirm').hidden) return;
    $('confirm').hidden = true;
    const r = confirmResolve; confirmResolve = null;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
    r && r(v);
  }
  document.addEventListener('click', (e) => {
    if (e.target.id === 'confirmYes') settleConfirm(true);
    if (e.target.id === 'confirmNo') settleConfirm(false);
    // 点遮罩取消（与 Esc 一致），避免误触卡死 await
    if (e.target.id === 'confirm') settleConfirm(false);
    if (e.target.id === 'modalClose' || e.target.id === 'modal') closeModal();
  });

  /* ---------- 抽屉 ---------- */
  function openDrawer(title, html) {
    lastFocus = document.activeElement;
    $('drawerTitle').textContent = title; $('drawerBody').innerHTML = html; $('drawer').hidden = false; $('drawerMask').hidden = false;
    $('drawerClose')?.focus();
  }
  function closeDrawer() {
    if ($('drawer').hidden) return;
    $('drawer').hidden = true; $('drawerMask').hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }
  document.addEventListener('click', (e) => { if (e.target.id === 'drawerClose' || e.target.id === 'drawerMask') closeDrawer(); });
  // Esc 关闭最上层浮层：palette → confirm → modal → drawer
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('palette').hidden) { closePalette(); return; }
    if (!$('confirm').hidden) { settleConfirm(false); return; }
    if (!$('modal').hidden) { closeModal(); return; }
    if (!$('drawer').hidden) { closeDrawer(); return; }
  }, true);

  /* ---------- 面板菜单 ---------- */
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pm]');
    if (!btn) return;
    const panel = btn.closest('.panel');
    if (!panel) return;
    const kind = btn.dataset.pm;
    const ch = panel.querySelector('.chart');
    if (kind === 'full') {
      panel.classList.toggle('fullscreen');
      if (ch) setTimeout(() => { const i = echarts.getInstanceByDom(ch); i && i.resize(); }, 90);
    } else if (kind === 'png') {
      const inst = ch && echarts.getInstanceByDom(ch);
      if (!inst) return;
      const a = document.createElement('a');
      a.href = inst.getDataURL({ pixelRatio: 2, backgroundColor: C.bg0 || '#0e1014' });
      a.download = `llmbench-${panel.dataset.panel || 'panel'}-${Date.now()}.png`;
      a.click();
      toast('图表已导出 PNG', 'ok');
    }
  });

  /* ---------- 表格排序 ---------- */
  function sortable(table, onSort) {
    if (!table) return;
    table.querySelectorAll('th[data-sort]').forEach((th) => {
      th.classList.add('sortable');
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        const cur = th.dataset.dir === 'asc' ? 'desc' : 'asc';
        table.querySelectorAll('th').forEach((x) => { delete x.dataset.dir; x.classList.remove('asc', 'desc'); });
        th.dataset.dir = cur; th.classList.add(cur);
        onSort(key, cur);
      });
    });
  }

  /* ---------- 命令面板 ⌘K ---------- */
  let paletteItems = [], paletteFiltered = [], paletteIdx = 0, paletteProvider = () => [];
  function setPaletteProvider(fn) { paletteProvider = fn; }
  function openPalette() {
    $('palette').hidden = false;
    const inp = $('paletteInput'); inp.value = ''; paletteIdx = 0;
    paletteItems = paletteProvider() || [];
    paletteFiltered = paletteItems.slice(0, 40);
    renderPalette(); setTimeout(() => inp.focus(), 30);
  }
  function closePalette() { $('palette').hidden = true; }
  function renderPalette() {
    $('paletteList').innerHTML = paletteFiltered.map((it, i) =>
      `<div class="pitem ${i === paletteIdx ? 'on' : ''}" id="pitem-${i}" role="option" aria-selected="${i === paletteIdx}" data-i="${i}">
        <span class="pl">${esc(it.label)}</span>${it.sub ? `<span class="ps">${esc(it.sub)}</span>` : ''}
      </div>`).join('') || '<div class="pempty">无匹配</div>';
    const inp = $('paletteInput');
    if (inp) inp.setAttribute('aria-activedescendant', paletteFiltered.length ? `pitem-${paletteIdx}` : '');
  }
  function runPalette(i) {
    const it = paletteFiltered[i];
    if (!it) return;
    closePalette();
    try { it.action(); } catch (err) { toast('执行失败: ' + err.message, 'err'); }
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('#btnPalette') || e.target.closest('#btnPaletteRail')) openPalette();
    else if (e.target.id === 'palette') closePalette();
    const p = e.target.closest('.pitem');
    if (p) runPalette(Number(p.dataset.i));
  });
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'paletteInput') return;
    const q = e.target.value.trim().toLowerCase();
    paletteFiltered = (q ? paletteItems.filter((it) => (it.label + ' ' + (it.sub || '')).toLowerCase().includes(q)) : paletteItems).slice(0, 40);
    paletteIdx = 0; renderPalette(); scrollPalette();
  });
  function scrollPalette() { document.getElementById(`pitem-${paletteIdx}`)?.scrollIntoView({ block: 'nearest' }); }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'k' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); openPalette(); return; }
    if ($('palette').hidden) return;
    if (e.key === 'Escape') closePalette();
    else if (e.key === 'ArrowDown') { e.preventDefault(); paletteIdx = Math.min(paletteIdx + 1, paletteFiltered.length - 1); renderPalette(); scrollPalette(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); paletteIdx = Math.max(paletteIdx - 1, 0); renderPalette(); scrollPalette(); }
    else if (e.key === 'Enter') { e.preventDefault(); runPalette(paletteIdx); }
  });

  window.UI = {
    C, AXIS, SPLIT, GRAT, MINOR, GRID, fmt, pct, fmtTime, fmtTimeParts, tstr, hm, dtstr, nowTime, esc, grad, hexA,
    tooltip, base, initChart, noData, axisLabelFor,
    toast, setBusy, openModal, closeModal, confirm: confirmBox,
    openDrawer, closeDrawer, sortable, setPaletteProvider, openPalette,
  };
})();
