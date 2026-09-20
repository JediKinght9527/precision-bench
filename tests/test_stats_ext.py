"""统计层单测：Wilson 区间、McNemar、降智判定。"""

from __future__ import annotations

from server.stats_ext import evaluate, mcnemar_p, two_proportion_p, wilson_ci


def test_wilson_ci_matches_reference():
    """与 statsmodels 的 Wilson 结果一致（保留 6 位）。"""
    p, lo, hi = wilson_ci(50, 100)
    assert abs(p - 0.5) < 1e-12
    assert abs(lo - 0.403832) < 1e-6
    assert abs(hi - 0.596168) < 1e-6
    # 0/20 的上界不应为 0
    _, lo2, hi2 = wilson_ci(0, 20)
    assert lo2 == 0.0 and 0.15 < hi2 < 0.17
    # 空样本
    assert wilson_ci(0, 0) == (0.0, 0.0, 0.0)


def test_mcnemar_exact():
    # 完全一致 → p=1
    assert mcnemar_p(0, 0) == 1.0
    # 10 个不一致且方向单一 → 精确二项 2*(1/1024)
    assert abs(mcnemar_p(0, 10) - 2 / 1024) < 1e-12
    # 对称 → p=1
    assert mcnemar_p(5, 5) == 1.0


def test_two_proportion():
    # 相同比例 → 不显著
    assert two_proportion_p(50, 100, 50, 100) == 1.0
    # 明显差异 → 显著
    assert two_proportion_p(10, 100, 90, 100) < 1e-9


def test_evaluate_baseline_and_paired():
    """配对：同题集、doc_id 一致 → 用 McNemar；样本太少 → 退化两比例。"""
    base = {str(i): i < 90 for i in range(100)}  # 90%
    # 本次全部答错 → 显著下降 → suspect
    cur_bad = {str(i): False for i in range(100)}
    r = evaluate(base, cur_bad, alpha=0.05, min_delta=0.03)
    assert r["paired"] is True and r["test"] == "mcnemar"
    assert r["verdict"] == "suspect" and r["significant"] is True

    # 本次与基线完全一致 → 正常
    r2 = evaluate(base, dict(base))
    assert r2["verdict"] == "normal" and r2["significant"] is False

    # 小样本（<10 配对）→ 退化两比例
    r3 = evaluate({"0": True, "1": True}, {"0": True, "1": False})
    assert r3["paired"] is False and r3["test"] == "two_proportion"


def test_evaluate_first_run_is_baseline():
    r = evaluate({}, {"0": True, "1": True})
    assert r["verdict"] == "baseline"
    assert r["n_current"] == 2
    assert "ci95" in r


def test_improved_detected():
    base = {str(i): i < 50 for i in range(100)}  # 50%
    cur = {str(i): i < 90 for i in range(100)}  # 90%
    r = evaluate(base, cur, alpha=0.05, min_delta=0.03)
    assert r["verdict"] == "improved"


def test_small_effect_does_not_flag_suspect():
    """降幅小于 min_delta → 不报降智（无论是否显著）。"""
    base = {str(i): i < 500 for i in range(1000)}
    cur = {str(i): i < 495 for i in range(1000)}  # -0.5pp
    r = evaluate(base, cur, alpha=0.05, min_delta=0.03)
    assert r["verdict"] == "normal"
    assert r["delta"] == -0.005
