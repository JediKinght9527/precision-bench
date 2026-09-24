# LLM Bench 界面规范

本文件是本项目前端的设计与实现约定。**改 UI 前先读这里**，新增组件与改动必须符合下列规则。
规范基于现有实现固化而来，并对齐 [Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines)。

范围：`web/`（`index.html` / `style.css` / `ui.js` / `app.js` / `bench.js`）。零构建，原生 HTML/CSS/JS + 本地 ECharts。

---

## 1. 定位（决定一切取舍）

这不是通用后台，是一台**检定仪**：验中转渠道的真实速度与真实智力，并给出可对质的判定。

三条原则：
1. **结论先行**——一眼看到"正常 / 偏慢 / 不合格"，再往下才是细节。
2. **数据密度优先**——不追求留白，追求单位屏幕内的有效信息量。
3. **克制**——高光只给一处（判定块），其余安静；任何装饰若不能编码信息就删掉。

---

## 2. 设计令牌

改配色/字号/间距一律走令牌，禁止在组件里写死颜色。

### 颜色

设计语言：**NVIDIA 官网式企业深色**（2026-09-24 第五版，纯黑画布 + 中性灰阶 + 标志绿 `#76B900`）——
纯黑阶梯 + 中性白发丝线 + NVIDIA 绿单一品牌色（CTA/选中/轨迹）；**无霓虹、无品红、无装饰网格底纹**；
图表轨迹整组 NVIDIA 绿系明度差；辉光几乎去尽，仅残留极弱 `--glow-*`（默认不滥用）。

核心纪律：
1. 背景只靠 bg 阶梯 + 中性发丝线（`rgba(255,255,255,…)`）
2. 唯一品牌色 NVIDIA 绿 `--acc #76b900`（CTA / 选中 / 主轨迹），覆盖 <3% 面积；`--acc2` 为描边白，非第二品牌色
3. 语义色只表状态；**不做装饰性辉光/text-shadow**（判定态用色 + 字重区分）
4. **图表 series 一律 NVIDIA 绿系明度差**（`--tr-1…5`），不用彩虹；SLO 虚线仍用 `--warn` 黄（阈值语义）
5. 语义色只表状态；数值绿/黄/红**只由阈值判定驱动**
6. 令牌单源：颜色/字号/间距只写 `:root`

| 令牌 | 值 | 用途 |
|---|---|---|
| `--bg-0` … `--bg-5` | `#000000` `#0b0b0b` `#121212` `#1a1a1a` `#242424` `#2e2e2e` | 纯黑阶梯：canvas → 导轨/顶栏 → 面板 → 控件 → hover → pressed |
| `--line` / `--line-2` / `--line-3` | `rgba(255,255,255,.08)` / `.12` / `.18` | 中性白发丝分割线（唯一描边；三级强度） |
| `--tx-1` … `--tx-4` | `#ffffff` `#9b9b9b` `#6b6b6b` `#4a4a4a` | 正文 / 次级 / 三级（单位、轴标） / placeholder·disabled |
| `--acc` / `--acc-hi` / `--acc-lo` | `#76b900` / `#8ad600` / `#5a9200` | **NVIDIA 标志绿，主 CTA/选中/焦点**（黑字 `--on-acc`） |
| `--acc-subtle` / `--acc-ring` / `--on-acc` | `rgba(118,185,0,.15)` / `.45` / `#000000` | 选中底 / 焦点环 / 绿底上的黑字 |
| `--acc2` / `--acc2-hi` / `--acc2-subtle` | `#ffffff` / `#ffffff` / `rgba(255,255,255,.08)` | 描边白（次强调，非第二品牌色） |
| `--ok` `--warn` `--bad` `--info` | `#76b900` `#ffb800` `#ff4d4f` `#4086f4` | 语义色：绿=达标 黄=偏慢 红=超线 蓝=信息 |
| `--glow-ok/warn/bad/acc` | 极弱 8px 半透明（默认不给装饰性用法） | 仅极少数状态反馈，**禁止大面积辉光** |
| `--tr-1…5` | `#76b900` `#8ad600` `#a3e635` `#4d8a00` `#c6f96b` | **NVIDIA 绿系**轨迹色序（仅图表 series，明度差区分多线） |
| `--fs-11/12/13/15/17` + `--fs-num` / `--fs-kpi` | `11/12/13/15/17` + `clamp(32,3vw,44)` / `clamp(18–22)` | 字号 5 级 + 巨数 + KPI（token 化，禁写死 px） |
| `--s-1…8` + `--gap` | `4/8/12/16/20/24/32` + `12px` | 间距 4px 网格；面板 gap 固定 12px |
| `--r-1/2/3` / `--r-pill` | `4/6/8` / `999` | 圆角（企业精密感，非玩具圆润） |
| `--rail-w` `--side-w` `--top-h` `--ctl-h` | `200px` `300px` `48px` `32px` | 关键尺寸单源 |
| `--t-fast` / `--t-base` / `--ease` | `100ms` / `150ms` / `cubic-bezier(0,0,.2,1)` | 动效仅表状态 |

