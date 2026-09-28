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

  /* 图表动效：入场不做动画（首屏要立刻出图），但 live 更新走 260ms 过渡，
     否则每秒一次的 setOption 会让曲线瞬变、观感"硬切"。
     样本量超过 ANIM_MAX 时自动关闭更新动画，避免 4000 点每秒重算掉帧。 */
  const ANIM_MAX = 800;
  const anim = (n) => (n > ANIM_MAX
    ? { animation: false }
    : { animationDurationUpdate: 260, animationEasingUpdate: 'cubicOut', animationDuration: 0 });

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

  /* ── 带档位的数字输入 ──────────────────────────────────────────────
     痛点：并发、请求数、定频这些高频参数全靠手打，既慢又容易落到
     没意义的数上（并发 37、请求数 473）。但又不能只给滑杆 —— 有些场景
     需要精确值（比如对齐某次复现）。

     所以做成双模：滑杆负责"快速到位 + 阻尼档位"，数字框负责"精确输入"。
       · 拖动滑杆 → 实时预览
       · 松手 → 吸附到最近的档位（阻尼感）
       · 点档位标签 → 直接跳到该值
       · 在数字框里打字 → 原样保留，不被吸附逻辑改写
     跨度大的字段（并发 1–256、请求数 10–10000）走对数刻度，否则低分段
     会被压成一小截。 */
  /* 滑杆内部用 0..1000 的整数位置，避免浮点误差；跨 log/linear 两种刻度
     都能用同一套位置算吸附距离。 */
  const SLIDER_POS = 10000;
  /* 吸附容差（位置单位，约合轨道的 0.45%）。刻意不设成"永远吸附"：
     那样滑杆就永远停不到非档位值上，用户想放 90s 却只能落在 60/300。
     靠近档位才吸（阻尼感），远离就放手（精确值）。 */
  const SNAP_TOL = 450;

  function makeSlider(input, cfg) {
    const min = Number(cfg.min ?? input.min ?? 0);
    const max = Number(cfg.max ?? input.max ?? Math.max(...cfg.detents));
    const int = cfg.int === true;                       // 整数字段不产生小数
    const step = cfg.step && Number(cfg.step) > 0 ? Number(cfg.step) : null;
    const log = cfg.scale === 'log' && min > 0 && max / min > 50;
    const detents = cfg.detents.filter((d) => d >= min && d <= max);

    const clampPos = (pos) => Math.min(SLIDER_POS, Math.max(0, pos));
    const toPos = (v) => {
      const c = Math.min(max, Math.max(min, Number(v) || 0));
      return Math.round(log
        ? SLIDER_POS * (Math.log(c / min) / Math.log(max / min))
        : SLIDER_POS * ((c - min) / (max - min || 1)));
    };
    const toVal = (pos) => (log
      ? min * Math.pow(max / min, clampPos(pos) / SLIDER_POS)
      : min + ((max - min) * clampPos(pos)) / SLIDER_POS);

    /* 量化：整数字段取整，浮点字段落到声明的步长上。返回 null 表示输入非法。 */
    const quantize = (v) => {
      const n = Number(v);
      if (!isFinite(n)) return null;
      let x = Math.min(max, Math.max(min, n));
      if (int) x = Math.round(x);
      else if (step) x = Math.round(x / step) * step;
      return Number(x.toFixed(4));
    };
    /* 吸附：按"位置距离"判断，所以 log 与 linear 刻度手感一致 */
    const nearest = (v) => {
      const p = toPos(v);
      let best = null, bd = Infinity;
      for (const d of detents) {
        const dd = Math.abs(toPos(d) - p);
        if (dd < bd) { bd = dd; best = d; }
      }
      return bd <= SNAP_TOL ? best : null;
    };

    const wrap = document.createElement('div');
    wrap.className = 'numfield';
    const range = document.createElement('input');
    range.type = 'range';
    range.className = 'numfield-range';
    range.min = '0';
    range.max = String(SLIDER_POS);
    /* step 必须是 1：浏览器会把 range.value 夹到 step 的整数倍，
       step 设成"档位间距"（比如 175）的话滑杆根本表示不了键入的值 ——
       键 10000 会被挤到 875 位置（对应值 422）。方向键跳档改在 keydown 里做。 */
    range.step = '1';
    range.setAttribute('aria-label', (input.closest('label')?.textContent || input.id).trim());

    const ticks = document.createElement('div');
    ticks.className = 'numfield-ticks';
    /* 档位标记：中间档位只画刻度线，不写文字。侧栏一半字段只有 ~120px 宽，
       绝对定位的数字标签必然互相碰撞（"300"+"600" 叠成 "30000"），
       所以改成「刻度线 + 两端数值」，当前值由上面的数字框负责显示。 */
    const brief = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M`
      : n >= 1000 ? `${(n / 1000).toFixed(n % 1000 ? 1 : 0)}k` : String(n));
    const fmtTick = cfg.tickFormat || brief;
    detents.forEach((d, i) => {
      const b = document.createElement('button');
      const isEnd = i === 0 || i === detents.length - 1;
      b.type = 'button';
      b.className = isEnd ? 'numfield-tick is-end' : 'numfield-tick is-mark';
      b.textContent = isEnd ? fmtTick(d) : '';
      b.title = isEnd ? String(d) : `档位 ${d}（点击跳到这里）`;
      b.setAttribute('aria-label', isEnd ? String(d) : `跳到 ${d}`);
      b.style.left = `${(toPos(d) / SLIDER_POS) * 100}%`;
      b.dataset.val = String(d);
      b.addEventListener('click', () => apply(d, { snap: false }));
      ticks.appendChild(b);
    });
    /* 刻度线抽稀：既按可用宽度隔位显示，也躲开两端的数值标签。
       后者是必要的 —— 「爬升时长」的档位是 0/30/60/300，在线性刻度下
       0% 和 5% 几乎重合，5% 处的刻度线正好盖住 "0"，看上去就像数字丢了。 */
    const thin = () => {
      const w = ticks.clientWidth || 120;
      const ends = [...ticks.querySelectorAll('.is-end')];
      const endX = ends.map((el) => {
        const x = (toPos(Number(el.dataset.val)) / SLIDER_POS) * w;
        // 标签自身有宽度（10px 字号，最多 4 个字符 ≈ 26px），按半宽留安全距离
        return { x, half: (el.textContent.length * 6 + 4) / 2 };
      });
      const marks = [...ticks.querySelectorAll('.is-mark')];
      const stride = Math.max(1, Math.ceil(marks.length / Math.max(2, Math.floor(w / 14))));
      marks.forEach((el, i) => {
        const mx = (toPos(Number(el.dataset.val)) / SLIDER_POS) * w;
        const clash = endX.some((e) => Math.abs(mx - e.x) < e.half + 5);
        el.dataset.hide = clash || i % stride ? '1' : '0';
      });
    };
    thin();
    if (window.ResizeObserver) new ResizeObserver(thin).observe(ticks);

    /* 高亮当前值最近的那一档：松手就会吸到这里。没有这个提示的话，
       用户只能靠猜才知道"松手会不会跳"。 */
    const markActive = (v) => {
      const near = nearest(v);
      for (const el of ticks.querySelectorAll('.is-mark')) {
        el.dataset.active = near != null && el.dataset.val === String(near) ? '1' : '0';
      }
    };
    const sync = () => {
      range.value = String(toPos(input.value));
      markActive(input.value);
    };
    /* 唯一的写入口：量化 → 可选吸附 → 赋值 → 派发**一次** change。
       原来 release() 里连着调了两次 setValue，加上 change/pointerup 两个监听，
       一次松手会派发 4 次 change，saveCfg 之类跟着跑 4 遍。 */
    function apply(v, { snap = false, silent = false } = {}) {
      const q = quantize(v);
      if (q === null) return false;
      const final = snap ? (nearest(q) ?? q) : q;
      if (String(input.value) !== String(final)) input.value = String(final);
      if (!silent) input.dispatchEvent(new Event('change', { bubbles: true }));
      sync();
      return true;
    }

    range.addEventListener('input', () => {
      // 拖动中：只派发 input（不落盘），且立刻量化 —— 整数字段不该露出 17.582
      const q = quantize(toVal(Number(range.value)));
      if (q === null) return;
      input.value = String(q);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      range.value = String(toPos(q));
    });
    // range 原生在松手/键盘结束时都会派发 change，所以只挂这一个监听
    range.addEventListener('change', () => apply(toVal(Number(range.value)), { snap: true }));

    /* 方向键 = 一跳档位。自己处理而不用 range.step：step 必须是 1 才能
       表示任意值（见上），所以键盘导航在这里补回来。 */
    range.addEventListener('keydown', (e) => {
      const cur = quantize(input.value);
      if (cur === null) return;
      const at = detents.reduce((best, d, i) => (Math.abs(d - cur) < Math.abs(detents[best] - cur) ? i : best), 0);
      const last = detents.length - 1;
      let target = null;
      switch (e.key) {
        case 'ArrowRight': case 'ArrowUp': target = Math.min(last, at + 1); break;
        case 'ArrowLeft': case 'ArrowDown': target = Math.max(0, at - 1); break;
        case 'PageUp': target = Math.min(last, at + 5); break;
        case 'PageDown': target = Math.max(0, at - 5); break;
        case 'Home': target = 0; break;
        case 'End': target = last; break;
        default: return;
      }
      e.preventDefault();
      apply(detents[target], { snap: false });
    });

    // 数字框：输入过程中不移动滑杆（否则清空/输入中途会跳），change 时才夹取
    let lastGood = input.value;
    input.addEventListener('input', () => {
      if (input.value === '' || !isFinite(Number(input.value))) return;  // 空/非法: 保持滑杆不动
      sync();
    });
    input.addEventListener('change', () => {
      if (input.value === '' || !isFinite(Number(input.value))) {
        // 清空后失焦：回到上一个有效值，不让空串被存进配置
        input.value = lastGood;
        sync();
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
      const before = input.value;
      if (apply(before, { snap: false, silent: true })) {
        lastGood = input.value;
        if (input.value !== before) input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    wrap.appendChild(range);
    wrap.appendChild(ticks);
    sync();
    lastGood = input.value;
    input.dataset.hasSlider = '1';
  }

  function enhanceNumerics(config) {
    let n = 0;
    for (const [id, cfg] of Object.entries(config)) {
      const el = document.getElementById(id);
      if (!el || el.type !== 'number' || el.dataset.hasSlider) continue;
      makeSlider(el, cfg);
      n++;
    }
    return n;
  }

  window.UI = {
    C, AXIS, SPLIT, GRAT, MINOR, GRID, fmt, pct, fmtTime, fmtTimeParts, tstr, hm, dtstr, nowTime, esc, grad, hexA,
    tooltip, base, anim, initChart, noData, axisLabelFor,
    toast, setBusy, openModal, closeModal, confirm: confirmBox,
    openDrawer, closeDrawer, sortable, setPaletteProvider, openPalette,
    enhanceNumerics,
  };
})();
