"""统计推断：Wilson 置信区间 + McNemar 配对检验。

为什么要这两个：
  - lm-eval 只给 `value ± stderr`；stderr 在小样本下不可靠，Wilson 区间更稳。
  - 基线对比若用"总分下降 10pp"这种拍脑袋阈值，几十道题上等于噪声。
    同一题集 + 同一种子 ⇒ doc_id 一一对应 ⇒ 可以用**配对**检验（McNemar），
    功效远高于非配对的比率比较。
"""

from __future__ import annotations

import math

Z95 = 1.959963984540054


def wilson_ci(k: int, n: int, z: float = Z95) -> tuple[float, float, float]:
    """返回 (点估计, 下界, 上界)，95% Wilson 区间。"""
    if n <= 0:
        return 0.0, 0.0, 0.0
    p = k / n
    d = 1.0 + z * z / n
    centre = p + z * z / (2 * n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return p, max(0.0, (centre - half) / d), min(1.0, (centre + half) / d)


def mcnemar_p(b: int, c: int) -> float:
    """McNemar 精确检验（双尾）。

    b = 基线错、本次对；c = 基线对、本次错。
    只有这两类"不一致对"提供信息；n 小时用精确二项分布。
    """
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    # 双尾：2 * P(X <= k)，X ~ Bin(n, 0.5)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / (2**n)
    return min(1.0, 2.0 * tail)


def two_proportion_p(k1: int, n1: int, k2: int, n2: int) -> float:
    """非配对两比例 z 检验（当题集不可配对时退而求其次）。"""
    if n1 <= 0 or n2 <= 0:
        return 1.0
    p1, p2 = k1 / n1, k2 / n2
    p = (k1 + k2) / (n1 + n2)
    se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
    if se == 0:
        return 1.0
    z = abs(p1 - p2) / se
    # 正态双尾
    return math.erfc(z / math.sqrt(2))


def evaluate(
    baseline: dict[str, bool],
    current: dict[str, bool],
    alpha: float = 0.05,
    min_delta: float = 0.03,
) -> dict:
    """对比基线，产出「疑似降智 / 正常 / 提升」判定。

    baseline / current：{doc_id: 是否答对}
    若 doc_id 有交集 → 配对 McNemar；否则退化为两比例检验。
    """
    common = sorted(set(baseline) & set(current))
    n_cur = len(current)
    k_cur = sum(1 for v in current.values() if v)
    p_cur, lo_cur, hi_cur = wilson_ci(k_cur, n_cur)

    if not baseline:
        return {
            "verdict": "baseline",
            "n_current": n_cur,
            "current": round(p_cur, 4),
            "ci95": [round(lo_cur, 4), round(hi_cur, 4)],
            "paired": False,
            "note": "已记录为基线",
        }

    n_base = len(baseline)
    k_base = sum(1 for v in baseline.values() if v)
    p_base, lo_base, hi_base = wilson_ci(k_base, n_base)
    delta = p_cur - p_base

    paired = len(common) >= 10
    b = c = 0
    if paired:
        b = sum(1 for d in common if not baseline[d] and current[d])
        c = sum(1 for d in common if baseline[d] and not current[d])
        p_value = mcnemar_p(b, c)
        test = "mcnemar"
    else:
        p_value = two_proportion_p(k_base, n_base, k_cur, n_cur)
        test = "two_proportion"

    significant = p_value < alpha
    if significant and delta <= -min_delta:
        verdict = "suspect"
    elif significant and delta >= min_delta:
        verdict = "improved"
    else:
        verdict = "normal"

    return {
        "verdict": verdict,
        "paired": paired,
        "test": test,
        "p_value": round(p_value, 5),
        "significant": significant,
        "alpha": alpha,
        "min_delta": min_delta,
        "baseline": round(p_base, 4),
        "current": round(p_cur, 4),
        "baseline_ci95": [round(lo_base, 4), round(hi_base, 4)],
        "ci95": [round(lo_cur, 4), round(hi_cur, 4)],
        "n_baseline": n_base,
        "n_current": n_cur,
        "n_paired": len(common),
        "delta": round(delta, 4),
        "discordant": {
            "baseline_wrong_current_right": b,
            "baseline_right_current_wrong": c,
        }
        if paired
        else None,
        "note": "" if significant else f"变化不显著（p={p_value:.3f}）",
    }