约束：
- 正文对比度 ≥ 4.5:1；`--tx-3` 只用于单位/轴标，`--tx-4` 只用于 placeholder/disabled。
- **唯一品牌色** `#76B900` 出现的位置必须表示 CTA/选中/主轨迹，不得当大面积底色铺开；**禁止装饰性辉光**。
- 数值的绿/黄/红**只由阈值判定驱动**，不得为了好看上色。
- **单源纪律**：`ui.js` 的调色板与 ECharts 主题用 `getComputedStyle` 读 `:root`（fallback 与 CSS 同值），改 CSS 即全端同步；组件/图表内禁止另写色值。
- JS 内联样式只允许引用已存在的令牌名（`--tx-*` / `--line*` / `--acc*` / `--ok|warn|bad` / `--tr-*` / `--glow-*`），禁止旧名（`--ink/--muted/--faint/--acc-bright/--rule`）。

### 字体

- UI 与正文：`-apple-system, "SF Pro Text", "PingFang SC", …`（系统字，不引入 Web 字体）。
- 大数字与判定读数用 `--sans-d`（SF Pro Display 优先），`tabular-nums` + 紧字距
  （vbNum 700 / -.04em，ro dd 650 / -.035em）。
- 代码/prompt：`--mono`。
- 字号梯度走 token 共 5 级 + 巨数 + KPI：`--fs-11 / --fs-12 / --fs-13 / --fs-15 / --fs-17`，巨数 `--fs-num clamp(28–40)`、KPI `--fs-kpi clamp(18–22)`。正文 13px/1.5；标题最大 17px；**禁止出现 9.5/11.5/12.5/13.5/14/26 等漂移值**。
- **密度优先**：内边距收紧（面板头 36px、顶栏 48px、读数卡 7–10px），拒绝臃肿留白；行高 1.45。
- 中文文案不写全大写、不加字距；英文缩写保持原样。

### 间距与形状

- 间距走 token：`--s-1…8 = 4/8/12/16/20/24/32`，面板 gap `--gap = 12px`（细线用 1px）。
- 圆角用令牌，禁止随手写：`--r-1` 4px（控件/chip）、`--r-2` 6px（卡片/输入）、
  `--r-3` 8px（面板/弹窗）、`--r-pill` 999px（徽章/开关）。
- **描边只用冷色半透明发丝线**（`--line/.08`、`--line-2/.14`、`--line-3/.22`），层级靠 bg 亮度阶梯；
  判定环/主 KPI 允许同色辉光，禁止大面积装饰性 box-shadow 抬升。
- 面板之间用 **12px 间距** 的独立面板卡，不要用 `gap:1px` 的连续细线网格（看起来生硬）。
- 折线默认 `smooth: 0.25` + `cap/join: round`；柱状 `borderRadius:[4,4,0,0]`；图表井为圆角内凹区。
- `main` 必须可滚动（`overflow-y:auto`），顶栏 `position:sticky`——否则下半部分内容够不到。
- 动效只动 `transform` / `opacity`，时长 ≤ 200ms，且必须被 `prefers-reduced-motion` 关闭。

---

## 3. 布局

```
┌──┬────────────┬──────────────────────────────────────┐
│导│ 配置侧栏    │ 顶栏：面包屑 · 时间范围 · 状态 · ⌘K    │
│航│ (可折叠)    ├──────────────────────────────────────┤
│58│            │ 结论带：判定块 + 读数表               │
│  │            ├──────────────────────────────────────┤
│  │            │ 面板栅格（不等大）                    │
│  │            ├──────────────────────────────────────┤
│  │            │ 底部面板：运行记录 / 对比表 / 日志     │
└──┴────────────┴──────────────────────────────────────┘
```

- **玻璃卡片化**：面板是浮在暗室辉光上的独立烟色玻璃卡（18px 大圆角 + 14px 间距），顶栏/侧栏为玻璃条；
  **禁止实色面板底与彩色渐变装饰**；层级优先靠 bg-0…4 背景差分，发丝描边为辅。
- **禁止等大栅格**：主图 `w7h2`（7 列 × 2 行），其余 `w5` / `w7` 混排，允许行高不同。
- 左导轨：**展开式导航**（172px）= 海狸徽标 + 品牌名 + 分组标题（检测/工具）+ 图标文案条目 + 底部 build 版本号；
  `≤1180px` 收窄，`≤980px` 自动折叠为 56px 图标条（隐藏文案/分组/版本号）。条目 active = 绿染底 + 左侧 3px NVIDIA 绿指示条。
- 侧栏：`<details>` 折叠分组，默认只展开"目标渠道 / 测试参数"；底部常驻操作条。
- 抽屉宽度 `min(640px, 92vw)`，遮罩点击关闭。
- 断点：`1420px` 收窄侧栏；`1180px` 面板/栅格收窄；`980px` 结论带改上下堆叠 + 图标条；`720px` 单列读数、顶栏次要项隐藏。

---

## 4. 组件规范

每个交互组件必须实现 **hover / focus-visible / active / disabled / loading / empty** 六态。

