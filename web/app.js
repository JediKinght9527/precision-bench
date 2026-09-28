/* Precision Bench — 性能压测模块 */
(function () {
'use strict';
const $ = (id) => document.getElementById(id);
const { fmt, pct, fmtTime, fmtTimeParts, tstr, esc, nowTime, dtstr } = UI;
const C = UI.C;
const AXIS = UI.AXIS, SPLIT = UI.SPLIT, GRAT = UI.GRAT, MINOR = UI.MINOR;

const state = {
  targets: [], runs: new Map(), primary: null, colorIdx: 0, logs: [],
  filter: '', sort: { key: null, dir: 'asc' }, range: 0, autoRefresh: true,
  historyLoaded: false,
  activeIds: [],
  reqSamples: [], reqOnlyFail: false, reqClass: '', reqSearch: '', reportMarkdown: '',
};
let renderSignature = '';

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
  // 下限别被取整抹成 0。延迟数据下界常常是 2s/6s 这种远离 0 的值，
  // 但 floor 到整步长会把 min 压到 0，于是 80% 画布变成空白、真实波动被压扁。
  // 只有数据确实贴近 0（lo 很小）时才保留 0 轴。
  if (min <= 0 && lo > 0) {
    min = nice(lo * 0.8);
    if (min >= lo) min = nice(lo * 0.5);
    // 抬高下限后格数可能超标，重新收敛一次
    for (let i = 0; i < 8 && (max - min) / step > 6; i++) {
      step = nice(step * 1.5);
      max = Math.ceil((hi + span * pad) / step) * step;
    }
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
    // 下限 1s：几条样本挤在同一秒时 span→0 会把 rps 打成尖刺
    const span = Math.max(1, S[i].ts - S[lo].ts, winMs / 1000 * 0.5);
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

/* ---------- 带档位的数字输入 ----------
   只给「有自然档位、高频调参」的字段加滑杆；价格、显著性、随机种子这类
   自由值保持纯输入框 —— 给它们硬加滑杆只会碍事。 */
const NUMERIC_SLIDERS = {
  // 负载：档位只留真正会用的量级，9 个档在侧栏窄栏里会挤成糊字
  concurrency:    { detents: [1, 2, 4, 8, 16, 32, 64, 128, 256], min: 1, max: 256, scale: 'log', int: true },
  request_count:  { detents: [10, 50, 100, 500, 1000, 5000, 10000], min: 1, max: 10000, scale: 'log', int: true },
  rate:           { detents: [1, 5, 20, 100, 500], min: 0.1, max: 500, step: 0.5 },
  duration_s:     { detents: [10, 30, 60, 300, 1800], min: 1, max: 3600, scale: 'log', int: true },
  ramp_s:         { detents: [0, 30, 60, 300], min: 0, max: 600, int: true },
  cooldown_s:     { detents: [0, 30, 60, 300], min: 0, max: 600, int: true },
  warmup:         { detents: [0, 1, 3, 10, 20], min: 0, max: 20, int: true },
  ramp_rate:      { detents: [0, 1, 5, 25, 50], min: 0, max: 50, step: 0.5 },
  timeout_s:      { detents: [10, 30, 60, 300, 600], min: 1, max: 600, scale: 'log', int: true },
  retries:        { detents: [0, 1, 2, 3, 5], min: 0, max: 5, int: true },
  jitter:         { detents: [0, 0.1, 0.5, 1], min: 0, max: 1, step: 0.05 },
  // 请求内容
  max_tokens:     { detents: [16, 64, 256, 1024, 4096], min: 1, max: 8192, scale: 'log', int: true },
  temperature:    { detents: [0, 0.5, 1, 2], min: 0, max: 2, step: 0.1 },
  top_p:          { detents: [0.1, 0.5, 0.9, 1], min: 0, max: 1, step: 0.05 },
  // 合格线：最常被反复调的一组
  slo_ttft:       { detents: [500, 1500, 3000, 5000], min: 50, max: 10000, scale: 'log', int: true },
  slo_tpot:       { detents: [10, 30, 50, 100], min: 1, max: 500, scale: 'log', int: true },
  slo_e2e:        { detents: [1000, 5000, 10000, 30000], min: 100, max: 120000, scale: 'log', int: true },
  // 缓存探针
  c_rounds:       { detents: [2, 4, 8, 20], min: 2, max: 20, int: true },
  c_prefix:       { detents: [256, 1024, 4096, 8192], min: 64, max: 16384, scale: 'log', int: true },
  // 降智检测
  'b-concurrent': { detents: [1, 4, 16, 64], min: 1, max: 64, scale: 'log', int: true },
};

/* ---------- 图表 ---------- */
const charts = {};
['e2e', 'ttft', 'tpot', 'tput', 'heat', 'err', 'dist', 'cmp'].forEach((k) => { charts[k] = UI.initChart($('ch-' + k)); });
// 三张延迟图共享同一 seq 序列 → 联动十字准星，竖向对齐可直接比读
try { echarts.connect([charts.e2e, charts.ttft, charts.tpot, charts.tput]); } catch (e) { /* 老版本忽略 */ }
window.addEventListener('resize', () => Object.values(charts).forEach((c) => c && c.resize()));
window.addEventListener('viewchange', (e) => {
  if (e.detail.view === 'perf') {
    renderSignature = '';
    renderAll(true);
    requestAnimationFrame(() => Object.values(charts).forEach((c) => c && c.resize()));
  }
});

/* ---------- 结论带 ---------- */
/* 缓存能不能测，取决于配置：
   - randomize 开启 → 每次前缀都不同，缓存必然不命中
   - prompt 极短（hi）→ 命中 token 数低于缓存最小粒度，测不出来
   这两种情况都不能显示 0%（会被误读成"渠道无缓存"）。 */
function cacheDisplay(sum) {
  const run = state.primary ? state.runs.get(state.primary) : null;
  if (!sum || !sum.cache || !sum.tokens || !sum.tokens.in) return { text: '–', cls: '' };
  if (run && run.randomize && !run.cacheMode) return { text: 'n/a', cls: '' };
  if (run && run.promptMode === 'tiny') return { text: 'n/a', cls: '' };
  if (sum.cache.reported === false && !(sum.cache.cached_tokens > 0)) {
    return { text: 'n/a', cls: '', tip: '渠道未上报缓存字段（reported=false），命中率无法测得，见判定块说明或用「缓存检测」主动探测' };
  }
  const r = sum.cache.hit_rate;
  return { text: pct(r), cls: r > 0 ? 'v-ok' : '' };
}

// 有失败时不给延迟上好颜色；一个都没成功则延迟无意义，显示 –
const lat = (s, v, ok, warn) => (s.failed > 0 ? '' : v <= ok ? 'v-ok' : v <= warn ? 'v-warn' : 'v-bad');
const lv = (s, v) => (s.ok ? fmt(v) : '–');
/* 延迟读数：自适应 ms/s（≥1s 显秒），空值 – */
const lvT = (s, v) => (s.ok ? fmtTime(v) : '–');
// 指标命名对齐 vLLM / SGLang：TTFT / TPOT / ITL / E2EL，字段规律 {stat}_{metric}
/* 读数区第一行 = 判定依据三要素（口径与判定一致：用 P95 + run.slo）；次级网格按重要性排序 */
const SLO_DEF = { ttft_ms: 1500, tpot_ms: 50, e2e_ms: 5000 };
const runSlo = (run) => Object.assign({}, SLO_DEF, (run && run.slo) || {});
/* 与 evaluate() 同色阶：≤limit 绿，≤1.5×limit 黄，否则红 */
const latSlo = (s, v, limit) => (s.failed > 0 || limit == null ? '' : v <= limit ? 'v-ok' : v <= limit * 1.5 ? 'v-warn' : 'v-bad');
const PRIMARY_DEFS = [
  ['Success rate', (s) => pct(s.success_rate), '', (s) => s.success_rate >= 0.99 ? 'v-ok' : s.success_rate >= 0.95 ? 'v-warn' : 'v-bad', '请求成功率'],
  ['TTFT P95', (s) => lvT(s, s.ttft.p95), '', (s, run) => latSlo(s, s.ttft.p95, runSlo(run).ttft_ms), 'Time To First Token 首字延迟 P95（与判定同口径：合格线见侧栏「合格线 · 成本」区内的首字/端到端）'],
  ['E2EL P95', (s) => lvT(s, s.e2e.p95), '', (s, run) => latSlo(s, s.e2e.p95, runSlo(run).e2e_ms), 'End-to-End Latency 端到端 P95（与判定同口径：合格线见侧栏「合格线 · 成本」区内的首字/端到端）'],
];
const METRIC_DEFS = [
  ['成功 RPS', (s) => fmt(s.rps, 2), 'req/s', () => '', '成功请求速率 = 成功请求数 / 墙钟；尝试速率见详情'],
  ['Output tok/s', (s) => fmt(s.tokens.output_throughput, 1), 'tok/s', () => 'v-info', '总输出 token / 墙钟时长（与 vLLM、SGLang 口径一致）；单请求解码口径见详情'],
  ['Cache hit', (s) => { const d = cacheDisplay(s); return d.text; }, '', (s) => cacheDisplay(s).cls, '缓存命中率 = 命中输入 token / 总输入 token（token 口径）；请求 hit/miss 见判定块。随机化/过短 → n/a；渠道未上报字段 → n/a（非 0%）'],
  // 分档补 v-bad：原来只有 ≥0.9 绿 / 否则黄两档，2% 的 goodput 只被标成"警告"，
  // 和「Cost 未配置」看起来一样重 —— 而它其实是压倒性的失败。
  ['Goodput', (s) => pct(s.goodput), '', (s) => s.goodput >= 0.9 ? 'v-ok' : s.goodput >= 0.6 ? 'v-warn' : 'v-bad', '达标请求占比（TTFT/E2E/TPOT 均≤合格线）；计入 SCORE（20 分）'],
  ['TPOT', (s) => (s.measurable && !s.measurable.tpot ? 'n/a' : s.ok ? fmtTime(s.tpot.mean) : '–'), '', (s, run) => (s.measurable && !s.measurable.tpot ? '' : latSlo(s, s.tpot.mean, runSlo(run).tpot_ms)), 'Time Per Output Token 每 token 时间（均值着色用侧栏 tpot 合格线；判定块用 P95）'],
  ['ITL P99', (s) => (s.measurable && !s.measurable.itl ? 'n/a' : s.ok ? fmtTime(s.itl.p99) : '–'), '', () => '', 'Inter-Token Latency 相邻 token 间隔的 P99（非流式不可测）'],
  ['E2EL P50', (s) => lvT(s, s.e2e.p50), '', () => '', 'End-to-End Latency 端到端 P50'],
  ['E2EL P99', (s) => lvT(s, s.e2e.p99), '', () => '', '端到端长尾；主流压测工具（k6/Locust）都会单列的尾分位'],
  ['E2EL mean', (s) => lvT(s, s.e2e.mean), '', () => '', '端到端均值'],
  ['Checks', (s) => (s.ok > 0 && s.checks && s.checks.nonempty_rate != null ? pct(s.checks.nonempty_rate) : '–'), '', (s) => (s.ok > 0 && s.checks && s.checks.empty_output ? (s.checks.nonempty_rate >= 0.95 ? 'v-warn' : 'v-bad') : s.ok > 0 ? 'v-ok' : ''), '内容校验（k6 checks 口径）：成功请求中输出 token>0 的占比；0 token 通常意味着渠道返回 200 但空补全'],
  ['Cost', (s) => (s.cost && (s.cost.price_in > 0 || s.cost.price_out > 0) ? '¥' + fmt(s.cost.total, 4) : '未配置'), '', () => '', '总花费 = 输入×单价 + 输出×单价（在「合格线 · 成本」里填写单价后自动估算）'],
  ['Errors', (s) => fmt(s.failed), '', (s) => s.failed ? 'v-bad' : '', '失败请求数'],
];

/* 空态与运行态：都按同一套指标定义渲染，避免列不一致 */
function summaryEmpty() {
  $('roPrimary').innerHTML = PRIMARY_DEFS.map(([k, , , , hint]) => `<div class="ro-item is-empty"><dt title="${esc(hint || '')}">${k}</dt><dd>–</dd></div>`).join('');
  $('metrics').innerHTML = METRIC_DEFS.map(([k, , , , hint]) => `<div class="metric is-empty"><dt title="${esc(hint || '')}">${k}</dt><dd>–</dd></div>`).join('');
  $('verdictBlock').className = 'verdict-block';
  $('vbState').textContent = '待检测';
  $('vbRing').innerHTML = '<div class="rings-empty">–</div>';
  $('vbRing').title = '';
  $('vbRingsLegend').innerHTML = '';
  $('vbLabel').textContent = '等待运行';
  $('vbSub').textContent = '粘贴渠道配置并开始测试';
  $('vbSlo').innerHTML = '';
  $('vbTicks').innerHTML = ''; $('vbTicksCap').textContent = '最近请求';
}

/* 健康分 0–100：按本次 summary 实时核算 —— 成功率 30 + Goodput 20 + TTFT 15 + E2E 25 + TPOT 10 = 100
   （延迟相对 run.slo 合格线；Goodput = 三项均达标的请求占比，直接反映「能用的请求」比例） */
/* 五个分项的达标度（0–1）。healthScore / scoreBreakdown / 三环共用同一份算法，
   否则环上的进度与数字分数会各算各的，出现"环满但分低"的矛盾。
   latPart：≤合格线=1，≥2×合格线=0，中间线性；无可测样本给 0.5 中性。 */
function scoreParts(sum, run) {
  const slo = runSlo(run);
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const sr = clamp(sum.success_rate ?? 0);
  const latPart = (v, limit) => {
    if (v == null || !limit || !sum.ok) return 0.5;
    if (v <= limit) return 1;
    if (v >= limit * 2) return 0;
    return clamp(1 - (v - limit) / limit);
  };
  const ttft = latPart(sum.ttft && sum.ttft.p95, slo.ttft_ms);
  const e2e = latPart(sum.e2e && sum.e2e.p95, slo.e2e_ms);
  const tpot = (sum.measurable && !sum.measurable.tpot) ? 0.5 : latPart(sum.tpot && sum.tpot.p95, slo.tpot_ms);
  const gp = sum.goodput != null ? clamp(sum.goodput) : (sum.ok ? (ttft + e2e + tpot) / 3 : 0.5);
  return { sr, gp, ttft, e2e, tpot };
}

/* 三环的三个维度：可靠性 / 速度 / 有效吞吐。
   延迟维度取 E2EL 与 TTFT 中较差的一项——只报 E2EL 会掩盖首字延迟。 */
function ringParts(sum, run) {
  if (!sum || !sum.total) return null;
  const p = scoreParts(sum, run);
  const slo = runSlo(run);
  const lat = Math.min(p.e2e, p.ttft);
  const latMs = Math.max(
    (sum.e2e && sum.e2e.p95) || 0,
    (sum.ttft && sum.ttft.p95) || 0,
  );
  return {
    rings: [
      { k: 'reliab', label: '可靠性', v: p.sr, disp: pct(p.sr), cls: 'p',
        tip: `成功率 ${pct(p.sr)}，合格 ≥${pct(slo_rate(slo))}` },
      { k: 'speed', label: '速度', v: lat, disp: latMs ? fmtTime(latMs) : '—', cls: 'p',
        tip: `首字/端到端较慢项 ${latMs ? fmtTime(latMs) : 'n/a'}，合格 ≤${fmtTime(Math.max(slo.ttft_ms, slo.e2e_ms))}` },
      { k: 'thru', label: '有效吞吐', v: p.gp, disp: pct(p.gp), cls: 'p',
        tip: `Goodput ${pct(p.gp)}：三项延迟均达标的请求占比` },
    ],
  };
}

/* 把 evaluate() 的每条判据结果贴到对应的环上。
   环的颜色是「维度身份」，达标状态另用状态点表达，两者不混用——
   否则绿色环到底是"速度环"还是"达标"就说不清了。 */
function ringVerdicts(sum, run) {
  const v = evaluate(sum, run);
  const by = {};
  for (const ch of v.chips || []) by[ch.k] = ch;
  const rp = ringParts(sum, run);
  if (!rp) return null;
  const sr = by['Success rate'];
  const e2e = by['E2EL P95'];
  const ttft = by['TTFT P95'];
  // 速度环取首字/端到端中较差的状态
  const order = { p: 0, w: 1, f: 2 };
  const speedCls = (!e2e || !ttft || e2e.cls === '' || ttft.cls === '')
    ? '' : (order[e2e.cls] >= order[ttft.cls] ? e2e.cls : ttft.cls);
  rp.rings[0].cls = (sr && sr.cls) || '';
  rp.rings[1].cls = speedCls;
  rp.rings[2].cls = '';          // Goodput 无独立合格线
  rp.rings[0].note = sr && sr.tip;
  rp.rings[1].note = (e2e && e2e.tip) || (ttft && ttft.tip);
  return rp;
}

/* ── 三环仪表 ────────────────────────────────────────────────────────────
   参照 Apple HIG 的运动环语汇：纯色（无渐变/无阴影）、圆头线帽、起点在 12 点
   方向顺时针、轨道用同色低透明。不复制 Apple 的 Move/Exercise/Stand 语义与
   色值，改用本项目自己的三维度：可靠性 / 速度 / 有效吞吐。
   环长 = 该维度相对合格线的达标度，环满即刚好达标。
   半径由外到内递减 12 = 环宽 9 + 间隙 3，符合 HIG「间隙不大于环宽」。 */
const RING_SVG = 132, RING_C = RING_SVG / 2;
const RING_R = [54, 40, 26];         // 半径差 14 = 环宽 10 + 间隙 4
const RING_TONE = ['a', 'b', 'c'];   // a=可靠性 b=速度 c=有效吞吐
const RING_W = 10;

/* 外缘 20 根刻度针，每 5% 一根（每 4 根加长）—— 让它读作仪表而非进度条 */
const RING_TICKS = Array.from({ length: 20 }, (_, i) => {
  const a = (i / 20) * Math.PI * 2 - Math.PI / 2;
  const r1 = 60, r2 = i % 4 === 0 ? 64.5 : 62.5;
  const x1 = RING_C + Math.cos(a) * r1, y1 = RING_C + Math.sin(a) * r1;
  const x2 = RING_C + Math.cos(a) * r2, y2 = RING_C + Math.sin(a) * r2;
  return `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`;
}).join('');

function ringsSvg(rp) {
  const arcs = rp.rings.map((g, i) => {
    const c = 2 * Math.PI * RING_R[i];
    const frac = Math.max(0, Math.min(1, g.v || 0));
    return `<g class="ring tone-${RING_TONE[i]}">
      <title>${esc(`${g.label} ${g.disp}，达标度 ${Math.round(frac * 100)}%`)}\n${esc(g.tip)}</title>
      <circle class="ring-track" cx="${RING_C}" cy="${RING_C}" r="${RING_R[i]}" stroke-width="${RING_W}"/>
      <circle class="ring-arc" cx="${RING_C}" cy="${RING_C}" r="${RING_R[i]}" stroke-width="${RING_W}"
        stroke-dasharray="${(c * frac).toFixed(2)} ${c.toFixed(2)}"/>
    </g>`;
  }).join('');
  return `<svg class="rings-svg" viewBox="0 0 ${RING_SVG} ${RING_SVG}" aria-hidden="true">
    <g class="ring-ticks">${RING_TICKS}</g>
    <g transform="rotate(-90 ${RING_C} ${RING_C})">${arcs}</g>
  </svg>`;
}

function healthScore(sum, run) {
  if (!sum || !sum.total) return null;
  const p = scoreParts(sum, run);
  // 满分 100：30+20+15+25+10
  return Math.round(p.sr * 30 + p.gp * 20 + p.ttft * 15 + p.e2e * 25 + p.tpot * 10);
}
/* 健康分明细 tooltip（挂在环上），让用户知道分是怎么来的 */
function scoreBreakdown(sum, run) {
  if (!sum || !sum.total) return '';
  const slo = runSlo(run);
  const p = scoreParts(sum, run);
  return [
    `成功率 ${pct(p.sr)} × 30 = ${(p.sr * 30).toFixed(1)}`,
    `Goodput ${pct(p.gp)} × 20 = ${(p.gp * 20).toFixed(1)}`,
    `TTFT ${fmtTime(sum.ttft && sum.ttft.p95)} / ${fmtTime(slo.ttft_ms)} × 15 = ${(p.ttft * 15).toFixed(1)}`,
    `E2EL ${fmtTime(sum.e2e && sum.e2e.p95)} / ${fmtTime(slo.e2e_ms)} × 25 = ${(p.e2e * 25).toFixed(1)}`,
    `TPOT ${sum.measurable && !sum.measurable.tpot ? 'n/a ×10 = 5.0（中性）' : `${fmtTime(sum.tpot && sum.tpot.p95)} / ${fmtTime(slo.tpot_ms)} × 10 = ${(p.tpot * 10).toFixed(1)}`}`,
  ].join('\n');
}

/* 新运行开始：立刻清空上一次的残留（否则看起来像"没反应"） */
function renderRunning(run) {
  $('verdictBlock').className = 'verdict-block s-run';
  $('vbState').textContent = '运行中';
  $('vbRing').innerHTML = '<div class="rings-empty">–</div>';
  $('vbRing').title = '';
  $('vbRingsLegend').innerHTML = '';
  $('vbLabel').textContent = '采集中';
  $('vbSub').innerHTML = run
    ? `<b>${esc(run.target === run.model ? run.target : `${run.target}　${run.model}`)}</b>`
    : '';
  $('vbSlo').innerHTML = '';
  $('vbTicks').innerHTML = '';
  $('vbTicksCap').textContent = '等待连接…';
  const dash = (k, hint) => `<div class="metric is-empty"><dt title="${esc(hint || '')}">${k}</dt><dd>–</dd></div>`;
  $('roPrimary').innerHTML = PRIMARY_DEFS.map(([k, , , , hint]) => `<div class="ro-item is-empty"><dt title="${esc(hint || '')}">${k}</dt><dd>–</dd></div>`).join('');
  $('metrics').innerHTML = METRIC_DEFS.map(([k, , , , hint]) => dash(k, hint)).join('');
  ['e2e', 'ttft', 'tpot', 'tput', 'heat', 'err', 'dist', 'cmp'].forEach((k) => UI.noData($('ch-' + k), 'Waiting for data…'));
  document.querySelectorAll('#perfDash .panel-grid > .panel').forEach((p) => p.classList.add('is-waiting'));
}
function clearWaiting() {
  document.querySelectorAll('#perfDash .panel-grid > .panel.is-waiting').forEach((p) => p.classList.remove('is-waiting'));
}

function renderCards(sum) {
  if (!sum) { summaryEmpty(); return; }
  const run = state.primary ? state.runs.get(state.primary) : null;
  const cell = (k, get, unit, cls, box, hint) => {
    let v = '–';
    try { v = get(sum); } catch { v = '–'; }
    const empty = v === '–' || v === 'n/a' || v === '未配置';
    const showUnit = unit && !empty;
    const extra = empty ? ' is-empty' : '';
    return `<div class="${box}${extra} ${cls ? cls(sum, run) : ''}"><dt title="${esc(hint || '')}">${k}</dt><dd>${v}${showUnit ? ` <em>${unit}</em>` : ''}</dd></div>`;
  };
  /* live summary 每秒推一次，若每次都 innerHTML 重建，3+12 个格子会整块闪一下。
     这里只在首次（或格子数量/顺序变化）时建结构，之后仅改变化的数值文本，
     配合 CSS 的 dd 过渡，数字变化才是"平滑更新"而不是"重排闪烁"。 */
  const paint = (id, defs, box) => {
    const host = $(id);
    const want = defs.length;
    if (host.childElementCount !== want) {
      host.innerHTML = defs.map(([k, get, unit, cls, hint]) => cell(k, get, unit, cls, box, hint)).join('');
      return;
    }
    defs.forEach(([k, get, unit, cls, hint], i) => {
      const el = host.children[i];
      let v = '–';
      try { v = get(sum); } catch { v = '–'; }
      const empty = v === '–' || v === 'n/a' || v === '未配置';
      const dd = el.querySelector('dd');
      if (!dd) return;
      const want2 = `${v}${unit && !empty ? ` <em>${unit}</em>` : ''}`;
      if (dd.dataset.v !== String(v)) {
        dd.dataset.v = String(v);
        dd.innerHTML = want2;
        dd.classList.remove('dd-bump');
        void dd.offsetWidth;            // 强制回流，让下面的动画能重新触发
        dd.classList.add('dd-bump');
      }
      el.classList.toggle('is-empty', empty);
      const kls = `${box} ${cls ? cls(sum, run) : ''}`;
      if (el.className !== kls) el.className = kls;
    });
  };
  paint('roPrimary', PRIMARY_DEFS, 'ro-item');
  paint('metrics', METRIC_DEFS, 'metric');

  // 无成功样本时延迟无意义：不显示 44px 的「0」（大白 0 会像一块白斑）
  const p95 = (sum.ok > 0 && sum.e2e && sum.e2e.p95 != null) ? sum.e2e.p95 : null;
  const v = evaluate(sum, run);
  const vb = $('verdictBlock');
  vb.className = 'verdict-block s-' + v.state + (p95 == null ? ' vb-empty' : '');
  $('vbState').textContent = v.label;
  /* 三环仪表：环长 = 相对合格线的达标度，圆心读数取三环中最优的一项。
     达标度与健康分共用 scoreParts()，避免"环满但分低"的自相矛盾。 */
  const rp = ringVerdicts(sum, run);
  const score = healthScore(sum, run);
  $('vbRing').title = scoreBreakdown(sum, run);
  if (!rp) {
    $('vbRing').innerHTML = `<div class="rings-empty">–</div>`;
    $('vbLabel').textContent = '等待运行';
  } else {
    const best = rp.rings.reduce((a, b) => (b.v > a.v ? b : a));
    $('vbRing').innerHTML = ringsSvg(rp) + `
      <div class="rings-core">
        <b>${score == null ? '–' : score}</b>
        <span>健康分</span>
      </div>`;
    $('vbRingsLegend').innerHTML = rp.rings.map((g, i) => {
      const isBest = g === best;
      const pc = Math.round(Math.max(0, Math.min(1, g.v || 0)) * 100);
      return `<div class="tone-${RING_TONE[i]}${isBest ? ' is-best' : ''}" title="${esc(g.note || g.tip)}">
        <i class="sw"></i><span class="nm">${esc(g.label)}</span>
        <span class="bar"><b style="width:${pc}%"></b></span>
        <em class="r-${g.cls || 'na'}">${esc(g.disp)}</em>
        ${isBest ? '<span class="best-tag">最优</span>' : ''}
      </div>`;
    }).join('');
    // 数值只在图例里出现一次；右侧只留判定状态与最优维度名
    $('vbLabel').innerHTML = `${esc(best.label)}<span class="vb-label-tip">三环中最优</span>`;
  }
  // target 与 model 同名时不重复显示（如渠道名直接填了模型名）
  const t = run ? (run.target === run.model ? run.target : `${run.target}　${run.model}`) : '';
  const who = t ? `<b>${esc(t)}</b>` : '粘贴渠道配置并开始测试';
  let cacheLine = '';
  const c = sum.cache;
  const cd = cacheDisplay(sum);
  if (cd.text === 'n/a') {
    cacheLine = '　Cache hit n/a（随机化/过短或渠道未上报字段，不可测）';
    if (run && run.randomize) {
      cacheLine += '。「随机化请求」已开启会破坏前缀。测缓存请关闭，或用「缓存检测」按钮';
    } else if (cd.tip) {
      cacheLine += `。${cd.tip}`;
    }
  } else if (c && c.cached_tokens > 0) {
    cacheLine = `　Cache hit ${pct(c.hit_rate)}（token 口径 ${fmt(c.cached_tokens)}/${fmt(sum.tokens.in)}；请求 ${c.requests_hit} 命中 / ${c.requests_miss} 未命中）`;
    if (c.ttft_speedup) {
      cacheLine += ` · TTFT ${fmtTime(c.ttft_hit.mean)} vs ${fmtTime(c.ttft_miss.mean)}（加速 ${c.ttft_speedup}×）`;
    }
  } else if (c && sum.measurable) {
    if (c.reported === false) {
      cacheLine = '　Cache hit n/a（渠道 usage 未上报缓存字段，命中率不可测）';
      cacheLine += '。可用「缓存检测」主动探测（同前缀多轮 + TTFT 加速比交叉验证）';
    } else {
      cacheLine = '　Cache hit 0%（渠道已上报缓存字段，本轮全部未命中）';
      if ($('randomize')?.checked) {
        cacheLine += '。注意：「随机化请求」已开启，每次前缀都不同，缓存必然不命中。测缓存请关闭它，或改用「缓存检测」按钮';
      } else if (($('input_tokens')?.value | 0) < 256) {
        cacheLine += '。注意：输入 token 数偏小（低于常见缓存门槛），建议 ≥1024 再观察命中';
      } else {
        cacheLine += '。可用「缓存检测」主动探测（同前缀多轮 + TTFT 加速比交叉验证）';
      }
    }
  }
  const noteCls = v.state === 'bad' ? 'is-bad' : v.state === 'warn' ? 'is-warn' : '';
  const noteHtml = v.notes.length
    ? `<span class="vb-note ${noteCls}">${esc(v.notes.join(' · '))}</span>`
    : '';
  $('vbSub').innerHTML = `${who}${noteHtml}<span class="vb-cache">${esc(cacheLine)}</span>`;
  // 合格线基准：原先这里渲染四枚 chip，但它们的数值与三环图例、右侧指标格
  // 完全重复（同屏三处）。这里改为一行阈值——chip 独有、别处没有的信息。
  // 合格线是用户填的设置值，不是测量值：去掉 fmtTime 的尾随 .0
  // （"逐字 ≤50.0 ms" 会暗示不存在的测量精度）
  const fmtSlo = (ms) => fmtTime(ms).replace(/\.0(?=\s|$)/, '');
  const slo = runSlo(run);
  $('vbSlo').innerHTML =
    `<span class="slo-cap">合格线</span>` +
    `<span>成功率 ≥${(slo_rate(slo) * 100).toFixed(1).replace(/\.0$/, '')}%</span>` +
    `<span>首字 ≤${fmtSlo(slo.ttft_ms)}</span><span>端到端 ≤${fmtSlo(slo.e2e_ms)}</span>` +
    `<span>逐字 ≤${fmtSlo(slo.tpot_ms)}</span>`;
  renderTicks(run);
}

/* 判定完全由"用户设的合格线"驱动，并在界面上写明是哪一条没过 —— 不再是魔法数字 */
function evaluate(sum, run) {
  const slo = runSlo(run);
  const rows = [
    { k: 'Success rate', v: sum.success_rate, limit: slo_rate(slo), cmp: '>=', bad: 0.95, show: pct },
    { k: 'E2EL P95', v: sum.e2e ? sum.e2e.p95 : null, limit: slo.e2e_ms, cmp: '<=', show: fmtTime },
    { k: 'TTFT P95', v: sum.ttft ? sum.ttft.p95 : null, limit: slo.ttft_ms, cmp: '<=', show: fmtTime },
    { k: 'TPOT P95', v: sum.tpot ? sum.tpot.p95 : null, limit: slo.tpot_ms, cmp: '<=', show: fmtTime },
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
  if (!S.length) { box.innerHTML = ''; box.classList.remove('all-fail'); $('vbTicksCap').textContent = '最近请求'; return; }
  const fails = S.filter((s) => !s.ok).length;
  const allFail = fails === S.length;
  const lat = S.map((s) => s.e2e_ms || 0);
  const max = Math.max(...lat, 1);
  /* 全失败时不画红墙：统一降调高度，靠文案表达失败 */
  box.classList.toggle('all-fail', allFail);
  box.innerHTML = S.map((s) => {
    const h = allFail ? 55 : Math.max(12, Math.round((s.e2e_ms || 0) / max * 100));
    return `<i class="${s.ok ? '' : 'f'}" style="height:${h}%" title="#${s.seq} ${s.ok ? fmtTime(s.e2e_ms) : (s.error_class || '失败')}"></i>`;
  }).join('');
  const prog = run.requestCount ? ` · ${run.samples.length}/${run.requestCount}` : (run.samples.length ? ` · ${run.samples.length} 条` : '');
  $('vbTicksCap').textContent = `最近 ${S.length} 次请求${prog}${fails ? `，失败 ${fails}` : ''}`;
}

/* ---------- 单 run 图表 ---------- */
// 少于这么多条样本时，波形图只会画出误导性的直线/三角形，不如明说
const MIN_WAVE = 2;
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
    renderErrors(raw);
    return;
  }
  // 延迟三图只画成功样本：失败请求的 e2e（超时/错误耗时）会把 Y 轴和分位带全部带偏
  const S = raw.filter((s) => s.ok);
  const idx = S.map((_, i) => i);
  const e2e = S.map((s) => s.e2e_ms), ttft = S.map((s) => s.ttft_ms), tpot = S.map((s) => s.tpot_ms);
  const hasTTFT = ttft.some((v) => v != null && isFinite(v) && v > 0);
  const hasTPOT = tpot.some((v) => v != null && isFinite(v) && v > 0);
  const hasE2E = e2e.some((v) => v != null && isFinite(v) && v > 0);
  const slo = Object.assign({ ttft_ms: 1500, tpot_ms: 50, e2e_ms: 5000 }, run.slo || {});
  const ln = (name, data, color, w = 1.5, extra = {}) => ({ name, type: 'line', showSymbol: false, smooth: 0.25, data, lineStyle: { color, width: w, cap: 'round', join: 'round' }, itemStyle: { color }, ...extra });

  // 窗口按样本量自适应：固定 50 在只有 30 条的运行里会让首几个离群值一直留在分位里
  const pctWin = Math.max(10, Math.min(50, Math.floor(S.length / 3)));
  const P50 = rollingPercentile(e2e, pctWin, 50, Math.min(10, pctWin));
  const P95 = rollingPercentile(e2e, pctWin, 95, Math.min(10, pctWin));
  const band = P95.map((v, i) => (v != null && P50[i] != null ? +(v - P50[i]).toFixed(1) : 0));
  const seqCat = S.map((s) => String(s.seq));
  const dense = S.length > 120;   // 样本多时原始点变噪声，自动退到图例里
  if (!hasE2E) {
    UI.noData($('ch-e2e'), '无成功样本 · 延迟不可测');
  } else {
  charts.e2e.setOption(UI.base({
    ...UI.anim(S.length),
    tooltip: UI.tooltip('ms'),
    legend: { right: 8, top: 0, itemWidth: 14, itemHeight: 3, textStyle: { color: C.tx2, fontSize: 11 }, selected: dense ? { raw: false } : {}, data: run.mode === 'open' ? ['raw', 'P50', 'P95', 'corrected'] : ['raw', 'P50', 'P95'] },
    // 刻度密度与其余时序图统一（原来用 interval:'auto'，100 个样本会排出 11 个刻度，
    // 末尾标签还被容器裁掉一半）
    xAxis: { type: 'category', boundaryGap: false, data: seqCat, name: 'seq', nameTextStyle: { color: C.tx3, fontSize: 10 }, axisLabel: { ...AXIS, hideOverlap: true, interval: Math.max(0, Math.ceil(S.length / 6) - 1) }, axisLine: { lineStyle: { color: C.line2 } }, splitLine: { show: false } },
    yAxis: { type: 'value', scale: true, splitNumber: 4, nameTextStyle: { color: C.tx3, fontSize: 11 }, axisLabel: UI.axisLabelFor(e2e, 'ms'), name: (UI.axisLabelFor(e2e, 'ms').name || 'ms'), ...robustRange(e2e), axisLine: { show: false }, splitLine: GRAT, minorSplitLine: MINOR, minorTick: { show: true, splitNumber: 5 }, axisTick: { show: true, length: 3, lineStyle: { color: C.line2 } } },
    series: [
      // 分位带：整段 polygon（P95 上沿 + P50 下沿），避免逐点半透明矩形叠出栅栏条纹
      ...(S.length >= MIN_BAND ? [{
        name: '_band', type: 'custom', silent: true, z: 1,
        data: P50.map((v, i) => [i, v, P95[i]]),
        renderItem: (params, api) => {
          const kids = [];
          let top = [], bot = [];
          const flush = () => {
            if (top.length >= 2) {
              kids.push({
                type: 'polygon',
                shape: { points: top.concat(bot.slice().reverse()) },
                style: { fill: UI.grad(C.tr3, .05, 0), stroke: C.tr3, lineWidth: 0.5, strokeOpacity: .18 },
              });
            }
            top = []; bot = [];
          };
          for (let i = 0; i < P50.length; i++) {
            const lo = P50[i], hi = P95[i];
            if (lo == null || hi == null || !isFinite(lo) || !isFinite(hi)) { flush(); continue; }
            top.push(api.coord([i, hi]));
            bot.push(api.coord([i, lo]));
          }
          flush();
          if (!kids.length) return;
          return { type: 'group', children: kids };
        },
      }] : []),
      // opacity 压到 .15：100 个点在 700px 宽度上会连成点阵纹理，比 P50/P95 本身还抢眼
      // 有分位带时 raw 退到背景层：100 个点会连成点阵纹理，和带子糊成一块实心区域，
      // 反过来抢掉 P50/P95 的注意力。size 2 + opacity .10 只留一个"这里有样本"的暗示。
      { name: 'raw', type: 'scatter', symbolSize: 2, data: e2e, itemStyle: { color: '#8a8a8a', opacity: S.length >= MIN_BAND ? .10 : (dense ? .12 : .22) }, z: 2 },
      ln('P50', P50, C.tr1, 2, { z: 5 }),
      ln('P95', P95, C.tr3, 1.8, { lineStyle: { color: C.tr3, width: 1.8, type: 'dashed' }, z: 5 }),
      ...(run.mode === 'open'
        ? [ln('corrected', S.map((s) => s.corrected_e2e_ms), C.tr2, 1.2, { lineStyle: { color: C.tr2, width: 1.2, type: 'dashed' }, z: 2 })]
        : []),
    ],
  }), true);
  }

  const sloLine = (v, color) => ({ silent: true, symbol: 'none', lineStyle: { color, type: 'dashed', width: 1 }, label: { formatter: 'SLO', color, fontSize: 9 }, data: [{ yAxis: v }] });
  if (!hasTTFT) {
    UI.noData($('ch-ttft'), '无 TTFT 样本 · 全部失败或非流式');
  } else {
  charts.ttft.setOption(UI.base({
    ...UI.anim(S.length),
    tooltip: UI.tooltip('ms'),
    xAxis: { type: 'category', boundaryGap: false, data: seqCat, axisLabel: { ...AXIS, hideOverlap: true, interval: Math.max(0, Math.ceil(S.length / 6) - 1) }, axisLine: { lineStyle: { color: C.line2 } }, splitLine: { show: false }, axisTick: { show: true, length: 3, lineStyle: { color: C.line2 } } },
    yAxis: { type: 'value', scale: true, splitNumber: 4, nameTextStyle: { color: C.tx3, fontSize: 11 }, axisLabel: UI.axisLabelFor(ttft, 'ms'), name: (UI.axisLabelFor(ttft, 'ms').name || 'ms'), ...robustRange(ttft), axisLine: { show: false }, splitLine: GRAT, minorSplitLine: MINOR, minorTick: { show: true, splitNumber: 5 }, axisTick: { show: true, length: 3, lineStyle: { color: C.line2 } } },
    series: [ln('TTFT', ttft, C.tr3, 1.4, { areaStyle: { color: UI.grad(C.tr3, .06, 0) }, markLine: sloLine(slo.ttft_ms, C.yellow) })],
  }), true);
  }

  if (!hasTPOT) {
    UI.noData($('ch-tpot'), '无 TPOT 样本 · 全部失败或非流式');
  } else {
  charts.tpot.setOption(UI.base({
    ...UI.anim(S.length),
    tooltip: UI.tooltip('ms'),
    xAxis: { type: 'category', boundaryGap: false, data: seqCat, axisLabel: { ...AXIS, hideOverlap: true, interval: Math.max(0, Math.ceil(S.length / 6) - 1) }, axisLine: { lineStyle: { color: C.line2 } }, splitLine: { show: false }, axisTick: { show: true, length: 3, lineStyle: { color: C.line2 } } },
    yAxis: { type: 'value', scale: true, splitNumber: 4, nameTextStyle: { color: C.tx3, fontSize: 11 }, axisLabel: UI.axisLabelFor(tpot, 'ms'), name: (UI.axisLabelFor(tpot, 'ms').name || 'ms'), ...robustRange(tpot), axisLine: { show: false }, splitLine: GRAT, minorSplitLine: MINOR, minorTick: { show: true, splitNumber: 5 }, axisTick: { show: true, length: 3, lineStyle: { color: C.line2 } } },
    series: [ln('TPOT', tpot, C.tr4, 1.4, { areaStyle: { color: UI.grad(C.tr4, .08, 0) }, markLine: sloLine(slo.tpot_ms, C.yellow) })],
  }), true);
  }

  // 窗口下限 5s：短窗 + seq 等距 x 会把完成时刻抖动画成梳齿
  if (!S.length) {
    UI.noData($('ch-tput'), '无成功样本 · 吞吐不可测');
    UI.noData($('ch-heat'), '无成功样本 · 延迟不可测');
    UI.noData($('ch-dist'), '无成功样本 · 分布不可测');
  } else {
    const winMs = Math.max(5000, pickBucketMs(S));
    const [rpsArr, tokArr] = windowedRate(S, winMs);
    charts.tput.setOption(UI.base({
    ...UI.anim(S.length),
      tooltip: UI.tooltip(),
      grid: { left: 54, right: 52, top: 26, bottom: 30 },
      legend: { right: 8, top: 0, itemWidth: 14, itemHeight: 3, textStyle: { color: C.tx2, fontSize: 10 } },
      xAxis: { type: 'category', boundaryGap: false, data: seqCat, axisLabel: { ...AXIS, hideOverlap: true, interval: Math.max(0, Math.ceil(S.length / 6) - 1) }, axisLine: { lineStyle: { color: C.line2 } }, splitLine: { show: false }, axisTick: { show: true, length: 3, lineStyle: { color: C.line2 } } },
      yAxis: [
        { type: 'value', scale: true, splitNumber: 4, name: 'req/s', nameLocation: 'middle', nameRotate: 90, nameGap: 36, nameTextStyle: { color: C.tx3, fontSize: 11 }, axisLabel: { ...UI.axisLabelFor(rpsArr), color: C.tx3, margin: 6 }, axisLine: { show: true, lineStyle: { color: C.line2 } }, splitLine: GRAT, minorSplitLine: MINOR, minorTick: { show: true, splitNumber: 5 } },
        { type: 'value', scale: true, splitNumber: 4, name: 'tok/s', nameLocation: 'middle', nameRotate: 90, nameGap: 40, nameTextStyle: { color: C.tx3, fontSize: 11 }, axisLabel: { ...UI.axisLabelFor(tokArr), color: C.tx3, margin: 6 }, axisLine: { show: false }, splitLine: { show: false } },
      ],
      series: [
        ln('req/s', rpsArr, C.tr1, 1.4, { smooth: 0.4, areaStyle: { color: UI.grad(C.tr1, .08, 0) } }),
        ln('tok/s', tokArr, C.tr3, 1.4, { smooth: 0.4, yAxisIndex: 1 }),
      ],
    }), true);
    const tn = $('tputNote');
    if (tn) tn.textContent = `按 ${winMs >= 60000 ? (winMs / 60000) + ' 分钟' : (winMs / 1000) + ' 秒'}滑动窗口计算`;
    renderHeat(S); renderDist(S);
  }
  // 错误图必须吃全量样本（含失败），否则全失败时会显示 No errors
  renderErrors(raw);
}

function latBucket(v) { const b = [50, 100, 200, 400, 800, 1600, 3200, 6400, 12800]; for (let i = 0; i < b.length; i++) if (v < b[i]) return i; return b.length; }

function renderErrors(S) {
  const classes = [...new Set(S.filter((s) => !s.ok).map((s) => s.error_class || 'unknown'))];
  const bk = pickBucketMs(S);
  const fmtB = bucketLabel(bk);
  if (!classes.length) { UI.noData($('ch-err'), 'No errors'); return; }
  const buckets = bucketize(S, bk, (a) => a);
  charts.err.setOption(UI.base({
    ...UI.anim(S.length),
    tooltip: { ...UI.tooltip(), trigger: 'axis' },
    legend: { right: 8, top: 0, itemWidth: 14, itemHeight: 3, textStyle: { color: C.tx2, fontSize: 10 } },
    xAxis: { type: 'category', boundaryGap: false, data: buckets.map(([b]) => fmtB(b / 1000)), axisLabel: { ...AXIS, hideOverlap: true, interval: Math.max(0, Math.ceil(buckets.length / 6) - 1) }, axisLine: { lineStyle: { color: C.line2 } }, splitLine: { show: false } },
    yAxis: { type: 'value', name: '错误数', nameTextStyle: { color: C.tx3, fontSize: 11 }, axisLabel: AXIS, axisLine: { show: false }, splitLine: GRAT, minorSplitLine: MINOR, axisTick: { show: true, length: 3, lineStyle: { color: C.line2 } } },
    series: classes.map((cls, i) => ({ name: cls, type: 'bar', stack: 'e', barMaxWidth: 18, data: buckets.map(([, a]) => a.filter((s) => !s.ok && (s.error_class || 'unknown') === cls).length), itemStyle: { color: UI.hexA(C.bad, .55), borderRadius: [3, 3, 0, 0] }, emphasis: { itemStyle: { color: UI.hexA(C.bad, .85) } } })),
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
    ...UI.anim(S.length),
    tooltip: { ...UI.tooltip(), trigger: 'item', position: 'top' }, grid: { left: 66, right: 14, top: 8, bottom: 26 },
    xAxis: { type: 'category', data: buckets.map(([b]) => f(b / 1000)), axisLabel: { ...AXIS, hideOverlap: true, interval: Math.max(0, Math.ceil(buckets.length / 8) - 1) }, axisLine: { lineStyle: { color: C.line2 } }, splitLine: { show: false } },
    yAxis: { type: 'category', name: '延迟', nameTextStyle: { color: C.tx3, fontSize: 11 }, data: ys.map((y) => yLabels[y]), axisLabel: AXIS, axisLine: { show: false }, splitLine: { show: false } },
    visualMap: {
      show: false, min: 0, max,
      inRange: { color: ['rgba(30,35,45,.55)', 'rgba(90,70,20,.7)', 'rgba(180,120,30,.85)', '#f0b429'] },
    },
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
  // CDF 必须按分箱对齐到 category 轴的索引上。
  // 之前给的是 [原始毫秒, 百分比]（如 [1924.094…, 1]），而 xAxis 是
  // category(['1924','2202',…]) —— ECharts 按字符串严格匹配，'1924' 不等于
  // '1924.094…'，于是 100 个点全部落空，曲线从来没画出来过。
  const cdfTop = new Array(nb).fill(null);
  sorted.forEach((v, i) => {
    const bi = Math.min(nb - 1, Math.max(0, Math.floor((v - min) / step)));
    const pct = ((i + 1) / sorted.length) * 100;
    if (cdfTop[bi] === null) cdfTop[bi] = pct;
  });
  // 空箱沿用前一个值，保证 CDF 单调不回落
  const cdfData = [];
  let carry = 0;
  for (let i = 0; i < nb; i++) {
    if (cdfTop[i] !== null) carry = cdfTop[i];
    cdfData.push([i, +carry.toFixed(2)]);
  }
  charts.dist.setOption(UI.base({
    ...UI.anim(S.length),
    tooltip: { ...UI.tooltip(), trigger: 'axis' },
    grid: { left: 52, right: 50, top: 26, bottom: 30 },
    legend: { right: 8, top: 0, itemWidth: 14, itemHeight: 3, textStyle: { color: C.tx2, fontSize: 10 } },
    xAxis: { type: 'category', data: hist.map((_, i) => (min + i * step).toFixed((max - min) < 10 ? 1 : 0)), axisLabel: { ...AXIS, rotate: 0, hideOverlap: true, interval: Math.max(0, Math.ceil(nb / 4) - 1) }, axisLine: { lineStyle: { color: C.line2 } } },
    yAxis: [{ type: 'value', name: '频次', nameLocation: 'middle', nameRotate: 90, nameGap: 34, nameTextStyle: { color: C.tr4, fontSize: 11 }, axisLabel: { ...AXIS, color: C.tr4, margin: 6 }, axisLine: { show: true, lineStyle: { color: C.tr4, opacity: .35 } }, splitLine: GRAT, minorSplitLine: MINOR, minorTick: { show: true, splitNumber: 5 }, axisTick: { show: true, length: 3, lineStyle: { color: C.line2 } } },
      { type: 'value', name: 'CDF %', max: 100, nameLocation: 'middle', nameRotate: 90, nameGap: 38, nameTextStyle: { color: C.tr3, fontSize: 11 }, axisLabel: { ...AXIS, color: C.tr3, margin: 6 }, axisLine: { show: true, lineStyle: { color: C.tr3, opacity: .35 } }, splitLine: { show: false } }],
    series: [
      { name: '直方图', type: 'bar', data: hist, itemStyle: { color: UI.grad(C.tr4, .85, .3), borderRadius: [4, 4, 0, 0] } },
      { name: 'CDF', type: 'line', yAxisIndex: 1, showSymbol: false, step: 'end', data: cdfData, z: 5, lineStyle: { color: C.tr3, width: 2 } },
    ],
  }), true);
}

function renderCompareChart() {
  // 只对比最近 5 条：线上轨迹太多会糊成一片，图例也放不下
  // 只画成功样本：失败请求的超时耗时会把 Y 轴拉到几十秒，轨迹变成一条假高位线
  const all = [...state.runs.values()].filter((r) => visSamples(r).some((s) => s.ok))
    .sort((a, b) => (a.samples[0]?.ts || 0) - (b.samples[0]?.ts || 0));
  const runs = all.slice(-5);
  $('cmpLegend').textContent = runs.length ? `最近 ${runs.length} 条${all.length > runs.length ? ` / 共 ${all.length}` : ''}` : '';
  if (!runs.length) { UI.noData($('ch-cmp'), '无成功样本 · 暂无可对比轨迹'); return; }
  const series = runs.map((r) => {
    const S = visSamples(r).filter((s) => s.ok);
    if (!S.length) return null;
    const t0 = S[0].ts, step = Math.max(1, Math.floor(S.length / 800)), pts = [];
    for (let i = 0; i < S.length; i += step) { if (S[i].e2e_ms != null) pts.push([+(S[i].ts - t0).toFixed(1), S[i].e2e_ms]); }
    // 名字必须唯一：多条同名 run 会被 ECharts 图例合并，看起来像是丢数据
    const stamp = new Date((r.samples[0].ts || 0) * 1000).toTimeString().slice(0, 5);
    return { name: `${r.target} (${r.model}) ${stamp}`, type: 'line', showSymbol: false,
             data: pts, lineStyle: { color: r.color, width: 1.4 } };
  }).filter(Boolean);
  if (!series.length) { UI.noData($('ch-cmp'), '无成功样本 · 暂无可对比轨迹'); return; }
  charts.cmp.setOption(UI.base({
    ...UI.anim(series.reduce((n, s) => n + s.data.length, 0)),
    tooltip: UI.tooltip('ms'),
    // 图例放底部：多条轨迹时顶部会盖住波形
    legend: { bottom: 0, left: 'center', itemWidth: 14, itemHeight: 3,
              textStyle: { color: C.tx2, fontSize: 10 }, data: series.map((x) => x.name) },
    grid: { left: 60, right: 20, top: 22, bottom: 46 },
    xAxis: { type: 'value', name: '相对时间(s)', nameTextStyle: { color: C.tx3, fontSize: 10 }, axisLabel: AXIS, axisLine: { lineStyle: { color: C.line2 } }, splitLine: GRAT, minorSplitLine: MINOR, minorTick: { show: true, splitNumber: 5 }, axisTick: { show: true, length: 3, lineStyle: { color: C.line2 } } },
    yAxis: { type: 'value', scale: true, splitNumber: 4, nameLocation: 'middle', nameRotate: 90, nameGap: 44, nameTextStyle: { color: C.tx3, fontSize: 11 }, axisLabel: UI.axisLabelFor(series.flatMap((s) => s.data.map((p) => p[1])), 'ms'), name: (UI.axisLabelFor(series.flatMap((s) => s.data.map((p) => p[1])), 'ms').name || 'E2E'), axisLine: { show: false }, splitLine: GRAT, minorSplitLine: MINOR, minorTick: { show: true, splitNumber: 5 }, axisTick: { show: true, length: 3, lineStyle: { color: C.line2 } } },
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
      <td class="num">${s.ok != null ? s.ok : '–'}${s.success_rate != null ? ` <span class="mono" style="color:var(--tx-3)">${pct(s.success_rate)}</span>` : ''}</td>
      <td class="num">${s.e2e ? fmtTime(s.e2e.p95) : '–'}</td>
      <td class="num">${s.ttft ? fmtTime(s.ttft.mean) : '–'}</td>
      <td class="num">${s.tpot ? fmtTime(s.tpot.mean) : '–'}</td>
      <td class="num">${s.tokens ? fmt(s.tokens.output_throughput, 1) : '–'}</td>
      <td class="act"><button class="mini" data-act="sel" data-id="${r.id}">主视图</button>
        <button class="mini ghost" data-act="detail" data-id="${r.id}">详情</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="10" class="hint">暂无记录</td></tr>';
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
    ['E2EL mean', (r) => r.summary.e2e.mean, 'low', (v) => fmtTime(v)],
    ['E2EL P95', (r) => r.summary.e2e.p95, 'low', (v) => fmtTime(v)],
    ['TTFT mean', (r) => r.summary.ttft.mean, 'low', (v) => fmtTime(v)],
    ['TPOT mean', (r) => r.summary.tpot.mean, 'low', (v) => fmtTime(v)],
    ['Output tok/s', (r) => r.summary.tokens.output_throughput, 'high', (v) => fmt(v, 1)],
     ['Cache hit', (r) => (r.summary.cache && r.summary.cache.reported !== false ? r.summary.cache.hit_rate : null), 'high', pct],
    ['Errors', (r) => r.summary.failed, 'low', (v) => v],
  ];
  const head = $('cmpTable').querySelector('thead'), body = $('cmpTable').querySelector('tbody');
  if (!runs.length) { head.innerHTML = ''; body.innerHTML = '<tr><td class="hint">暂无记录</td></tr>'; return; }
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
function syncRunControls() {
  const start = $('btnStart');
  const pause = $('btnPause');
  const stop = $('btnStop');
  const actions = $('side-actions-perf');
  if (!start || !pause || !stop) return;
  const run = state.primary ? state.runs.get(state.primary) : null;
  const status = run?.status || 'idle';
  const active = status === 'running' || status === 'paused';
  const batchActive = state.activeIds.length > 0;
  const stopping = status === 'stopping';
  const finished = ['done', 'error', 'stopped'].includes(status);
  start.disabled = active || stopping || batchActive || start.dataset.busy === '1';
  pause.disabled = !batchActive;
  stop.disabled = !batchActive || stopping;
  if (start.dataset.busy !== '1') {
    start.textContent = stopping ? '正在停止…' : status === 'paused' ? '继续测试' : status === 'running' ? '测试进行中' : finished ? '重新测试' : '开始测试';
    start.classList.toggle('is-resume', status === 'paused');
    start.setAttribute('aria-label', start.textContent);
  }
  pause.textContent = status === 'paused' ? '继续' : '暂停';
  stop.textContent = '停止测试';
  actions?.setAttribute('data-state', status);
}

function refreshTopbar() {
  const runs = [...state.runs.values()];
  $('runCount').textContent = runs.length;
  syncRailStats();
  $('reqCount').textContent = runs.reduce((a, r) => a + (r.summary?.total ?? r.samples.length), 0);
  $('errCount').textContent = runs.reduce((a, r) => a + (r.summary?.failed ?? r.samples.filter((s) => !s.ok).length), 0);
  $('rec').hidden = !runs.some((r) => r.status === 'running');
  const has = state.historyLoaded && runs.length > 0;
  const loading = !state.historyLoaded;
  $('emptyPerf').hidden = loading || has;
  $('perfDash').hidden = !has;
  document.body.classList.toggle('has-data', has);
  syncRunControls();
  const reportBtn = $('btnVerifyReport');
  if (reportBtn) reportBtn.disabled = !(state.primary && state.runs.get(state.primary)?.summary);
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
  $('reqHint').textContent = all.length
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
    body.innerHTML = `<tr><td colspan="9" class="hint">${all.length ? '没有符合条件的请求' : '暂无记录'}</td></tr>`;
    return;
  }
  const style = (r) => (r.ok ? '' : 'style="color:var(--bad)"');
  body.innerHTML = rows.map((r) => `<tr>
    <td class="num">${r.seq}</td>
    <td class="num" ${style(r)}>${r.status_code ?? '–'}</td>
    <td>${r.ok ? '' : `<span class="badge no">${esc(r.error_class || 'error')}</span>`}</td>
    <td class="num">${r.ttft_ms != null ? fmtTime(r.ttft_ms) : '–'}</td>
    <td class="num">${r.e2e_ms != null ? fmtTime(r.e2e_ms) : '–'}</td>
    <td class="num">${r.tpot_ms != null ? fmtTime(r.tpot_ms) : '–'}</td>
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
         ${row('成功 / 尝试 RPS', `${fmt(s.rps, 2)} / ${fmt(s.attempted_rps, 2)} req/s`)}
        ${row('E2EL mean/P95/P99', s.e2e ? `${fmtTime(s.e2e.mean)} / ${fmtTime(s.e2e.p95)} / ${fmtTime(s.e2e.p99)}` : '-')}
        ${row('TTFT mean/P95', s.ttft ? `${fmtTime(s.ttft.mean)} / ${fmtTime(s.ttft.p95)}` : '-')}
        ${row('TPOT / ITL P99', s.tpot ? `${fmtTime(s.tpot.mean)} / ${fmtTime(s.itl.p99)}` : 'n/a')}
        ${row('Output tok/s', s.tokens && s.tokens.output_throughput != null ? `${fmt(s.tokens.output_throughput, 1)} tok/s（墙钟） / ${fmt(s.tokens.output_throughput_per_user, 1)} tok/s（解码）` : 'n/a')}
        ${row('Tokens in/out', s.tokens ? `${s.tokens.in} / ${s.tokens.out}` : '-')}
         ${row('Cache hit', s.cache ? (s.cache.reported === false ? '未上报' : `${pct(s.cache.hit_rate)}（token ${fmt(s.cache.cached_tokens)}/${fmt(s.tokens.in)}，请求命中 ${s.cache.requests_hit}/${s.cache.requests_hit + s.cache.requests_miss}${s.cache.ttft_speedup ? `，TTFT 加速 ${s.cache.ttft_speedup}×` : ''}）`) : '-')}
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
function connectSSE(run, resetAck = false, afterId = null) {
  const query = resetAck ? `?reset=1&after_id=${encodeURIComponent(afterId ?? 0)}` : '';
  const es = new EventSource(`/api/runs/${run.id}/stream${query}`);
  run.sse = es;
  es.onopen = () => {
    run.sseOpen = true;
    if (state.primary === run.id && run.status === 'running') {
      $('vbTicksCap').textContent = run.samples.length ? `最近 ${run.samples.length} 次请求` : '流已连接 · 等待样本…';
    }
  };
  es.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id != null) {
      if (run.lastEventId && msg.id <= run.lastEventId) return;
      run.lastEventId = msg.id;
    }
    if (msg.type === 'reset') {
      es.close();
      run.sse = null;
      run.sseOpen = false;
       run.samples = [];
       run.sampleSeqs = new Set();
       run.lastEventId = 0;
      const recoverSnapshot = (attempt = 0) => {
        fetchJSON(`/api/runs/${run.id}/samples?max_points=4000`).then((d) => {
          run.samples = d.samples || [];
          run.sampleSeqs = new Set(run.samples.map((s) => s.seq));
          run.lastEventId = d.event_seq || 0;
          if (state.primary === run.id) renderSingle(run);
          connectSSE(run, true, run.lastEventId);
        }).catch(() => {
          const delay = Math.min(10000, 500 * (2 ** Math.min(attempt, 4)));
          setTimeout(() => recoverSnapshot(attempt + 1), delay);
        });
      };
      recoverSnapshot();
      return;
    }
     if (msg.type === 'sample') {
       if (!run.sampleSeqs) run.sampleSeqs = new Set();
       if (run.sampleSeqs.has(msg.data.seq)) return;
       run.sampleSeqs.add(msg.data.seq);
       run.samples.push(msg.data);
      if (run.samples.length > 4000) run.samples.shift();
      if (!msg.data.ok) log('warn', `[${run.target}] #${msg.data.seq} 失败 ${msg.data.error_class || ''} ${msg.data.status_code || ''}`);
      clearWaiting();
      if (state.primary === run.id) renderTicks(run);
      refreshTopbar();
    } else if (msg.type === 'summary') {
      run.summary = msg.data;
      if (state.primary === run.id) renderCards(run.summary);
      refreshTopbar();
      if (!msg.live) { renderRuns(); renderCompareTable(); }
    } else if (msg.type === 'phase') {
      if (msg.phase === 'warmup') {
        $('vbTicksCap').textContent = `预热中 ${msg.done}/${msg.total}（预热不计入统计）`;
      } else if (msg.phase === 'steady' && state.primary === run.id) {
        $('vbTicksCap').textContent = run.samples.length ? `最近 ${run.samples.length} 次请求` : '预热完成 · 等待样本…';
      }
    } else if (msg.type === 'status') {
      run.status = msg.status; renderRuns();
       if (msg.status === 'done' || msg.status === 'error' || msg.status === 'stopped') {
         state.activeIds = state.activeIds.filter((rid) => rid !== run.id);
         clearWaiting();
        const stopped = msg.status === 'stopped';
        log(msg.status === 'done' ? 'ok' : stopped ? 'warn' : 'err', `[${run.target}] 运行结束：${msg.status}`);
        UI.toast(`${run.target} 运行${msg.status === 'done' ? '完成' : stopped ? '已停止' : '出错'}`, msg.status === 'done' ? 'ok' : stopped ? 'info' : 'err');
        es.close();
        fetchJSON(`/api/runs/${run.id}`).then((d) => { run.summary = d.summary; if (state.primary === run.id) renderCards(d.summary); renderRuns(); renderCompareTable(); renderSingle(run); notify(run); });
      }
    } else if (msg.type === 'error') {
      UI.toast(`运行出错：${msg.message || '未知错误'}`, 'err');
      if (state.primary === run.id) $('vbTicksCap').textContent = '连接异常';
    }
  };
  es.onerror = () => {
    if (run.status === 'done' || run.status === 'error' || run.status === 'stopped') { es.close(); return; }
    run.sseOpen = false;
    if (state.primary === run.id) $('vbTicksCap').textContent = '连接中断，重连中…';
  };
}

/* ---------- 渲染循环 ---------- */
function renderAll(force = false) {
  if (location.hash === '#bench') return;
  const run = state.primary ? state.runs.get(state.primary) : null;
  const runs = [...state.runs.values()];
  const sampleCount = runs.reduce((n, r) => n + r.samples.length, 0);
  const statusKey = runs.map((r) => r.status).join(',');
  const signature = `${state.primary || ''}|${state.range}|${runs.length}|${sampleCount}|${statusKey}`;
  if (!force && signature === renderSignature) return;
  renderSignature = signature;
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
      ${t.base_url ? `<span class="chan-url" title="${esc(t.base_url)}">${esc(t.base_url.replace(/^https?:\/\//, ''))}</span>`
                   : `<button type="button" class="chan-warn" data-fillurl="${i}" title="点击补填 base_url">待填地址</button>`}
      ${t.api_key ? `<span class="chan-key">${esc(maskKey(t.api_key))}</span>`
                  : '<span class="chan-warn">缺少密钥</span>'}
    </div>`).join('') || '<div class="hint">还没识别到渠道。把供应商给的内容贴进上面的框，点「识别配置」。</div>';
}
// 渠道卡缺地址：就地补填，不必整段重贴
document.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-fillurl]');
  if (!b) return;
  const i = Number(b.dataset.fillurl);
  const cur = state.targets[i];
  if (!cur) return;
  const url = prompt('补填 base_url（完整接口地址，如 https://api.example.com/v1）', cur.base_url || 'https://');
  if (url == null) return;
  const u = url.trim();
  if (!u) return;
  state.targets[i] = { ...cur, base_url: u };
  renderTargets();
  UI.toast('已更新 base_url', 'ok');
});
async function doParse() {
  const text = $('paste').value.trim();
  if (!text) { UI.toast('先粘贴供应商配置（地址 / 密钥 / 模型）', 'warn'); $('paste').focus(); return; }
  const btn = $('btnParse');
  UI.setBusy(btn, true, '识别中…');
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
  finally { UI.setBusy(btn, false); }
}
async function doStart() {
  const current = state.primary ? state.runs.get(state.primary) : null;
  if (current?.status === 'paused') { await control('resume'); return; }
  if (state.activeIds.length) { UI.toast('已有测试仍在运行，请先停止当前批次', 'warn'); return; }
  if (!state.targets.length) { await doParse(); if (!state.targets.length) { UI.toast('请先粘贴配置并点「识别配置」', 'warn'); return; } }
  const ready = state.targets.filter((t) => t.base_url);
  if (!ready.length) { UI.toast('还没有可用地址，请补上 base_url 后再测', 'warn'); setSidebar(true); return; }
  const missing = state.targets.length - ready.length;
  if (missing) UI.toast(`${missing} 个渠道缺地址，本次跳过`, 'warn');
  const btn = $('btnStart');
  UI.setBusy(btn, true, '启动中…');
  try {
    const cfg = buildConfig();
    const d = await fetchJSON('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
    log('ok', `启动 ${d.count} 个运行 · mode=${cfg.mode}`);
    UI.toast(`已启动 ${d.count} 个运行`, 'ok');
    d.run_ids.forEach((rid, i) => {
      const t = ready[i];
      const run = { id: rid, target: t.name, model: t.model, provider: t.provider, status: 'running', samples: [], sampleSeqs: new Set(), summary: null, slo: cfg.slo, mode: cfg.mode, requestCount: cfg.mode === 'open' ? null : cfg.request_count, randomize: cfg.randomize, cacheMode: cfg.cache_mode, promptMode: cfg.traffic && cfg.traffic.prompt_mode, color: C.series[state.colorIdx++ % C.series.length], sse: null, sseOpen: false, lastEventId: 0 };
       state.runs.set(rid, run);
       state.activeIds.push(rid);
       if (i === 0) state.primary = rid;
       connectSSE(run);
    });
    renderRuns(); renderCompareTable(); refreshTopbar();
    const first = state.runs.get(state.primary);
    if (first) renderRunning(first);
    // 收起前先把焦点挪出侧栏，再提示 ⌘B——否则键盘用户焦点跌回 body
    const wasOpen = !document.getElementById('app').classList.contains('side-collapsed');
    setSidebar(false);
    $('btnSidebar').focus({ preventScroll: true });
    if (wasOpen) UI.toast('已收起配置面板 · ⌘B 展开', 'info', 2500);
  } catch (e) { log('err', '启动失败: ' + e.message); UI.toast('启动失败: ' + e.message, 'err'); }
  finally { UI.setBusy(btn, false); }
}
async function control(act) {
  const ids = state.activeIds.length ? [...state.activeIds] : state.primary ? [state.primary] : [];
  if (!ids.length) { UI.toast('请先选择一个运行', 'warn'); return; }
  try {
    await Promise.all(ids.map((rid) => fetchJSON(`/api/runs/${rid}/${act}`, { method: 'POST' })));
    ids.forEach((rid) => {
      const run = state.runs.get(rid);
      if (run) run.status = act === 'pause' ? 'paused' : act === 'resume' ? 'running' : act === 'stop' ? 'stopping' : run.status;
    });
    log('info', `已发送 ${act} · ${ids.length} 个运行`);
    UI.toast(act === 'stop' ? `已发送停止 · ${ids.length} 个运行` : act === 'pause' ? `已发送暂停 · ${ids.length} 个运行` : `已发送继续 · ${ids.length} 个运行`, 'info', 2000);
    renderRuns();
  } catch (e) { log('err', e.message); UI.toast('操作失败: ' + e.message, 'err'); }
}
function buildConfig() {
  const n = (id) => Number($(id).value);
  return {
    name: `bench-${nowTime()}`, targets: state.targets.filter((t) => t.base_url),
    mode: $('mode').value, concurrency: n('concurrency'), request_count: n('request_count'),
     rate: n('rate'), duration_s: n('duration_s'), warmup: $('cache_mode').checked ? Math.max(1, n('warmup')) : n('warmup'), timeout_s: n('timeout_s'),
     retries: n('retries'), stream: $('stream').checked, connection_reuse: $('connection_reuse').checked,
     verify_tls: $('verify_tls').checked, cache_mode: $('cache_mode').checked,
     randomize: !$('cache_mode').checked && $('randomize').checked, jitter: n('jitter'),
     proxy: $('proxy').value.trim() || null, ramp_rate: n('ramp_rate'),
     ramp_s: n('ramp_s'), cooldown_s: n('cooldown_s'),
     price_in: n('price_in'), price_out: n('price_out'), price_cache_in: n('price_cache_in'), price_cache_write: n('price_cache_write'),
     slo: { ttft_ms: n('slo_ttft'), tpot_ms: n('slo_tpot'), e2e_ms: n('slo_e2e') },
     traffic: {
       prompt_mode: $('prompt_mode').value,
       prompt: $('prompt').value,
       system_prompt: $('system_prompt').value,
       input_dist: $('input_dist').value,
       input_tokens: n('input_tokens'),
       top_p: $('top_p').value === '' ? null : n('top_p'),
       max_tokens: n('max_tokens'),
       temperature: n('temperature'),
     },
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
      <td class="num">${r.status_code || '–'}</td><td class="num">${fmtTime(r.ttft_ms)}</td><td class="num">${fmtTime(r.e2e_ms)}</td>
      <td class="num">${fmtTime(r.tpot_ms)}</td>
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
      const d = await fetchJSON('/api/targets/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targets: [t] }) });
      const models = (d.models && d.models[t.name]) || [];
      const q = (t.model || '').trim();
      const emptyHint = !t.api_key
        ? '无模型（网络/上游异常；可不填 key 重试，OpenRouter 列表无需鉴权）'
        : '无（可能不支持 /v1/models，或密钥无权限）';
      const hits = q ? models.filter((m) => m.toLowerCase().includes(q.toLowerCase())) : [];
      const hitLine = q
        ? (hits.length
            ? ` · 当前 <code>${esc(q)}</code> 命中 ${hits.length}${hits.length === 1 && hits[0].toLowerCase() === q.toLowerCase() ? ' ✓' : ''}`
            : ` · 当前 <code>${esc(q)}</code> 不在列表（仍可直接请求，列表可能滞后）`)
        : '';
      out.push(`<div class="ml-ch" data-ch="${esc(t.name)}" data-key="${t.api_key ? '1' : '0'}">
        <h4 style="color:var(--tx-1);font-size:12px;font-weight:600;margin:10px 0 4px">${esc(t.name)} · ${models.length} 个模型${hitLine}</h4>
        <input type="search" class="ml-filter" placeholder="过滤模型 id…（如 bunny / stealth）" data-mlf="${esc(t.name)}" spellcheck="false" />
        <div class="mono ml-list" data-mll="${esc(t.name)}">${models.map((m) => `<div class="ml-item${q && m.toLowerCase() === q.toLowerCase() ? ' hit' : ''}" data-mid="${esc(m)}">${esc(m)}</div>`).join('') || `<span class="hint">${emptyHint}</span>`}</div>
      </div>`);
    } catch (e) { out.push(`<div class="hint">${esc(t.name)}: ${esc(e.message)}</div>`); }
  }
  UI.openModal('模型列表', out.join(''));
  document.querySelectorAll('.ml-filter').forEach((inp) => {
    const box0 = document.querySelector(`.ml-list[data-mll="${CSS.escape(inp.dataset.mlf)}"]`);
    const hit = box0 && box0.querySelector('.ml-item.hit');
    if (hit) hit.scrollIntoView({ block: 'center' });
    inp.addEventListener('input', () => {
      const q = inp.value.trim().toLowerCase();
      const box = document.querySelector(`.ml-list[data-mll="${CSS.escape(inp.dataset.mlf)}"]`);
      if (!box) return;
      box.querySelectorAll('.ml-item').forEach((el) => {
        el.hidden = q ? !el.dataset.mid.toLowerCase().includes(q) : false;
      });
    });
  });
}

/* ---------- 渠道验真报告 ---------- */
function buildVerifyReport(run, cache, bench) {
  const s = run.summary || {};
  const cacheSummary = cache && cache.summary ? cache.summary : null;
  const benchSummary = bench && bench.summary ? bench.summary : null;
  const perfPassed = s.slo && s.slo.total ? s.slo.passed === s.slo.total : null;
  const perfText = perfPassed == null ? '样本不足，暂不判定' : perfPassed ? '性能 SLO 全部达标' : `性能 SLO 达标 ${s.slo.passed}/${s.slo.total}`;
  const cacheText = !cacheSummary ? '未执行缓存检测' : cacheSummary.verdict === 'valid' ? '缓存有效' : cacheSummary.verdict === 'suspect' ? '疑似假缓存' : cacheSummary.verdict === 'unreported' ? '未上报缓存字段' : '缓存检测失败';
  const benchText = !benchSummary ? '未执行降智检测' : benchSummary.verdict === 'normal' || benchSummary.verdict === 'baseline' ? '降智检测正常' : benchSummary.verdict === 'suspect' ? '发现疑似降智' : benchSummary.verdict === 'improved' ? '高于基线' : benchSummary.verdict;
  const lines = [
    '# Precision Bench 渠道验真报告',
    '',
    `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
    `- Run ID：${run.id}`,
    `- 渠道：${run.target || '-'}`,
    `- 模型：${run.model || '-'}`,
    `- 协议：${run.provider || '-'}`,
    '',
    '## 1. 性能',
    `- 样本：${s.total || 0}，成功 ${s.ok || 0}，失败 ${s.failed || 0}`,
    `- 成功率：${pct(s.success_rate)}；Goodput：${pct(s.goodput)}`,
    `- TTFT P95：${fmtTime(s.ttft && s.ttft.p95)}；E2EL P95：${fmtTime(s.e2e && s.e2e.p95)}`,
    `- TPOT：${s.tpot && s.tpot.mean != null ? fmtTime(s.tpot.mean) : 'n/a'}；成功/尝试 RPS：${fmt(s.rps, 2)} / ${fmt(s.attempted_rps, 2)}`,
    `- 判定：${perfText}`,
    '',
    '## 2. Prompt Cache',
    cacheSummary
      ? `- 判定：${cacheText}；命中轮 ${cacheSummary.hit_requests || 0}/${cacheSummary.ok_rounds || 0}；加速 ${fmt(cacheSummary.speedup_min ?? cacheSummary.speedup, 2)}×`
      : '- 判定：未执行缓存检测',
    '',
    '## 3. 降智检测',
    benchSummary
      ? `- 判定：${benchText}；完成 ${benchSummary.completed || 0}/${benchSummary.n_items || 0}；总分 ${benchSummary.total != null ? pct(benchSummary.total) : 'n/a'}`
      : '- 判定：未执行降智检测',
    '',
    '## 4. 综合结论',
    `- ${perfText}；${cacheText}；${benchText}。`,
    '- 复算依据：原始样本、SLO 参数、价格参数与检测轮次均保留在本机历史记录中。',
  ];
  return lines.join('\n');
}
async function openVerifyReport() {
  const run = state.primary ? state.runs.get(state.primary) : null;
  if (!run || !run.summary) { UI.toast('先完成一次性能测试，再生成验真报告', 'warn'); return; }
  const [cacheData, benchData] = await Promise.all([
    fetchJSON('/api/cache/checks?limit=20').catch(() => ({ checks: [] })),
    fetchJSON('/api/bench/runs').catch(() => ({ runs: [] })),
  ]);
  const cache = (cacheData.checks || []).find((c) => c.model === run.model) || null;
  const bench = (benchData.runs || []).find((b) => b.model === run.model) || null;
  state.reportMarkdown = buildVerifyReport(run, cache, bench);
  UI.openModal('渠道验真报告', `<pre class="report-markdown">${esc(state.reportMarkdown)}</pre><div class="btnrow" style="margin-top:12px"><button class="primary mini" data-report-copy>复制 Markdown</button><button class="ghost mini" data-report-download>下载报告</button></div>`);
}
function downloadVerifyReport() {
  if (!state.reportMarkdown) return;
  const blob = new Blob([state.reportMarkdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `llm-bench-verify-${state.primary || 'report'}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.addEventListener('click', async (e) => {
  const presetLoad = e.target.closest('button[data-preset-load]');
  const presetDelete = e.target.closest('button[data-preset-delete]');
  if (presetLoad) { loadPreset(presetLoad.dataset.presetLoad); return; }
  if (presetDelete) { deletePreset(presetDelete.dataset.presetDelete); return; }
  if (e.target.closest('#btnVerifyReport')) { await openVerifyReport(); return; }
  if (e.target.closest('[data-report-copy]')) {
    try { await navigator.clipboard.writeText(state.reportMarkdown); UI.toast('报告已复制', 'ok'); }
    catch (err) { UI.toast('复制失败: ' + err.message, 'err'); }
    return;
  }
  if (e.target.closest('[data-report-download]')) { downloadVerifyReport(); }
});

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
  const speedupMin = s.speedup_min ?? s.speedup;
  const missTtft = s.ttft_miss_min ?? s.ttft_miss_med ?? s.ttft_miss_mean;
  const hitTtft = s.ttft_hit_min ?? s.ttft_hit_med ?? s.ttft_hit_mean;
  const delta = (r.baseline && speedupMin != null && r.baseline.speedup != null)
    ? speedupMin - r.baseline.speedup : null;
  const deltaTxt = delta == null ? '' : `<span style="color:${delta >= 0 ? 'var(--ok)' : 'var(--bad)'}">${delta >= 0 ? '+' : ''}${delta.toFixed(2)}×</span>`;
  const kv = `<div class="kv">
    ${r.baseline ? `<div class="k">基线加速比</div><div class="v">${fmt(r.baseline.speedup, 2)}×　${deltaTxt}（相对本次）</div>` : ''}
     <div class="k">TTFT miss → hit</div><div class="v">${fmtTime(missTtft)} → ${fmtTime(hitTtft)}（min / 旧记录回退中位）</div>
     <div class="k">加速比</div><div class="v"><b>${fmt(speedupMin, 2)}×</b>（min 口径，判定用）· 中位 ${fmt(s.speedup, 2)}× · 阈值 ${fmt(s.speedup_threshold, 1)}×</div>
    <div class="k">命中请求</div><div class="v">${fmt(s.hit_requests)} / ${fmt(s.ok_rounds)} 成功轮</div>
    <div class="k">上报 cached</div><div class="v">${s.provider_reported ? '是' : '否（未返回缓存字段）'}</div>
  </div>
  ${(s.notes || []).length ? `<div class="hint" style="color:var(--tx-2)">${s.notes.map(esc).join('；')}</div>` : ''}`;
  const rows = (r.rounds || []).map((it, i) => `<tr>
    <td class="num">${it.seq}</td>
    <td><span class="badge ${it.ok ? 'ok' : 'no'}">${it.ok ? (i === 0 ? '写入' : (it.cached_tokens > 0 ? '命中' : '未命中')) : (it.error_class || 'FAIL')}</span></td>
    <td class="num">${fmtTime(it.ttft_ms)}</td>
    <td class="num">${fmtTime(it.e2e_ms)}</td>
    <td class="num">${fmt(it.cached_tokens)}</td>
    <td class="num">${fmt(it.cache_write_tokens)}</td>
    <td class="num">${fmt(it.in_tokens)}</td>
    <td class="trunc" title="${esc(it.error_msg || '')}" style="color:var(--bad)">${esc(it.error_msg || '')}</td></tr>`).join('');
  const table = `<div class="table-scroll"><table class="grid"><thead><tr>
    <th class="num">#</th><th>Result</th><th class="num">TTFT</th><th class="num">E2EL</th>
    <th class="num">Cached</th><th class="num">Write</th><th class="num">in tok</th><th>Error</th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;
  return `<div style="margin:0 0 6px">${cacheVerdictBadge(s.verdict)} <b>${esc(r.name)}</b> <span class="mono" style="color:var(--tx-2)">${esc(r.model)}</span></div>
    ${kv}${table}`;
}
async function renderCacheHist(offset = 0, append = false) {
  const box = $('cacheHist');
  if (!box) return;
  try {
    const d = await fetchJSON(`/api/cache/checks?limit=20&offset=${offset}`);
    const rows = (d.checks || []).map((c) => {
      const s = c.summary || {};
      return `<tr>
        <td class="mono">${dtstr(c.ts)}</td>
        <td>${esc(c.name)}</td><td class="mono">${esc(c.model)}</td>
         <td class="num">${fmt(s.speedup_min ?? s.speedup, 2)}×</td>
        <td>${cacheVerdictBadge(s.verdict)}${c.is_baseline ? ' <span class="mono" style="color:var(--acc-hi);font-size:10.5px">基线</span>' : ''}</td>
        <td class="act">
          <button class="mini ghost" data-cact="view" data-cid="${c.id}">查看</button>
          <button class="mini ghost" data-cact="base" data-cid="${c.id}">设基线</button>
          <button class="mini ghost" data-cact="del" data-cid="${c.id}">删</button>
        </td></tr>`;
    }).join('');
    if (append) {
      const tbody = box.querySelector('tbody');
      if (tbody) tbody.insertAdjacentHTML('beforeend', rows);
      const more = box.querySelector('[data-cache-more]');
      if (d.has_more && more) more.dataset.offset = d.next_offset;
      else if (more) more.remove();
      return;
    }
    box.innerHTML = `<h4 style="color:var(--tx-1);font-size:12px;font-weight:600;margin:14px 0 6px">检测历史</h4>
      <div class="table-scroll"><table class="grid"><thead><tr>
        <th>时间</th><th>渠道</th><th>模型</th><th class="num">加速比</th><th>判定</th><th class="act">操作</th>
        </tr></thead><tbody>${rows || '<tr><td colspan="6" class="hint">还没有检测记录。点「缓存检测」跑一次，就能看到这条渠道的缓存是否真实生效。</td></tr>'}</tbody></table></div>
      ${d.has_more ? `<button class="mini ghost" data-cache-more data-offset="${d.next_offset}">加载更多历史</button>` : ''}`;
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
    max_tokens: Math.max(Number($('max_tokens').value) || 1024, 1024),
    stream: $('stream').checked,
    timeout_s: Number($('timeout_s').value) || 60,
    proxy: $('proxy').value.trim() || null,
    verify_tls: $('verify_tls').checked,
    background: true,
  };
  const t0 = Date.now();
  UI.openModal('缓存检测', `<div class="hint" data-busy="1">正在提交 ${state.targets.length} 个渠道…</div>`);
  try {
    const started = await fetchJSON('/api/cache/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const jobId = started.job_id;
    if (!jobId) throw new Error('服务未返回缓存检测任务');
    UI.openModal('缓存检测', `<div class="hint" data-cache-job="${jobId}">正在检测 ${state.targets.length} 个渠道…（串行 ${body.rounds} 轮/渠道）</div><div style="margin-top:12px"><button class="ghost" data-cache-cancel="${jobId}">取消检测</button></div>`);
    const poll = async () => {
      try {
        const job = await fetchJSON(`/api/cache/check/${jobId}`);
        const el = $('modalBody');
        if (job.status === 'running' || job.status === 'cancelling') {
          if (el) el.innerHTML = `<div class="hint" data-cache-job="${jobId}">${job.status === 'cancelling' ? '正在取消…' : `正在检测… 已用 ${((Date.now() - t0) / 1000).toFixed(1)} 秒（串行 ${body.rounds} 轮/渠道）`}</div>${job.status === 'cancelling' ? '' : `<div style="margin-top:12px"><button class="ghost" data-cache-cancel="${jobId}">取消检测</button></div>`}`;
          setTimeout(poll, 800);
          return;
        }
        if (job.status === 'cancelled') {
          UI.openModal('缓存检测', '<div class="hint">检测已取消，未完成的轮次不会写入历史。</div>');
          UI.toast('缓存检测已取消', 'info');
          return;
        }
        if (job.status === 'error') throw new Error(job.error || '检测任务失败');
        const results = job.results || [];
        UI.openModal('缓存检测', results.map(cacheResultHtml).join('<div style="height:14px"></div>') + '<div id="cacheHist"></div>');
        renderCacheHist();
        const okN = results.filter((r) => (r.summary || {}).verdict === 'valid').length;
        UI.toast(`缓存检测完成：${okN}/${results.length} 渠道缓存有效`, okN ? 'ok' : 'warn');
      } catch (e) {
        UI.openModal('缓存检测', `<div class="hint">检测失败：${esc(e.message)}。请确认渠道地址可达，或把「超时」调大后重试。</div>`);
        UI.toast('缓存检测失败', 'err');
      }
    };
    poll();
  } catch (e) {
    UI.openModal('缓存检测', `<div class="hint">检测提交失败：${esc(e.message)}</div>`);
    UI.toast('缓存检测提交失败', 'err');
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

document.addEventListener('click', async (e) => {
  const more = e.target.closest('button[data-cache-more]');
  if (!more) return;
  more.disabled = true;
  await renderCacheHist(Number(more.dataset.offset) || 0, true);
  more.disabled = false;
});

document.addEventListener('click', async (e) => {
  const cancel = e.target.closest('button[data-cache-cancel]');
  if (!cancel) return;
  cancel.disabled = true;
  try {
    await fetchJSON(`/api/cache/check/${cancel.dataset.cacheCancel}/cancel`, { method: 'POST' });
    UI.toast('已发送取消请求', 'info');
  } catch (err) {
    cancel.disabled = false;
    UI.toast('取消失败: ' + err.message, 'err');
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
  new Notification(`Precision Bench · ${run.target} 完成`, { body: `成功率 ${pct(s.success_rate)} · E2E P95 ${fmtTime(s.e2e.p95)} · TTFT ${fmtTime(s.ttft.mean)}` });
}
const PERSIST = ['mode', 'concurrency', 'request_count', 'rate', 'duration_s', 'ramp_s', 'cooldown_s', 'ramp_rate', 'warmup', 'timeout_s', 'retries', 'jitter', 'proxy', 'prompt_mode', 'input_dist', 'input_tokens', 'system_prompt', 'top_p', 'max_tokens', 'temperature', 'slo_ttft', 'slo_tpot', 'slo_e2e', 'price_in', 'price_out', 'price_cache_in', 'price_cache_write', 'sch_name', 'sch_cron', 'alert_url', 'c_rounds', 'c_prefix', 'c_speedup', 'c_preset', 'cache_mode'];
function saveCfg() { const o = {}; PERSIST.forEach((id) => { const el = $(id); if (el) o[id] = el.value; }); ['stream', 'connection_reuse', 'verify_tls', 'randomize', 'cache_mode'].forEach((id) => o[id] = $(id).checked); localStorage.setItem('llmbench.cfg', JSON.stringify(o)); }
function loadCfg() {
  try { const o = JSON.parse(localStorage.getItem('llmbench.cfg') || '{}'); Object.entries(o).forEach(([k, v]) => { const el = $(k); if (!el) return; if (el.type === 'checkbox') el.checked = v; else el.value = v; }); } catch { /* ignore */ }
}
const PRESET_KEY = 'llmbench.presets';
function snapshotCfg() {
  const values = {};
  PERSIST.forEach((id) => { const el = $(id); if (el) values[id] = el.type === 'checkbox' ? el.checked : el.value; });
  return values;
}
function readPresets() {
  try { const data = JSON.parse(localStorage.getItem(PRESET_KEY) || '[]'); return Array.isArray(data) ? data : []; } catch { return []; }
}
function renderPresets() {
  const box = $('presetList');
  if (!box) return;
  box.innerHTML = readPresets().map((p) => `<span class="preset-chip"><button class="mini ghost" data-preset-load="${esc(p.name)}">${esc(p.name)}</button><button class="mini ghost" data-preset-delete="${esc(p.name)}" aria-label="删除 ${esc(p.name)}">×</button></span>`).join('');
}
function savePreset() {
  const name = ($('preset_name')?.value || '').trim();
  if (!name) { UI.toast('先给测试方案起个名字', 'warn'); return; }
  const presets = readPresets().filter((p) => p.name !== name);
  presets.unshift({ name, values: snapshotCfg(), saved_at: Date.now() });
  localStorage.setItem(PRESET_KEY, JSON.stringify(presets.slice(0, 8)));
  $('preset_name').value = '';
  renderPresets();
  UI.toast(`已保存「${name}」`, 'ok');
}
function loadPreset(name) {
  const preset = readPresets().find((p) => p.name === name);
  if (!preset) { UI.toast('测试方案不存在', 'warn'); return; }
  Object.entries(preset.values || {}).forEach(([id, value]) => {
    const el = $(id);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!value;
    else el.value = value;
  });
  saveCfg();
  renderPresets();
  UI.toast(`已载入「${name}」`, 'ok');
}
function deletePreset(name) {
  localStorage.setItem(PRESET_KEY, JSON.stringify(readPresets().filter((p) => p.name !== name)));
  renderPresets();
}
async function loadHistory() {
  try {
    const d = await fetchJSON('/api/runs');
    const recent = d.runs.slice(0, 8).reverse();
    const activeRows = d.runs.filter((r) => ['running', 'pending', 'stopping', 'paused'].includes(r.status));
    const loadedRows = [...new Map([...recent, ...activeRows].map((r) => [r.run_id, r])).values()];
    const newest = d.runs[0] && d.runs[0].run_id;
    const loaded = await Promise.all(loadedRows.map(async (r) => {
      if (state.runs.has(r.run_id)) return null;
      try {
        const [det, smp] = await Promise.all([fetchJSON(`/api/runs/${r.run_id}`), fetchJSON(`/api/runs/${r.run_id}/samples?max_points=4000`)]);
        return { r, det, smp };
      } catch { return null; }
    }));
    for (const item of loaded) {
      if (!item) continue;
      const { r, det, smp } = item;
      const t = det.run && det.run.params_json ? JSON.parse(det.run.params_json).targets[0] : { name: r.run_id, model: r.model };
      const run = { id: r.run_id, target: t.name, model: r.model, provider: r.provider, status: det.status, samples: smp.samples || [], sampleSeqs: new Set((smp.samples || []).map((s) => s.seq)), summary: det.summary, slo: det.run ? JSON.parse(det.run.slo_json || '{}') : {}, mode: det.run && det.run.params_json ? (JSON.parse(det.run.params_json).mode || 'closed') : 'closed', randomize: det.run && det.run.params_json ? !!JSON.parse(det.run.params_json).randomize : undefined, cacheMode: det.run && det.run.params_json ? !!JSON.parse(det.run.params_json).cache_mode : false, promptMode: det.run && det.run.params_json ? (JSON.parse(det.run.params_json).traffic || {}).prompt_mode : undefined, color: C.series[state.colorIdx++ % C.series.length], sse: null, sseOpen: false, lastEventId: 0 };
      state.runs.set(r.run_id, run);
    }
    // 默认主视图：在**已加载的这 8 条**里挑"样本充足"的最近一条
    // （在全部历史里挑会选到没加载的运行，导致 state.primary 落空、图表不渲染）
    const okRecent = recent.filter((r) => (r.total || 0) >= 10);
    const pick = state.primary
      || (okRecent.length ? okRecent[okRecent.length - 1].run_id : null)
      || newest;
    if (pick && state.runs.has(pick)) {
      state.primary = pick;
      renderCards(state.runs.get(pick).summary);
    } else if (state.runs.size) {
      // 兜底：至少有数据就先渲染，别让画布空着
      state.primary = [...state.runs.keys()].pop();
      renderCards(state.runs.get(state.primary).summary);
    }
    state.activeIds = d.runs.filter((r) => ['running', 'pending', 'stopping', 'paused'].includes(r.status)).map((r) => r.run_id);
    state.activeIds.forEach((rid) => {
      const run = state.runs.get(rid);
      if (run && !run.sse) connectSSE(run);
    });
    renderRuns(); renderCompareTable(); renderAll(); refreshTopbar();
    if (recent.length) log('info', `已恢复 ${recent.length} 条历史运行`);
  } catch (e) {
    log('warn', '历史加载失败: ' + (e && e.message));
  } finally {
    state.historyLoaded = true;
    refreshTopbar();
  }
}

/* ---------- 指标口径说明 ---------- */
const GLOSSARY = [
  ['TTFT', 'Time To First Token', '首字延迟', '请求发出 → 首个内容 token'],
  ['TPOT', 'Time Per Output Token', '每 token 时间', '(E2EL − TTFT) / (输出 token − 1)，每请求一个值'],
  ['ITL', 'Inter-Token Latency', 'token 间隔', '相邻流式 chunk 间隔，报 P50/P99'],
  ['E2EL', 'End-to-End Latency', '端到端延迟', '请求发出 → 末 token'],
  ['RPS', 'Requests Per Second', '请求速率', '成功请求数 / 墙钟（样本时长 ≥1s 才计算）；详情同时显示尝试速率'],
  ['Output tok/s', 'Output Throughput', '输出吞吐', '总输出 token / 墙钟时长（vLLM / SGLang 口径）。另有单请求解码口径（per-user）'],
  ['Goodput', '—', '有效吞吐', '达标请求占比。vLLM 的 request_goodput 为速率口径（req/s），本工具两个都给'],
  ['Cache hit', 'Prompt Cache Hit Rate', '缓存命中率', '命中输入 token / 总输入 token（token 口径）；请求级 hit/miss 单独计数。0% 可能是渠道未上报字段，主动探测用「缓存检测」（min 加速比判定，压测汇总为 mean 口径）'],
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
    { label: '解析供应商配置', sub: '识别配置', action: doParse },
    { label: '探活测速', action: doProbe },
    { label: '拉取模型列表', action: doModels },
    { label: '缓存检测（验证 Prompt Cache）', action: doCacheCheck },
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
function syncRailStats() {
  const runs = state.runs.size;
  let errs = 0;
  state.runs.forEach((r) => { errs += (r.errorCount || (r.summary && r.summary.errors) || 0); });
  /* 顶栏错误数以 DOM 为准（含未入 Map 的历史） */
  const topErr = document.getElementById('errCount');
  const topRun = document.getElementById('runCount');
  const rr = document.getElementById('railRuns');
  const re = document.getElementById('railErrs');
  if (rr) rr.textContent = topRun ? topRun.textContent : String(runs);
  if (re) re.textContent = topErr ? topErr.textContent : String(errs);
}
async function health() {
  try {
    await fetchJSON('/api/health');
    $('health').className = 'led ok'; $('healthTxt').textContent = '在线';
    const rl = $('railLed'); if (rl) rl.className = 'led ok';
    const rh = $('railHealth'); if (rh) rh.textContent = '在线';
  } catch {
    $('health').className = 'led err'; $('healthTxt').textContent = '离线';
    const rl = $('railLed'); if (rl) rl.className = 'led err';
    const rh = $('railHealth'); if (rh) rh.textContent = '离线';
  }
  syncRailStats();
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
$('btnGlossaryRail').onclick = showGlossary;
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
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    // ⌘Enter 跟当前视图走：降智页启动降智，否则启动压测
    if (location.hash === '#bench' && typeof window.__benchStart === 'function') window.__benchStart();
    else doStart();
  }
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
        try {
          await fetchJSON(`/api/runs/${id}`, { method: 'DELETE' });
          state.runs.delete(id);
          if (state.primary === id) state.primary = null;
          UI.closeDrawer(); renderRuns(); renderCompareTable(); UI.toast('已删除', 'ok');
        } catch (e) { UI.toast('删除失败: ' + e.message, 'err'); }
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

/* ---------- 面板高度/宽度拖拽（垂直 + 横向列宽，角点可同时调） ---------- */
const PANEL_H_KEY = 'llmbench.panelH';
const PANEL_W_KEY = 'llmbench.panelW';
function panelHeights() {
  try { return JSON.parse(localStorage.getItem(PANEL_H_KEY) || '{}'); } catch { return {}; }
}
function panelSpans() {
  try { return JSON.parse(localStorage.getItem(PANEL_W_KEY) || '{}'); } catch { return {}; }
}
function savePanelSpans(sp) { try { localStorage.setItem(PANEL_W_KEY, JSON.stringify(sp)); } catch { /* ignore */ } }
function initPanelResize() {
  const saved = panelHeights();
  const spans = panelSpans();
  document.querySelectorAll('.panel-grid > .panel, .bottom-panel').forEach((panel) => {
    const key = panel.dataset.panel;
    if (!key) return;
    if (saved[key]) {
      if (panel.classList.contains('bottom-panel')) panel.style.setProperty('--panes-h', saved[key] + 'px');
      else panel.style.setProperty('--ph', saved[key] + 'px');
    }
    // 恢复列宽（仅 grid 内 panel；bottom-panel 不占栅格列）
    if (!panel.classList.contains('bottom-panel') && spans[key]) {
      panel.style.gridColumn = `span ${spans[key]}`;
    }
    const hnd = document.createElement('div');
    hnd.className = 'rs-h';
    hnd.setAttribute('role', 'separator');
    hnd.setAttribute('aria-orientation', 'horizontal');
    hnd.setAttribute('tabindex', '0');
    hnd.title = '拖边缘调高，拖右缘或角点调宽，双击复位，↑/↓ 微调';
    panel.appendChild(hnd);

    const isGrid = !panel.classList.contains('bottom-panel');
    let whnd = null;
    if (isGrid) {
      whnd = document.createElement('div');
      whnd.className = 'rs-w';
      whnd.setAttribute('role', 'separator');
      whnd.setAttribute('aria-orientation', 'vertical');
      whnd.setAttribute('tabindex', '0');
      whnd.title = '拖拽调整宽度（列数），双击复位';
      panel.appendChild(whnd);
    }
    const cnd = document.createElement('div');
    cnd.className = 'rs-c';
    cnd.setAttribute('role', 'separator');
    cnd.setAttribute('tabindex', '0');
    cnd.title = '角点拖拽：同时调宽高，双击复位';
    panel.appendChild(cnd);

    const applyH = (px) => {
      const clamped = Math.max(120, Math.min(800, Math.round(px)));
      if (panel.classList.contains('bottom-panel')) panel.style.setProperty('--panes-h', clamped + 'px');
      else panel.style.setProperty('--ph', clamped + 'px');
      saved[key] = clamped;
      hnd.setAttribute('aria-valuenow', clamped);
      return clamped;
    };
    const applyW = (span) => {
      if (!isGrid) return;
      const s = Math.max(3, Math.min(12, Math.round(span)));
      panel.style.gridColumn = `span ${s}`;
      spans[key] = s;
      if (whnd) whnd.setAttribute('aria-valuenow', String(s));
    };
    const curH = () => (panel.classList.contains('bottom-panel')
      ? (panel.querySelector('.panes')?.getBoundingClientRect().height || 320)
      : panel.getBoundingClientRect().height);
    const curSpan = () => {
      if (!isGrid) return 6;
      const m = (panel.style.gridColumn || '').match(/span\s+(\d+)/);
      if (m) return Number(m[1]);
      // 类名形如 w7h2：只取 w 后的列数，不能把 h2 的 2 也吃进去
      const cls = ['w5h2', 'w6h2', 'w7h2', 'w5', 'w6', 'w7'].find((c) => panel.classList.contains(c));
      const wm = cls && cls.match(/w(\d+)/);
      return wm ? Number(wm[1]) : 6;
    };
    const colPx = () => {
      const grid = panel.parentElement;
      if (!grid || grid.clientWidth < 80) return 80;
      const cols = 12;
      const gap = parseFloat(getComputedStyle(grid).gap) || 12;
      const col = (grid.clientWidth - gap * (cols - 1)) / cols;
      return col > 8 ? col : 80; // 防 0/负列宽导致 span 瞬间顶满
    };

    const startDrag = (handle, mode) => {
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || panel.classList.contains('fullscreen')) return;
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        startY = e.clientY; startX = e.clientX;
        startH = curH(); startW = curSpan(); startCol = colPx();
        document.body.classList.add('panel-resizing');
        dragMode = mode;
      });
      handle.addEventListener('pointermove', (e) => {
        if (!handle.hasPointerCapture(e.pointerId)) return;
        if (mode !== 'w') applyH(startH + e.clientY - startY);
        if (mode !== 'h' && isGrid) applyW(startW + (e.clientX - startX) / (startCol + (parseFloat(getComputedStyle(panel.parentElement).gap) || 12)));
      });
      const end = (e) => {
        if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
        document.body.classList.remove('panel-resizing');
        dragMode = '';
        try { localStorage.setItem(PANEL_H_KEY, JSON.stringify(saved)); } catch { /* ignore */ }
        if (isGrid) savePanelSpans(spans);
      };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    };
    let startY = 0, startX = 0, startH = 0, startW = 6, startCol = 80, dragMode = '';

    startDrag(hnd, 'h');
    if (whnd) startDrag(whnd, 'w');
    startDrag(cnd, 'hw');
    // 手柄可聚焦，保证 ←/→ 键盘调宽可用（pointer capture 后 focus 可能丢失）
    [hnd, whnd, cnd].filter(Boolean).forEach((el) => {
      el.addEventListener('pointerdown', () => { try { el.focus({ preventScroll: true }); } catch { /* ignore */ } });
    });

    const reset = () => {
      delete saved[key];
      delete spans[key];
      try { localStorage.setItem(PANEL_H_KEY, JSON.stringify(saved)); } catch { /* ignore */ }
      savePanelSpans(spans);
      panel.style.removeProperty('--ph');
      panel.style.removeProperty('--panes-h');
      if (isGrid) panel.style.removeProperty('grid-column');
    };
    [hnd, whnd, cnd].filter(Boolean).forEach((el) => el.addEventListener('dblclick', reset));
    hnd.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      applyH(curH() + (e.key === 'ArrowUp' ? 40 : -40));
      try { localStorage.setItem(PANEL_H_KEY, JSON.stringify(saved)); } catch { /* ignore */ }
    });
    if (whnd) whnd.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      applyW(curSpan() + (e.key === 'ArrowRight' ? 1 : -1));
      savePanelSpans(spans);
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
// 必须在 loadCfg 之后：滑杆要按恢复出来的初值定位，否则松手就会被吸到默认档位。
// 方案（预设）恢复时也会走各 input 的 change 事件，滑杆会自动跟随同步。
UI.enhanceNumerics(NUMERIC_SLIDERS);
$('btnSavePreset').onclick = savePreset;
$('btnLoadPreset').onclick = () => {
  const name = ($('preset_name')?.value || '').trim() || readPresets()[0]?.name;
  if (name) loadPreset(name);
  else UI.toast('还没有保存的测试方案', 'warn');
};
$('c_preset').onchange = () => {
  const prefix = { openai: 1024, qwen: 1024, deepseek: 1024, kimi: 1024, anthropic: 2048 }[$('c_preset').value];
  if (prefix) $('c_prefix').value = prefix;
  saveCfg();
};
renderPresets();
initPinParams();
initPanelResize();
const savedSidebar = localStorage.getItem('llmbench.sidebar');
const narrowSidebar = window.matchMedia('(max-width: 1100px)').matches;
setSidebar(savedSidebar == null ? !narrowSidebar : savedSidebar === '1');
summaryEmpty();
renderRuns();
renderCompareTable();
loadSchedules();
loadHistory();
health();
log('info', '仪表盘就绪 · 粘贴供应商配置后「解析」→「开始测试」');
})();
