# LLM Bench

第三方 **LLM 中转 API** 性能 / 稳定性测试平台。粘贴供应商给的 `base_url + api_key + model` 即可测，**不打分**，只输出可复算的原始指标与深色波形图。

- 协议：**OpenAI 兼容** + **Anthropic Messages**
- 形态：本地服务 + 高级黑玻璃仪表盘（海狸徽标、Apple 风毛玻璃、大圆角、信号绿强调；ECharts 本地化，零外网依赖）
- 模式：并发（closed-loop）/ 定频（open-loop，**含 coordinated omission 修正**）/ 时长（长时稳定性）
- 批量：多个供应商一键横评叠加；定时巡检 + Webhook/飞书告警
- 存储：SQLite（WAL），长跑持久化、断线可恢复

## 功能一览

| 功能 | 说明 |
|---|---|
| 粘贴即测 | 三件套 / JSON / curl / 中文标签 / 多供应商分隔，自动识别协议 |
| 探活测速 | 单次请求，返回 TTFT / E2E / TPOT / **DNS·TCP·TLS 分段耗时** / in·out token |
| 拉取模型 | 查询上游 `/v1/models`，确认可用模型与渠道真伪 |
| 三种负载 | 并发 / 定频（CO 修正）/ 时长；可配预热、重试、抖动、代理、TLS |
| 场景化流量 | 输入长度分布（固定/均匀/正态）、max_tokens、temperature |
| 反识别 | prompt 随机化 + 长度可变 + 定时抖动，降低被供应商识别优待 |
| 8 张波形图 | E2E 分位包络、TTFT、TPOT、吞吐、延迟热力图、错误时间轴、分布+CDF、多供应商横评 |
| 指标卡 | 请求/成功率/Goodput/RPS/延迟分位/吞吐/**成本**，带实时 sparkline |
| SLO 徽章 | 判定块下四枚徽章（成功率/TTFT/TPOT/E2EL）逐项对着合格线着色：达标绿、偏慢黄、超线红、不可测灰 |
| 对比表 | 多供应商横向对比，最优绿/最差红，一眼看出差距 |
| 实时日志 | 失败样本、运行事件、探活结果滚动输出 |
| 历史恢复 | 刷新/重启后自动载入最近 8 条运行，图表续看 |
| 导出 | CSV 原始样本 / JSON 汇总 / **Markdown 报告** |
| 定时巡检 | cron 周期任务；告警规则（成功率、延迟、连续失败）+ 飞书/Webhook |
| 成本估算 | 填 输入/输出 ¥每百万 token，自动算每请求与总额 |
| 桌面通知 | 运行结束浏览器通知 |
| 快捷键 | `⌘/Ctrl+Enter` 开始 · `⌘/Ctrl+K` 解析 |
| 缓存指标 | 兼容 OpenAI / Anthropic / DeepSeek / Kimi 四种结构；报命中率与**命中 vs 未命中的 TTFT 对比** |
| 缓存检测 | 同一长前缀串行 N 次主动验证：揪出「上报命中但不加速」的假缓存；判定 有效/疑似假缓存/未上报；历史 + 基线对比 |
| 指标口径 | 顶栏 `?` 一键查看全部指标定义 |

---

> 前端设计与实现约定见 **[DESIGN.md](./DESIGN.md)**（令牌、组件六态、图表规范、无障碍硬性要求、验收清单）。

## 界面

单页仪表盘，左侧展开式海狸导航（172px，`≤1080px` 自动折叠为图标条）切换两个视图（`/` 处；`/bench` 重定向到 `/#bench`）：

| 视图 | 用途 |
|---|---|
| **性能压测** | 延迟 / 吞吐 / 稳定性 波形图、探活测速、拉模型、成本、定时巡检 |
| **降智检测** | 能力探测、自动判分、基线对比、降智判定 |

- **可折叠配置栏**：`⌘/Ctrl+B` 或顶栏按钮收起；点「开始测试」后自动收起，图表占满全宽（状态记忆）
- **仪表盘栅格**：主次分明——E2E 主图占 8×2 大位，TTFT/TPOT 右侧堆叠，吞吐/分布、热力/错误按 8+4 配对，横评通栏；面板随窗口自适应（ResizeObserver）
- **首屏空态**：无运行时显示引导卡（打开配置 / 填入示例），不再是空白图表墙
- **面板化**：每张图表是独立面板，hover 出现菜单（全屏 / 导出 PNG），空数据居中显示 No data（无错误时显示「无错误」）
- **Stat 面板**：单行等高对齐，大数值 + 单位 + sparkline + 阈值配色（超阈变红/黄）
- **顶栏**：时间范围、自动刷新、服务状态、实时时钟、命令面板
- **表格**：粘性表头、点击列排序、关键字筛选、行点击开运行详情抽屉
- **命令面板**：`⌘/Ctrl + K` 唤起，可执行命令或跳转运行
- **反馈**：Toast 通知、危险操作二次确认、运行详情抽屉（含导出）

前端零构建：`echarts` 本地化，`ui.js` 为共享组件层，`app.js` / `bench.js` 为两个视图模块。

## 降智检测（模型降智 / 换模 / 量化降级）

针对"模型悄悄降智、被换成廉价或量化版本"的问题，内置一套**可自动判分**的探测集，
跑完给每维度准确率 + 输出指纹 + 与基线的差值，自动给出「正常 / 疑似降智」。

| 维度 | 对齐 benchmark | 判分方式 |
|---|---|---|
| 数学推理 | GSM8K / MATH | 数值精确匹配（取末尾数字，避免中间值误判）|
| 知识选择 | MMLU | 单选字母提取 |
| 中文能力 | C-Eval / CMMLU | 单选字母提取 |
| 指令遵循 | IFEval | 词数 / 字数 / 首尾词 / 禁用词 / 列表项数 |
| 结构化输出 | JSON | JSON 解析 + 字段/类型/长度校验 |
| 代码推理 | HumanEval | 预测输出精确匹配 |
| 长上下文检索 | Needle-in-Haystack | 运行时按长度构造，校验检索命中（暴露上下文截断）|
| 自洽性 | Self-consistency | 同题两问，输出须一致（低温非确定性）|

**判定逻辑**
- 同一 `base_url + model` **首次运行自动记为基线**；后续与之对比。
- 总分下降 ≥ 阈值（默认 10pp）或任一维度下降 ≥ 阈值 → **疑似降智**。
- 输出**指纹**（归一化答案哈希）变化会单独标注——即使分数接近，指纹突变也提示换模。
- 全流程无主观打分，判分完全由代码完成，可复算。

> 题集为自建 curated 子集，思路对齐上述 benchmark，非官方数据集，避免版权与体积问题。

## 快速开始

```bash
# 1) 启动仪表盘
./run.sh                      # → http://127.0.0.1:8787

# 2)（可选）本地假上游，用来验证工具本身
./run_mock.sh                 # → http://127.0.0.1:8899
#    在左侧粘贴：
#    base_url: http://127.0.0.1:8899
#    api_key: sk-x
#    model: gpt-4o
```

依赖由 `uv` 管理（Python 3.12），首次 `./run.sh` 会自动同步。

### 作为常驻服务运行（macOS）

```bash
./service.sh install     # 安装 launchd 服务：开机自启 + 崩溃自动重启
./service.sh status      # 查看状态与健康检查
./service.sh logs        # 跟踪日志
./service.sh restart     # 重启
./service.sh uninstall   # 卸载并停止
```

- 日志：`~/Library/Logs/llm-bench.log`（错误另见 `llm-bench.err.log`）
- 改端口：`PORT=9000 ./service.sh install`；要给局域网访问：`HOST=0.0.0.0 ./service.sh install`
- ⚠️ **必须单进程**：运行状态（Engine / BenchManager / SSE 订阅）在进程内存里，不要加多 worker
- 可用 `LLMBENCH_DB=/path/to.db ./run.sh` 起独立实例或重置数据
- 访问日志默认关闭（`--no-access-log`），只留异常；否则 5 秒一次的健康检查会灌满日志
- 已结束的运行在内存中最多保留 40 个（`KEEP_FINISHED`），长期运行不会累积；历史数据始终在 SQLite 里

---

## 指标口径（UI 内亦可复算）

令 `t0`=请求发出，`tf`=首个内容 token 到达，`tl`=末 token 到达，`N`=输出 token 数。

| 指标 | 公式 | 说明 |
|---|---|---|
| TTFT | `tf − t0` | 首字延迟，跳过 role / ping / 注释帧 |
| E2E | `tl − t0` | 端到端延迟 |
| TPOT | `(tl − tf)/(N−1)` | 每 token 时间，对齐 vLLM/MLPerf 口径 |
| ITL | 相邻 chunk 间隔的 mean / P99 | 解码抖动 |
| 吞吐 | `N/(tl−tf)` tok/s | 纯解码速率 |
| 分位 | P50/90/95/99/99.9 | **HDR Histogram**（非朴素排序） |
| Goodput | `count(TTFT≤SLO₁ ∧ TPOT≤SLO₂)/total` | SLO 达标吞吐 |
| corrected | 定频模式下 `到达 − 计划发出时刻` | **CO 修正**，暴露被并发/排队掩盖的尾延迟 |

- **token 计数**：优先取 API `usage`；缺失时 tiktoken 回退，UI 标注「估算」。
- **时钟**：延迟用 `time.perf_counter()` 单调时钟，杜绝墙钟漂移。
- **预热**：默认 3 次，不计入统计。
- **错误分类**：auth / rate_limit / overloaded / invalid_request / model_not_found / context_length / content_filter / server_error / timeout / connect_error / tls_error / empty_response / stream_interrupted。

---

## 负载模式

| 模式 | 机制 | 用途 |
|---|---|---|
| 并发 closed-loop | k 个 worker 循环发，`总请求数` 收敛 | 评质量、贴近真实用户 |
| 定频 open-loop | 按计划时刻 `start + i/rate` 发，抖动可选；同时报 `observed` 与 `corrected` | 压容量、测限流 |
| 时长 duration | ramp → steady → cooldown | 分钟~小时级稳定性 |

> 定频模式下 `并发` 是「在途请求上限」。默认 32，可按需调整。

## 场景化流量 / 反识别

- 输入长度分布：固定 / 均匀 / 正态；输出长度用 `max_tokens` 约束。
- 反识别：请求前缀随机化、长度可变、可选定时抖动，降低被供应商识别并优待压测流量的概率。

---

## 竞品定位

调研（2026-09）显示，全网无「主动压测 + 通用粘贴即测 + OpenAI/Anthropic 双协议 + 长时稳定性 + 多供应商横评 + 深色波形图」六合一工具：

- LLM 专用压测（EvalScope / vLLM bench / SGLang / GenAI-Perf）：指标专业但面向自建推理、**仅 OpenAI 协议**、CLI、无长时看板。
- 通用压测（k6 / Locust / wrk2 / Gatling / JMeter）：负载模型成熟但**不懂 SSE 语义**，无 TTFT/token，需写脚本。
- 网关/监控（New API / LiteLLM / Helicone / Uptime Kuma）：只做被动观测或单次探测，不主动压测。

本工具方法学对齐 wrk2（CO 修正）与 vLLM/EvalScope（指标口径）。

---

## 目录

```
server/  main.py(FastAPI+SSE) engine.py(调度/CO) providers.py(双协议打点)
         parse.py(粘贴解析) metrics.py stats.py(HDR/LTTB) store.py(SQLite)
         scheduler.py(定时) notifier.py(告警) schemas.py mock? no → tests/
web/     index.html app.js style.css echarts.min.js
tests/   mock_upstream.py + 单测/端到端
data/    bench.db
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/parse` | 解析粘贴文本为 targets |
| POST | `/api/probe` | 单次探活测速（含 DNS/TCP/TLS 分段）|
| GET/POST | `/api/targets/models` | 查询上游模型列表 |
| GET | `/api/compare?ids=a,b,c` | 多运行对比汇总 |
| POST | `/api/runs` | 启动测试（每 target 一个 run）|
| GET | `/api/runs` | 运行列表 |
| GET | `/api/runs/{id}` | 详情 + 汇总 |
| GET | `/api/runs/{id}/stream` | SSE 实时指标 |
| GET | `/api/runs/{id}/series` | 降采样波形数据 |
| GET | `/api/runs/{id}/export.csv` / `.json` / `.md` | 导出（CSV / JSON / Markdown 报告）|
| POST | `/api/runs/{id}/stop` / `pause` / `resume` | 控制 |
| GET/POST/DELETE | `/api/schedules` | 定时巡检 |
| GET | `/api/alerts` | 告警记录 |
| GET | `/api/bench/datasets` | 降智检测维度与题量 |
| POST | `/api/bench/run` | 启动降智检测（每 target 一个 run）|
| GET | `/api/bench/runs` / `/api/bench/runs/{id}` | 记录列表 / 明细（含逐题结果）|
| GET | `/api/bench/runs/{id}/stream` | SSE 逐题进度 |
| POST | `/api/bench/runs/{id}/baseline` / `/stop` | 设为基线 / 停止 |
| GET | `/api/bench/baselines` | 已有基线 |

## 测试

```bash
uv run pytest -q
```

- `test_parse.py`：三件套 / JSON / curl / 中文标签 / 多供应商。
- `test_metrics.py`：分位、Goodput、错误分类。
- `test_instrumentation.py`：用可控延迟假上游断言 **TTFT/TPOT 打点误差**。
- `test_engine.py`：并发、**CO 修正**、重试不掩盖失败、持久化。

## 安全

- **api_key 不落库**：`runs.params_json` 写入前剔除 `targets[].api_key`；历史行由启动时 `_migrate` 幂等清洗。
- **API 出口脱敏**：`GET /api/runs/{id}`、`export.json`、`export.md`、`GET /api/schedules` 递归剔除 `api_key`。`schedules.config_json` 在 DB 保留 key 供调度器加载，仅出口脱敏。
- **模型列表**：`POST /api/targets/models`（key 走 body）。**无 GET query 版本**（key 不进 URL/浏览器历史/代理日志）。
- **lm-eval**：key 经 `LMEVAL_ARGV` 环境变量传入子进程（不进 `ps` argv）；SSE `cmd` 展示正则打码；`parse` 前 `scrub_dir` 清洗 result/samples 落盘文件。
- `base_url` 落库用 `base_url_masked`（`user:pass@` → `***@`）；`data/` 已在 `.gitignore` 排除。
- 支持每任务独立代理（国内直连 / `http://127.0.0.1:7890`）与 TLS 校验开关。