| 组件 | 规则 |
|---|---|
| 按钮 | 高度 32（mini 25）；主操作 `primary`（`#76B900` 实底 + 黑字 `--on-acc`，hover 提亮 `#8ad600`）；破坏性 `danger` 红描边，**必须二次确认** |
| 输入 | 高 32，聚焦 NVIDIA 绿边 + 2.5px 光环；`type` 用语义值（`number`/`search`/`text`）；搜索框 `spellcheck=false` |
| 开关 | 同一 `<label>` 包裹 input 与文字，整块可点 |
| 徽章 | 高 20，胶囊，前置 5px 方点；状态色只表状态 |
| 渠道行 | 模型为主行（13px/500），地址与掩码密钥次行；右侧协议徽章 + 移除按钮；缺字段用 `--warn` 文案标注 |
| 面板 | 头 36px（主图 42px）；hover 才显菜单（导出 PNG / 全屏）；空态居中一行说明，**不留白板** |
| 表格 | 粘性表头、列可排序、行 hover、数字列右对齐 + tabular；行可 `Tab` 聚焦、`Enter` 打开详情 |
| 抽屉/弹窗 | `overscroll-behavior: contain`；关闭按钮有文字；遮罩可点关闭 |
| Toast | 右下堆叠，`role="status" aria-live="polite"`，自动消失，不用 alert |
| 命令面板 | `role=combobox` + `role=listbox/option` + `aria-activedescendant`；↑↓ 选择 / Enter 执行 / Esc 关闭 |

---

## 5. 图表规范

统一通过 `UI.base()` / `UI.tooltip()` / `UI.noData()` 构建，禁止逐图随意写样式。

- 值轴一律 `scale: true`（否则延迟图 80% 是空白）。
- 双向刻度格：主 `rgba(255,255,255,.042)`，次 `rgba(255,255,255,.018)`。
- 面积用**垂直渐变**（10–25% → 0），不用平铺半透明块。
- 柱状 `borderRadius:[2,2,0,0]` + 渐变；线宽 1.5–2。
- 分位带用 **category 轴 + stack** 实现（value 轴 + stack 会渲染成斜楔，已踩坑）。
- 辅助系列（分位带基底）命名以 `_` 开头，tooltip 与图例需过滤。
- 阈值/SLO 用虚线 + 标注；空数据调 `UI.noData(el, 原因)`，热力图样本不足要显式提示。
- 数字轴标交给 ECharts 智能刻度，**不要自己加全局 formatter**（会把整数轴变 `10.0`）。
- 图表容器尺寸变化必须 `resize()`；`UI.initChart` 已挂 `ResizeObserver`，不要绕过它初始化。
- **时间分桶必须自适应**：用 `pickBucketMs(S)`（目标约 48 桶，档位 1s→1h）。禁止固定 `2000ms` / `1000ms`——长跑会生成上千列，既卡又不可读。
- **同源指标共享 x 域**：主图、TTFT、TPOT、吞吐量四图必须用同一 `seq` 类目轴（`data: seqCat`）且标签密度一致；四者通过 `echarts.connect([...])` 联动十字准星，支持竖向比读。
- **画不出来的图不要留空白**：热力图在时间跨度或延迟分档不足时，回退为「逐窗口统计表」（时间窗 / 请求 / 成功 / P50 / P95 / P99），而不是一句"样本不足"。
- 定频（open-loop）专属的 `corrected` 曲线，在并发（closed-loop）模式下不得绘制（此时它与 observed 恒等，纯噪声）。
- **双轴图**（吞吐、分布）：`grid.right ≥ 48` 给右轴留位（否则三位数标签被裁成两位数）；左右轴标签与轴线**用各自曲线颜色着色**；图例放**左侧**，避免与右轴名相撞。
- 吞吐量按**滑动窗口**计算并以 `seq` 为轴（与延迟图同源），不用固定时间桶柱状图。

---

## 6. 文案规范

- 说人话、主动语态、第二人称；按钮用具体动作：`识别配置`、`开始测试`、`导出对比`。
- 不用 `A · B · C` 这类中点拼接元信息；不做全大写 eyebrow 标签。
- 省略号用 `…`；中文引号用 `“”` 或 `「」`；数字与单位之间不空格（`295ms`）或按平台惯例统一。
- 空态是行动邀请：说清下一步，而不是"暂无数据"。
- 错误必须含**原因 + 下一步**（例：`还没有可用地址，请补上 base_url 后再测`）。
- 状态词统一：`正常 / 偏慢 / 不合格`；运行态 `运行中 / 完成 / 错误 / 暂停 / 已停`。

---

## 7. 无障碍与交互硬性要求

对齐 Vercel WIG，逐条落到本项目：

