"""统计工具：线性插值分位（对齐 numpy）、LTTB 降采样。"""

from __future__ import annotations

import math

def percentiles(values: list[float], ps: list[float]) -> dict[float, float]:
    vals = [v for v in values if v is not None]
    if not vals:
        return {p: 0.0 for p in ps}
    # 线性插值分位，与 numpy.percentile（vLLM / SGLang 所用）逐位一致。
    # 注意：不要改回 HDR Histogram —— HDR 把值量化到整数毫秒，小样本下
    # 与主流工具的分位结果对不上，无法横向比对。
    return {p: _linear_pct(vals, p) for p in ps}


def _linear_pct(values: list[float], p: float) -> float:
    s = sorted(values)
    k = (len(s) - 1) * p / 100
    lo = int(math.floor(k))
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def mean_std(values: list[float]) -> tuple[float, float]:
    vals = [v for v in values if v is not None]
    if not vals:
        return 0.0, 0.0
    m = sum(vals) / len(vals)
    var = sum((v - m) ** 2 for v in vals) / len(vals)
    return m, math.sqrt(var)


def lttb(x: list[float], y: list[float], n: int) -> tuple[list[float], list[float]]:
    """Largest-Triangle-Three-Buckets 降采样，保留波形形态。"""
    if n >= len(x) or n < 3:
        return x, y
    sampled_x, sampled_y = [x[0]], [y[0]]
    every = (len(x) - 2) / (n - 2)
    a = 0
    for i in range(n - 2):
        start = int(math.floor((i + 1) * every) + 1)
        end = int(math.floor((i + 2) * every) + 1)
        end = min(end, len(x))
        avg_start = int(math.floor(i * every) + 1)
        avg_end = int(math.floor((i + 1) * every) + 1)
        avg_end = min(avg_end, len(x))
        avg_x = sum(x[avg_start:avg_end]) / max(1, avg_end - avg_start)
        avg_y = sum(y[avg_start:avg_end]) / max(1, avg_end - avg_start)
        rng = range(start, end)
        if not rng:
            continue
        max_area = -1.0
        next_a = start
        for j in rng:
            area = (
                abs((x[a] - avg_x) * (y[j] - y[a]) - (x[a] - x[j]) * (avg_y - y[a]))
                * 0.5
            )
            if area > max_area:
                max_area = area
                next_a = j
        sampled_x.append(x[next_a])
        sampled_y.append(y[next_a])
        a = next_a
    sampled_x.append(x[-1])
    sampled_y.append(y[-1])
    return sampled_x, sampled_y
