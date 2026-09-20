"""lm-eval 结果解析单测：组任务展开、逐题归一、指标挑选、密钥不落库。"""

from __future__ import annotations

import json

from server import lm_eval_runner as L


def _write_run(tmp_path, results, subtasks, samples, nshot=None):
    out = tmp_path
    (out / "result_2026-01-01T00-00-00.000000.json").write_text(
        json.dumps(
            {
                "results": results,
                "group_subtasks": subtasks,
                "n-shot": nshot or {},
                "config": {
                    "limit": 3.0,
                    "model_args": {
                        "base_url": "http://x",
                        "model": "m",
                        "api_key": "SECRET",
                    },
                },
                "lm_eval_version": "9.9.9",
                "total_evaluation_time_seconds": 1.5,
            }
        ),
        encoding="utf-8",
    )
    for leaf, items in samples.items():
        lines = []
        for doc, ok in items.items():
            lines.append(
                json.dumps(
                    {
                        "doc_id": int(doc),
                        "target": "T",
                        "filtered_resps": [f"resp{doc}"],
                        "exact_match": 1.0 if ok else 0.0,
                    }
                )
            )
        (out / f"samples_{leaf}_2026-01-01T00-00-00.000000.jsonl").write_text(
            "\n".join(lines), encoding="utf-8"
        )
    return out


def test_parse_leaf_task(tmp_path):
    out = _write_run(
        tmp_path,
        results={
            "gsm8k": {
                "sample_len": 2,
                "exact_match,flexible-extract": 0.5,
                "exact_match_stderr,flexible-extract": 0.25,
            }
        },
        subtasks={},
        samples={"gsm8k": {"0": True, "1": False}},
        nshot={"gsm8k": 5},
    )
    r = L.parse(out, ["gsm8k"], {"seed": 7})
    d = r["dims"]["math"]
    assert d["name"] == "GSM8K"
    assert d["score"] == 0.5 and d["n"] == 2 and d["passed"] == 1
    assert d["metric"].startswith("exact_match") and "flexible" in d["metric"]
    assert len(r["items"]) == 2
    assert r["config"]["seed"] == 7 and r["config"]["fewshot"] == 5
    assert r["config"]["model_args"]["model"] == "m"
    # 密钥绝不能被落库/返回
    assert "api_key" not in r["config"]["model_args"]


def test_parse_group_task_expands_leaves(tmp_path):
    """组任务（MMLU 风格）要把多个叶子任务合并成一个维度，item_id 不能撞。"""
    out = _write_run(
        tmp_path,
        results={
            "grp": {"sample_len": 3, "exact_match,get_response": 2 / 3},
            "grp::a": {"sample_len": 2},
            "grp::b": {"sample_len": 1},
        },
        subtasks={
            "grp": ["grp::a", "grp::b"],
            "grp::a": ["leaf_a"],
            "grp::b": ["leaf_b"],
        },
        samples={"leaf_a": {"0": True, "1": False}, "leaf_b": {"0": True}},
    )
    # 注册一个临时 group 任务
    L.TASKS["grp"] = {
        "label": "GRP",
        "dim": "knowledge",
        "metric": "exact_match",
        "fewshot": 0,
        "logprobs": False,
        "leaves": 3,
    }
    try:
        r = L.parse(out, ["grp"], {})
        d = r["dims"]["knowledge"]
        assert d["n"] == 3 and d["passed"] == 2 and d["leaves"] == 2
        ids = [it["item_id"] for it in r["items"]]
        assert len(ids) == len(set(ids)) == 3
        assert all(":" in i for i in ids)
    finally:
        L.TASKS.pop("grp", None)


def test_build_cmd_puts_output_in_run_dir(tmp_path):
    """输出必须落在本次运行的独立目录，避免历史结果互相污染。"""
    from server.schemas import Provider, Target

    t = Target(name="m", provider=Provider.openai, base_url="http://h",
               api_key="sk-x", model="gpt-4o")
    cmd = L.build_cmd(t, ["gsm8k"], {"limit": 5, "num_concurrent": 2}, tmp_path)
    assert cmd[0].endswith("lm-eval") and "run" in cmd
    assert str(tmp_path / "result.json") in cmd
    joined = " ".join(cmd)
    assert "--apply_chat_template" in joined and "--log_samples" in joined


def test_dataset_specs_mapping():
    specs = L.dataset_specs(["gsm8k", "mmlu_generative"])
    assert ("openai/gsm8k", "main") in specs
    assert ("cais/mmlu", "all") in specs
    assert L.dataset_specs([]) == []