| 要求 | 落实方式 |
|---|---|
| 图标按钮必须有可访问名 | `aria-label`（+ `title`） |
| 装饰性 SVG | `aria-hidden="true"` |
| 表单控件必须有标签 | `<label>` / `aria-label`；`<label for>` 绑定 |
| 可见焦点 | 按钮 `:focus-visible` + 2px NVIDIA 绿 outline；复合控件 `.dim:focus-within`；禁止无替代的 `outline:none` |
| 异步播报 | Toast 容器 `role="status" aria-live="polite"` |
| 键盘可达 | 表格行 `tabindex=0` + `Enter`；命令面板 ↑↓/Enter/Esc |
| 语义 HTML | 操作用 `<button>`，导航用 `<a>`，不拿 `div` 当按钮 |
| 破坏性操作 | 删除运行/记录/任务均走确认框 |
| 动效 | 遵守 `prefers-reduced-motion`；只动 transform/opacity；不用 `transition: all` |
| 浅色/深色 | `html { color-scheme: dark }` + `<meta name="theme-color">`（含原生 select 深色） |
| 降低透明度 | `prefers-reduced-transparency` 下回退为实色表面并关闭 `backdrop-filter` |
| 长内容 | 文本容器 `overflow:hidden` + `text-overflow:ellipsis`，flex 子项 `min-width:0` |
| 长列表 | 表格行 `content-visibility: auto` + `contain-intrinsic-size` |
| 滚动 | 弹窗/抽屉/面板内容 `overscroll-behavior: contain` |
| 触控 | `touch-action: manipulation`、`-webkit-tap-highlight-color: transparent` |
| 数字/时间格式 | 一律 `Intl.NumberFormat` / `Intl.DateTimeFormat`（见 `ui.js` 的 `fmt/tstr/hm/dtstr/nowTime`） |
| 缩放 | 不禁用缩放，`viewport` 不加 `user-scalable=no` |

---

## 8. 反模式（禁止新增）

- 一排同构读数卡（小灰标签 + 大数字 + 火花线）——本项目已改为"判定块 + 读数表"。
- 彩色渐变底、非语义的装饰性光晕/网格底纹/扫描线（辉光几乎去尽；主色只给 CTA/选中/主轨迹）。
- 全 UI 出现第三种强调色互相抢（只允许 `#76B900` 单品牌色 + 语义色）；满屏小灰标签。
- 每个面板标题前重复的小横线（eyebrow）。
- 小数据全用等宽字体。
- `transition: all`、无替代的 `outline:none`、`div` 当按钮。
- 图表空数据留白板、热力图单格撑满、value 轴 + stack 分位带。
- 固定格式的日期/时间/数字硬编码。
- 依赖 `getBoundingClientRect` 之类布局读取做渲染计算。

---

## 9. 验收清单（改完 UI 必过）

1. `node --check web/*.js` 全过；三个 JS 里 `$('id')` 引用的 id 都存在于 `index.html`。
2. `uv run --group dev pytest -q` 全绿（36 项）。
3. 浏览器控制台**零错误**（含资源 404）。
4. 三档宽度截图核对：`1720 / 1280 / 1024`，无溢出、无裁切、无空洞。
5. 键盘走查：`Tab` 能到达所有交互元素，焦点可见；`⌘K` 面板可用。
6. 空态/加载/错误三态存在且文案可执行。
7. 对比度抽查：正文 ≥ 4.5:1。
8. 新增颜色/字号/间距只能取自第 2 节令牌。

---

## 10. 数据可信度规则（重要）

面向供应商验收，界面上的数字必须**可信**——荒谬值比"没有值"更伤信任。

- **速率类指标需足够采样时长**：`rps = 总请求/墙钟` 仅在 `墙钟 ≥ 1s` 时计算；`tok/s` 仅在 `解码总时长 ≥ 1s` 时计算。否则返回 `null`，界面显示 `–`。
  （否则 2 次请求 1ms 的短跑会算出 `17,403 req/s`。）
- 该门槛在**后端 `metrics.summarize` 统一实现**，不要在 UI 逐处打补丁——读数区、对比表、详情抽屉必须一致。
- 单价未配置时，成本显示「未配置单价」，不要显示 `¥0.0000`。
- 渠道名不得重复：`_uniquify_names` 在解析收尾统一去重（冲突时用 host 区分）。

## 11. 测试参数与判定标准（默认值与依据）

**判定原则：界面上所有"正常/偏慢/不合格"必须由用户设的合格线驱动，并在界面上写明是哪一条没过。禁止魔法数字。**

### 性能压测默认值

| 参数 | 默认 | 依据 |
|---|---|---|
| 负载模式 | 并发 closed-loop | 贴近真实用户，评"质量" |
| 并发 | 2 | 保守默认；压容量请切定频并调高 |
| 总请求数 | **100** | 20 条算不出可信分位；P99 至少需要 ~100 样本 |
| 定频速率 / 时长 | 5 req/s / 60s | 定频模式用 |
| 预热 | 3 | 建立连接池、排除首请求偏差；**预热次数不计入统计** |
| 预热超时 | min(超时, 20s) | 预热只确认可用性，不能把界面卡死 |
| 请求超时 | 120s | 宽松默认；超长会拉高 P99，建议按模型输出长度收紧 |
| 重试 | 0 | 长时稳定性必须暴露原始失败，不掩盖 |
| stream | 开 | 测首字延迟必须 |
| 连接复用 | 开 | 模拟真实客户端 |
| temperature | 0 | 可复现 |

### 合格线（SLO）默认值

| 项 | 默认 | 依据 |
|---|---|---|
| 首字延迟 TTFT | 1500 ms | 800ms 内为优秀，1.5s 是可接受线 |
| 逐 token TPOT | 50 ms（=20 tok/s） | 主流 API 解码 20–60 tok/s |
| 端到端 E2E | 5000 ms | 覆盖长输出场景 |

