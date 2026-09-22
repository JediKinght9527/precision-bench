/* LLM Bench · 共享 UI 套件
   - 统一 ECharts 主题与图表基座
   - Toast / 确认框 / 弹窗 / 抽屉
   - 面板菜单（全屏 / 导出 PNG）
   - 命令面板（⌘K）
   - 通用格式化与表格排序 */
(function () {
  'use strict';

  const C = {
    tx1: '#f6f3ee', tx2: '#b0a99e', tx3: '#827b72',
    line: 'rgba(255,250,240,.085)', line2: 'rgba(255,250,240,.16)',
    acc: '#e0a84f', acc2: '#f0c56e',
    ok: '#3dd68c', warn: '#f5b942', bad: '#ff6b5b', info: '#7dd3c8',
    cyan: '#5ec8b8', pink: '#ff7a8a', purple: '#d4a5e8', orange: '#f0c56e',
    blue: '#7eb6ff', green: '#3dd68c', yellow: '#f5b942', red: '#ff6b5b',
    tr1: '#5ec8b8', tr2: '#ff7a8a', tr3: '#f0c56e', tr4: '#7eb6ff', tr5: '#d4a5e8',
    series: ['#5ec8b8', '#ff7a8a', '#f0c56e', '#7eb6ff', '#d4a5e8', '#3dd68c', '#f5b942', '#ff6b5b'],
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
  const _tfHMS = new Intl.DateTimeFormat('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const _tfHM = new Intl.DateTimeFormat('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  const _dtf = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const tstr = (ts) => _tfHMS.format(new Date(ts * 1000));
  const hm = (ts) => _tfHM.format(new Date(ts * 1000));
  const dtstr = (ts) => _dtf.format(new Date(ts * 1000));
  const nowTime = () => _tfHMS.format(new Date());

  /* ---------- ECharts 主题 ---------- */
  echarts.registerTheme('llmbench', {
    color: C.series,
    backgroundColor: 'transparent',
    textStyle: { color: C.tx1, fontSize: 12, fontFamily: '-apple-system, "SF Pro Text", "PingFang SC", sans-serif' },
    title: { textStyle: { color: C.tx1, fontSize: 13, fontWeight: 600 } },
    line: { lineStyle: { width: 2, cap: 'round', join: 'round' }, symbol: 'none', smooth: 0.25 },
    categoryAxis: {
      axisLine: { lineStyle: { color: C.line2 } }, axisTick: { show: false },
      axisLabel: { color: C.tx3, fontSize: 11 }, splitLine: { show: false },
    },
    valueAxis: {
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: C.tx3, fontSize: 11 },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,.055)' } },
    },
    legend: { textStyle: { color: C.tx2, fontSize: 11 } },
  });

  const AXIS = { color: C.tx3, fontSize: 11, fontFamily: '-apple-system, "SF Pro Text", "PingFang SC", sans-serif' };
  const SPLIT = { lineStyle: { color: 'rgba(255,255,255,.055)', width: 1 } };
  const GRAT = { show: true, lineStyle: { color: 'rgba(255,255,255,.042)', width: 1 } };
  const MINOR = { show: true, lineStyle: { color: 'rgba(255,255,255,.018)', width: 1 } };
  const GRID = { left: 56, right: 18, top: 26, bottom: 30 };

  const grad = (hex, a1 = 0.22, a2 = 0) => new echarts.graphic.LinearGradient(0, 0, 0, 1, [
    { offset: 0, color: hexA(hex, a1) }, { offset: 1, color: hexA(hex, a2) },
  ]);
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function tooltip(unit = '', nd = 1) {
    return {
    backgroundColor: 'rgba(12,13,17,.88)', borderColor: 'rgba(255,255,255,.14)', borderWidth: 1,
    padding: [9, 11], textStyle: { color: C.tx1, fontSize: 12, fontFamily: '-apple-system, "SF Pro Text", "PingFang SC", sans-serif' },
    extraCssText: 'border-radius:14px;box-shadow:0 18px 44px rgba(0,0,0,.6);-webkit-backdrop-filter:blur(28px) saturate(1.4);backdrop-filter:blur(28px) saturate(1.4);',
      trigger: 'axis',
      axisPointer: {
        type: 'cross',
        crossStyle: { color: C.tx3, width: 1 },
        lineStyle: { color: 'rgba(255,255,255,.22)', type: 'dashed', width: 1 },
        label: { backgroundColor: 'rgba(62,66,74,.92)', color: C.tx1, fontSize: 11, borderRadius: 6, padding: [3, 7], fontFamily: '-apple-system, sans-serif' },
      },
      formatter: (ps) => {
        if (!ps || !ps.length) return '';
        let h = `<div style="color:${C.tx3};margin-bottom:7px;font-size:11px">${ps[0].axisValueLabel || ''}</div>`;
        ps.filter((p) => p.value != null && p.seriesName && !p.seriesName.startsWith('_')).forEach((p) => {
          let v = Array.isArray(p.value) ? p.value[1] : p.value;
          if (v == null || Number.isNaN(v)) return;
          v = Number(v).toFixed(nd);
          h += `<div style="display:flex;align-items:center;gap:9px;min-width:180px;line-height:1.9">
            <span style="width:8px;height:8px;border-radius:50%;background:${p.color};flex:none"></span>
            <span style="color:#c9c9d2">${p.seriesName}</span>
            <b style="margin-left:auto;font-variant-numeric:tabular-nums;font-family:inherit;font-variant-numeric:tabular-nums;font-weight:500">${v}${unit ? ' <span style="color:#6e6e7d;font-weight:400">' + unit + '</span>' : ''}</b></div>`;
        });
        return h;
      },
    };
  }

  /* 轴标小数位按数据跨度自适应：跨度大用整数，跨度小才加小数。
     否则 ECharts 会输出 318.4 / 21.88 这种又长又挤、还重复的标签。 */
  function axisLabelFor(values, unit = '') {
    const vs = (values || []).filter((v) => typeof v === 'number' && isFinite(v));
    if (!vs.length) return AXIS;
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
      graphic: { type: 'text', left: 'center', top: 'middle', style: { text, fill: C.tx3, fontSize: 12.5 } },
      xAxis: { show: false }, yAxis: { show: false }, series: [],
    }, true);
  }

  /* ---------- Toast ---------- */
  function toast(msg, type = 'info', ms = 3200) {
    const box = $('toasts');
    if (!box) return;
    const el = document.createElement('div');
    el.className = `toast t-${type}`;
    const icon = type === 'ok' ? '✓' : type === 'err' ? '✕' : type === 'warn' ? '!' : 'i';
    el.innerHTML = `<span class="tico">${icon}</span><span>${esc(msg)}</span>`;
    box.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 220); }, ms);
  }

  /* ---------- 通用弹窗 ---------- */
  function openModal(title, html) { $('modalTitle').textContent = title; $('modalBody').innerHTML = html; $('modal').hidden = false; }
  function closeModal() { $('modal').hidden = true; }

  /* ---------- 确认框 ---------- */
  let confirmResolve = null;
  function confirmBox(msg, title = '确认操作', danger = true) {
    $('confirmTitle').textContent = title;
    $('confirmMsg').textContent = msg;
    $('confirmYes').className = danger ? 'danger' : 'primary';
    $('confirm').hidden = false;
    return new Promise((res) => { confirmResolve = res; });
  }
  document.addEventListener('click', (e) => {
    if (e.target.id === 'confirmYes') { $('confirm').hidden = true; confirmResolve && confirmResolve(true); confirmResolve = null; }
    if (e.target.id === 'confirmNo') { $('confirm').hidden = true; confirmResolve && confirmResolve(false); confirmResolve = null; }
    if (e.target.id === 'modalClose' || e.target.id === 'modal') closeModal();
  });

  /* ---------- 抽屉 ---------- */
  function openDrawer(title, html) { $('drawerTitle').textContent = title; $('drawerBody').innerHTML = html; $('drawer').hidden = false; $('drawerMask').hidden = false; }
  function closeDrawer() { $('drawer').hidden = true; $('drawerMask').hidden = true; }
  document.addEventListener('click', (e) => { if (e.target.id === 'drawerClose' || e.target.id === 'drawerMask') closeDrawer(); });

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
      a.href = inst.getDataURL({ pixelRatio: 2, backgroundColor: '#08090c' });
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
    paletteIdx = 0; renderPalette();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'k' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); openPalette(); return; }
    if ($('palette').hidden) return;
    if (e.key === 'Escape') closePalette();
    else if (e.key === 'ArrowDown') { e.preventDefault(); paletteIdx = Math.min(paletteIdx + 1, paletteFiltered.length - 1); renderPalette(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); paletteIdx = Math.max(paletteIdx - 1, 0); renderPalette(); }
    else if (e.key === 'Enter') { e.preventDefault(); runPalette(paletteIdx); }
  });

  window.UI = {
    C, AXIS, SPLIT, GRAT, MINOR, GRID, fmt, pct, tstr, hm, dtstr, nowTime, esc, grad, hexA,
    tooltip, base, initChart, noData, axisLabelFor,
    toast, openModal, closeModal, confirm: confirmBox,
    openDrawer, closeDrawer, sortable, setPaletteProvider, openPalette,
  };
})();
