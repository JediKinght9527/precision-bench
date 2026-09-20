"""验证：本工具的解析结果 vs lm-eval 官方报告，必须逐位一致。

比对三项：
  1) 维度分数 == 结果 JSON 里该任务的指标值
  2) 样本数 == 结果 JSON 里的 sample_len
  3) 逐题通过数 / 样本数 == 由 JSONL 重算的结果
"""

import glob
import json
import sys
from pathlib import Path

sys.path.insert(0, ".")
from server import lm_eval_runner as L

DIRS = sys.argv[1:] or sorted(
    str(p) for p in Path("data/lm_eval").iterdir() if p.is_dir()
)
bad = 0
checked = 0
for d in DIRS:
    p = Path(d)
    jsons = [f for f in glob.glob(str(p / "*.json")) if not f.endswith(".jsonl")]
    if not jsons:
        continue
    raw = json.loads(Path(jsons[-1]).read_text())
    results = raw.get("results", {})
    groups = raw.get("group_subtasks", {})

    # 推断本次请求了哪些任务：结果键里命中注册表的就是（组任务也会出现）
    requested = [k for k in results if k in L.TASKS]
    requested = list(dict.fromkeys(requested))
    if not requested:
        continue

    parsed = L.parse(p, requested, {"seed": 42})
    for task in requested:
        meta = L.TASKS[task]
        dim = meta["dim"]
        got = parsed["dims"].get(dim)
        if not got:
            print(f"  ✗ {task}: 解析未产出维度 {dim}")
            bad += 1
            continue
        res = results.get(task, {})
        want_val, _, key = L._pick_metric(res, meta["metric"])
        if want_val is None:
            continue
        checked += 1
        ok_val = abs(got["score"] - want_val) < 1e-9
        ok_n = got["n"] == res.get("sample_len")
        recomputed = (got["passed"] / got["n"]) if got["n"] else 0.0
        ok_re = abs(recomputed - want_val) < 1e-9
        flag = "✓" if (ok_val and ok_n and ok_re) else "✗"
        if flag == "✗":
            bad += 1
        print(
            f"  {flag} {task:22s} 本工具={got['score']:.4f} 官方={want_val:.4f} "
            f"| n={got['n']} 官方 sample_len={res.get('sample_len')} "
            f"| 逐题重算={recomputed:.4f} (指标键 {key})"
        )

print()
print(
    f"比对 {checked} 个任务，不一致 {bad} 个 →",
    "✓ 与 lm-eval 官方报告完全一致" if bad == 0 else "✗ 存在差异",
)
sys.exit(1 if bad else 0)