**指标命名对齐 vLLM / SGLang**（字段规律 `{统计量}_{指标}_{单位}`）：

| 缩写 | 全称 | 中文 | 口径 |
|---|---|---|---|
| TTFT | Time To First Token | 首字延迟 | 请求发出 → 首个内容 token |
| TPOT | Time Per Output Token | 每 token 时间 | `(E2EL − TTFT) / (输出 token − 1)`，**每请求一个值** |
| ITL | Inter-Token Latency | token 间隔 | 相邻流式 chunk 间隔（P50/P99）；一个 chunk 含多 token 时与 TPOT 不等 |
| E2EL | End-to-End Latency | 端到端 | 请求发出 → 末 token |
| RPS | Requests Per Second | 请求速率 | 完成请求数 / 墙钟（≥1s 才计算） |
| Output tok/s | Output Throughput | 输出吞吐 | 输出 token / 纯解码时长 |
| Cache hit | Prompt Cache Hit Rate | 缓存命中率 | 命中输入 token / 总输入 token |
| Goodput | — | 有效吞吐 | TTFT 与 E2EL 达标（流式时含 TPOT）的请求占比 |

**不可测要显式标注**：非流式请求拿不到逐 token 时间 → TPOT/ITL 显示 `n/a`，
且 **Goodput 不强制要求 TPOT**（否则健康渠道会被误判为 0%）。字段 `summary.measurable` 标明哪些可测。

### 缓存（Prompt Caching）

必须兼容 4 种返回结构，解析顺序即优先级：

| 厂商 | 字段 | 位置 |
|---|---|---|
| OpenAI / GLM / Qwen | `prompt_tokens_details.cached_tokens` | 嵌套 |
| Anthropic | `cache_read_input_tokens` / `cache_creation_input_tokens` | 顶层 |
| DeepSeek | `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` | 顶层 |
| Kimi | `cached_tokens` | 扁平 |
| Gemini | `usageMetadata.cached_content_token_count` | 顶层 |

- 流式下：OpenAI 需 `stream_options.include_usage`；Anthropic 输入侧在 `message_start`、输出侧在 `message_delta`。
- **差异化指标**：`cache.ttft_hit` vs `cache.ttft_miss`（命中与未命中的 TTFT 对比 + 加速比）——
  主流工具都不产出，用来判断渠道的缓存是否真的生效。
- 成本按缓存单价计算：`price_cache_in`（0 表示与输入同价）。

### 缓存检测（主动验证 Prompt Cache，2026-09-19）

「缓存检测」按钮对同一长前缀**串行**发 N 次（默认 6 轮 = 1 写入 + 5 命中）：

- 前缀开头注入随机 nonce：每次检测冷启动（跨次不污染），单次内轮间前缀一致。
- 判定由用户阈值驱动（默认加速比 ≥1.5×、命中轮数 ≥ 成功轮数−1），禁魔法数字。
  **加速比判定用 min 口径**（miss 最快 / hit 最快）：思考型模型 TTFT 含思考时长、方差极大，
  中位数会被一轮长思考拖到阈值下产生误报（DeepSeek 实测：min 2.04× 判有效 vs 中位 1.51× 误判 suspect）；
  中位数（miss_med → hit_med）仍如实展示供对照。
  另有输入一致性校验：各轮 in_tokens（已归一为总输入）应与首轮一致，偏差 >10% 提示
  「前缀可能被中转截断或改写」。
  - **缓存有效**：上游上报缓存字段 + 加速比达标 + 命中轮数达标；
  - **疑似假缓存**：上报命中但 TTFT 无相应下降（中转渠道常见猫腻，正是本功能要抓的）；
  - **未上报**：成功轮次无任何缓存字段（中转吞 usage / 渠道不支持提示缓存）；
  - **检测失败**：全部失败，无可判数据。
- 结果落库（`cache_checks` / `cache_baselines` 表）：历史回看、设基线、跨次加速比对比。
- mock 上游含三态缓存模拟：默认真实 miss→hit（TTFT ×1.15 → ×0.35）、
  `x-test-cache: fake`（上报命中不加速）、`x-test-cache: nocache`（不上报），供测试与演示。
- 局限：轮数少，结论是「趋势参考」；Anthropic 最低可缓存门槛依模型（2048+）；
  OpenAI 协议无"写入"字段，第 1 轮 Cached=0/Write=0 属正常。
- **Anthropic in_tokens 口径**（2026-09-19 修正）：Anthropic 的 `input_tokens` 只含未命中部分
  （缓存单独列），providers 层已统一归一为总输入（+cache_read+cache_write），与 OpenAI 的
  prompt_tokens（含命中）一致——否则缓存命中率分母错、吞吐被带歪。流式在 message_start
  就地归一 usage_in（流末统一赋值，中途改 res.in_tokens 会被覆盖，已踩坑）。
- **被动压测测不出缓存的两个原因**（界面已提示）：`randomize` 开启时前缀随机、必然不命中；
  输入 token 低于门槛（OpenAI 1024 / Anthropic 2048+）时命中也不加速。测缓存请用「缓存检测」按钮。

