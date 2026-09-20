/* LLM Bench — 性能压测模块 */
(function () {
'use strict';
const $ = (id) => document.getElementById(id);
const { fmt, pct, tstr, esc, nowTime, dtstr } = UI;
const C = UI.C;
const AXIS = UI.AXIS, SPLIT = UI.SPLIT, GRAT = UI.GRAT, MINOR = UI.MINOR;

const state = {
  targets: [], runs: new Map(), primary: null, colorIdx: 0, logs: [],
  filter: '', sort: { key: null, dir: 'asc' }, range: 0, autoRefresh: true,
  reqSamples: [], reqOnlyFail: false, reqClass: '', reqSearch: '',
};

/* ---------- 工具 ---------- */
/* 滚动分位。
   关键：窗口内样本不足 minSamples 时返回 null（不画）。
   否则第 1 个样本就参与分位 → P50 从首值一路收敛到稳态，会画出一个巨大的三角楔形，
   既难看又没有统计意义。 */
function rollingPercentile(values, win, p, minSamples = 10) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const s = values.slice(Math.max(0, i - win + 1), i + 1).filter((x) => x != null).sort((a, b) => a - b);
    if (s.length < minSamples) { out.push(null); continue; }
    const k = (s.length - 1) * p / 100, lo = Math.floor(k), hi = Math.min(lo + 1, s.length - 1);
    out.push(+(s[lo] + (s[hi] - s[lo]) * (k - lo)).toFixed(1));
  }
  return out;
}

/* 稳健 Y 轴范围：按 P2–P98 取，避免个别离群值把整张图压平。
   超出范围的样本依然画（被裁剪），tooltip 里能看真值。 */
function robustRange(values, pad = 0.12) {
  const vs = (values || []).filter((v) => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b);
  if (vs.length < 5) return {};
  const q = (p) => vs[Math.min(vs.length - 1, Math.max(0, Math.round((vs.length - 1) * p)))];
  const lo = q(0.02), hi = q(0.98);
  const span = Math.max(hi - lo, 1e-6);
  const nice = (x) => {
    const m = Math.pow(10, Math.floor(Math.log10(x)));
    const f = x / m;
    return m * (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10);
  };
  // 目标 4 格；若取整后格数超过 5（说明中间刻度会挤成一坨）就放大步长
  let step = nice((span * (1 + pad * 2)) / 4);
  let min = Math.floor((lo - span * pad) / step) * step;
  let max = Math.ceil((hi + span * pad) / step) * step;
  for (let i = 0; i < 12 && (max - min) / step > 5; i++) {
    step = nice(step * 1.5);
    min = Math.floor((lo - span * pad) / step) * step;
    max = Math.ceil((hi + span * pad) / step) * step;
  }
  // interval 显式喂给 ECharts：value 轴不会再自作主张插 39.5/38.5 这种中间刻度
  return { min: +min.toFixed(4), max: +max.toFixed(4), interval: +step.toFixed(4) };
}
// 按运行时长自适应分桶，目标 ~48 个桶（长跑不会产生上千列）
const BUCKET_STEPS = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000, 3600000];
function pickBucketMs(S, target = 48) {
  if (!S || S.length < 2) return 1000;
  const spanMs = Math.max(0, (S[S.length - 1].ts - S[0].ts) * 1000);
  const raw = Math.max(1000, spanMs / target);
  return BUCKET_STEPS.find((s) => s >= raw) || BUCKET_STEPS[BUCKET_STEPS.length - 1];
}
const bucketLabel = (ms) => (ms >= 60000 ? UI.hm : UI.tstr);

/* 滑动窗口速率：输出与样本等长，x 与延迟图同为 seq 序列，可直接纵向比对 */
function windowedRate(S, winMs) {
  const n = S.length, rps = new Array(n), tps = new Array(n);
  let lo = 0, cnt = 0, tok = 0;
  for (let i = 0; i < n; i++) {
    cnt += 1; tok += S[i].out_tokens || 0;
    while (lo < i && (S[i].ts - S[lo].ts) * 1000 > winMs) { cnt -= 1; tok -= S[lo].out_tokens || 0; lo += 1; }
    const span = Math.max(0.25, S[i].ts - S[lo].ts);
    rps[i] = +(cnt / span).toFixed(2);
    tps[i] = +(tok / span).toFixed(1);
  }
  return [rps, tps];
}

function bucketize(samples, bucketMs, fn) {
  const map = new Map();
  for (const s of samples) {
    const b = Math.floor((s.ts * 1000) / bucketMs) * bucketMs;
    if (!map.has(b)) map.set(b, []);
    map.get(b).push(s);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([b, arr]) => [b, fn(arr)]);
}
function visSamples(run) {
  if (!run) return [];
  let s = run.samples;
  if (state.range > 0) {
    const cut = Date.now() / 1000 - state.range;
    s = s.filter((x) => x.ts >= cut);
  }
  return s;
}
function log(level, msg) {
  const t = nowTime();
  state.logs.push({ t, level, msg });
  if (state.logs.length > 500) state.logs.shift();
  const el = $('log');
  if (!el) return;
  const div = document.createElement('div');
  div.innerHTML = `<span class="t">${t}</span> <span class="l-${level}">${esc(msg)}</span>`;
  el.appendChild(div);
  while (el.childElementCount > 500) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}
