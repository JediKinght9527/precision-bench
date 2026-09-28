"""前端滑杆配置的契约测试。

`NUMERIC_SLIDERS` 是 JS 字面量，这里用纯 Python 解析（不引入 node 依赖），
然后校验它与 index.html 的一致性。挡住的是真实会发生的错：

  · 抄错 id（配置了一个页面上不存在的字段）→ 滑杆静默不生效
  · 档位没排序 / 有重复 / 超出 [min, max] → 吸附逻辑行为异常
  · log 刻度配了 min=0 → log(0) = -Infinity，滑杆直接废掉
  · 只给一个档位 → 没有吸附可言
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
APP_JS = (ROOT / "web" / "app.js").read_text(encoding="utf-8")
INDEX_HTML = (ROOT / "web" / "index.html").read_text(encoding="utf-8")


def _parse_slider_config() -> dict:
    """从 app.js 里抠出 NUMERIC_SLIDERS 字面量并转成 JSON。"""
    start = APP_JS.index("const NUMERIC_SLIDERS = {")
    # 从起始大括号做括号配平, 避免正则吃到后面的无关代码
    i = APP_JS.index("{", start)
    depth = 0
    for j in range(i, len(APP_JS)):
        if APP_JS[j] == "{":
            depth += 1
        elif APP_JS[j] == "}":
            depth -= 1
            if depth == 0:
                lit = APP_JS[i : j + 1]
                break
    else:
        raise AssertionError("NUMERIC_SLIDERS 的大括号没配平")
    # JS 字面量 → JSON
    lit = re.sub(r"//[^\n]*", "", lit)                        # 去行注释
    lit = re.sub(r"([{,]\s*)([A-Za-z_][\w-]*)(\s*:)", r'\1"\2"\3', lit)  # 键加引号
    lit = lit.replace("'", '"')                                  # 单引号 → 双引号
    lit = re.sub(r",(\s*[}\]])", r"\1", lit)                  # 去尾逗号
    return json.loads(lit)


CFG = _parse_slider_config()


def test_config_not_empty():
    assert len(CFG) >= 15, f"滑杆配置只有 {len(CFG)} 项，改造没生效？"


@pytest.mark.parametrize("field_id", sorted(CFG))
def test_field_exists_in_html(field_id):
    """配置了的 id 必须在页面里存在，且是 number 输入框。"""
    pat = re.compile(
        rf'<input[^>]*\bid="{re.escape(field_id)}"[^>]*type="number"', re.S
    )
    assert pat.search(INDEX_HTML), (
        f"index.html 里没有 type=number 的 #{field_id}，滑杆会静默失效"
    )


@pytest.mark.parametrize("field_id", sorted(CFG))
def test_detents_sorted_unique_in_range(field_id):
    cfg = CFG[field_id]
    detents = cfg["detents"]
    assert len(detents) >= 2, f"{field_id} 只有 {len(detents)} 个档位，吸附没有意义"
    assert detents == sorted(detents), f"{field_id} 档位未升序: {detents}"
    assert len(set(detents)) == len(detents), f"{field_id} 档位有重复: {detents}"
    lo, hi = cfg.get("min"), cfg.get("max")
    if lo is not None:
        assert all(d >= lo for d in detents), (
            f"{field_id} 有档位低于 min={lo}: {detents}"
        )
    if hi is not None:
        assert all(d <= hi for d in detents), (
            f"{field_id} 有档位高于 max={hi}: {detents}"
        )


@pytest.mark.parametrize("field_id", sorted(CFG))
def test_log_scale_requires_positive_min(field_id):
    """对数刻度下 min 必须 > 0：log(0) = -Inf 会让滑杆彻底失效。"""
    cfg = CFG[field_id]
    if cfg.get("scale") != "log":
        return
    lo = cfg.get("min")
    assert lo is not None and lo > 0, f"{field_id} 用了 log 刻度但 min={lo}"


def test_detent_density_is_sane():
    """档位太多会挤成糊字：UI 只在两端显示数值，中间靠刻度线。"""
    for field_id, cfg in CFG.items():
        n = len(cfg["detents"])
        assert n <= 9, f"{field_id} 有 {n} 个档位，窄栏里会挤成一片：{cfg['detents']}"