**判定规则**：
- 成功率 < 95% 或任一延迟 > 合格线 × 1.5 → **不合格**
- 成功率 < 99% 或任一延迟 > 合格线 → **偏慢**
- 否则 → **正常**
- 样本数 < 100 时，判定附「分位值参考性有限」提示

### 降智检测默认值

| 参数 | 默认 | 依据 |
|---|---|---|
| temperature | 0 | 可复现 |
| 最大输出 | 512 | 覆盖推理题 |
| 长上下文 | 4000 tokens | 触发上下文截断检测 |
| 降智阈值 | 10 个百分点 | **自建 57 题时该阈值噪声较大**，判定时会同时提示样本量 |

> ⚠️ 降智检测当前用的是自建 curated 题集，**分数不可与公开榜单对比**；要作对外结论需接入官方数据集（见待办）。

## 12. 官方数据集与统计判定（P0）

降智检测支持两套题集，**基线按题集隔离**（`bench_baselines` 主键 = base_url + model + task_key）：

| 题集 | 引擎 | 用途 | 分数可比性 |
|---|---|---|---|
| 轻量自建 57 题 | `curated` | 秒级冒烟，日常盯变化 | ❌ 不可对外引用 |
| 官方数据集 | `lm_eval` | 验收/对质 | ✅ 与公开榜同源 |

- **引擎**：`lm-eval-harness` 子进程（`server/lm_eval_runner.py`），输出目录按 run_id 隔离。
- **任务**：默认只启用**生成式**任务（`gsm8k`、`mmlu_generative`）——任何端点都能跑；
  loglikelihood 类（`mmlu`/`ceval-valid`/`arc`/`hellaswag`/`truthfulqa`）**需端点支持 logprobs**，
  UI 明确标注，Anthropic 渠道不可用。
- **limit 语义**：对组任务（MMLU 有 57 个叶子）是**每个子任务**生效，`n_items = 叶子数 × limit`，UI 如实提示。
- **数据集下载**：走 `HF_ENDPOINT=https://hf-mirror.com`；提供「预下载」按钮避免跑一半卡住。
- **可复现**：`seed` / `fewshot` / `limit` / `lm_eval_version` 全部入库。

**统计判定（替代拍脑袋阈值）**
- 每维度给 **Wilson 95% 置信区间**（`stats_ext.wilson_ci`，与 statsmodels 一致到 1e-16）。
- 基线对比：`doc_id` 交集 ≥10 → **McNemar 配对精确检验**；否则退化两比例 z 检验。
- 判定 = **显著（p<α）且 |Δ| ≥ min_delta**；不显著时明确显示「变化不显著（p=…）」。
- 逐题结果可从 `bench_items` 重算，**与 lm-eval 官方报告逐位一致**（`tests/verify_lm_eval_parity.py`，含非零分数）。

## 13. 逐请求明细（可对质）

性能页底部有 `Requests` 标签：列出**主视图运行**的每一条请求——
`seq / status / class / TTFT / E2EL / TPOT / in-out / cache / 错误原文`，
支持「只看失败」、按错误类筛选、搜索错误原文、导出当前筛选的 CSV。

> 为什么必须有：以前只能看到 `rate_limit: 15` 这个计数，**看不到供应商到底回了什么**；
> 而对质时最有力的证据就是那句错误原文。

## 14. 与主流项目的一致性核对（源码级）

核对对象为**源码**（不是文档）：`vllm-project/vllm` 的 `vllm/benchmarks/serve.py`、
`sgl-project/sglang` 的 `python/sglang/benchmark/serving.py`（截至 2026-09-18 main 分支）。

| 指标 | vLLM / SGLang 源码 | 本项目 | 结论 |
|---|---|---|---|
| TTFT | 首个带时间戳的 chunk − 发出（SGLang `if ttft == 0.0: ttft = timestamp - st`） | 同 | ✅ 一致 |
| TPOT | `(latency - ttft) / (output_len - 1)`，`output_len ≤ 1` 记 0（vLLM L624-631） | 同；`out ≤ 1` 记 None，Goodput 中不参与（等效放行） | ✅ 一致 |
| ITL | 相邻流式 chunk 间隔**列表**（`itl.append(timestamp - last)`），与 TPOT 独立 | 同 | ✅ 一致 |
| E2EL | 末 token − 发出 | 同 | ✅ 一致 |
| 请求吞吐 | `request_throughput = completed / dur_s` | `total / wall`，且**样本时长 <1s 不计算** | ✅ 一致（本项目更严） |
| 输出吞吐 | `output_throughput = Σoutput_tokens / dur_s`（**墙钟**） | `output_throughput` 墙钟口径；另给 `..._per_user` 解码口径 | ✅ 已对齐 |
| Goodput | `request_goodput = good_completed / dur_s`（**速率**） | `goodput` 占比 + `request_goodput` 速率，两个都给 | ✅ 已对齐 |
| 分位算法 | `np.percentile`（线性插值） | 同（曾用 HDR Histogram，**已改**） | ✅ 已对齐 |
| 字段命名 | `mean_ttft_ms` / `p99_tpot_ms` / `mean_itl_ms` | 同规律 | ✅ 一致 |
| 缓存指标 | vLLM/SGLang 仅服务端 Prometheus 暴露命中率；客户端几乎不做 | 客户端直接报 + 命中/未命中 TTFT 对比 | ➕ 本项目更全 |

