"""lm-eval-harness 接入：跑官方数据集（MMLU / GSM8K / C-Eval / ARC / HellaSwag / TruthfulQA）。

为什么用 lm-eval 而不是自建题集：
  自建题集的分数不可与公开榜对比，供应商一句"样本太小/题目不对"就能推翻结论。
  lm-eval 是事实标准，题集、prompt 模板、few-shot、判分逻辑都由它保证。

设计要点：
  - 只做**生成式**任务的默认集（gsm8k / mmlu_generative），任何端点都能跑；
    loglikelihood 类任务（mmlu / ceval-valid / arc / hellaswag / truthfulqa）需要
    端点支持 logprobs，作为可选并在前端标注。
  - 逐题结果从 `samples_*.jsonl` 取：doc_id → item_id，判分 → passed，
    这样能直接复用现有的基线/指纹/趋势，并支持**配对检验**（lm-eval 自己不提供）。
"""

from __future__ import annotations

import asyncio
import glob
import json
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Any, Callable

from .schemas import Provider, Target

ROOT = Path(__file__).resolve().parent.parent
OUT_ROOT = ROOT / "data" / "lm_eval"
HF_MIRROR = "https://hf-mirror.com"

# 任务注册表：logprobs=True 的必须端点支持 logprobs（Anthropic 不支持）
TASKS: dict[str, dict[str, Any]] = {
    "gsm8k": {
        "label": "GSM8K",
        "dim": "math",
        "metric": "exact_match",
        "fewshot": 5,
        "logprobs": False,
        "desc": "小学数学应用题，答案取数值精确匹配",
    },
    "mmlu_generative": {
        "label": "MMLU (生成式)",
        "dim": "knowledge",
        "metric": "exact_match",
        "fewshot": 5,
        "logprobs": False,
        "desc": "57 学科选择题，生成式判分，无需 logprobs",
    },
    "mmlu": {
        "label": "MMLU",
        "dim": "knowledge",
        "metric": "acc",
        "fewshot": 5,
        "logprobs": True,
        "desc": "标准 MMLU，逐选项算似然（需端点支持 logprobs）",
    },
    "ceval-valid": {
        "label": "C-Eval",
        "dim": "chinese",
        "metric": "acc",
        "fewshot": 5,
        "logprobs": True,
        "desc": "中文综合能力（需 logprobs）",
    },
    "arc_challenge": {
        "label": "ARC-Challenge",
        "dim": "knowledge",
        "metric": "acc_norm",
        "fewshot": 25,
        "logprobs": True,
        "desc": "科学推理（需 logprobs）",
    },
    "hellaswag": {
        "label": "HellaSwag",
        "dim": "knowledge",
        "metric": "acc_norm",
        "fewshot": 10,
        "logprobs": True,
        "desc": "常识续写（需 logprobs）",
    },
    "truthfulqa_mc2": {
        "label": "TruthfulQA",
        "dim": "truthfulness",
        "metric": "acc",
        "fewshot": 0,
        "logprobs": True,
        "desc": "真实性（需 logprobs）",
    },
}

# 默认可选：不依赖 logprobs
DEFAULT_TASKS = ["gsm8k", "mmlu_generative"]


def lm_eval_bin() -> str | None:
    """定位 lm-eval 可执行文件（服务在 launchd 下 PATH 极简，必须用绝对路径）。"""
    cand = Path(sys.executable).parent / "lm-eval"
    if cand.exists():
        return str(cand)
    return shutil.which("lm-eval")


def available() -> bool:
    return lm_eval_bin() is not None


def version() -> str:
    try:
        import importlib.metadata as md

        return md.version("lm_eval")
    except Exception:
        return "unknown"


# 各任务背后的 HF 数据集（预下载用；走 hf-mirror 镜像）
DATASETS: dict[str, list[tuple[str, str | None]]] = {
    "gsm8k": [("openai/gsm8k", "main")],
    "mmlu_generative": [("cais/mmlu", "all")],
    "mmlu": [("cais/mmlu", "all")],
    "ceval-valid": [("ceval/ceval-exam", "computer_network")],
    "arc_challenge": [("allenai/ai2_arc", "ARC-Challenge")],
    "hellaswag": [("Rowan/hellaswag", None)],
    "truthfulqa_mc2": [("truthfulqa/truthful_qa", "multiple_choice")],
}


