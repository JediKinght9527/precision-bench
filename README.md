<p align="center"><img src="assets/logo.svg" width="240" alt="Precision Bench"></p>

<h1 align="center">Precision Bench</h1>

<p align="center"><b>LLM relay API load testing, cache verification, and degradation detection.</b></p>

<p align="center">
  <img alt="CI" src="https://img.shields.io/github/actions/workflow/status/JediKinght9527/precision-bench/ci.yml?branch=main&label=CI">
  <img alt="tests" src="https://img.shields.io/badge/tests-88%20passed-5dd39e">
  <img alt="coverage" src="https://img.shields.io/badge/coverage-64%25-7395be">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-f0b642">
  <img alt="python" src="https://img.shields.io/badge/python-3.11%2B-7395be">
</p>

<p align="center">
  <b><a href="#quick-start">Quick start</a></b> ·
  <a href="#load-testing">Load testing</a> ·
  <a href="#prompt-cache-verification">Cache</a> ·
  <a href="#degradation-detection">Degradation</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<img src="docs/assets/dashboard.png" alt="Precision Bench dashboard" width="100%">

## Overview

Precision Bench is a local dashboard for testing third-party LLM endpoints. It sends real traffic at a channel, measures latency directly from the SSE stream, normalizes the provider's usage fields, and compares later runs against a stored baseline.

- Paste `base_url + api_key + model` (also JSON, curl, labeled tables) — protocol is detected: OpenAI-compatible, Anthropic Messages, OpenRouter.
- Three load modes: closed-loop, open-loop with coordinated-omission correction, and duration.
- Metrics: TTFT, TPOT, ITL, E2E percentiles to P99.9, goodput, success rate, throughput, cost across input / output / cache-read / cache-write.
- Prompt-cache check: usage fields normalized on every run, plus an active fixed-prefix probe that compares hit vs miss TTFT. Verdicts: effective, suspected fake, not reported.
- Degradation check: eight scored dimensions with a per-channel baseline; a score drop or output-fingerprint change raises a verdict.
- Multi-channel comparison, scheduled checks, Feishu/webhook alerts, CSV/JSON/Markdown export, one-click channel verification report.
- SQLite storage (WAL). Runs survive refresh and restart.

## Quick start