**2000 个分位值逐位比对 `numpy.percentile`，零差异**（脚本可复跑）。

> 未对齐项说明：vLLM 的 `goodput` 不带占比、SGLang 无 ITL 均值字段，均为其取舍，不影响可比性。

## 15. 图表退化与轴标规范

**小样本不得画成"看起来正常"的图形**——那比空着更糟（会误导判断）。

| 场景 | 阈值 | 处理 |
|---|---|---|
| 波形图（E2EL/TTFT/TPOT/吞吐/热力/错误） | <5 条样本 | 显示「样本不足（n 条，至少需 5 条）」，不画 |
| 分位带（P50–P95） | <20 条样本 | 不画色带（否则是一个无意义的三角楔形），只保留 P50/P95 线 |
| 直方图 | <10 条样本 | 显示「样本不足」，不画（两根柱子没有信息量） |

**轴标**：小数位按数据跨度自适应（`UI.axisLabelFor`），并用 `+toFixed()` 去掉尾随 0——
避免出现 `122.0 / 21.40` 这种又长又挤、还互相重叠的标签；短面板 `splitNumber: 3` 降密度。

**图例**：多序列时放**底部**（顶部会盖住波形）；横评图默认只对比**最近 5 条**，
且 series 名必须唯一（同名会被 ECharts 图例合并，看起来像丢数据）。

**轴名**：单轴图也用竖排居中（`nameLocation:'middle'`），避免与顶部刻度数字重叠。

## 16. 视觉与数据的一体化（玻璃场景）

**问题**：玻璃折射动画（`glass-hero.js`，原生 WebGL1）原先只活在"空态"和一个独立 demo 页里，
而仪表盘是另一套语言——两者割裂。

**做法**：把 WebGL 场景变成**整个应用的底层**，面板用 `backdrop-filter` 真实折射它。

```
#appScene   position:fixed; inset:0; z-index:0; pointer-events:none   ← WebGL 场景
#app        position:relative; z-index:1                              ← 玻璃面板浮在上面
```

- 场景常驻挂载（不再只在空态），两个视图共享同一个世界。
- **数据驱动色调**：已随 glass-hero 移除（2026-09-23）；当前状态色只落在
  `.verdict-block.s-*` / 指标卡 `v-ok|v-warn|v-bad` 上，不再切 body class。
- 有数据时 `body.has-data` 把场景压到 `.58`，让波形图保持清晰。
- 空态：引导卡贴底居中（`min-height: calc(100vh - 132px)` + `align-items:flex-end`），
  避开上方巨型排版；卡面用 `rgba(9,10,13,.93)` 保证可读。
- `prefers-reduced-motion` 下停止动画；WebGL 不可用时降级为 2D 文字层。

> ⚠️ 实现坑：`GlassHero.mount()` 必须在**布局完成后**调用（`requestAnimationFrame`），
> 否则 `clientWidth` 为 0，画布停在默认 300×150，场景等于没画。
> 同时 resize 需要观察 canvas 自身 + 监听 window。

## 17. 趋势图规范

> 原「Logo 三球场景」已移除（2026-09-22）：`#logoScene` canvas、`mountHero()`、
> `logoOrbFloat` 动画及相关 mood 滤镜均已删除，logo 仅保留 `logo-rail.png` 图标。
> `glass-hero.js` 于 2026-09-23 从 script 加载链移除（零调用死代码）。

**趋势图（总分趋势）专业规范**：
- Y 轴**自适应区间**（按数据上下各留 4% 再取整到 5 的倍数），不要固定 0–100——
  分数集中在高段时固定量程会看不出任何变化。
- **基线虚线** + 最新点放大加粗 + 数值标签 + 极值 pin 标记。
- 平滑 0.35、线宽 2、渐变面积 16%、圆头圆角。

## 18. 已知例外与待办

- **多 worker 不允许**：运行状态在进程内存（Engine / BenchManager / SSE 订阅），必须单进程。
- 命令面板项仍是 `div`（带 `role=option` 与全局键盘处理），未改为原生 `<button>`。
- 深度链接只覆盖视图切换（`#bench`），标签页/筛选未同步到 URL。
- 表格未做虚拟滚动，靠 `content-visibility` 兜底；单次样本上千时需评估。
- 仅深色主题，无浅色切换。

## 19. 面板高度拖拽（.rs-h）

面板高度可拖拽（`.rs-h` 手柄：左键拖拽/双击复位/↑↓ 微调，localStorage `llmbench.panelH`）。
`glass-hero.js` 已删除（2026-09-23 移入回收站）：全仓无 `GlassHero.mount()` 调用，零调用死代码。

## 20. 读数区与面板布局策略（2026-09-19；2026-09-23 第四版 Cyber HUD；2026-09-24 第五版 NVIDIA）