def dataset_specs(tasks: list[str]) -> list[tuple[str, str | None]]:
    out: list[tuple[str, str | None]] = []
    for t in tasks:
        for spec in DATASETS.get(t, []):
            if spec not in out:
                out.append(spec)
    return out


def list_tasks() -> list[dict[str, Any]]:
    return [{"task": k, **{kk: vv for kk, vv in v.items()}} for k, v in TASKS.items()]


def _endpoint(target: Target) -> str:
    base = target.base_url.rstrip("/")
    if target.provider == Provider.anthropic:
        p = "/v1/messages"
    else:
        p = "/v1/chat/completions"
    if base.endswith("/v1") and p.startswith("/v1"):
        p = p[3:]
    return base + p


def build_cmd(
    target: Target, tasks: list[str], opts: dict[str, Any], out_dir: Path
) -> list[str]:
    bin_ = lm_eval_bin()
    if not bin_:
        raise RuntimeError("未安装 lm-eval，请执行 uv add 'lm_eval[api]'")
    limit = int(opts.get("limit", 200))
    fewshot = opts.get("fewshot")  # None → 用任务默认
    seed = str(opts.get("seed", 42))
    concurrent = int(opts.get("num_concurrent", 8))

    if target.provider == Provider.anthropic:
        model = "anthropic-chat"
        args = f"model={target.model},api_key={target.api_key},max_tokens={int(opts.get('max_tokens', 512))}"
        if target.base_url and "api.anthropic.com" not in target.base_url:
            args += f",base_url={target.base_url}"
    else:
        model = "local-chat-completions"
        args = (
            f"base_url={_endpoint(target)},model={target.model},"
            f"api_key={target.api_key},num_concurrent={concurrent},"
            f"max_tokens={int(opts.get('max_tokens', 512))}"
        )

    cmd = [
        bin_,
        "run",
        "--model",
        model,
        "--model_args",
        args,
        "--tasks",
        ",".join(tasks),
        "--limit",
        str(limit),
        "--seed",
        seed,
        "--apply_chat_template",
        "--log_samples",
        "--output_path",
        str(out_dir / "result.json"),
    ]
    if fewshot is not None:
        cmd += ["--num_fewshot", str(int(fewshot))]
    return cmd


# 用 python -c + LMEVAL_ARGV 启动：api_key 在环境变量里，不进 ps 的 argv
_LAUNCH_CODE = (
    "import json, os, sys\n"
    "from lm_eval.__main__ import cli_evaluate\n"
    "sys.argv = json.loads(os.environ['LMEVAL_ARGV'])\n"
    "cli_evaluate()\n"
)

_CMD_KEY_RE = re.compile(r"api_key=[^,\s\"]+")


def _scrub_cmd_text(s: str) -> str:
    """SSE 展示用：把 model_args 里的 key 打码。"""
    return _CMD_KEY_RE.sub("api_key=***", s)


def scrub_dir(out_dir: Path) -> int:
    """清洗 result/samples 落盘文件里的 api_key（parse 前必调）。"""
    n = 0
    json_re = re.compile(r'("api_key"\s*:\s*")([^"]*)(")')
    kv_re = re.compile(r"(api_key=)([^,\s\"]+)")
    for p in list(out_dir.rglob("*.json")) + list(out_dir.rglob("*.jsonl")):
        try:
            text = p.read_text(encoding="utf-8")
        except Exception:
            continue
        new = json_re.sub(r"\1***\3", text)
        new = kv_re.sub(r"\1***", new)
        if new != text:
            try:
                p.write_text(new, encoding="utf-8")
                n += 1
            except Exception:
                pass
    return n


def _env() -> dict[str, str]:
    env = dict(os.environ)
    env["HF_ENDPOINT"] = HF_MIRROR  # 国内必须走镜像
    env["PYTHONUNBUFFERED"] = "1"
    env["TOKENIZERS_PARALLELISM"] = "false"
    # launchd 下 PATH 很干净，补上 venv bin 避免子进程找不到东西
    env["PATH"] = f"{Path(sys.executable).parent}:{env.get('PATH', '/usr/bin:/bin')}"
    return env


_TQDM_RE = re.compile(r"(\d+)%\|")
_TASK_RE = re.compile(r"Building contexts for (\S+)")
_RUNNING_RE = re.compile(r"Running (generate_until|loglikelihood) requests")


