/* LLM Bench — 降智检测模块 */
(function () {
'use strict';
const $ = (id) => document.getElementById(id);
const { fmt, pct, esc, hm, dtstr } = UI;
const C = UI.C;

const state = { targets: [], dims: [], lmEval: null, engine: 'curated', selected: new Set(), current: null, currentStatus: 'idle', lastEventId: 0, sse: null, runIds: [], seenItems: new Set(), runs: [], lastSummary: null, filter: '' };
let dimChart = null, trendChart = null;

function ensureCharts() {
  if (!dimChart) {
    dimChart = UI.initChart($('b-ch-dims'));
    trendChart = UI.initChart($('b-ch-trend'));
    window.addEventListener('resize', () => { dimChart.resize(); trendChart.resize(); });
  }
  dimChart.resize(); trendChart.resize();
}

async function fetchJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

/* ---------- 维度选择 ---------- */
async function loadDims() {
  const d = await fetchJSON('/api/bench/datasets');
  state.dims = d.dimensions;
  state.lmEval = d.lm_eval || null;
  state.selected = new Set(defaultSelection());
  renderDims();
}
function defaultSelection() {
  if (state.engine === 'lm_eval') {
    return (state.lmEval && state.lmEval.default_tasks) || ['gsm8k'];
  }
  return state.dims.map((x) => x.dim);
}
function renderDims() {
  const box = $('b-dims');
  if (state.engine === 'lm_eval') {
    const L = state.lmEval;
    if (!L || !L.available) {
      box.innerHTML = '<div class="hint">未安装 lm-eval，无法使用官方数据集</div>';
      return;
    }
    box.innerHTML = L.tasks.map((t) => {
      const on = state.selected.has(t.task) && !t.logprobs;
      const unsupported = t.logprobs;
      return `<label class="dim ${on ? 'on' : ''} ${unsupported ? 'unsupported' : ''}" data-dim="${t.task}" data-logprobs="${unsupported ? '1' : '0'}">
        <input type="checkbox" ${on ? 'checked' : ''} ${unsupported ? 'disabled' : ''} />
        <span class="dn">${esc(t.label)}</span>
        <span class="db">${esc(t.task)}</span>
        <span class="dc">${unsupported ? '当前执行器不支持' : '生成式'}</span>
      </label>`;
    }).join('');
    return;
  }
  box.innerHTML = state.dims.map((d) => `
    <label class="dim ${state.selected.has(d.dim) ? 'on' : ''}" data-dim="${d.dim}">
      <input type="checkbox" ${state.selected.has(d.dim) ? 'checked' : ''} />
      <span class="dn">${esc(d.name)}</span>
      <span class="db">${esc(d.bench)}</span>
      <span class="dc">${d.dynamic ? '动态' : d.count + ' 题'}</span>
    </label>`).join('');
}
document.addEventListener('click', (e) => {
  const el = e.target.closest('.dim');
  if (!el) return;
  const dim = el.dataset.dim;
  if (el.dataset.logprobs === '1') { UI.toast('当前执行器不支持 logprobs 任务', 'warn'); return; }
  if (state.selected.has(dim)) state.selected.delete(dim); else state.selected.add(dim);
  renderDims();
});

/* ---------- 解析 ---------- */
function maskKey(k) {
  if (!k) return '';
  if (k.length <= 12) return k;
  return k.slice(0, 6) + '…' + k.slice(-4);
}
function renderTargets() {
  const list = state.targets;
  $('b-chanCount').textContent = list.length ? `${list.length} 个渠道 · ${new Set(list.map((t) => t.model)).size} 个模型` : '未解析';
  $('b-channels').innerHTML = list.map((t, i) => `
    <div class="chan" data-i="${i}">
      <span class="chan-model">${esc(t.model || '(缺模型名)')}</span>
      <span class="chan-side">
        <span class="badge">${esc(t.provider)}</span>
        <button class="chan-x" data-brm="${i}" title="移除">×</button>
      </span>
      ${t.base_url ? `<span class="chan-url" title="${esc(t.base_url)}">${esc(t.base_url.replace(/^https?:\/\//, ''))}</span>` : `<button type="button" class="chan-warn" data-bfillurl="${i}" title="点击补填 base_url">待填地址</button>`}
      ${t.api_key ? `<span class="chan-key">${esc(maskKey(t.api_key))}</span>` : '<span class="chan-warn">缺少密钥</span>'}
    </div>`).join('') || '<div class="hint">还没识别到渠道。贴入配置后点「识别配置」。</div>';
}
async function doParse() {
  const text = $('b-paste').value.trim();
  if (!text) { UI.toast('先粘贴供应商配置（地址 / 密钥 / 模型）', 'warn'); $('b-paste').focus(); return; }
  const btn = $('btnBenchParse');
  UI.setBusy(btn, true, '识别中…');
  try {
    const d = await fetchJSON('/api/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    state.targets = d.targets;
    renderTargets();
    UI.toast(d.targets.length ? `识别到 ${d.targets.length} 个渠道` : '没识别出渠道，检查一下粘贴内容', d.targets.length ? 'ok' : 'warn');
  } catch (e) { UI.toast('识别失败: ' + e.message, 'err'); }
  finally { UI.setBusy(btn, false); }
}
document.addEventListener('click', (e) => {
  const rm = e.target.closest('button[data-brm]');
  if (rm) { state.targets.splice(Number(rm.dataset.brm), 1); renderTargets(); return; }
  const fu = e.target.closest('button[data-bfillurl]');
  if (fu) {
    const i = Number(fu.dataset.bfillurl);
    const cur = state.targets[i];
    if (!cur) return;
    const url = prompt('补填 base_url（完整接口地址，如 https://api.example.com/v1）', cur.base_url || 'https://');
    if (url == null) return;
    const u = url.trim();
    if (!u) return;
    state.targets[i] = { ...cur, base_url: u };
    renderTargets();
    UI.toast('已更新 base_url', 'ok');
  }
});

/* ---------- 运行 ---------- */
function buildBody() {
  const n = (id) => Number($(id).value);
  const body = {
    targets: state.targets.filter((t) => t.base_url), dims: [...state.selected],
    engine: state.engine,
    temperature: n('b-temperature'), max_tokens: n('b-max_tokens'),
    needle_tokens: n('b-needle_tokens'), threshold: n('b-threshold'),
    timeout_s: n('b-timeout_s'), proxy: $('b-proxy').value.trim() || null,
    verify_tls: true, name: '',
  };
  if (state.engine === 'lm_eval') {
    body.limit = n('b-limit') || 0;          // 0 = 全量
    body.num_concurrent = n('b-concurrent');
    body.seed = n('b-seed');
    body.alpha = n('b-alpha');
    body.min_delta = n('b-mindelta');
    const fs = $('b-fewshot').value.trim();
    body.fewshot = fs === '' ? null : Number(fs);
  }
  return body;
}
function syncBenchControls() {
  const run = $('btnBenchRun');
  const stop = $('btnBenchStop');
  const actions = $('side-actions-bench');
  if (!run || !stop) return;
  const active = state.currentStatus === 'running' || state.currentStatus === 'pending';
  const batchActive = state.runIds.length > 0;
  const stopping = state.currentStatus === 'stopping';
  const finished = ['done', 'error', 'stopped'].includes(state.currentStatus);
  run.disabled = active || stopping || batchActive || run.dataset.busy === '1';
  stop.disabled = !batchActive || stopping;
  if (run.dataset.busy !== '1') {
    run.textContent = stopping ? '正在停止…' : state.currentStatus === 'running' ? '检测进行中' : finished ? '重新检测' : '开始检测';
    run.setAttribute('aria-label', run.textContent);
  }
  stop.textContent = '停止检测';
  actions?.setAttribute('data-state', state.currentStatus);
}

async function startRun() {
  if (!state.targets.length) { await doParse(); if (!state.targets.length) { UI.toast('请先粘贴配置并点「识别配置」', 'warn'); return; } }
  if (!state.selected.size) { UI.toast('请至少选择一个维度', 'warn'); return; }
  if (!state.targets.filter((t) => t.base_url).length) { UI.toast('还没有可用地址，请补上 base_url 后再检测', 'warn'); return; }
  const btn = $('btnBenchRun');
  UI.setBusy(btn, true, '启动中…');
  try {
    const d = await fetchJSON('/api/bench/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildBody()) });
    state.runIds = d.run_ids;
    state.current = d.run_ids[0];
    state.currentStatus = 'running';
    syncBenchControls();
    $('b-itemsBody').innerHTML = '';
    $('b-progress').textContent = '0/0';
    renderVerdict({ verdict: 'running' }); ensureCharts(); UI.noData($('b-ch-dims'), 'No data'); UI.noData($('b-ch-trend'));
    if (state.sse) state.sse.close();
    state.lastEventId = 0;
    state.seenItems.clear();
    state.sse = null;
    UI.toast('降智检测已启动', 'ok');
    connectSSE(state.current);
  } catch (e) { UI.toast('启动失败: ' + e.message, 'err'); }
  finally { UI.setBusy(btn, false); syncBenchControls(); }
}
window.__benchStart = startRun;
function connectSSE(rid, resetAck = false, afterId = null) {
  const query = resetAck ? `?reset=1&after_id=${encodeURIComponent(afterId ?? 0)}` : '';
  const es = new EventSource(`/api/bench/runs/${rid}/stream${query}`);
  state.sse = es;
  es.onopen = () => {
    const el = $('b-progress');
    // HTML 默认是 "0/0"：仅在尚未收到 progress 时才显示「连接中…」
    if (!el.dataset.got) el.textContent = '连接中…';
  };
  es.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id != null) {
      if (state.lastEventId && m.id <= state.lastEventId) return;
      state.lastEventId = m.id;
    }
    if (m.type === 'reset') {
      state.lastEventId = 0;
      viewing(rid, true);
      return;
    }
    if (m.type === 'item') addItem(m.data);
    else if (m.type === 'progress') {
      const el = $('b-progress');
      el.dataset.got = '1';
      el.textContent = `${m.done}/${m.total}`;
      $('b-passed').textContent = m.ok;
    }
    else if (m.type === 'summary') {
      syncBenchControls();
      renderSummary(m.data);
    }
    else if (m.type === 'status') {
       state.currentStatus = m.status;
       if (m.id != null && ['done', 'error', 'stopped'].includes(m.status)) {
         state.runIds = state.runIds.length <= 1 ? [] : state.runIds.filter((rid) => rid !== state.current);
       }
       syncBenchControls();
      if (['done', 'error', 'stopped'].includes(m.status)) {
        if (m.status !== 'done') renderVerdict({ verdict: 'error', note: m.status === 'stopped' ? '已停止' : '出错' });
        loadHistory();
        if (m.status === 'done') UI.toast('降智检测完成', 'ok');
        es.close();
      }
    } else if (m.type === 'error') { state.currentStatus = 'error'; syncBenchControls(); renderVerdict({ verdict: 'error', note: m.message }); UI.toast('检测出错: ' + m.message, 'err'); }
  };
  // 可见重连提示：不让 EventSource 静默死亡（原实现直接 close 屏蔽自动重连）
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      renderVerdict({ verdict: 'error', note: '连接中断，无法自动重连' });
      UI.toast('检测连接中断', 'err');
    } else {
      // 重连时保留已有进度数字，只在从未收到 progress 时提示文案
      const el = $('b-progress');
      if (!el.dataset.got) el.textContent = '重连中…';
    }
  };
}
function addItem(d) {
  const key = `${d.dim}::${d.item_id}`;
  if (state.seenItems.has(key)) return;
  state.seenItems.add(key);
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${esc(d.dim)}</td><td class="mono">${esc(d.item_id)}</td>
    <td><span class="badge ${d.passed ? 'ok' : 'no'}">${d.passed ? 'PASS' : 'FAIL'}</span></td>
    <td class="num">${d.latency_ms ? Math.round(d.latency_ms) + ' ms' : '–'}</td>
    <td class="dimtxt">${esc(d.detail || '')}</td>
    <td class="got">${esc(d.got || '')}</td>`;
  const body = $('b-itemsBody');
  body.appendChild(tr);
  while (body.childElementCount > 300) body.removeChild(body.firstChild);
  tr.scrollIntoView({ block: 'nearest' });
}

/* ---------- 结果渲染 ---------- */
function renderSummary(s) {
  state.lastSummary = s;
  renderVerdict(s); ensureCharts(); renderDimChart(s); renderTrend(s);
  $('b-progress').textContent = `${s.completed ?? 0}/${s.n_items ?? 0}`;
  $('b-passed').textContent = Object.values(s.dims || {}).reduce((a, d) => a + (d.passed || 0), 0);
}
function renderVerdict(s) {
  const v = s.verdict || (s.comparison && s.comparison.verdict) || 'running';
  const c = s.comparison || s;
  const map = {
    idle: ['待检测', '', '粘贴供应商配置、选择维度后开始；首次运行自动建立基线'],
    running: ['运行中', 'acc', '正在逐题检测…'],
    baseline: ['基线已建立', 'b', '已记录为基线，下次检测将与之对比'],
    normal: ['正常', 'g', '与基线相比无显著变化'],
    suspect: ['疑似降智', 'x', '总分或关键维度显著下降'],
    improved: ['高于基线', 'g', '分数高于基线'],
    error: ['出错', 'x', ''],
  };
  const [title, cls, note] = map[v] || ['—', '', ''];
  const total = s.total != null ? (s.total * 100).toFixed(1) + '%' : '—';
  const delta = c.delta != null ? (c.delta > 0 ? '+' : '') + (c.delta * 100).toFixed(1) + 'pp' : '';
  const stats = [];
  const notes = [note];
  const n = s.n_items ?? s.completed ?? null;
  if (s.n_items != null || s.completed != null) stats.push(`样本 <b>${s.completed ?? 0}/${s.n_items ?? '—'}</b>`);
  const passed = Object.values(s.dims || {}).reduce((a, d) => a + (d.passed || 0), 0);
  if (Object.keys(s.dims || {}).length) stats.push(`通过 <b>${passed}</b>`);
  if (c.baseline_total != null) stats.push(`基线 <b>${(c.baseline_total * 100).toFixed(1)}%</b>`);
  if (c.p_value != null) stats.push(`p <b>${Number(c.p_value).toFixed(3)}</b>`);
  if (s.consistency_match != null) stats.push(`自洽 <b>${(s.consistency_match * 100).toFixed(0)}%</b>`);
  if (n != null && n < 200) notes.push('样本偏小，仅作趋势参考');
  if (c.p_value != null && !c.significant) notes.push('变化不显著');
  if (c.n_paired) notes.push(`配对题数 ${c.n_paired}`);
  if (c.fingerprint_changed) notes.push('题集指纹变化');
  if (c.flag_dims && c.flag_dims.length) notes.push(`下降维度：${c.flag_dims.join('、')}`);
  const el = $('b-verdict');
  el.className = `verdict ${cls}`;
  const right = v === 'idle' ? '' : `<div class="vright"><div class="vscore">${total}</div><div class="vdelta ${c.delta < 0 ? 'down' : c.delta > 0 ? 'up' : ''}">${delta}</div></div>`;
  el.innerHTML = `<div class="vleft"><div class="vtitle">${title}</div><div class="vnote">${notes.filter(Boolean).join(' · ')}</div>${stats.length ? `<div class="vstats">${stats.map((item) => `<span class="vstat">${item}</span>`).join('')}</div>` : ''}</div>${right}`;
}
function renderDimChart(s) {
  if (!dimChart) return;
  const dims = Object.entries(s.dims || {});
  if (!dims.length) { UI.noData($('b-ch-dims'), 'No data'); return; }
  const names = dims.map(([, v]) => v.name);
  const vals = dims.map(([, v]) => +(v.score * 100).toFixed(1));
  // 95% Wilson 置信区间：区间越宽 = 题量越不足，一眼能看出结论的可信度
  const ciData = dims.map(([, v], i) => [i, +((v.ci_low ?? v.score) * 100).toFixed(1), +((v.ci_high ?? v.score) * 100).toFixed(1)]);
  dimChart.setOption(UI.base({
    tooltip: { ...UI.tooltip(), trigger: 'axis' },
    grid: { left: 52, right: 20, top: 18, bottom: 44 },
    xAxis: { type: 'category', data: names, axisLabel: { ...UI.AXIS, interval: 0, rotate: 20 }, axisLine: { lineStyle: { color: C.line2 } } },
    yAxis: { type: 'value', max: 100, axisLabel: { ...UI.AXIS, formatter: '{value}%' }, axisLine: { show: false }, splitLine: UI.SPLIT },
    series: [
      { name: '本次', type: 'bar', data: vals, barMaxWidth: 34,
        itemStyle: { color: UI.grad(C.tr1, .9, .3), borderRadius: [4, 4, 0, 0] },
        label: { show: true, position: 'top', color: C.tx2, fontSize: 11, formatter: '{c}%' } },
      { name: '95% CI', type: 'custom', silent: true, z: 5, data: ciData,
        renderItem: (params, api) => {
          const i = api.value(0);
          const lo = api.coord([i, api.value(1)]);
          const hi = api.coord([i, api.value(2)]);
          const w = 7;
          const stl = { stroke: C.tx2, lineWidth: 1.4 };
          return { type: 'group', children: [
            { type: 'line', shape: { x1: lo[0], y1: lo[1], x2: hi[0], y2: hi[1] }, style: stl },
            { type: 'line', shape: { x1: lo[0] - w, y1: lo[1], x2: lo[0] + w, y2: lo[1] }, style: stl },
            { type: 'line', shape: { x1: hi[0] - w, y1: hi[1], x2: hi[0] + w, y2: hi[1] }, style: stl },
          ] };
        } },
    ],
  }), true);
}
function renderTrend(s) {
  if (!trendChart) return;
  const run = state.runs.find((r) => r.run_id === state.current);
  if (!run) { UI.noData($('b-ch-trend')); return; }
  const same = state.runs
    .filter((r) => r.base_url_masked === run.base_url_masked && r.model === run.model)
    .filter((r) => !run.task_key || r.task_key === run.task_key)
    .sort((a, b) => a.ts - b.ts);
  if (!same.length) { UI.noData($('b-ch-trend')); return; }

  const pts = same.map((r) => +((r.total_score || 0) * 100).toFixed(1));
  const labels = same.map((r) => hm(r.ts));
  const last = pts.length - 1;
  const base = s && s.comparison && s.comparison.baseline_total != null
    ? +(s.comparison.baseline_total * 100).toFixed(1) : null;
  const lo = Math.min(...pts, base != null ? base : 101);
  const hi = Math.max(...pts, base != null ? base : -1);

  // 最新点单独放大标注，其余点按常规大小
  const data = pts.map((v, i) => (i === last
    ? { value: v, symbolSize: 12, itemStyle: { color: C.tr4, borderColor: C.bg0, borderWidth: 3 } }
    : v));

  trendChart.setOption(UI.base({
    tooltip: { ...UI.tooltip('%'), trigger: 'axis' },
    grid: { left: 56, right: 26, top: 26, bottom: 40 },
    xAxis: {
      type: 'category', boundaryGap: false, data: labels,
      axisLabel: { ...UI.AXIS, hideOverlap: true },
      axisLine: { lineStyle: { color: C.line2 } }, splitLine: { show: false },
      axisTick: { show: true, length: 3, lineStyle: { color: C.line2 } },
    },
    // 自适应区间：分数集中在高段时不要把 0~100 全画出来，那样看不出变化
    yAxis: {
      type: 'value', min: Math.max(0, Math.floor((lo - 4) / 5) * 5),
      max: Math.min(100, Math.ceil((hi + 4) / 5) * 5),
      axisLabel: { ...UI.AXIS, formatter: '{value}%' },
      axisLine: { show: false }, splitLine: UI.SPLIT,
    },
    series: [{
      name: '总分', type: 'line', smooth: 0.35, symbol: 'circle', symbolSize: 7,
      data,
      lineStyle: { color: C.tr4, width: 2, cap: 'round', join: 'round', shadowColor: C.tr4, shadowBlur: 4 },
      itemStyle: { color: C.tr4, borderColor: C.bg0, borderWidth: 2 },
      areaStyle: { color: UI.grad(C.tr4, .10, 0) },
      // 基线参考线：一眼看出"比基线高还是低"
      markLine: base != null ? {
        silent: true, symbol: 'none',
        lineStyle: { color: C.tx3, type: 'dashed', width: 1 },
        label: { formatter: `基线 ${base}%`, color: C.tx3, fontSize: 10, position: 'insideEndTop' },
        data: [{ yAxis: base }],
      } : undefined,
      // 极值标注
      markPoint: pts.length > 1 ? {
        symbol: 'pin', symbolSize: 34,
        itemStyle: { color: UI.hexA(C.tr4, .18), borderColor: C.tr4, borderWidth: 1 },
        label: { color: C.tx1, fontSize: 10, formatter: (x) => `${x.value}%` },
        data: [{ type: 'max', name: '最高' }, { type: 'min', name: '最低' }],
      } : undefined,
      // 最新一次的值直接标在点上
      label: {
        show: true, position: 'top', color: C.tr4, fontSize: 11, fontWeight: 600,
        formatter: (x) => (x.dataIndex === last ? `${x.value}%` : ''),
      },
    }],
  }), true);
}

/* ---------- 历史 ---------- */
async function loadHistory() {
  const d = await fetchJSON('/api/bench/runs');
  state.runs = d.runs;
  const current = d.runs.find((r) => r.run_id === state.current) || d.runs[0];
  state.currentStatus = current?.status || 'idle';
  state.runIds = d.runs.filter((r) => ['running', 'pending', 'stopping'].includes(r.status)).map((r) => r.run_id);
  syncBenchControls();
  renderHist();
  if (!state.current && d.runs.length) viewing(d.runs[0].run_id);
  if (state.current && ['running', 'pending', 'stopping'].includes(state.currentStatus) && !state.sse) viewing(state.current);
}
function renderHist() {
  $('b-histBody').innerHTML = state.runs.map((r) => `<tr>
      <td class="mono">${dtstr(r.ts)}</td>
      <td>${esc(r.model)}</td>
      <td>${esc(r.base_url_masked)}</td>
      <td class="num">${((r.total_score || 0) * 100).toFixed(1)}%</td>
      <td class="mono">${esc(r.fingerprint || '–')}</td>
      <td class="st-${r.status === 'done' ? 'done' : r.status === 'error' ? 'error' : 'running'}">${r.status}</td>
      <td class="act">
        <button class="mini" data-bact="view" data-id="${r.run_id}">查看</button>
        <button class="mini ghost" data-bact="base" data-id="${r.run_id}">设为基线</button>
        <button class="mini ghost" data-bact="del" data-id="${r.run_id}">删</button>
      </td></tr>`).join('') || '<tr><td colspan="7" class="hint">暂无记录</td></tr>';
}
async function viewing(id, resetAck = false) {
  const body = $('b-itemsBody');
  body.innerHTML = '<tr><td colspan="6" class="hint">加载中…</td></tr>';
  try {
    if (state.sse) { state.sse.close(); state.sse = null; state.lastEventId = 0; }
    const d = await fetchJSON(`/api/bench/runs/${id}`);
     state.current = id;
     state.seenItems = new Set((d.items || []).map((it) => `${it.dim}::${it.item_id}`));
     state.lastEventId = d.event_seq || 0;
     const meta = state.runs.find((r) => r.run_id === id);
     state.currentStatus = meta?.status || 'idle';
     state.runIds = state.runs.filter((r) => ['running', 'pending', 'stopping'].includes(r.status)).map((r) => r.run_id);
     syncBenchControls();
     if (['running', 'pending', 'stopping'].includes(state.currentStatus) && !state.sse) connectSSE(id, true, state.lastEventId);
     renderSummary(d.run.scores || {});
    const rows = d.items.map((it) => `<tr>
    <td>${esc(it.dim)}</td><td class="mono">${esc(it.item_id)}</td>
    <td><span class="badge ${it.passed ? 'ok' : 'no'}">${it.passed ? 'PASS' : 'FAIL'}</span></td>
    <td class="num">${it.latency_ms ? Math.round(it.latency_ms) + ' ms' : '–'}</td>
    <td class="dimtxt">${esc(it.detail || '')}</td>
    <td class="got">${esc(it.got || '')}</td></tr>`);
    // 与实时 addItem 同上限：lm_eval 千行直接 innerHTML 会卡死
    body.innerHTML = rows.slice(0, 300).join('') || '<tr><td colspan="6" class="hint">暂无条目</td></tr>';
    if (rows.length > 300) body.insertAdjacentHTML('beforeend', `<tr><td colspan="6" class="hint">仅显示前 300 条，共 ${rows.length} 条</td></tr>`);
  } catch (e) {
    body.innerHTML = `<tr><td colspan="6" class="hint">加载失败：${esc(e.message)}</td></tr>`;
    UI.toast('加载详情失败: ' + e.message, 'err');
    if (resetAck) setTimeout(() => viewing(id, true), 1200);
  }
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-bact]');
  if (!b) return;
  const { bact, id } = b.dataset;
  if (bact === 'view') viewing(id);
  else if (bact === 'base') { await fetchJSON(`/api/bench/runs/${id}/baseline`, { method: 'POST' }); UI.toast('已设为基线', 'ok'); loadHistory(); }
  else if (bact === 'del') {
    if (await UI.confirm('删除该检测记录？', '删除记录')) {
      try {
        await fetchJSON(`/api/bench/runs/${id}`, { method: 'DELETE' });
        if (state.current === id) state.current = null;
        UI.toast('已删除', 'ok');
        loadHistory();
      } catch (e) { UI.toast('删除失败: ' + e.message, 'err'); }
    }
  }
});

/* ---------- tabs / 搜索 / 视图切换 ---------- */
document.querySelectorAll('#view-bench .tabs button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('#view-bench .tabs button').forEach((x) => x.classList.toggle('on', x === b));
  ['b-pane-items', 'b-pane-hist'].forEach((k) => $(k).classList.toggle('on', k === 'b-pane-' + b.dataset.tab));
});
$('benchSearch').oninput = () => {
  const q = $('benchSearch').value.trim().toLowerCase();
  [...$('b-itemsBody').children].forEach((tr) => { tr.style.display = (!q || tr.textContent.toLowerCase().includes(q)) ? '' : 'none'; });
};
setInterval(() => {
  if (state.runIds.length || ['running', 'pending', 'stopping'].includes(state.currentStatus)) {
    loadHistory().catch(() => {});
  }
}, 3000);

window.addEventListener('viewchange', (e) => {
  if (!e.detail || e.detail.view !== 'bench') return;
  ensureCharts();
  if (state.lastSummary) { renderDimChart(state.lastSummary); renderTrend(state.lastSummary); }
});

$('btnBenchParse').onclick = doParse;
$('btnBenchRun').onclick = startRun;
$('btnBenchStop').onclick = async () => { if (state.runIds.length) { await Promise.all(state.runIds.map((rid) => fetchJSON(`/api/bench/runs/${rid}/stop`, { method: 'POST' }))); state.currentStatus = 'stopping'; syncBenchControls(); UI.toast('已发送停止', 'info'); } };
/* 题集切换：切引擎时重置选择并切换参数区 */
$('b-engine').onchange = () => {
  state.engine = $('b-engine').value;
  $('b-official-params').hidden = state.engine !== 'lm_eval';
  state.selected = new Set(defaultSelection());
  renderDims();
};

/* 预下载官方数据集（走 hf-mirror 镜像） */
$('btnPredownload').onclick = async () => {
  const tasks = [...state.selected];
  if (!tasks.length) { UI.toast('请先选择任务', 'warn'); return; }
  $('btnPredownload').disabled = true;
  $('b-hf-state').textContent = '下载中…（首次可能几分钟）';
  try {
    const d = await fetchJSON('/api/bench/predownload', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tasks }) });
    $('b-hf-state').textContent = d.ok ? '数据集已就绪' : '下载失败，见日志';
    UI.toast(d.ok ? '数据集已缓存到本地' : '下载失败', d.ok ? 'ok' : 'err');
  } catch (e) {
    $('b-hf-state').textContent = '下载失败: ' + e.message;
    UI.toast('下载失败: ' + e.message, 'err');
  } finally { $('btnPredownload').disabled = false; }
};

$('btnBenchDemo').onclick = () => { $('b-paste').value = 'base_url: https://api.openai.com\napi_key: sk-your-key\nmodel: gpt-4o-mini'; doParse(); };

renderVerdict({ verdict: 'idle' });
syncBenchControls();
UI.noData($('b-ch-dims'), 'No data'); UI.noData($('b-ch-trend'));
loadDims();
loadHistory();
})();