function sparkline(canvas, values, color) {
  if (!canvas || !values.length) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 120, h = canvas.clientHeight || 20;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  const vs = values.filter((v) => v != null);
  if (vs.length < 2) return;
  const min = Math.min(...vs), max = Math.max(...vs), span = max - min || 1;
  g.beginPath();
  values.forEach((v, i) => { if (v == null) return; const x = (i / (values.length - 1)) * w; const y = h - 2 - ((v - min) / span) * (h - 4); i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.strokeStyle = color; g.lineWidth = 1.2; g.stroke();
  g.lineTo(w, h); g.lineTo(0, h); g.closePath();
  const grad = g.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, color + '33'); grad.addColorStop(1, color + '00');
  g.fillStyle = grad; g.fill();
}

/* ---------- 图表 ---------- */
const charts = {};
['e2e', 'ttft', 'tpot', 'tput', 'heat', 'err', 'dist', 'cmp'].forEach((k) => { charts[k] = UI.initChart($('ch-' + k)); });
// 三张延迟图共享同一 seq 序列 → 联动十字准星，竖向对齐可直接比读
try { echarts.connect([charts.e2e, charts.ttft, charts.tpot, charts.tput]); } catch (e) { /* 老版本忽略 */ }
window.addEventListener('resize', () => Object.values(charts).forEach((c) => c && c.resize()));
window.addEventListener('viewchange', (e) => {
  if (e.detail.view === 'perf') requestAnimationFrame(() => Object.values(charts).forEach((c) => c && c.resize()));
});

/* ---------- 结论带 ---------- */
/* 缓存能不能测，取决于配置：
   - randomize 开启 → 每次前缀都不同，缓存必然不命中
   - prompt 极短（hi）→ 命中 token 数低于缓存最小粒度，测不出来
   这两种情况都不能显示 0%（会被误读成"渠道无缓存"）。 */
function cacheDisplay(sum) {
  const run = state.primary ? state.runs.get(state.primary) : null;
  if (!sum || !sum.cache || !sum.tokens || !sum.tokens.in) return { text: '–', cls: '' };
  if (run && run.randomize) return { text: 'n/a', cls: '' };
  if (run && run.promptMode === 'tiny') return { text: 'n/a', cls: '' };
  const r = sum.cache.hit_rate;
  return { text: pct(r), cls: r > 0 ? 'v-ok' : '' };
}

// 有失败时不给延迟上好颜色；一个都没成功则延迟无意义，显示 –
const lat = (s, v, ok, warn) => (s.failed > 0 ? '' : v <= ok ? 'v-ok' : v <= warn ? 'v-warn' : 'v-bad');
const lv = (s, v) => (s.ok ? fmt(v) : '–');
// 指标命名对齐 vLLM / SGLang：TTFT / TPOT / ITL / E2EL，字段规律 {stat}_{metric}
// 第六项是中文释义，用作 hover 提示；完整口径见顶栏「?」里的说明表
/* 读数区第一行 = 判定依据三要素（口径与判定一致：用 P95）；次级网格按重要性排序 */
const PRIMARY_DEFS = [
  ['Success rate', (s) => pct(s.success_rate), '', (s) => s.success_rate >= 0.99 ? 'v-ok' : s.success_rate >= 0.95 ? 'v-warn' : 'v-bad', '请求成功率'],
  ['TTFT P95', (s) => lv(s, s.ttft.p95), 'ms', (s) => lat(s, s.ttft.p95, 800, 2000), 'Time To First Token 首字延迟 P95（与判定同口径）'],
  ['E2EL P95', (s) => lv(s, s.e2e.p95), 'ms', (s) => lat(s, s.e2e.p95, 800, 2000), 'End-to-End Latency 端到端 P95（与判定同口径）'],
];
const METRIC_DEFS = [
  ['RPS', (s) => fmt(s.rps, 2), 'req/s', () => '', '请求速率 = 完成请求数 / 墙钟'],
  ['Output tok/s', (s) => fmt(s.tokens.output_throughput, 1), 'tok/s', () => 'v-info', '总输出 token / 墙钟时长（与 vLLM、SGLang 口径一致）；单请求解码口径见详情'],
  ['Cache hit', (s) => cacheDisplay(s).text, '', (s) => cacheDisplay(s).cls, '缓存命中率 = 命中输入 token / 总输入 token。随机化开启或 prompt 过短时无法测量'],
  ['Goodput', (s) => pct(s.goodput), '', (s) => s.goodput >= 0.9 ? 'v-ok' : 'v-warn', '达标请求占比；vLLM 的 request_goodput 是速率口径（req/s），见详情'],
  ['TPOT', (s) => (s.measurable && !s.measurable.tpot ? 'n/a' : s.ok ? fmt(s.tpot.mean, 1) : '–'), 'ms', (s) => (s.measurable && !s.measurable.tpot ? '' : lat(s, s.tpot.mean, 40, 100)), 'Time Per Output Token 每 token 时间（非流式不可测）'],
  ['ITL P99', (s) => (s.measurable && !s.measurable.itl ? 'n/a' : fmt(s.itl.p99, 1)), 'ms', () => '', 'Inter-Token Latency 相邻 token 间隔的 P99（非流式不可测）'],
  ['E2EL P50', (s) => lv(s, s.e2e.p50), 'ms', () => '', 'End-to-End Latency 端到端 P50'],
  ['E2EL P99', (s) => lv(s, s.e2e.p99), 'ms', () => '', '端到端长尾；主流压测工具（k6/Locust）都会单列的尾分位'],
  ['E2EL mean', (s) => lv(s, s.e2e.mean), 'ms', () => '', '端到端均值'],
  ['Checks', (s) => (s.ok > 0 && s.checks && s.checks.nonempty_rate != null ? pct(s.checks.nonempty_rate) : '–'), '', (s) => (s.ok > 0 && s.checks && s.checks.empty_output ? (s.checks.nonempty_rate >= 0.95 ? 'v-warn' : 'v-bad') : s.ok > 0 ? 'v-ok' : ''), '内容校验（k6 checks 口径）：成功请求中输出 token>0 的占比；0 token 通常意味着渠道返回 200 但空补全'],
  ['Cost', (s) => (s.cost && (s.cost.price_in > 0 || s.cost.price_out > 0) ? '¥' + fmt(s.cost.total, 4) : '未配置'), '', () => '', '总花费 = 输入×单价 + 输出×单价（在「合格线 · 成本」里填写单价后自动估算）'],
  ['Errors', (s) => fmt(s.failed), '', (s) => s.failed ? 'v-bad' : '', '失败请求数'],
];

/* 空态与运行态：都按同一套指标定义渲染，避免列不一致 */
function summaryEmpty() {
  $('roPrimary').innerHTML = PRIMARY_DEFS.map(([k, , , , hint]) => `<div class="ro-item"><dt title="${esc(hint || '')}">${k}</dt><dd>–</dd></div>`).join('');
  $('metrics').innerHTML = METRIC_DEFS.map(([k, , , , hint]) => `<div class="metric"><dt title="${esc(hint || '')}">${k}</dt><dd>–</dd></div>`).join('');
  $('verdictBlock').className = 'verdict-block';
  $('vbState').textContent = '待检测';
  $('vbNum').innerHTML = '—<span>ms</span>';
  $('vbSub').textContent = '粘贴渠道配置并开始测试';
  $('vbSlo').innerHTML = '';
  $('vbTicks').innerHTML = ''; $('vbTicksCap').textContent = '最近请求';
}

/* 新运行开始：立刻清空上一次的残留（否则看起来像"没反应"） */
function renderRunning(run) {
  $('verdictBlock').className = 'verdict-block s-run';
  $('vbState').textContent = '运行中';
  $('vbNum').innerHTML = '—<span>ms</span>';
  $('vbSub').innerHTML = run ? `<b>${esc(run.target)}　${esc(run.model)}</b>` : '';
  $('vbSlo').innerHTML = '';
  $('vbTicks').innerHTML = '';
  $('vbTicksCap').textContent = '预热中…';
  const dash = (k, hint) => `<div class="metric"><dt title="${esc(hint || '')}">${k}</dt><dd>–</dd></div>`;
  $('roPrimary').innerHTML = PRIMARY_DEFS.map(([k, , , , hint]) => `<div class="ro-item"><dt title="${esc(hint || '')}">${k}</dt><dd>–</dd></div>`).join('');
  $('metrics').innerHTML = METRIC_DEFS.map(([k, , , , hint]) => dash(k, hint)).join('');
  ['e2e', 'ttft', 'tpot', 'tput', 'heat', 'err', 'dist', 'cmp'].forEach((k) => UI.noData($('ch-' + k), 'Waiting for data…'));
}

function renderCards(sum) {
  if (!sum) { summaryEmpty(); return; }
  const run = state.primary ? state.runs.get(state.primary) : null;
  const cell = (k, get, unit, cls, box, hint) => {
    let v = '–';
    try { v = get(sum); } catch { v = '–'; }
    const showUnit = unit && v !== 'n/a' && v !== '–';
    return `<div class="${box} ${cls ? cls(sum) : ''}"><dt title="${esc(hint || '')}">${k}</dt><dd>${v}${showUnit ? ` <em>${unit}</em>` : ''}</dd></div>`;
  };
  $('roPrimary').innerHTML = PRIMARY_DEFS.map(([k, get, unit, cls, hint]) => cell(k, get, unit, cls, 'ro-item', hint)).join('');
  $('metrics').innerHTML = METRIC_DEFS.map(([k, get, unit, cls, hint]) => cell(k, get, unit, cls, 'metric', hint)).join('');

  const p95 = sum.e2e ? sum.e2e.p95 : 0;
  const v = evaluate(sum, run);
  // 数据状态驱动场景色调：这是"炫酷效果"与"中转测试"的结合点
  document.body.classList.toggle('mood-warn', v.state === 'warn');
  document.body.classList.toggle('mood-bad', v.state === 'bad');
  const vb = $('verdictBlock');
  vb.className = 'verdict-block s-' + v.state;
  $('vbState').textContent = v.label;
  $('vbNum').innerHTML = `${fmt(p95)}<span>ms</span>`;
  const t = run ? `${run.target}　${run.model}` : '';
  const who = t ? `<b>${esc(t)}</b>` : '粘贴渠道配置并开始测试';
  let cacheLine = '';
  const c = sum.cache;
  if (c && c.cached_tokens > 0) {
    cacheLine = `　Cache hit ${pct(c.hit_rate)}（${c.requests_hit} 命中 / ${c.requests_miss} 未命中）`;
    if (c.ttft_speedup) {
      cacheLine += ` · TTFT ${fmt(c.ttft_hit.mean)} vs ${fmt(c.ttft_miss.mean)} ms（${c.ttft_speedup}×）`;
    }
  } else if (c && sum.measurable) {
    cacheLine = '　Cache hit 0%（该渠道未返回缓存字段，或全部未命中）';
    // 0% 命中的常见原因是自己配置导致：随机化破坏前缀、输入太短低于门槛
    if ($('randomize')?.checked) {
      cacheLine += '。注意：「随机化请求」已开启，每次前缀都不同，缓存必然不命中——测缓存请关闭它，或改用「缓存检测」按钮';
    } else if (($('input_tokens')?.value | 0) < 256) {
      cacheLine += '。注意：输入 token 数偏小（低于常见缓存门槛），建议 ≥1024 再观察命中';
    }
  }
  $('vbSub').innerHTML = (v.notes.length
    ? `${who}　<span style="color:var(--bad)">${v.notes.join('；')}</span>`
    : who) + `<span style="color:var(--faint)">${cacheLine}</span>`;
  const shortK = { 'Success rate': '成功率', 'E2EL P95': 'E2EL', 'TTFT P95': 'TTFT', 'TPOT P95': 'TPOT' };
  $('vbSlo').innerHTML = (v.chips || []).map((ch) =>
    `<span class="slo-chip ${ch.cls}" title="${esc(ch.tip || '')}">${esc(shortK[ch.k] || ch.k)} <b>${esc(ch.v)}</b></span>`).join('');
  renderTicks(run);
}

/* 判定完全由"用户设的合格线"驱动，并在界面上写明是哪一条没过 —— 不再是魔法数字 */
function evaluate(sum, run) {
  const slo = Object.assign({ ttft_ms: 1500, tpot_ms: 50, e2e_ms: 5000 }, (run && run.slo) || {});
  const rows = [
    { k: 'Success rate', v: sum.success_rate, limit: slo_rate(slo), cmp: '>=', bad: 0.95, show: pct },
    { k: 'E2EL P95', v: sum.e2e ? sum.e2e.p95 : null, limit: slo.e2e_ms, cmp: '<=', show: (x) => fmt(x) + ' ms' },
    { k: 'TTFT P95', v: sum.ttft ? sum.ttft.p95 : null, limit: slo.ttft_ms, cmp: '<=', show: (x) => fmt(x) + ' ms' },
    { k: 'TPOT P95', v: sum.tpot ? sum.tpot.p95 : null, limit: slo.tpot_ms, cmp: '<=', show: (x) => fmt(x, 1) + ' ms' },
  ];
  let bad = false, warn = false;
  const notes = [];
  const chips = [];
  for (const r of rows) {
    // 徽章：p=达标 w=偏慢 f=超线；无样本=中性
    if (r.v == null) { chips.push({ k: r.k, v: 'n/a', cls: '', tip: `${r.k}：本次无可测样本` }); continue; }
    let cls = 'p';
    if (r.cmp === '>=') {
      if (r.v < r.bad) { cls = 'f'; bad = true; notes.push(`${r.k} ${r.show(r.v)} < ${r.show(r.bad)}`); }
      else if (r.v < r.limit) { cls = 'w'; warn = true; notes.push(`${r.k} ${r.show(r.v)} 低于合格线 ${r.show(r.limit)}`); }
      chips.push({ k: r.k, v: r.show(r.v), cls, tip: `${r.k} ${r.show(r.v)}，要求 ≥ ${r.show(r.limit)}` });
    } else {
      // 无成功样本时延迟无意义（P95=0 会假绿），显式标 n/a —— 对齐 §10 数据可信度
      if (!sum.ok) { chips.push({ k: r.k, v: 'n/a', cls: '', tip: `${r.k}：本次无成功样本，延迟无意义` }); continue; }
      if (r.v > r.limit * 1.5) { cls = 'f'; bad = true; notes.push(`${r.k} ${r.show(r.v)} 超过 ${r.show(r.limit)}`); }
      else if (r.v > r.limit) { cls = 'w'; warn = true; notes.push(`${r.k} ${r.show(r.v)} 超过 ${r.show(r.limit)}`); }
      chips.push({ k: r.k, v: r.show(r.v), cls, tip: `${r.k} ${r.show(r.v)}，合格线 ≤ ${r.show(r.limit)}` });
    }
  }
  const state = bad ? 'bad' : warn ? 'warn' : 'ok';
  const label = bad ? '不合格' : warn ? '偏慢' : '正常';
  if (sum.total > 0 && sum.total < 100) notes.push(`样本仅 ${sum.total} 条，分位值参考性有限（建议 ≥100）`);
  return { state, label, notes, chips };
}
const slo_rate = () => 0.99;

/* 信号条：每根 = 一次请求，高度编码延迟，颜色编码成败 */
function renderTicks(run) {
  const box = $('vbTicks');
  if (!box) return;
  const S = run ? run.samples.slice(-64) : [];
  if (!S.length) { box.innerHTML = ''; $('vbTicksCap').textContent = '最近请求'; return; }
  const lat = S.map((s) => s.e2e_ms || 0);
  const max = Math.max(...lat, 1);
  box.innerHTML = S.map((s) => {
    const h = Math.max(12, Math.round((s.e2e_ms || 0) / max * 100));
    return `<i class="${s.ok ? '' : 'f'}" style="height:${h}%" title="#${s.seq} ${s.ok ? fmt(s.e2e_ms) + ' ms' : (s.error_class || '失败')}"></i>`;
  }).join('');
  const fails = S.filter((s) => !s.ok).length;
  $('vbTicksCap').textContent = `最近 ${S.length} 次请求${fails ? `，失败 ${fails}` : ''}`;
}

/* ---------- 单 run 图表 ---------- */
// 少于这么多条样本时，波形图只会画出误导性的直线/三角形，不如明说
const MIN_WAVE = 5;
const MIN_BAND = 20;
const MIN_HIST = 10;

function renderSingle(run) {
  const el = $('ch-e2e');
  const raw = run ? visSamples(run) : [];
  if (!raw.length) {
    ['e2e', 'ttft', 'tpot', 'tput', 'heat', 'err', 'dist', 'cmp'].forEach((k) => UI.noData($('ch-' + k)));
    return;
  }
  if (raw.length < MIN_WAVE) {
    ['e2e', 'ttft', 'tpot', 'tput', 'heat', 'err', 'dist'].forEach((k) =>
      UI.noData($('ch-' + k), `样本不足（${raw.length} 条，至少需 ${MIN_WAVE} 条）`));
    return;
  }
  const S = raw;
  const idx = S.map((_, i) => i);
  const e2e = S.map((s) => s.e2e_ms), ttft = S.map((s) => s.ttft_ms), tpot = S.map((s) => s.tpot_ms);
  const slo = Object.assign({ ttft_ms: 1500, tpot_ms: 50, e2e_ms: 5000 }, run.slo || {});
  const ln = (name, data, color, w = 1.5, extra = {}) => ({ name, type: 'line', showSymbol: false, smooth: 0.25, data, lineStyle: { color, width: w, cap: 'round', join: 'round' }, itemStyle: { color }, ...extra });

  // 窗口按样本量自适应：固定 50 在只有 30 条的运行里会让首几个离群值一直留在分位里
  const pctWin = Math.max(10, Math.min(50, Math.floor(S.length / 3)));
  const P50 = rollingPercentile(e2e, pctWin, 50, Math.min(10, pctWin));
  const P95 = rollingPercentile(e2e, pctWin, 95, Math.min(10, pctWin));
  const band = P95.map((v, i) => (v != null && P50[i] != null ? +(v - P50[i]).toFixed(1) : 0));
  const seqCat = S.map((s) => String(s.seq));
  const dense = S.length > 120;   // 样本多时原始点变噪声，自动退到图例里
  charts.e2e.setOption(UI.base({
    tooltip: UI.tooltip('ms'),
    legend: { right: 8, top: 0, itemWidth: 14, itemHeight: 3, textStyle: { color: C.tx2, fontSize: 10 }, selected: dense ? { raw: false } : {}, data: run.mode === 'open' ? ['raw', 'P50', 'P95', 'corrected'] : ['raw', 'P50', 'P95'] },
    xAxis: { type: 'category', boundaryGap: false, data: seqCat, name: 'seq', nameTextStyle: { color: C.tx3, fontSize: 10 }, axisLabel: { ...AXIS, interval: 'auto', hideOverlap: true }, axisLine: { lineStyle: { color: C.line2 } }, splitLine: { show: false } },
    yAxis: { type: 'value', scale: true, splitNumber: 4, name: 'ms', nameTextStyle: { color: C.tx3, fontSize: 11 }, axisLabel: UI.axisLabelFor(e2e), ...robustRange(e2e), axisLine: { show: false }, splitLine: GRAT, minorSplitLine: MINOR, minorTick: { show: true, splitNumber: 5 }, axisTick: { show: true, length: 3, lineStyle: { color: C.line2 } } },
    series: [
      // 分位带用 custom 矩形逐点绘制：stack 遇到 null 会被当成 0，把 Y 轴拉到 0，整条带从底填起
      ...(S.length >= MIN_BAND ? [{
        name: '_band', type: 'custom', silent: true, z: 1,
        data: P50.map((v, i) => [i, v, P95[i]]),
        renderItem: (params, api) => {
          const lo = api.value(1), hi = api.value(2);
          if (lo == null || hi == null) return;
          const a = api.coord([api.value(0), lo]);
          const b = api.coord([api.value(0), hi]);
          const top = Math.min(a[1], b[1]);
          const h = Math.max(1, Math.abs(a[1] - b[1]));
          // 分类轴上 api.size([1,0]) 恒为 0，必须用相邻 category 的像素差求真实宽度，
          // 否则每个矩形退化成细条，整条带看起来像"栅栏"。
          const x0 = api.coord([api.value(0), 0])[0];
          const x1 = api.coord([api.value(0) + 1, 0])[0];
          const w = Math.max(2, Math.abs(x1 - x0) + 1);
          return { type: 'rect', shape: { x: a[0] - w / 2, y: top, width: w, height: h }, style: { fill: 'rgba(242,204,12,.16)' } };
        },
      }] : []),
      { name: 'raw', type: 'scatter', symbolSize: dense ? 2 : 4, data: e2e, itemStyle: { color: C.tr4, opacity: dense ? .22 : .5 }, z: 3},
      ln('P50', P50, C.tr1, 1.8, { z: 4 }),
      ln('P95', P95, C.tr3, 1.8, { z: 4 }),
      ...(run.mode === 'open'
        ? [ln('corrected', S.map((s) => s.corrected_e2e_ms), C.tr2, 1.2, { lineStyle: { color: C.tr2, width: 1.2, type: 'dashed' }, z: 2 })]
        : []),
    ],
  }), true);

  const sloLine = (v, color) => ({ silent: true, symbol: 'none', lineStyle: { color, type: 'dashed', width: 1 }, label: { formatter: 'SLO', color, fontSize: 9 }, data: [{ yAxis: v }] });
  charts.ttft.setOption(UI.base({
    tooltip: UI.tooltip('ms'),
    xAxis: { type: 'category', boundaryGap: false, data: seqCat, axisLabel: { ...AXIS, hideOverlap: true, interval: Math.max(0, Math.ceil(S.length / 6) - 1) }, axisLine: { lineStyle: { color: C.line2 } }, splitLine: { show: false }, axisTick: { show: true, length: 3, lineStyle: { color: C.line2 } } },
    yAxis: { type: 'value', scale: true, splitNumber: 4, name: 'ms', nameTextStyle: { color: C.tx3, fontSize: 11 }, axisLabel: UI.axisLabelFor(ttft), ...robustRange(ttft), axisLine: { show: false }, splitLine: GRAT, minorSplitLine: MINOR, minorTick: { show: true, splitNumber: 5 }, axisTick: { show: true, length: 3, lineStyle: { color: C.line2 } } },
    series: [ln('TTFT', ttft, C.tr3, 1.5, { areaStyle: { color: UI.grad(C.tr3, .2, 0) }, markLine: sloLine(slo.ttft_ms, C.yellow) })],
  }), true);

  charts.tpot.setOption(UI.base({
    tooltip: UI.tooltip('ms'),
    xAxis: { type: 'category', boundaryGap: false, data: seqCat, axisLabel: { ...AXIS, hideOverlap: true, interval: Math.max(0, Math.ceil(S.length / 6) - 1) }, axisLine: { lineStyle: { color: C.line2 } }, splitLine: { show: false }, axisTick: { show: true, length: 3, lineStyle: { color: C.line2 } } },
    yAxis: { type: 'value', scale: true, splitNumber: 4, name: 'ms', nameTextStyle: { color: C.tx3, fontSize: 11 }, axisLabel: UI.axisLabelFor(tpot), ...robustRange(tpot), axisLine: { show: false }, splitLine: GRAT, minorSplitLine: MINOR, minorTick: { show: true, splitNumber: 5 }, axisTick: { show: true, length: 3, lineStyle: { color: C.line2 } } },
    series: [ln('TPOT', tpot, C.tr4, 1.5, { areaStyle: { color: UI.grad(C.tr4, .2, 0) }, markLine: sloLine(slo.tpot_ms, C.yellow) })],
  }), true);

  const winMs = Math.max(1000, pickBucketMs(S));
  const [rpsArr, tokArr] = windowedRate(S, winMs);
  charts.tput.setOption(UI.base({
    tooltip: UI.tooltip(),
    grid: { left: 54, right: 52, top: 26, bottom: 30 },
    legend: { right: 8, top: 0, itemWidth: 14, itemHeight: 3, textStyle: { color: C.tx2, fontSize: 10 } },
    xAxis: { type: 'category', boundaryGap: false, data: seqCat, axisLabel: { ...AXIS, hideOverlap: true, interval: Math.max(0, Math.ceil(S.length / 6) - 1) }, axisLine: { lineStyle: { color: C.line2 } }, splitLine: { show: false }, axisTick: { show: true, length: 3, lineStyle: { color: C.line2 } } },
    yAxis: [
      { type: 'value', scale: true, splitNumber: 4, name: 'req/s', nameLocation: 'middle', nameRotate: 90, nameGap: 36, nameTextStyle: { color: C.tr1, fontSize: 11 }, axisLabel: { ...UI.axisLabelFor(rpsArr), color: C.tr1, margin: 6 }, axisLine: { show: true, lineStyle: { color: C.tr1, opacity: .35 } }, splitLine: GRAT, minorSplitLine: MINOR, minorTick: { show: true, splitNumber: 5 } },
      { type: 'value', scale: true, splitNumber: 4, name: 'tok/s', nameLocation: 'middle', nameRotate: 90, nameGap: 40, nameTextStyle: { color: C.tr2, fontSize: 11 }, axisLabel: { ...UI.axisLabelFor(tokArr), color: C.tr2, margin: 6 }, axisLine: { show: true, lineStyle: { color: C.tr2, opacity: .35 } }, splitLine: { show: false } },
    ],
    series: [
      ln('req/s', rpsArr, C.tr1, 1.6, { areaStyle: { color: UI.grad(C.tr1, .18, 0) } }),
      ln('tok/s', tokArr, C.tr2, 1.6, { yAxisIndex: 1 }),
    ],
  }), true);
  const tn = $('tputNote');
  if (tn) tn.textContent = `按 ${winMs >= 60000 ? (winMs / 60000) + ' 分钟' : (winMs / 1000) + ' 秒'}滑动窗口计算`;

  renderHeat(S); renderErrors(S); renderDist(S);
}

function latBucket(v) { const b = [50, 100, 200, 400, 800, 1600, 3200, 6400, 12800]; for (let i = 0; i < b.length; i++) if (v < b[i]) return i; return b.length; }

function renderErrors(S) {
  const classes = [...new Set(S.filter((s) => !s.ok).map((s) => s.error_class || 'unknown'))];
  const bk = pickBucketMs(S);
  const fmtB = bucketLabel(bk);
  if (!classes.length) { UI.noData($('ch-err'), 'No errors'); return; }
  const buckets = bucketize(S, bk, (a) => a);
  charts.err.setOption(UI.base({
    tooltip: { ...UI.tooltip(), trigger: 'axis' },
    legend: { right: 8, top: 0, itemWidth: 14, itemHeight: 3, textStyle: { color: C.tx2, fontSize: 10 } },
    xAxis: { type: 'category', boundaryGap: false, data: buckets.map(([b]) => fmtB(b / 1000)), axisLabel: { ...AXIS, hideOverlap: true, interval: Math.max(0, Math.ceil(buckets.length / 6) - 1) }, axisLine: { lineStyle: { color: C.line2 } }, splitLine: { show: false } },
    yAxis: { type: 'value', name: '错误数', nameTextStyle: { color: C.tx3, fontSize: 11 }, axisLabel: AXIS, axisLine: { show: false }, splitLine: GRAT, minorSplitLine: MINOR, axisTick: { show: true, length: 3, lineStyle: { color: C.line2 } } },
    series: classes.map((cls, i) => ({ name: cls, type: 'bar', stack: 'e', barMaxWidth: 18, data: buckets.map(([, a]) => a.filter((s) => !s.ok && (s.error_class || 'unknown') === cls).length), itemStyle: { color: C.series[(i + 5) % C.series.length], borderRadius: [4, 4, 0, 0] } })),
  }), true);
}

/* 热力图：样本跨度不足时改为逐窗口统计表，不留空白板 */
function renderHeat(S) {
  const yLabels = ['<50ms', '50-100', '100-200', '200-400', '400-800', '0.8-1.6s', '1.6-3.2s', '3.2-6.4s', '6.4-12.8s', '>12.8s'];
  const bk = pickBucketMs(S);
  const buckets = bucketize(S, bk, (a) => a);
  const used = new Set();
  const raw = [];
  buckets.forEach(([, arr], xi) => {
    const c = {};
    arr.forEach((s) => { const y = latBucket(s.e2e_ms || 0); c[y] = (c[y] || 0) + 1; used.add(y); });
    Object.entries(c).forEach(([y, n]) => raw.push([xi, +y, n]));
  });
  const drawable = raw.length && buckets.length >= 2 && used.size >= 2;
  if (!drawable) { renderRollup(S, bk); return; }
  $('heatRollup').hidden = true;
  $('ch-heat').hidden = false;
  const ys = [...used].sort((a, b) => a - b);
  const remap = Object.fromEntries(ys.map((v, i) => [v, i]));
  const data = raw.map(([x, y, n]) => [x, remap[y], n]);
  const max = Math.max(1, ...data.map((d) => d[2]));
  const f = bucketLabel(bk);
  charts.heat.setOption(UI.base({
    tooltip: { ...UI.tooltip(), trigger: 'item', position: 'top' }, grid: { left: 66, right: 14, top: 8, bottom: 26 },
    xAxis: { type: 'category', data: buckets.map(([b]) => f(b / 1000)), axisLabel: { ...AXIS, hideOverlap: true, interval: Math.max(0, Math.ceil(buckets.length / 8) - 1) }, axisLine: { lineStyle: { color: C.line2 } }, splitLine: { show: false } },
    yAxis: { type: 'category', name: '延迟', nameTextStyle: { color: C.tx3, fontSize: 11 }, data: ys.map((y) => yLabels[y]), axisLabel: AXIS, axisLine: { show: false }, splitLine: { show: false } },
    visualMap: { show: false, min: 0, max },
    series: [{ type: 'heatmap', data, itemStyle: { borderRadius: 4, borderColor: 'rgba(0,0,0,.25)', borderWidth: 1 }, emphasis: { itemStyle: { borderColor: C.tx1, borderWidth: 1 } } }],
  }), true);
}

/* 逐窗口统计表（热力图回退）：比空白更有用 */
function renderRollup(S, bk) {
  const fmtB = bucketLabel(bk);
  const buckets = bucketize(S, bk, (a) => a);
  const rows = buckets.map(([b, arr]) => {
    const ok = arr.filter((s) => s.ok);
    const vals = ok.map((s) => s.e2e_ms).filter((v) => v != null);
    const p = (q) => {
      if (!vals.length) return '–';
      const s2 = [...vals].sort((a, c) => a - c);
      const k = (s2.length - 1) * q / 100, lo = Math.floor(k), hi = Math.min(lo + 1, s2.length - 1);
      return fmt(s2[lo] + (s2[hi] - s2[lo]) * (k - lo));
    };
    return `<tr><td class="mono">${fmtB(b / 1000)}</td><td class="num">${arr.length}</td>
      <td class="num ${ok.length === arr.length ? '' : 'worst'}">${arr.length ? Math.round(ok.length / arr.length * 100) + '%' : '–'}</td>
      <td class="num">${p(50)}</td><td class="num">${p(95)}</td><td class="num">${p(99)}</td></tr>`;
  }).join('');
  $('ch-heat').hidden = true;
  const box = $('heatRollup');
  box.hidden = false;
  box.innerHTML = `<div class="rollup-cap">样本时间跨度不足以绘制热力图，改为逐窗口统计（单位 ms）</div>
    <table class="grid"><thead><tr><th>时间窗</th><th class="num">请求</th><th class="num">成功</th>
    <th class="num">P50</th><th class="num">P95</th><th class="num">P99</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderDist(S) {
  const vals = S.map((s) => s.e2e_ms).filter((v) => v != null);
  if (vals.length < MIN_HIST) {
    UI.noData($('ch-dist'), `样本不足（${vals.length} 条，至少需 ${MIN_HIST} 条）`);
    return;
  }
  const min = Math.min(...vals), max = Math.max(...vals);
  const nb = Math.max(5, Math.min(30, Math.floor(vals.length / 2)));
  const step = (max - min) / nb || 1;
  const hist = new Array(nb).fill(0);
  vals.forEach((v) => { hist[Math.min(nb - 1, Math.floor((v - min) / step))]++; });
  const sorted = [...vals].sort((a, b) => a - b);
  charts.dist.setOption(UI.base({
    tooltip: { ...UI.tooltip(), trigger: 'axis' },
    grid: { left: 52, right: 50, top: 26, bottom: 30 },
    legend: { right: 8, top: 0, itemWidth: 14, itemHeight: 3, textStyle: { color: C.tx2, fontSize: 10 } },
    xAxis: { type: 'category', data: hist.map((_, i) => (min + i * step).toFixed((max - min) < 10 ? 1 : 0)), axisLabel: { ...AXIS, rotate: 0, hideOverlap: true, interval: Math.max(0, Math.ceil(nb / 4) - 1) }, axisLine: { lineStyle: { color: C.line2 } } },
    yAxis: [{ type: 'value', name: '频次', nameLocation: 'middle', nameRotate: 90, nameGap: 34, nameTextStyle: { color: C.tr4, fontSize: 11 }, axisLabel: { ...AXIS, color: C.tr4, margin: 6 }, axisLine: { show: true, lineStyle: { color: C.tr4, opacity: .35 } }, splitLine: GRAT, minorSplitLine: MINOR, minorTick: { show: true, splitNumber: 5 }, axisTick: { show: true, length: 3, lineStyle: { color: C.line2 } } },
      { type: 'value', name: 'CDF %', max: 100, nameLocation: 'middle', nameRotate: 90, nameGap: 38, nameTextStyle: { color: C.tr3, fontSize: 11 }, axisLabel: { ...AXIS, color: C.tr3, margin: 6 }, axisLine: { show: true, lineStyle: { color: C.tr3, opacity: .35 } }, splitLine: { show: false } }],
    series: [
      { name: '直方图', type: 'bar', data: hist, itemStyle: { color: UI.grad(C.tr4, .85, .3), borderRadius: [4, 4, 0, 0] } },
      { name: 'CDF', type: 'line', yAxisIndex: 1, showSymbol: false, smooth: true, data: sorted.map((v, i) => [v, ((i + 1) / sorted.length) * 100]), lineStyle: { color: C.tr3, width: 1.8 } },
    ],
  }), true);
}

function renderCompareChart() {
  // 只对比最近 5 条：线上轨迹太多会糊成一片，图例也放不下
  const all = [...state.runs.values()].filter((r) => visSamples(r).length)
    .sort((a, b) => (a.samples[0]?.ts || 0) - (b.samples[0]?.ts || 0));
  const runs = all.slice(-5);
  $('cmpLegend').textContent = runs.length ? `最近 ${runs.length} 条${all.length > runs.length ? ` / 共 ${all.length}` : ''}` : '';
  if (!runs.length) { UI.noData($('ch-cmp')); return; }
  const series = runs.map((r) => {
    const S = visSamples(r);
    const t0 = S[0].ts, step = Math.max(1, Math.floor(S.length / 800)), pts = [];
    for (let i = 0; i < S.length; i += step) { if (S[i].e2e_ms != null) pts.push([+(S[i].ts - t0).toFixed(1), S[i].e2e_ms]); }
    // 名字必须唯一：多条同名 run 会被 ECharts 图例合并，看起来像是丢数据
    const stamp = new Date((r.samples[0].ts || 0) * 1000).toTimeString().slice(0, 5);
    return { name: `${r.target} (${r.model}) ${stamp}`, type: 'line', showSymbol: false,
             data: pts, lineStyle: { color: r.color, width: 1.4 } };
  });
  charts.cmp.setOption(UI.base({
    tooltip: { ...UI.tooltip(), trigger: 'item' },
    // 图例放底部：多条轨迹时顶部会盖住波形
    legend: { bottom: 0, left: 'center', itemWidth: 14, itemHeight: 3,
              textStyle: { color: C.tx2, fontSize: 10 }, data: series.map((x) => x.name) },
    grid: { left: 60, right: 20, top: 22, bottom: 46 },
    xAxis: { type: 'value', name: '相对时间(s)', nameTextStyle: { color: C.tx3, fontSize: 10 }, axisLabel: AXIS, axisLine: { lineStyle: { color: C.line2 } }, splitLine: GRAT, minorSplitLine: MINOR, minorTick: { show: true, splitNumber: 5 }, axisTick: { show: true, length: 3, lineStyle: { color: C.line2 } } },
    yAxis: { type: 'value', scale: true, splitNumber: 4, name: 'E2E ms', nameLocation: 'middle', nameRotate: 90, nameGap: 44, nameTextStyle: { color: C.tx3, fontSize: 11 }, axisLabel: UI.axisLabelFor(runs.flatMap((r) => visSamples(r).map((x) => x.e2e_ms))), axisLine: { show: false }, splitLine: GRAT, minorSplitLine: MINOR, minorTick: { show: true, splitNumber: 5 }, axisTick: { show: true, length: 3, lineStyle: { color: C.line2 } } },
    series,
  }), true);
}

/* ---------- 表格 ---------- */
function getRows() {
  let rows = [...state.runs.values()];
  if (state.filter) {
    const q = state.filter.toLowerCase();
    rows = rows.filter((r) => (r.target + ' ' + r.model + ' ' + r.provider).toLowerCase().includes(q));
  }
  const k = state.sort.key;
  if (k) {
    const get = {
      target: (r) => r.target, model: (r) => r.model, status: (r) => r.status,
      total: (r) => r.summary?.total ?? r.samples.length, ok: (r) => r.summary?.ok ?? 0,
      p95: (r) => r.summary?.e2e?.p95 ?? -1, ttft: (r) => r.summary?.ttft?.mean ?? -1,
      tpot: (r) => r.summary?.tpot?.mean ?? -1, tps: (r) => r.summary?.tokens?.output_throughput ?? -1,
    }[k];
    rows.sort((a, b) => { const va = get(a), vb = get(b); return (va > vb ? 1 : va < vb ? -1 : 0) * (state.sort.dir === 'asc' ? 1 : -1); });
  } else {
    rows.reverse();
  }
  return rows;
}
function statusBadge(s) {
  const cls = s === 'done' ? 'ok' : s === 'error' ? 'no' : 'run';
  const txt = { running: 'Running', done: 'Done', error: 'Error', paused: 'Paused', stopped: 'Stopped', pending: 'Pending' }[s] || s;
  return `<span class="badge ${cls}">${txt}</span>`;
}
function renderRuns() {
  $('runsBody').innerHTML = getRows().map((r) => {
    const s = r.summary || {};
    return `<tr class="${state.primary === r.id ? 'sel' : ''}" data-run="${r.id}" tabindex="0" aria-label="运行 ${esc(r.target)} ${esc(r.model)}，按回车查看详情">
      <td><span class="dot" style="background:${r.color}"></span>${esc(r.target)}</td>
      <td>${esc(r.model)}</td>
      <td>${statusBadge(r.status)}</td>
      <td class="num">${s.total ?? r.samples.length}</td>
      <td class="num">${s.ok != null ? s.ok : '–'}${s.success_rate != null ? ` <span class="mono" style="color:var(--faint)">${pct(s.success_rate)}</span>` : ''}</td>
      <td class="num">${s.e2e ? fmt(s.e2e.p95) + ' ms' : '–'}</td>
      <td class="num">${s.ttft ? fmt(s.ttft.mean) + ' ms' : '–'}</td>
      <td class="num">${s.tpot ? fmt(s.tpot.mean, 1) + ' ms' : '–'}</td>
      <td class="num">${s.tokens ? fmt(s.tokens.output_throughput, 1) : '–'}</td>
      <td class="act"><button class="mini" data-act="sel" data-id="${r.id}">主视图</button>
        <button class="mini ghost" data-act="detail" data-id="${r.id}">详情</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="10" class="hint">暂无运行记录</td></tr>';
  /* 运行时间线（status-page 惯例）：每格一条运行，颜色=成功率档位，点击切主视图 */
  const tl = $('runsTimeline');
  if (tl) {
    const recent = [...state.runs.values()].slice(-40);
    tl.hidden = !recent.length;
    tl.innerHTML = recent.map((r) => {
      const s = r.summary || {};
      const rate = s.total ? (s.ok ?? 0) / s.total : null;
      const cls = r.status === 'error' ? 'f' : r.status !== 'done' ? 'idle' : rate == null ? 'idle' : rate >= 0.99 ? 'p' : rate >= 0.95 ? 'w' : 'f';
      const when = r.samples && r.samples.length ? tstr(r.samples[r.samples.length - 1].ts) : '';
      const tip = `${r.target} · ${r.model}${when ? ` · ${when}` : ''}｜${r.status === 'done' ? (rate == null ? '无样本' : `成功率 ${pct(rate)}（${s.ok ?? 0}/${s.total}）`) : `状态 ${r.status}`}`;
      return `<button class="tl-seg ${cls}${state.primary === r.id ? ' on' : ''}" data-act="sel" data-id="${r.id}" title="${esc(tip)}" aria-label="切换主视图到运行 ${esc(r.target)} ${esc(r.model)}"></button>`;
    }).join('');
  }
  refreshTopbar();
}
function renderCompareTable() {
  const runs = [...state.runs.values()].filter((r) => r.summary);
  const cols = [
    ['Channel', (r) => r.target, null], ['Model', (r) => r.model, null],
    ['Success', (r) => r.summary.success_rate, 'high', pct],
    ['Goodput', (r) => r.summary.goodput, 'high', pct],
    ['RPS', (r) => r.summary.rps, 'high', (v) => fmt(v, 2)],
    ['E2EL mean', (r) => r.summary.e2e.mean, 'low', (v) => fmt(v) + ' ms'],
    ['E2EL P95', (r) => r.summary.e2e.p95, 'low', (v) => fmt(v) + ' ms'],
    ['TTFT mean', (r) => r.summary.ttft.mean, 'low', (v) => fmt(v) + ' ms'],
    ['TPOT mean', (r) => r.summary.tpot.mean, 'low', (v) => fmt(v, 1) + ' ms'],
    ['Output tok/s', (r) => r.summary.tokens.output_throughput, 'high', (v) => fmt(v, 1)],
    ['Cache hit', (r) => (r.summary.cache ? r.summary.cache.hit_rate : null), 'high', pct],
    ['Errors', (r) => r.summary.failed, 'low', (v) => v],
  ];
  const head = $('cmpTable').querySelector('thead'), body = $('cmpTable').querySelector('tbody');
  if (!runs.length) { head.innerHTML = ''; body.innerHTML = '<tr><td class="hint">暂无数据</td></tr>'; return; }
  head.innerHTML = '<tr>' + cols.map(([h, , dir]) => `<th class="${dir ? 'num' : ''}">${h}</th>`).join('') + '</tr>';
  const bounds = cols.map(([, get, dir]) => {
    if (!dir) return null;
    const vals = runs.map(get).filter((v) => v != null);
    if (!vals.length) return null;
    return { best: dir === 'high' ? Math.max(...vals) : Math.min(...vals), worst: dir === 'high' ? Math.min(...vals) : Math.max(...vals) };
  });
  body.innerHTML = runs.map((r) => '<tr>' + cols.map(([, get, dir, f], ci) => {
    const v = get(r);
    let cls = dir ? 'num' : '';
    if (dir && v != null && bounds[ci] && runs.length > 1 && bounds[ci].best !== bounds[ci].worst) cls += v === bounds[ci].best ? ' best' : (v === bounds[ci].worst ? ' worst' : '');
    return `<td class="${cls}">${f ? f(v) : esc(v ?? '–')}</td>`;
  }).join('') + '</tr>').join('');
}
function refreshTopbar() {
  const runs = [...state.runs.values()];
  $('runCount').textContent = runs.length;
  $('reqCount').textContent = runs.reduce((a, r) => a + (r.summary?.total ?? r.samples.length), 0);
  $('errCount').textContent = runs.reduce((a, r) => a + (r.summary?.failed ?? 0), 0);
  $('rec').hidden = !runs.some((r) => r.status === 'running');
  // 有数据 → 显示仪表盘，隐藏空态
  const has = runs.length > 0;
  $('emptyPerf').hidden = has;
  $('perfDash').hidden = !has;
  document.body.classList.toggle('has-data', has);
}

/* ---------- Logo 三球玻璃场景 ----------
   三个动态白色玻璃球限制在 logo 周围（76px 区域），screen 混合让黑底隐形、只留球体。
   不传文字：球体靠边缘菲涅尔 + 高光成像，正好是"白色玻璃球"。
   色调仍跟随渠道健康状态：正常银白 / 偏慢偏黄 / 不合格偏红。 */
let _hero = null;
function mountHero() {
  if (_hero || !window.GlassHero) return;
  const cv = $('logoScene');
  if (!cv) return;
  _hero = GlassHero.mount(cv, {
    lines: [],                       // 不要文字层
    bright: true,                    // 明亮底 → 球体像实心白色玻璃
    spheres: [                       // 三球聚在 logo 外圈，避开中心的 logo 方块
      { r: 0.150, hx: 0.24, hy: 0.30, follow: 0.09, drift: 3.0, ox: 0, oy: 0 },
      { r: 0.110, hx: 0.78, hy: 0.34, follow: 0.07, drift: 2.4, ox: 0, oy: 0 },
      { r: 0.086, hx: 0.52, hy: 0.84, follow: 0.11, drift: 2.0, ox: 0, oy: 0 },
    ],
  });
}
window.addEventListener('viewchange', () => Object.values(charts).forEach((c) => c && c.resize()));

/* ---------- 配置侧栏折叠 ---------- */
function setSidebar(open) {
  document.getElementById('app').classList.toggle('side-collapsed', !open);
  $('btnSidebar').classList.toggle('on', open);
  localStorage.setItem('llmbench.sidebar', open ? '1' : '0');
  // 触发图表自适应
  setTimeout(() => Object.values(charts).forEach((c) => c && c.resize()), 200);
}
function toggleSidebar() { setSidebar(document.getElementById('app').classList.contains('side-collapsed')); }

/* ---------- 逐请求明细（对质用：能直接看到供应商返回的错误原文）---------- */
async function loadRequests(runId) {
  if (!runId) { renderRequests(); return; }
  try {
    const d = await fetchJSON(`/api/runs/${runId}/samples?max_points=4000`);
    state.reqSamples = d.samples || [];
  } catch { state.reqSamples = []; }
  renderRequests();
}

function filteredRequests() {
  const q = state.reqSearch.trim().toLowerCase();
  return state.reqSamples.filter((r) => {
    if (state.reqOnlyFail && r.ok) return false;
    if (state.reqClass && (r.error_class || '') !== state.reqClass) return false;
    if (q && !(String(r.error_msg || '') + ' ' + String(r.error_class || '')).toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderRequests() {
  const rows = filteredRequests();
  const all = state.reqSamples;
  const fails = all.filter((r) => !r.ok).length;
  $('reqCount').textContent = all.length
    ? `共 ${all.length} 条，失败 ${fails} 条${rows.length !== all.length ? `，当前筛选 ${rows.length} 条` : ''}`
    : '（该运行暂无样本，点上方运行行切换）';
  // 错误类下拉
  const classes = [...new Set(all.filter((r) => !r.ok).map((r) => r.error_class || 'unknown'))].sort();
  const sel = $('reqErrClass');
  const keep = sel.value;
  sel.innerHTML = '<option value="">全部错误类</option>' +
    classes.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  sel.value = classes.includes(keep) ? keep : '';

  const body = $('reqBody');
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="9" class="hint">${all.length ? '没有符合条件的请求' : '暂无数据'}</td></tr>`;
    return;
  }
  const style = (r) => (r.ok ? '' : 'style="color:var(--bad)"');
  body.innerHTML = rows.map((r) => `<tr>
    <td class="num">${r.seq}</td>
    <td class="num" ${style(r)}>${r.status_code ?? '–'}</td>
    <td>${r.ok ? '' : `<span class="badge no">${esc(r.error_class || 'error')}</span>`}</td>
    <td class="num">${r.ttft_ms != null ? fmt(r.ttft_ms) : '–'}</td>
    <td class="num">${r.e2e_ms != null ? fmt(r.e2e_ms) : '–'}</td>
    <td class="num">${r.tpot_ms != null ? fmt(r.tpot_ms, 1) : '–'}</td>
    <td class="num">${r.in_tokens}/${r.out_tokens}</td>
    <td class="num">${r.cached_tokens ? fmt(r.cached_tokens) : '–'}</td>
    <td class="got" ${style(r)}>${esc((r.error_msg || '').slice(0, 300))}</td>
  </tr>`).join('');
}

/* ---------- 抽屉 ---------- */
async function openRunDetail(id) {
  try {
    const d = await fetchJSON(`/api/runs/${id}`);
    const run = state.runs.get(id) || {};
    const s = d.summary || {};
    const t = d.target || {};
    const row = (k, v) => `<div class="k">${k}</div><div class="v">${v}</div>`;
    UI.openDrawer(`运行详情：${run.target || t.name || id}`, `
      <div class="kv">
        ${row('Run ID', id)}
        ${row('供应商', esc(t.name || '-'))}${row('协议', t.provider || '-')}
        ${row('模型', esc(run.model || t.model || '-'))}
        ${row('Base URL', esc(t.base_url || '-'))}
        ${row('状态', d.status)}
        ${row('请求 / 成功', `${s.total ?? 0} / ${s.ok ?? 0}`)}
        ${row('Success / Goodput', `${pct(s.success_rate)} / ${pct(s.goodput)}${s.request_goodput != null ? `（${fmt(s.request_goodput, 2)} req/s）` : ''}`)}
        ${row('RPS', fmt(s.rps, 2))}
        ${row('E2EL mean/P95/P99', s.e2e ? `${fmt(s.e2e.mean)} / ${fmt(s.e2e.p95)} / ${fmt(s.e2e.p99)} ms` : '-')}
        ${row('TTFT mean/P95', s.ttft ? `${fmt(s.ttft.mean)} / ${fmt(s.ttft.p95)} ms` : '-')}
        ${row('TPOT / ITL P99', s.tpot ? `${fmt(s.tpot.mean, 1)} / ${fmt(s.itl.p99, 1)} ms` : 'n/a')}
        ${row('Output tok/s', s.tokens && s.tokens.output_throughput != null ? `${fmt(s.tokens.output_throughput, 1)} tok/s（墙钟） / ${fmt(s.tokens.output_throughput_per_user, 1)} tok/s（解码）` : 'n/a')}
        ${row('Tokens in/out', s.tokens ? `${s.tokens.in} / ${s.tokens.out}` : '-')}
        ${row('Cache hit', s.cache ? `${pct(s.cache.hit_rate)}（cached ${s.cache.cached_tokens}${s.cache.ttft_speedup ? `，TTFT ${fmt(s.cache.ttft_hit.mean)} vs ${fmt(s.cache.ttft_miss.mean)} ms` : ''}）` : '-')}
        ${row('Checks 非空输出', s.ok > 0 && s.checks && s.checks.nonempty_rate != null ? `${pct(s.checks.nonempty_rate)}${s.checks.empty_output ? `（空输出 ${s.checks.empty_output} 条，疑似 200 空补全）` : ''}` : 'n/a')}
        ${row('Cost', s.cost && (s.cost.price_in > 0 || s.cost.price_out > 0) ? '¥' + fmt(s.cost.total, 4) : '未配置单价')}
        ${row('Errors', Object.entries(s.errors || {}).map(([k, v]) => `${k}:${v}`).join(', ') || '无')}
      </div>
      <div class="btnrow" style="margin-top:14px">
        <button class="mini" data-act="sel" data-id="${id}">设为主视图</button>
        <button class="mini ghost" data-act="csv" data-id="${id}">导出 CSV</button>
        <button class="mini ghost" data-act="json" data-id="${id}">导出 JSON</button>
        <button class="mini ghost" data-act="md" data-id="${id}">导出 MD</button>
        <button class="mini danger" data-act="del" data-id="${id}">删除</button>
      </div>`);
  } catch (e) { UI.toast('加载详情失败: ' + e.message, 'err'); }
}

/* ---------- SSE ---------- */
function connectSSE(run) {
  const es = new EventSource(`/api/runs/${run.id}/stream`);
  run.sse = es;
  es.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'sample') {
      run.samples.push(msg.data);
      if (run.samples.length > 4000) run.samples.shift();
      if (!msg.data.ok) log('warn', `[${run.target}] #${msg.data.seq} 失败 ${msg.data.error_class || ''} ${msg.data.status_code || ''}`);
    } else if (msg.type === 'summary') {
      run.summary = msg.data;
      if (state.primary === run.id) renderCards(run.summary);
      renderRuns(); renderCompareTable();
    } else if (msg.type === 'phase') {
      if (msg.phase === 'warmup') {
        $('vbTicksCap').textContent = `预热中 ${msg.done}/${msg.total}（预热不计入统计）`;
      } else if (msg.phase === 'steady' && state.primary === run.id) {
        $('vbTicksCap').textContent = '最近请求';
      }
    } else if (msg.type === 'status') {
      run.status = msg.status; renderRuns();
      if (msg.status === 'done' || msg.status === 'error') {
        log(msg.status === 'done' ? 'ok' : 'err', `[${run.target}] 运行结束：${msg.status}`);
        UI.toast(`${run.target} 运行${msg.status === 'done' ? '完成' : '出错'}`, msg.status === 'done' ? 'ok' : 'err');
        es.close();
        fetchJSON(`/api/runs/${run.id}`).then((d) => { run.summary = d.summary; if (state.primary === run.id) renderCards(d.summary); renderRuns(); renderCompareTable(); renderSingle(run); notify(run); });
      }
    }
  };
  es.onerror = () => { if (run.status === 'done' || run.status === 'error') es.close(); };
}

/* ---------- 渲染循环 ---------- */
function renderAll() {
  const run = state.primary ? state.runs.get(state.primary) : null;
  if (run) renderSingle(run);
  renderCompareChart();
}
setInterval(() => { if (state.autoRefresh) renderAll(); }, 1000);
setInterval(() => { $('clock').textContent = nowTime(); }, 1000);

/* ---------- API ---------- */
async function fetchJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
function maskKey(k) {
  if (!k) return '';
  if (k.length <= 12) return k;
  return k.slice(0, 6) + '…' + k.slice(-4);
}
function renderTargets() {
  const box = $('channels');
  const list = state.targets;
  $('chanCount').textContent = list.length ? `${list.length} 个渠道 · ${new Set(list.map((t) => t.model)).size} 个模型` : '未解析';
  box.innerHTML = list.map((t, i) => `
    <div class="chan" data-i="${i}">
      <span class="chan-model">${esc(t.model || '(缺模型名)')}</span>
      <span class="chan-side">
        <span class="badge">${esc(t.provider)}</span>
        <button class="chan-x" data-rm="${i}" title="移除">×</button>
      </span>
      ${t.base_url ? `<span class="chan-url">${esc(t.base_url.replace(/^https?:\/\//, ''))}</span>`
                   : '<span class="chan-warn">待填地址</span>'}
      ${t.api_key ? `<span class="chan-key">${esc(maskKey(t.api_key))}</span>`
                  : '<span class="chan-warn">缺少密钥</span>'}
    </div>`).join('') || '<div class="hint">还没识别到渠道。把供应商给的内容贴进上面的框，点「识别配置」。</div>';
}
async function doParse() {
  const text = $('paste').value.trim();
  if (!text) return;
  try {
    const d = await fetchJSON('/api/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    state.targets = d.targets;
    renderTargets();
    const noKey = d.targets.filter((t) => !t.api_key).length;
    const noModel = d.targets.filter((t) => !t.model).length;
    const noUrl = d.targets.filter((t) => !t.base_url).length;
    const warn = [noUrl ? `${noUrl} 个待填地址` : '', noKey ? `${noKey} 个缺密钥` : '', noModel ? `${noModel} 个缺模型` : ''].filter(Boolean);
    log(d.targets.length ? 'ok' : 'warn', `识别到 ${d.targets.length} 个渠道${warn.length ? '（' + warn.join('，') + '）' : ''}`);
    UI.toast(d.targets.length ? `识别到 ${d.targets.length} 个渠道${warn.length ? '，' + warn.join('，') : ''}` : '没识别出渠道，检查一下粘贴内容', d.targets.length ? (warn.length ? 'warn' : 'ok') : 'warn');
  } catch (e) { log('err', '识别失败: ' + e.message); UI.toast('识别失败: ' + e.message, 'err'); }
}
async function doStart() {
  if (!state.targets.length) { await doParse(); if (!state.targets.length) { UI.toast('请先粘贴配置并点「识别配置」', 'warn'); return; } }
  const ready = state.targets.filter((t) => t.base_url);
  if (!ready.length) { UI.toast('还没有可用地址，请补上 base_url 后再测', 'warn'); setSidebar(true); return; }
  const missing = state.targets.length - ready.length;
  if (missing) UI.toast(`${missing} 个渠道缺地址，本次跳过`, 'warn');
  $('btnStart').disabled = true;
  try {
    const cfg = buildConfig();
    const d = await fetchJSON('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
    log('ok', `启动 ${d.count} 个运行 · mode=${cfg.mode}`);
    UI.toast(`已启动 ${d.count} 个运行`, 'ok');
    d.run_ids.forEach((rid, i) => {
      const t = state.targets[i];
      const run = { id: rid, target: t.name, model: t.model, provider: t.provider, status: 'running', samples: [], summary: null, slo: cfg.slo, mode: cfg.mode, randomize: cfg.randomize, promptMode: cfg.traffic && cfg.traffic.prompt_mode, color: C.series[state.colorIdx++ % C.series.length], sse: null };
      state.runs.set(rid, run); state.primary = rid; connectSSE(run);
    });
    renderRuns(); renderCompareTable();
    const first = state.runs.get(state.primary);
    if (first) renderRunning(first);
    setSidebar(false); // 开测后收起配置面板，让图表占满
  } catch (e) { log('err', '启动失败: ' + e.message); UI.toast('启动失败: ' + e.message, 'err'); }
  finally { $('btnStart').disabled = false; }
}
async function control(act) {
  if (!state.primary) { UI.toast('请先选择一个运行', 'warn'); return; }
  try { await fetchJSON(`/api/runs/${state.primary}/${act}`, { method: 'POST' }); log('info', `已发送 ${act}`); } catch (e) { log('err', e.message); }
}
function buildConfig() {
  const n = (id) => Number($(id).value);
  return {
    name: `bench-${nowTime()}`, targets: state.targets.filter((t) => t.base_url),
    mode: $('mode').value, concurrency: n('concurrency'), request_count: n('request_count'),
    rate: n('rate'), duration_s: n('duration_s'), warmup: n('warmup'), timeout_s: n('timeout_s'),
    retries: n('retries'), stream: $('stream').checked, connection_reuse: $('connection_reuse').checked,
    randomize: $('randomize').checked, jitter: n('jitter'), proxy: $('proxy').value.trim() || null,
    price_in: n('price_in'), price_out: n('price_out'), price_cache_in: n('price_cache_in'),
    slo: { ttft_ms: n('slo_ttft'), tpot_ms: n('slo_tpot'), e2e_ms: n('slo_e2e') },
    traffic: { prompt_mode: $('prompt_mode').value, prompt: $('prompt').value, input_tokens: n('input_tokens'), max_tokens: n('max_tokens'), temperature: n('temperature') },
  };
}

/* ---------- 探活 / 模型 ---------- */
async function doProbe() {
  if (!state.targets.length) await doParse();
  if (!state.targets.length) return;
  const t0 = Date.now();
  const timer = setInterval(() => {
    const el = $('modalBody');
    if (el && el.dataset.busy === '1') el.innerHTML = `<div class="hint">正在探测 ${state.targets.length} 个渠道… 已用 ${((Date.now() - t0) / 1000).toFixed(1)} 秒</div>`;
  }, 200);
  UI.openModal('探活测速', `<div class="hint" data-busy="1">正在探测 ${state.targets.length} 个渠道…</div>`);
  try {
    const cfg = buildConfig();
    // 探活是连通性检查，不该等用户设的 2 分钟超时
    const probeTimeout = Math.min(cfg.timeout_s || 20, 20);
    const d = await fetchJSON('/api/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targets: state.targets, traffic: cfg.traffic, stream: cfg.stream, timeout_s: probeTimeout, proxy: cfg.proxy, verify_tls: true }) });
    clearInterval(timer);
    const rows = d.results.map((r) => `<tr>
      <td>${esc(r.name)}</td><td>${r.provider}</td><td class="mono">${esc(r.model)}</td>
      <td><span class="badge ${r.ok ? 'ok' : 'no'}">${r.ok ? 'OK' : (r.error_class || 'FAIL')}</span></td>
      <td class="num">${r.status_code || '–'}</td><td class="num">${fmt(r.ttft_ms)} ms</td><td class="num">${fmt(r.e2e_ms)} ms</td>
      <td class="num">${fmt(r.tpot_ms, 1)} ms</td>
      <td class="num">${fmt(r.dns_ms, 1)}/${fmt(r.tcp_ms, 1)}/${fmt(r.tls_ms, 1)}</td>
      <td class="num">${r.in_tokens}/${r.out_tokens}</td>
      <td class="trunc" title="${esc(r.error_msg || '')}" style="color:var(--bad)">${esc(r.error_msg || '')}</td></tr>`).join('');
    UI.openModal('探活测速', `<div class="table-scroll"><table class="grid"><thead><tr><th>Channel</th><th>Provider</th><th>Model</th><th>Result</th><th class="num">Status</th><th class="num">TTFT</th><th class="num">E2EL</th><th class="num">TPOT</th><th class="num">DNS/TCP/TLS</th><th class="num">in/out</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table></div>`);
    UI.toast(`探活完成：${d.results.filter((r) => r.ok).length}/${d.results.length} 可用`, 'ok');
  } catch (e) { clearInterval(timer); UI.openModal('探活测速', `<div class="hint">失败：${esc(e.message)}</div>`); UI.toast('探活失败', 'err'); }
}
async function doModels() {
  if (!state.targets.length) await doParse();
  if (!state.targets.length) return;
  UI.openModal('模型列表', '<div class="hint">拉取中…</div>');
  const out = [];
  for (const t of state.targets) {
    try {
      const d = await fetchJSON(`/api/targets/models?base_url=${encodeURIComponent(t.base_url)}&api_key=${encodeURIComponent(t.api_key)}&provider=${t.provider}`);
      out.push(`<h4 style="color:var(--ink);font-size:12px;font-weight:600;margin:10px 0 4px">${esc(t.name)} · ${d.models.length} 个模型</h4>
        <div class="mono" style="font-size:11px;color:var(--muted);max-height:220px;overflow:auto;border:1px solid var(--rule);border-radius:8px;padding:8px">${d.models.map(esc).join('<br>') || '<span class="hint">无（可能不支持 /v1/models）</span>'}</div>`);
    } catch (e) { out.push(`<div class="hint">${esc(t.name)}: ${esc(e.message)}</div>`); }
  }
  UI.openModal('模型列表', out.join(''));
}

/* ---------- 缓存检测（主动验证 Prompt Cache） ---------- */
const CACHE_VERDICTS = {
  valid: ['缓存有效', 'ok'],
  suspect: ['疑似假缓存', 'no'],
  unreported: ['未上报缓存字段', ''],
  error: ['检测失败', 'no'],
};
function cacheVerdictBadge(v) {
  const [txt, cls] = CACHE_VERDICTS[v] || [v, ''];
  return `<span class="badge ${cls}">${txt}</span>`;
}
function cacheResultHtml(r) {
  const s = r.summary || {};
  const delta = (r.baseline && s.speedup != null && r.baseline.speedup)
    ? s.speedup - r.baseline.speedup : null;
  const deltaTxt = delta == null ? '' : `<span style="color:${delta >= 0 ? 'var(--ok)' : '#ff6961'}">${delta >= 0 ? '+' : ''}${delta.toFixed(2)}×</span>`;
  const kv = `<div class="kv">
    ${r.baseline ? `<div class="k">基线加速比</div><div class="v">${fmt(r.baseline.speedup, 2)}×　${deltaTxt}（相对本次）</div>` : ''}
    <div class="k">TTFT miss → hit</div><div class="v">${fmt(s.ttft_miss_med)} ms → ${fmt(s.ttft_hit_med)} ms（中位）</div>
    <div class="k">加速比</div><div class="v"><b>${fmt(s.speedup_min, 2)}×</b>（min 口径，判定用）· 中位 ${fmt(s.speedup, 2)}× · 阈值 ${fmt(s.speedup_threshold, 1)}×</div>
    <div class="k">命中请求</div><div class="v">${fmt(s.hit_requests)} / ${fmt(s.ok_rounds)} 成功轮</div>
    <div class="k">上报 cached</div><div class="v">${s.provider_reported ? '是' : '否（未返回缓存字段）'}</div>
  </div>
  ${(s.notes || []).length ? `<div class="hint" style="color:var(--muted)">${s.notes.map(esc).join('；')}</div>` : ''}`;
  const rows = (r.rounds || []).map((it, i) => `<tr>
    <td class="num">${it.seq}</td>
    <td><span class="badge ${it.ok ? 'ok' : 'no'}">${it.ok ? (i === 0 ? '写入' : (it.cached_tokens > 0 ? '命中' : '未命中')) : (it.error_class || 'FAIL')}</span></td>
    <td class="num">${fmt(it.ttft_ms)} ms</td>
    <td class="num">${fmt(it.e2e_ms)} ms</td>
    <td class="num">${fmt(it.cached_tokens)}</td>
    <td class="num">${fmt(it.cache_write_tokens)}</td>
    <td class="num">${fmt(it.in_tokens)}</td>
    <td class="trunc" title="${esc(it.error_msg || '')}" style="color:var(--bad)">${esc(it.error_msg || '')}</td></tr>`).join('');
  const table = `<div class="table-scroll"><table class="grid"><thead><tr>
    <th class="num">#</th><th>Result</th><th class="num">TTFT</th><th class="num">E2EL</th>
    <th class="num">Cached</th><th class="num">Write</th><th class="num">in tok</th><th>Error</th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;
  return `<div style="margin:0 0 6px">${cacheVerdictBadge(s.verdict)} <b>${esc(r.name)}</b> <span class="mono" style="color:var(--muted)">${esc(r.model)}</span></div>
    ${kv}${table}`;
}
async function renderCacheHist() {
  const box = $('cacheHist');
  if (!box) return;
  try {
    const d = await fetchJSON('/api/cache/checks');
    const rows = (d.checks || []).map((c) => {
      const s = c.summary || {};
      return `<tr>
        <td class="mono">${dtstr(c.ts)}</td>
        <td>${esc(c.name)}</td><td class="mono">${esc(c.model)}</td>
        <td class="num">${fmt(s.speedup, 2)}×</td>
        <td>${cacheVerdictBadge(s.verdict)}${c.is_baseline ? ' <span class="mono" style="color:var(--acc-bright);font-size:10.5px">基线</span>' : ''}</td>
        <td class="act">
          <button class="mini ghost" data-cact="view" data-cid="${c.id}">查看</button>
          <button class="mini ghost" data-cact="base" data-cid="${c.id}">设基线</button>
          <button class="mini ghost" data-cact="del" data-cid="${c.id}">删</button>
        </td></tr>`;
    }).join('');
    box.innerHTML = `<h4 style="color:var(--ink);font-size:12px;font-weight:600;margin:14px 0 6px">检测历史</h4>
      <div class="table-scroll"><table class="grid"><thead><tr>
        <th>时间</th><th>Channel</th><th>Model</th><th class="num">加速比</th><th>判定</th><th class="act">Actions</th>
        </tr></thead><tbody>${rows || '<tr><td colspan="6" class="hint">还没有检测记录。点「缓存检测」跑一次，就能看到这条渠道的缓存是否真实生效。</td></tr>'}</tbody></table></div>`;
  } catch { box.innerHTML = '<div class="hint">历史加载失败，请稍后重试</div>'; }
}
async function showCacheDetail(cid) {
  try {
    const d = await fetchJSON(`/api/cache/checks/${cid}`);
    UI.openModal(`缓存检测 · ${d.name}`, `${cacheResultHtml(d)}<div class="hint" style="margin-top:10px">检测时间 ${dtstr(d.ts)} · 前缀 ${fmt((d.params || {}).prefix_tokens)} tokens · ${fmt((d.params || {}).rounds)} 轮串行</div>`);
  } catch (e) { UI.toast('加载详情失败: ' + e.message, 'err'); }
}
async function doCacheCheck() {
  if (!state.targets.length) await doParse();
  if (!state.targets.length) { UI.toast('还没有可用渠道，请先粘贴供应商配置并识别', 'warn'); return; }
  if (state.targets.some((t) => !t.base_url)) { UI.toast('有渠道缺 base_url，补上后再测缓存', 'warn'); return; }
  const body = {
    targets: state.targets,
    rounds: Number($('c_rounds').value) || 6,
    prefix_tokens: Number($('c_prefix').value) || 2048,
    speedup_threshold: Number($('c_speedup').value) || 1.5,
    max_tokens: Math.max(Number($('max_tokens').value) || 1024, 1024),  // 思考型模型先耗预算，太小会整轮空输出
    stream: $('stream').checked,
    timeout_s: Number($('timeout_s').value) || 60,
    proxy: $('proxy').value.trim() || null,
    verify_tls: true,
  };
  const t0 = Date.now();
  UI.openModal('缓存检测', `<div class="hint" data-busy="1">正在检测 ${state.targets.length} 个渠道…（串行 ${body.rounds} 轮/渠道，约需数十秒）</div>`);
  const timer = setInterval(() => {
    const el = $('modalBody');
    if (el && el.dataset.busy === '1') el.innerHTML = `<div class="hint">正在检测… 已用 ${((Date.now() - t0) / 1000).toFixed(1)} 秒（串行 ${body.rounds} 轮/渠道，勿关闭）</div>`;
  }, 300);
  try {
    const d = await fetchJSON('/api/cache/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    clearInterval(timer);
    UI.openModal('缓存检测', d.results.map(cacheResultHtml).join('<div style="height:14px"></div>') + '<div id="cacheHist"></div>');
    renderCacheHist();
    const okN = d.results.filter((r) => (r.summary || {}).verdict === 'valid').length;
    UI.toast(`缓存检测完成：${okN}/${d.results.length} 渠道缓存有效`, okN ? 'ok' : 'warn');
  } catch (e) {
    clearInterval(timer);
    UI.openModal('缓存检测', `<div class="hint">检测失败：${esc(e.message)}。请确认渠道地址可达，或把「超时」调大后重试。</div>`);
    UI.toast('缓存检测失败', 'err');
  }
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-cact]');
  if (!b) return;
  const cid = b.dataset.cid;
  if (b.dataset.cact === 'view') showCacheDetail(cid);
  else if (b.dataset.cact === 'base') {
    try { await fetchJSON(`/api/cache/checks/${cid}/baseline`, { method: 'POST' }); UI.toast('已设为缓存基线', 'ok'); renderCacheHist(); }
    catch (err) { UI.toast('设置失败: ' + err.message, 'err'); }
  } else if (b.dataset.cact === 'del') {
    if (await UI.confirm('删除该缓存检测记录？（若它是基线将一并移除）', '删除记录')) {
      try { await fetchJSON(`/api/cache/checks/${cid}`, { method: 'DELETE' }); UI.toast('已删除', 'ok'); renderCacheHist(); }
      catch (err) { UI.toast('删除失败: ' + err.message, 'err'); }
    }
  }
});

/* ---------- 定时任务 ---------- */
async function loadSchedules() {
  try {
    const d = await fetchJSON('/api/schedules');
    $('schedules').innerHTML = d.schedules.map((s) => `<div class="tag"><b>${esc(s.name)}</b> <code>${esc(s.cron)}</code> ${s.enabled ? '' : '(停用)'}<button class="mini ghost" data-sid="${s.schedule_id}" style="float:right">删</button></div>`).join('') || '<div class="hint">暂无定时任务</div>';
  } catch { /* ignore */ }
}
async function createSchedule() {
  if (!state.targets.length) await doParse();
  if (!state.targets.length) { UI.toast('请先解析配置', 'warn'); return; }
  try {
    await fetchJSON('/api/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('sch_name').value, cron: $('sch_cron').value, enabled: true, run: buildConfig(), alert: { webhook_kind: $('alert_kind').value, webhook_url: $('alert_url').value.trim() || null, min_success_rate: Number($('alert_sr').value) } }) });
    UI.toast('定时任务已创建', 'ok'); loadSchedules();
  } catch (e) { UI.toast('创建失败: ' + e.message, 'err'); }
}

/* ---------- 通知 / 持久化 / 历史 ---------- */
function notify(run) {
  const s = run.summary;
  if (!('Notification' in window) || Notification.permission !== 'granted' || !s) return;
  new Notification(`LLM Bench · ${run.target} 完成`, { body: `成功率 ${pct(s.success_rate)} · E2E P95 ${fmt(s.e2e.p95)}ms · TTFT ${fmt(s.ttft.mean)}ms` });
}
const PERSIST = ['mode', 'concurrency', 'request_count', 'rate', 'duration_s', 'warmup', 'timeout_s', 'retries', 'jitter', 'proxy', 'prompt_mode', 'input_tokens', 'max_tokens', 'temperature', 'slo_ttft', 'slo_tpot', 'slo_e2e', 'price_in', 'price_out', 'price_cache_in', 'sch_name', 'sch_cron', 'alert_url', 'c_rounds', 'c_prefix', 'c_speedup'];
function saveCfg() { const o = {}; PERSIST.forEach((id) => { const el = $(id); if (el) o[id] = el.value; }); ['stream', 'connection_reuse', 'randomize'].forEach((id) => o[id] = $(id).checked); localStorage.setItem('llmbench.cfg', JSON.stringify(o)); }
function loadCfg() {
  try { const o = JSON.parse(localStorage.getItem('llmbench.cfg') || '{}'); Object.entries(o).forEach(([k, v]) => { const el = $(k); if (!el) return; if (el.type === 'checkbox') el.checked = v; else el.value = v; }); } catch { /* ignore */ }
}
async function loadHistory() {
  try {
    const d = await fetchJSON('/api/runs');
    const recent = d.runs.slice(0, 8).reverse();
    const newest = d.runs[0] && d.runs[0].run_id;
    for (const r of recent) {
      if (state.runs.has(r.run_id)) continue;
      const [det, smp] = await Promise.all([fetchJSON(`/api/runs/${r.run_id}`), fetchJSON(`/api/runs/${r.run_id}/samples?max_points=4000`)]);
      const t = det.run && det.run.params_json ? JSON.parse(det.run.params_json).targets[0] : { name: r.run_id, model: r.model };
      const run = { id: r.run_id, target: t.name, model: r.model, provider: r.provider, status: det.status, samples: smp.samples || [], summary: det.summary, slo: det.run ? JSON.parse(det.run.slo_json || '{}') : {}, mode: det.run && det.run.params_json ? (JSON.parse(det.run.params_json).mode || 'closed') : 'closed', randomize: det.run && det.run.params_json ? !!JSON.parse(det.run.params_json).randomize : undefined, promptMode: det.run && det.run.params_json ? (JSON.parse(det.run.params_json).traffic || {}).prompt_mode : undefined, color: C.series[state.colorIdx++ % C.series.length], sse: null };
      state.runs.set(r.run_id, run);
    }
    // 默认主视图：在**已加载的这 8 条**里挑"样本充足"的最近一条
    // （在全部历史里挑会选到没加载的运行，导致 state.primary 落空、图表不渲染）
    const loaded = recent.filter((r) => (r.total || 0) >= 10);
    const pick = state.primary
      || (loaded.length ? loaded[loaded.length - 1].run_id : null)
      || newest;
    if (pick && state.runs.has(pick)) {
      state.primary = pick;
      renderCards(state.runs.get(pick).summary);
    } else if (state.runs.size) {
      // 兜底：至少有数据就先渲染，别让画布空着
      state.primary = [...state.runs.keys()].pop();
      renderCards(state.runs.get(state.primary).summary);
    }
    renderRuns(); renderCompareTable(); renderAll();
    if (recent.length) log('info', `已恢复 ${recent.length} 条历史运行`);
  } catch { /* ignore */ }
}

/* ---------- 指标口径说明 ---------- */
const GLOSSARY = [
  ['TTFT', 'Time To First Token', '首字延迟', '请求发出 → 首个内容 token'],
  ['TPOT', 'Time Per Output Token', '每 token 时间', '(E2EL − TTFT) / (输出 token − 1)，每请求一个值'],
  ['ITL', 'Inter-Token Latency', 'token 间隔', '相邻流式 chunk 间隔，报 P50/P99'],
  ['E2EL', 'End-to-End Latency', '端到端延迟', '请求发出 → 末 token'],
  ['RPS', 'Requests Per Second', '请求速率', '完成请求数 / 墙钟（样本时长 ≥1s 才计算）'],
  ['Output tok/s', 'Output Throughput', '输出吞吐', '总输出 token / 墙钟时长（vLLM / SGLang 口径）。另有单请求解码口径（per-user）'],
  ['Goodput', '—', '有效吞吐', '达标请求占比。vLLM 的 request_goodput 为速率口径（req/s），本工具两个都给'],
  ['Cache hit', 'Prompt Cache Hit Rate', '缓存命中率', '命中输入 token / 总输入 token'],
  ['Cached tok', 'Cached Prompt Tokens', '命中 token 数', '各厂商结构归一后的命中输入 token'],
  ['Cache probe', 'Prompt Cache Verification', '缓存检测', '同一长前缀串行 N 次主动验证。加速比判定用 min 口径（思考/排队噪声的下界），中位数对照展示；上报命中但无加速 = 疑似假缓存'],
];
function showGlossary() {
  const rows = GLOSSARY.map(([a, b, c, d]) =>
    `<tr><td class="mono">${a}</td><td>${b}</td><td>${c}</td><td class="dimtxt">${d}</td></tr>`).join('');
  UI.openModal('指标口径说明', `
    <div class="table-scroll"><table class="grid"><thead><tr>
      <th>指标</th><th>全称</th><th>中文</th><th>口径</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="hint" style="margin-top:12px">
      命名对齐 <b>vLLM / SGLang</b>：字段规律为 <code>{统计量}_{指标}_{单位}</code>。<br>
      <b>TPOT ≠ ITL</b>：TPOT 是每请求的平均解码间隔，ITL 是逐 chunk 间隔；当一次返回包含多个 token（如投机解码）时两者不相等。<br>
      非流式请求测不到 TPOT/ITL，界面显示 <code>n/a</code>，且不计入 Goodput。<br>
      分位用<b>线性插值</b>，与 <code>numpy.percentile</code>（vLLM / SGLang 所用）逐位一致。<br>
      <b>缓存</b>兼容 4 种返回结构：OpenAI / GLM / Qwen（<code>prompt_tokens_details.cached_tokens</code>）、
      Anthropic（<code>cache_read_input_tokens</code>）、DeepSeek（<code>prompt_cache_hit_tokens</code>）、
      Kimi（扁平 <code>cached_tokens</code>）。<br>
      命中与未命中的 <b>TTFT 差值</b>会显示在结论下方，用来判断渠道的缓存是否真的生效。
    </div>`);
}

/* ---------- 命令面板 ---------- */
UI.setPaletteProvider(() => {
  const cmds = [
    { label: '开始性能测试', sub: '⌘/Ctrl+Enter', action: doStart },
    { label: '解析供应商配置', sub: '⌘/Ctrl+K', action: doParse },
    { label: '探活测速', action: doProbe },
    { label: '拉取模型列表', action: doModels },
    { label: '缓存检测（验证 Prompt Cache）', action: doCacheCheck },
    { label: '打开玻璃视觉 Demo', action: () => window.open('/static/demo-glass.html', '_blank') },
    { label: '查看指标口径说明', action: showGlossary },
    { label: '暂停当前运行', action: () => control('pause') },
    { label: '停止当前运行', action: () => control('stop') },
    { label: '切换到 · 降智检测', action: () => window.__switchView('bench') },
    { label: '切换到 · 性能压测', action: () => window.__switchView('perf') },
    { label: '导出当前运行 CSV', action: () => state.primary && window.open(`/api/runs/${state.primary}/export.csv`, '_blank') },
  ].map((c) => ({ ...c, sub: c.sub || '命令' }));
  const runs = [...state.runs.values()].map((r) => ({
    label: `打开运行 · ${r.target} (${r.model})`, sub: r.status, action: () => { state.primary = r.id; renderRuns(); renderAll(); fetchJSON(`/api/runs/${r.id}`).then((d) => { r.summary = d.summary; renderCards(d.summary); }).catch(() => {}); },
  }));
  return [...cmds, ...runs];
});

/* ---------- 健康 ---------- */
async function health() {
  try { await fetchJSON('/api/health'); $('health').className = 'led ok'; $('healthTxt').textContent = '在线'; }
  catch { $('health').className = 'led err'; $('healthTxt').textContent = '离线'; }
}
setInterval(health, 5000);

/* ---------- 事件 ---------- */
$('btnParse').onclick = doParse;
$('btnStart').onclick = doStart;
$('btnPause').onclick = () => control('pause');
$('btnStop').onclick = () => control('stop');
$('btnProbe').onclick = doProbe;
$('btnModels').onclick = doModels;
$('btnCache').onclick = doCacheCheck;
$('btnGlossary').onclick = showGlossary;
$('btnSchedule').onclick = createSchedule;
$('btnDemo').onclick = () => { $('paste').value = 'base_url: https://api.openai.com\napi_key: sk-your-key\nmodel: gpt-4o-mini'; doParse(); };
$('mode').onchange = () => { const m = $('mode').value; $('concurrency').value = m === 'open' ? 32 : (m === 'duration' ? 4 : 2); saveCfg(); };
$('timerange').onchange = () => { state.range = Number($('timerange').value); renderAll(); };
$('btnAutoRefresh').onclick = (e) => {
  state.autoRefresh = !state.autoRefresh;
  e.currentTarget.classList.toggle('on', state.autoRefresh);
  UI.toast(state.autoRefresh ? '自动刷新已开启' : '自动刷新已暂停', 'info', 1600);
  if (state.autoRefresh) renderAll();
};
$('runsSearch').oninput = () => { state.filter = $('runsSearch').value.trim(); renderRuns(); };
UI.sortable($('runsTable'), (key, dir) => { state.sort = { key, dir }; renderRuns(); });

document.querySelectorAll('#view-perf .tabs button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('#view-perf .tabs button').forEach((x) => x.classList.toggle('on', x === b));
  ['runs', 'req', 'cmp', 'log'].forEach((k) => $('pane-' + k).classList.toggle('on', k === b.dataset.tab));
  if (b.dataset.tab === 'req') loadRequests(state.primary);
});
$('reqOnlyFail').onchange = () => { state.reqOnlyFail = $('reqOnlyFail').checked; renderRequests(); };
$('reqErrClass').onchange = () => { state.reqClass = $('reqErrClass').value; renderRequests(); };
$('reqSearch').oninput = () => { state.reqSearch = $('reqSearch').value; renderRequests(); };
$('btnExportReq').onclick = () => {
  const rows = filteredRequests();
  if (!rows.length) { UI.toast('没有可导出的请求', 'warn'); return; }
  const cols = ['seq','status_code','error_class','ttft_ms','e2e_ms','tpot_ms','in_tokens','out_tokens','cached_tokens','error_msg'];
  const csv = [cols.join(',')].concat(rows.map((r) => cols.map((c) => {
    const v = r[c] == null ? '' : String(r[c]).replace(/"/g, '""');
    return /[",\n]/.test(v) ? `"${v}"` : v;
  }).join(','))).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `requests-${state.primary || 'run'}.csv`;
  a.click();
  UI.toast(`已导出 ${rows.length} 条请求`, 'ok');
};
document.addEventListener('change', saveCfg);
document.addEventListener('input', saveCfg);
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('#runsBody tr[data-run]')) {
    e.preventDefault(); openRunDetail(e.target.dataset.run); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doStart(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); doParse(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar(); }
});
$('btnSidebar').onclick = toggleSidebar;
$('btnOpenConfig').onclick = () => setSidebar(true);
$('btnQuickDemo').onclick = () => { $('paste').value = 'base_url: https://api.openai.com\napi_key: sk-your-key\nmodel: gpt-4o-mini'; setSidebar(true); doParse(); };
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (btn) {
    const { id, act } = btn.dataset;
    if (act === 'sel') { state.primary = id; renderRuns(); renderAll(); try { const d = await fetchJSON(`/api/runs/${id}`); state.runs.get(id).summary = d.summary; renderCards(d.summary); renderCompareTable(); } catch {} }
    else if (act === 'detail') openRunDetail(id);
    else if (act === 'csv') window.open(`/api/runs/${id}/export.csv`, '_blank');
    else if (act === 'json') window.open(`/api/runs/${id}/export.json`, '_blank');
    else if (act === 'md') window.open(`/api/runs/${id}/export.md`, '_blank');
    else if (act === 'del') {
      if (await UI.confirm('删除该运行及其全部样本？此操作不可撤销。', '删除运行')) {
        await fetch(`/api/runs/${id}`, { method: 'DELETE' }); state.runs.delete(id); if (state.primary === id) state.primary = null;
        UI.closeDrawer(); renderRuns(); renderCompareTable(); UI.toast('已删除', 'ok');
      }
    }
    return;
  }
  const row = e.target.closest('#runsBody tr[data-run]');
  if (row && !e.target.closest('button')) openRunDetail(row.dataset.run);
  const rm = e.target.closest('button[data-rm]');
  if (rm) { state.targets.splice(Number(rm.dataset.rm), 1); renderTargets(); return; }
  const del = e.target.closest('button[data-sid]');
  if (del) { await fetch(`/api/schedules/${del.dataset.sid}`, { method: 'DELETE' }); loadSchedules(); UI.toast('定时任务已删除', 'ok'); }
});

/* ---------- 面板高度拖拽 ---------- */
const PANEL_H_KEY = 'llmbench.panelH';
function panelHeights() {
  try { return JSON.parse(localStorage.getItem(PANEL_H_KEY) || '{}'); } catch { return {}; }
}
function initPanelResize() {
  const saved = panelHeights();
  document.querySelectorAll('.panel-grid > .panel, .bottom-panel').forEach((panel) => {
    const key = panel.dataset.panel;
    if (!key) return;
    if (saved[key]) {
      if (panel.classList.contains('bottom-panel')) panel.style.setProperty('--panes-h', saved[key] + 'px');
      else panel.style.setProperty('--ph', saved[key] + 'px');
    }
    const hnd = document.createElement('div');
    hnd.className = 'rs-h';
    hnd.setAttribute('role', 'separator');
    hnd.setAttribute('aria-orientation', 'horizontal');
    hnd.setAttribute('tabindex', '0');
    hnd.title = '拖拽调整高度 · 双击复位 · ↑/↓ 微调';
    panel.appendChild(hnd);

    const apply = (px) => {
      const clamped = Math.max(120, Math.min(800, Math.round(px)));
      if (panel.classList.contains('bottom-panel')) panel.style.setProperty('--panes-h', clamped + 'px');
      else panel.style.setProperty('--ph', clamped + 'px');
      saved[key] = clamped;
      hnd.setAttribute('aria-valuenow', clamped);
      return clamped;
    };
    const curH = () => (panel.classList.contains('bottom-panel')
      ? (panel.querySelector('.panes')?.getBoundingClientRect().height || 320)
      : panel.getBoundingClientRect().height);

    let startY = 0, startH = 0;
    hnd.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || panel.classList.contains('fullscreen')) return;
      e.preventDefault();
      hnd.setPointerCapture(e.pointerId);
      startY = e.clientY;
      startH = curH();
      document.body.classList.add('panel-resizing');
    });
    hnd.addEventListener('pointermove', (e) => {
      if (!hnd.hasPointerCapture(e.pointerId)) return;
      apply(startH + e.clientY - startY);
    });
    const end = (e) => {
      if (hnd.hasPointerCapture(e.pointerId)) hnd.releasePointerCapture(e.pointerId);
      document.body.classList.remove('panel-resizing');
      try { localStorage.setItem(PANEL_H_KEY, JSON.stringify(saved)); } catch { /* ignore */ }
    };
    hnd.addEventListener('pointerup', end);
    hnd.addEventListener('pointercancel', end);
    hnd.addEventListener('dblclick', () => {
      delete saved[key];
      try { localStorage.setItem(PANEL_H_KEY, JSON.stringify(saved)); } catch { /* ignore */ }
      panel.style.removeProperty('--ph');
      panel.style.removeProperty('--panes-h');
    });
    hnd.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      apply(curH() + (e.key === 'ArrowUp' ? 40 : -40));
      try { localStorage.setItem(PANEL_H_KEY, JSON.stringify(saved)); } catch { /* ignore */ }
    });
  });
}