async def run(
    target: Target,
    tasks: list[str],
    opts: dict[str, Any],
    run_id: str,
    on_event: Callable[[dict], None],
    should_stop: Callable[[], bool],
) -> dict[str, Any]:
    """执行 lm-eval 并把进度回调出去；返回解析后的结果。"""
    out_dir = OUT_ROOT / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = build_cmd(target, tasks, opts, out_dir)
    on_event(
        {
            "type": "phase",
            "phase": "lm_eval",
            "state": "starting",
            "tasks": tasks,
            "cmd": _scrub_cmd_text(" ".join(cmd[:6]) + " …"),
        }
    )

    env = _env()
    env["LMEVAL_ARGV"] = json.dumps(cmd, ensure_ascii=False)
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        _LAUNCH_CODE,
        cwd=str(ROOT),
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )

    cur_task = tasks[0] if tasks else ""
    last_pct = -1
    buf = ""
    try:
        assert proc.stdout
        while True:
            if should_stop() and proc.returncode is None:
                proc.terminate()
                break
            chunk = await proc.stdout.read(512)
            if not chunk:
                break
            buf += chunk.decode("utf-8", "replace")
            # tqdm 用 \r 刷新，必须同时按 \r 和 \n 切
            parts = re.split(r"[\r\n]", buf)
            buf = parts.pop()
            for line in parts:
                m = _TASK_RE.search(line)
                if m:
                    cur_task = m.group(1)
                    last_pct = -1
                if _RUNNING_RE.search(line):
                    on_event(
                        {
                            "type": "phase",
                            "phase": "lm_eval",
                            "state": "running",
                            "task": cur_task,
                        }
                    )
                p = _TQDM_RE.search(line)
                if p:
                    pct = int(p.group(1))
                    if pct != last_pct:
                        last_pct = pct
                        on_event(
                            {
                                "type": "phase",
                                "phase": "lm_eval",
                                "state": "progress",
                                "task": cur_task,
                                "percent": pct,
                            }
                        )
        await proc.wait()
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()

    if should_stop():
        on_event({"type": "phase", "phase": "lm_eval", "state": "stopped"})

    scrub_dir(out_dir)
    return parse(out_dir, tasks, opts)


# --------------------------------------------------------------------------
# 解析
# --------------------------------------------------------------------------
def _pick_metric(res: dict, want: str) -> tuple[float | None, float | None, str]:
    """从任务结果里挑指标值。lm-eval 的键形如 `exact_match,flexible-extract`。"""
    keys = [k for k in res if k.startswith(want) and not k.endswith("_stderr")]
    if not keys:
        return None, None, ""
    keys.sort(key=lambda k: (0 if "flexible" in k else 1 if "none" in k else 2, k))
    key = keys[0]
    val = res.get(key)
    err = res.get(f"{key}_stderr")
    return (
        float(val) if val is not None else None,
        float(err) if err is not None else None,
        key,
    )


def _item_passed(rec: dict, metric: str) -> bool:
    """逐题是否正确：优先取同名指标，缺失时看 metrics 里是否全 1。"""
    for k in (metric, metric.split(",")[0]):
        if k in rec and rec[k] is not None:
            return float(rec[k]) > 0.5
    ms = rec.get("metrics") or []
    if ms:
        try:
            return all(float(m) > 0.5 for m in ms)
        except Exception:
            return False
    return False


def _load_samples(out_dir: Path) -> dict[str, dict[str, Any]]:
    """读取目录下所有 samples_*.jsonl，按**叶子任务名**归组。

    组任务（如 mmlu_generative）会产出几十个 samples 文件（每个学科一个），
    文件名里带的是叶子任务名，所以不能按请求的任务名直接匹配。
    """
    out: dict[str, dict[str, Any]] = {}
    names = sorted(glob.glob(str(out_dir / "**" / "*samples*.jsonl"), recursive=True))
    for f in names:
        m = re.match(
            r"samples_(.+?)_(\d{4}-\d{2}-\d{2}T[\d.\-]+)\.jsonl$", Path(f).name
        )
        leaf = m.group(1) if m else Path(f).stem.replace("samples_", "")
        metric = "exact_match"
        # 从结果 JSON 反查该叶子的指标名（acc / acc_norm / exact_match）
        rec = out.setdefault(leaf, {"items": {}, "got": {}})
        try:
            for line in Path(f).read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                r = json.loads(line)
                ok = _item_passed(r, metric)
                doc = str(r.get("doc_id"))
                rec["items"][doc] = ok
                fr = r.get("filtered_resps") or r.get("resps") or []
                try:
                    rec["got"][doc] = str(fr[0])[:300] if fr else ""
                except Exception:
                    rec["got"][doc] = ""
        except Exception:
            continue
    return out