Requirements: Python 3.11+ and [uv](https://docs.astral.sh/uv/).

```bash
# dashboard -> http://127.0.0.1:8787
./run.sh

# optional local mock upstream (no real API key needed)
./run_mock.sh
```

Paste into the left panel:

```text
base_url: http://127.0.0.1:8899
api_key: demo
model: gpt-4o
```

Keep the default closed-loop profile, set total requests to `20`, start the run. Full walkthrough: [docs/demo.md](docs/demo.md).

Docker:

```bash
docker compose up -d --build   # -> http://127.0.0.1:8787
```

Run as a launchd service:

```bash
./service.sh install
./service.sh status
./service.sh logs
```

Note: run a single process only — live run state lives in memory. Do not bind `HOST=0.0.0.0` to the public internet; use an authenticated reverse proxy.

## Load testing

| Mode | Mechanism | Use it for |
|---|---|---|
| Closed-loop | *k* workers loop until total requests finish | quality runs, realistic traffic |
| Open-loop | send at `start + i/rate`, report observed and corrected latency | capacity, rate-limit discovery |
| Duration | ramp → steady → cooldown | minute-to-hour stability |

Profiles cover input length distribution, `max_tokens`, `temperature`, `top_p`, system prompts, warmup, retries, and ramp/cooldown. Eight charts: E2E percentile envelope, TTFT, TPOT, throughput, latency heatmap, error timeline, distribution + CDF, multi-channel comparison.

```text
RPS        = successful requests / wall clock   (attempted RPS reported separately)
Goodput    = requests meeting TTFT & TPOT SLO targets / total
corrected  = arrival time - planned send time  (coordinated-omission correction)
```

## Prompt-cache verification

1. Every run normalizes the provider usage fields (including `cache_read` / `cache_creation` for Anthropic-style APIs) and reports token hit rate, hit vs miss counts, hit vs miss TTFT, and cache pricing.
2. An active probe replays the same long prefix N times (write round, then hit rounds), in the background, cancelable, with paginated history. Verdicts: effective / suspected fake / not reported — a relay that counts cached tokens without serving them faster is caught here.

Cache-friendly mode disables request randomization and warms up at least once before sampling, so the first measured request is not a provider-side cache write.

## Degradation detection

| Dimension | Modeled after | Scoring |
|---|---|---|
| Math reasoning | GSM8K / MATH | exact numeric match (last number) |
| Knowledge | MMLU | multiple-choice letter extraction |
| Chinese | C-Eval / CMMLU | multiple-choice letter extraction |
| Instruction following | IFEval | word/char counts, first/last words, banned words |
| Structured output | JSON | parse + type/length validation |
| Code reasoning | HumanEval | exact prediction match |
| Long context | Needle-in-Haystack | constructed at runtime, retrieval hit |
| Self-consistency | — | same question twice, answers must agree |

The first run for a `base_url + model` pair becomes the baseline. Later runs compare total score (default threshold 10pp), per-dimension score, and an output fingerprint (normalized answer hash). Scoring is deterministic code — no judge model.

## Supported providers

| Protocol | Examples | Notes |
|---|---|---|
| OpenAI-compatible | OpenAI, DeepSeek, Qwen, GLM, Moonshot, vLLM, Ollama, most relays | cache usage fields normalized |
| Anthropic Messages | Claude, Bedrock-style relays | `cache_read_input_tokens` / `cache_creation_input_tokens` |
| OpenRouter | any model behind `sk-or-…` | auto-detected, default base URL filled in |

Cache presets (prompt-prefix length) ship for OpenAI, Qwen, DeepSeek, Kimi, GLM, and Anthropic. Per-model pricing feeds the cost cards.

## Metric definitions

`t0` request sent · `tf` first content token · `tl` last token · `N` output tokens.

| Metric | Formula | Notes |
|---|---|---|
| TTFT | `tf − t0` | skips role / ping / comment frames |
| E2E | `tl − t0` | end-to-end latency |
| TPOT | `(tl − tf)/(N−1)` | aligns with vLLM/MLPerf |
| ITL | mean / P99 of adjacent chunk gaps | decode jitter |
| Throughput | `N/(tl−tf)` | decode rate only |
| Percentiles | P50/90/95/99/99.9 | linear interpolation (not HDR) |

Token counts come from the API `usage` object when present; otherwise tiktoken is used and the UI labels the value as an estimate. Warmup requests (default 3) are excluded from statistics. Full reference including the error taxonomy and API table: [README.zh-CN.md](README.zh-CN.md#指标口径ui-内亦可复算).

## Documentation

| Guide | When you need it |
|---|---|
| [docs/demo.md](docs/demo.md) | first five minutes with the local mock upstream |
| [README.zh-CN.md](README.zh-CN.md) | full reference: features, metric formulas, API table (Chinese) |
| [DESIGN.md](DESIGN.md) | UI tokens, component states, chart rules, accessibility |
| [CONTRIBUTING.md](CONTRIBUTING.md) | dev setup, test commands, PR expectations |
| [SECURITY.md](SECURITY.md) | key handling and vulnerability reporting |
| [CHANGELOG.md](CHANGELOG.md) | what changed between versions |
| [docs/releasing.md](docs/releasing.md) | release checklist |

## Project layout

```
server/   main.py (FastAPI + SSE) · engine.py (scheduling / CO correction)
          providers.py (3 protocols) · parse.py · metrics.py · stats.py
          store.py (SQLite) · cachecheck.py · scheduler.py · notifier.py
web/      index.html · app.js · bench.js · ui.js · style.css (zero build step,
          ECharts bundled locally, no external CDN)
tests/    mock upstream + unit / end-to-end suite
docs/     demo, release checklist, assets
```

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
uv sync --frozen --group dev
uv run --frozen pytest          # 88 tests, coverage gate 55%
```

## Security

- API keys are not written to the database and are stripped from API responses and exports.
- Model-list requests send the key in the body, never in a URL.
- See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