/* ---------- 全局参数栏：侧栏参数拖入成快捷卡 ---------- */
const PIN_KEY = 'llmbench.pinParams';
function pinList() {
  try { const v = JSON.parse(localStorage.getItem(PIN_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function pinSave(list) { try { localStorage.setItem(PIN_KEY, JSON.stringify(list)); } catch { /* ignore */ } }
function pinLabelOf(el) {
  const wrap = el.closest('.switch') || el.parentElement;
  const lab = wrap && wrap !== el ? wrap.querySelector('label:not(.switch)') : null;
  return (lab && lab.textContent.trim()) || (el.closest('.switch') ? el.closest('.switch').textContent.trim() : (el.id || '参数'));
}
function pinBuildCard(id) {
  const src = $(id);
  if (!src) return null;
  const card = document.createElement('div');
  card.className = 'pin-card';
  card.draggable = true;
  card.dataset.pin = id;
  const label = pinLabelOf(src);
  let field = '';
  if (src.type === 'checkbox') {
    field = `<label class="switch"><input type="checkbox" ${src.checked ? 'checked' : ''} /><span>${esc(label)}</span></label>`;
  } else if (src.tagName === 'SELECT') {
    field = `<select aria-label="${esc(label)}">${[...src.options].map((o) =>
      `<option value="${esc(o.value)}" ${o.value === src.value ? 'selected' : ''}>${esc(o.textContent)}</option>`).join('')}</select>`;
  } else {
    field = `<input type="${src.type === 'number' ? 'number' : 'text'}" value="${esc(src.value)}" aria-label="${esc(label)}"
      ${src.step ? `step="${esc(src.step)}" ` : ''}${src.min != null && src.min !== '' ? `min="${esc(src.min)}" ` : ''} />`;
  }
  card.innerHTML = `<span class="pin-grip" title="拖拽排序，拖回侧栏移除">⠿</span>${field}
    ${src.type !== 'checkbox' ? `<label>${esc(label)}</label>` : ''}
    <button class="pin-x" title="移除" aria-label="移除参数 ${esc(label)}">×</button>`;
  return card;
}
function pinSync(src, val, isCheck) {
  if (isCheck) src.checked = val; else if (src.value !== String(val)) src.value = val;
  src.dispatchEvent(new Event('input', { bubbles: true }));
  src.dispatchEvent(new Event('change', { bubbles: true }));
}
function pinRender() {
  const strip = $('pinStrip');
  if (!strip) return;
  const list = pinList();
  strip.innerHTML = '';
  list.forEach((id) => {
    if (!$(id)) return;
    const card = pinBuildCard(id);
    if (!card) return;
    strip.appendChild(card);
    const src = $(id);
    const inp = card.querySelector('input,select');
    if (!inp) return;
    // 卡片 → 侧栏（派发事件联动持久化/联动逻辑）
    inp.addEventListener('input', () => pinSync(src, src.type === 'checkbox' ? inp.checked : inp.value, src.type === 'checkbox'));
    // 侧栏 → 卡片（loadCfg、模式联动改值等）
    const back = () => {
      if (src.type === 'checkbox') inp.checked = src.checked;
      else if (inp.value !== String(src.value)) inp.value = src.value;
    };
    src.addEventListener('input', back);
    src.addEventListener('change', back);
  });
  strip.hidden = list.length === 0;
}
function pinAdd(id) {
  if (!id || !$(id)) return;
  const list = pinList();
  if (list.includes(id)) { UI.toast('该参数已在全局参数栏里', 'info'); return; }
  list.push(id);
  pinSave(list);
  pinRender();
}
function pinRemove(id) {
  pinSave(pinList().filter((x) => x !== id));
  pinRender();
}
function initPinParams() {
  const side = $('side-perf');
  const main = document.querySelector('main');
  if (!side || !main) return;

  // 拖拽源：侧栏参数标签（label / switch）
  side.addEventListener('dragstart', (e) => {
    const lab = e.target.closest('label');
    if (!lab) return;
    const holder = lab.classList.contains('switch') ? lab : lab.parentElement;
    const src = holder && holder.querySelector('input,select');
    if (!src || src.tagName === 'TEXTAREA') return;
    e.dataTransfer.setData('text/pin-param', src.id);
    e.dataTransfer.effectAllowed = 'copyMove';
  });

  // 放下目标：主区 → 加入参数栏
  main.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/pin-param')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    $('pinStrip').classList.add('drop-on');
  });
  main.addEventListener('dragleave', (e) => {
    if (!main.contains(e.relatedTarget)) $('pinStrip').classList.remove('drop-on');
  });
  main.addEventListener('drop', (e) => {
    const id = e.dataTransfer.getData('text/pin-param');
    $('pinStrip').classList.remove('drop-on');
    if (!id) return;
    e.preventDefault();
    // 拖回侧栏即移除（来自卡片的移动）
    if (e.target.closest('.sidebar') || e.target.closest('.rail')) { pinRemove(id); UI.toast('已从参数栏移除', 'info'); return; }
    pinAdd(id);
  });

  // 卡片排序 + 拖出移除；点 × 移除
  const strip = $('pinStrip');
  strip.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.pin-card');
    if (!card || e.target.matches('input,select,button')) { e.preventDefault(); return; }
    e.dataTransfer.setData('text/pin-param', card.dataset.pin);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  strip.addEventListener('dragend', (e) => {
    strip.querySelectorAll('.pin-card').forEach((c) => c.classList.remove('dragging', 'drop-before', 'drop-after'));
  });
  strip.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/pin-param')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const over = e.target.closest('.pin-card');
    strip.querySelectorAll('.pin-card').forEach((c) => c.classList.remove('drop-before', 'drop-after'));
    if (!over || over.classList.contains('dragging')) return;
    const mid = over.getBoundingClientRect().left + over.getBoundingClientRect().width / 2;
    over.classList.add(e.clientX < mid ? 'drop-before' : 'drop-after');
  });
  strip.addEventListener('drop', (e) => {
    const id = e.dataTransfer.getData('text/pin-param');
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    const over = e.target.closest('.pin-card');
    const list = pinList();
    const from = list.indexOf(id);
    if (from >= 0) list.splice(from, 1);
    if (!over) { list.push(id); }
    else {
      const before = over.classList.contains('drop-before');
      let idx = list.indexOf(over.dataset.pin);
      if (idx < 0) idx = list.length;
      list.splice(before ? idx : idx + 1, 0, id);
    }
    pinSave(list);
    pinRender();
  });
  strip.addEventListener('click', (e) => {
    const x = e.target.closest('.pin-x');
    if (x) pinRemove(x.closest('.pin-card').dataset.pin);
  });

  pinRender();
}

if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();

loadCfg();
requestAnimationFrame(mountHero);   // 全局玻璃场景常驻
initPinParams();
initPanelResize();
setSidebar(localStorage.getItem('llmbench.sidebar') !== '0');
summaryEmpty();
renderRuns();
renderCompareTable();
loadSchedules();
loadHistory();
health();
log('info', '仪表盘就绪 · 粘贴供应商配置后「解析」→「开始测试」');
})();