def _leaves(
    task: str, subtasks: dict[str, list[str]], seen: set | None = None
) -> list[str]:
    """把组任务递归展开成叶子任务列表（mmlu_generative → 57 个学科）。"""
    seen = seen or set()
    if task in seen:
        return []
    seen.add(task)
    subs = subtasks.get(task) or []
    if not subs:
        return [task]
    out: list[str] = []
    for s in subs:
        out += _leaves(s, subtasks, seen)
    return out


def parse(
    out_dir: Path, tasks: list[str], opts: dict[str, Any] | None = None
) -> dict[str, Any]:
    """把结果 JSON + 逐题 JSONL 归一成内部结构。"""
    files = [
        f
        for f in sorted(glob.glob(str(out_dir / "*.json")))
        if not f.endswith(".jsonl")
    ]
    if not files:
        raise RuntimeError("lm-eval 未产出结果文件")
    data = json.loads(Path(files[-1]).read_text(encoding="utf-8"))
    results: dict = data.get("results", {})
    subtasks: dict = data.get("group_subtasks", {})
    config: dict = data.get("config", {})
    all_samples = _load_samples(out_dir)

    dims: dict[str, dict[str, Any]] = {}
    items: list[dict] = []
    for task in tasks:
        meta = TASKS.get(task, {"label": task, "dim": task, "metric": "exact_match"})
        res = results.get(task) or {}
        want = meta["metric"]
        val, err, key = _pick_metric(res, want)
        if val is None:
            for alt in ("exact_match", "acc_norm", "acc"):
                val, err, key = _pick_metric(res, alt)
                if val is not None:
                    break

        leaves = _leaves(task, subtasks) if task in subtasks else [task]
        per_item: dict[str, bool] = {}
        got: dict[str, str] = {}
        for leaf in leaves:
            sm = all_samples.get(leaf)
            if not sm:
                continue
            for doc, ok in sm["items"].items():
                per_item[f"{leaf}:{doc}"] = (
                    ok  # 叶子名+doc_id，避免不同学科 doc_id 冲突
                )
                got[f"{leaf}:{doc}"] = sm["got"].get(doc, "")

        n = len(per_item)
        k = sum(1 for v in per_item.values() if v)
        dims[meta["dim"]] = {
            "name": meta["label"],
            "bench": f"lm-eval:{task}",
            "task": task,
            "metric": key or want,
            "score": round(val, 4)
            if val is not None
            else (round(k / n, 4) if n else 0.0),
            "stderr": round(err, 4) if err is not None else None,
            "n": n,
            "passed": k,
            "total": n,
            "report_n": res.get("sample_len"),
            "leaves": len(leaves),
            "logprobs_required": bool(meta.get("logprobs")),
        }
        for iid in sorted(per_item):
            items.append(
                {
                    "dim": meta["dim"],
                    "item_id": iid,
                    "passed": per_item[iid],
                    "detail": f"lm-eval {task}",
                    "got": got.get(iid, ""),
                    "expected": "",
                }
            )

    # n-shot 在结果里是逐子任务的字典，这里收敛成"本次请求任务的"那个值
    nshot_raw = data.get("n-shot") or {}
    fewshot = None
    if isinstance(nshot_raw, dict):
        for t in tasks:
            if t in nshot_raw:
                fewshot = nshot_raw[t]
                break
        if fewshot is None:
            vals = [v for k, v in nshot_raw.items() if "::" not in k]
            fewshot = max(vals) if vals else None
    else:
        fewshot = nshot_raw

    return {
        "engine": "lm_eval",
        "lm_eval_version": data.get("lm_eval_version") or version(),
        "config": {
            "fewshot": fewshot,
            "limit": config.get("limit"),
            "seed": (opts or {}).get("seed", 42),
            "model_args": {
                k: v
                for k, v in (config.get("model_args") or {}).items()
                if k not in ("api_key",)
            },  # 不落库密钥
            "eval_seconds": data.get("total_evaluation_time_seconds"),
        },
        "dims": dims,
        "items": items,
    }
