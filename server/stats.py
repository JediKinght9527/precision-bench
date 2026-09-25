"""统计工具：线性插值分位（对齐 numpy）、LTTB 降采样。"""

from __future__ import annotations

import math


def percentiles(values: list[float], ps: list[float]) -> dict[float, float]:
    vals = [v for v in values if v is not None]
    if not vals:
        return {p: 0.0 for p in ps}
    ordered = sorted(vals)
    return {p: _linear_pct_sorted(ordered, p) for p in ps}


def _linear_pct_sorted(s: list[float], p: float) -> float:
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
    if not x or n <= 0:
        return [], []
    if n == 1:
        return [x[0]], [y[0]]
    if n == 2:
        return [x[0], x[-1]], [y[0], y[-1]]
    if n >= len(x):
        return x, y
    sampled_x, sampled_y = [x[0]], [y[0]]
    every = (len(x) - 2) / (n - 2)
    a = 0
    for i in range(n - 2):
        start = int(math.floor((i + 1) * every) + 1)
        end = int(math.floor((i + 2) * every) + 1)
        end = min(end, len(x) - 1)
        avg_start = int(math.floor(i * every) + 1)
        avg_end = int(math.floor((i + 1) * every) + 1)
        avg_end = min(avg_end, len(x))
        avg_x = sum(x[avg_start:avg_end]) / max(1, avg_end - avg_start)
        avg_y = sum(y[avg_start:avg_end]) / max(1, avg_end - avg_start)
        rng = range(start, end)
        if not rng:
            next_a = min(start, len(x) - 2)
        else:
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
    unique_x: list[float] = []
    unique_y: list[float] = []
    seen: set[float] = set()
    for sx, sy in zip(sampled_x, sampled_y):
        if sx in seen:
            continue
        seen.add(sx)
        unique_x.append(sx)
        unique_y.append(sy)
    if len(unique_x) < n:
        for sx, sy in zip(x, y):
            if sx in seen:
                continue
            seen.add(sx)
            unique_x.append(sx)
            unique_y.append(sy)
            if len(unique_x) >= n:
                break
    pairs = sorted(zip(unique_x, unique_y), key=lambda item: item[0])
    if len(pairs) > n:
        pairs = [pairs[0], *pairs[1:-1][: n - 2], pairs[-1]]
    return [item[0] for item in pairs], [item[1] for item in pairs]