读数层次承前（判定 P95 口径、判定块 + 读数表、面板栅格），视觉为 **NVIDIA 官网式企业深色**：
纯黑 `#000000` 阶梯 + 中性白发丝线 + `#76B900` 单品牌色 + **无装饰辉光/网格底纹**；
判定区为 `.vb-hud`（conic 健康分环 `.vb-ring` + 状态/E2EL 巨数 `.vb-hud-tx`），
健康分 `healthScore()` = 成功率 40 + TTFT/E2E/TPOT 各 20（相对 `runSlo` 合格线）。
绿/黄/红仍只作阈值状态色。

**读数区分层（重要性驱动）**：
- 第一行（判定三要素，与 SLO 判定同口径）：Success rate / **TTFT P95** / **E2EL P95**——
  判定用的是 P95，读数区就该显示 P95 而不是 mean（此前 TTFT/TPOT 用均值，与判定口径脱节）。
- 次级网格按"复看频率"排序：RPS → Output tok/s → Cache hit → Goodput → TPOT → ITL P99 →
  E2EL P50/P99/mean → Checks → Cost → Errors。
- 判定块仍是大数字 E2EL P95 + 四枚 SLO 徽章，结论先行不变。

**面板栅格（重要性 + 无空洞）**：行1 E2E 主图(7)+TTFT(5)；行2 Throughput(7)+分布(5)——
吞吐是第二重要的实时信号，提前；行3 TPOT(6)+热力(6)；行4 错误(5)+对比(7)。
w5/w7 混排时 dense 布局会留洞，配对必须凑满 12 列（已踩坑）。

## 21. 看板对照（2026-09-19，三轮对照主流项目）

对照对象：Grafana k6（web dashboard / thresholds / checks）、Locust（实时 web UI）、
vLLM / SGLang benchmark（源码级核对见 §12）、Grafana / status-page 呈现惯例。

| 能力 | k6 | Locust | vLLM/SGLang | 本项目 | 结论 |
|---|---|---|---|---|---|
| 合格线判定 | thresholds（结束时汇总） | — | — | SLO 徽章**逐项实时**着色 + 判定块 | ✅ 领先 |
| 内容校验 checks | ✓（check 失败率） | — | — | Checks 卡 + 抽屉行：成功但 0 输出 token = 空输出 | ✅ 追平 |
| 尾部分位 | p(90)/p(95) | 50/90/95/99 | P50–P99 全套 | 判定块 P95 + 读数区 P50/P99/mean，抽屉全套 | ✅ 追平 |
| 实时曲线 | ✓ web dashboard | RPS/失败率/响应时间/用户数 | — | SSE 实时波形 + 状态条 | ✅ |
| 在途并发数 | — | ✓ 当前用户数 | — | ❌ 无（需 engine 埋点） | ⏳ 待办 |
| 运行历史时间线 | — | — | — | status-page 式色条（40 条，点击切主视图） | ✅ 独有（绿/黄/红=状态） |
| 指标口径源码级核对 | — | — | 基准 | §12 逐字段核对 + 分位算法零差异 | ✅ 领先 |

### 三轮落地记录

1. **第一轮（k6 / Locust / vLLM 指标呈现）**：新增 Checks 内容校验（`summarize()` 新增
   `checks.empty_output` / `checks.nonempty_rate`，UI 读数卡 + 抽屉行 + 单测）、E2EL P99 读数卡。
2. **第二轮（Grafana / status-page 呈现惯例）**：Runs 页新增运行历史时间线（每格一条运行，
   绿=正常 / 黄=偏慢 / 红=不合格 / 灰=未完成（语义状态色），左旧右新，点击切主视图）。
3. **第三轮（端到端验证）**：mock 上游真实跑 12 请求（并发 2），UI 与 API 逐数字核对一致
   （P95 296.24→296、Checks 1.0→100.0%、RPS 8.11），四徽章达标、时间线着色正确、图表实时。

### Logo 与品牌（2026-09-23 更新）

- **河狸徽标（位图，暖棕点缀）**：圆脸琥珀色调，源图 `beaver-brass-2`（Pollinations flux），已裁水印。UI accent 已切 NVIDIA 标志绿 `#76B900` 纯黑企业深色（2026-09-24 第五版），logo 保持暖调作品牌点缀，不入交互色。
  - `web/logo-rail.png`（128）→ `index.html` `.rail-logo-img` 26px
  - `web/favicon.svg` = 64px PNG base64 内嵌 + 纯黑圆角底（`#000000`）
  - 附加：`favicon-64.png` / `favicon-192.png` 备用
- 改徽标：替换源图 → 重导上述 PNG/SVG → 无需重启（静态目录实时读盘）。

### 对照后待办（按价值排序）

- **在途请求数**：Locust 式实时并发显示，需 engine 在 progress 事件里带 in-flight 计数。
- **错误分类固定语义色**：调色板 series 已避开绿色（bad/warn/info 轮转），但热力/瀑布等自定义色仍需逐图核对。
- **对比表「每 1M token 成本」列**：横评定价时比总价更直接。
- **巡检可用性时间线扩容**：定时巡检产物目前与手动运行混在同一时间线，可单独聚合按天视图。
