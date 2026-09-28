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


def test_integer_fields_marked():
    """整数字段必须标 int: true —— 否则拖动过程中会露出 17.582 这种值。"""
    INT = {
        "concurrency", "request_count", "duration_s", "ramp_s", "cooldown_s", "warmup",
        "timeout_s", "retries", "max_tokens", "slo_ttft", "slo_tpot", "slo_e2e",
        "c_rounds", "c_prefix", "b-concurrent",
    }
    for fid in sorted(INT):
        assert CFG[fid].get("int") is True, f"{fid} 是整数字段但没标 int"
    for fid, cfg in CFG.items():
        if cfg.get("int"):
            assert "step" not in cfg, f"{fid} 同时有 int 和 step，量化规则会打架"
        else:
            assert cfg.get("step"), f"{fid} 既非整数也没给 step，浮点值会拖出任意精度"


def test_slider_step_is_one():
    """range.step 必须是 1。

    浏览器会把 range.value 夹到 step 的整数倍：step 设成"档位间距"（如 175）
    的话滑杆根本表示不了键入的值 —— 键 10000 会被挤到 875 位置（对应值 422）。
    方向键跳档因此必须放在 keydown 里自己实现。
    """
    assert "range.step = '1'" in (ROOT / "web" / "ui.js").read_text(encoding="utf-8"), (
        "ui.js 里 range.step 不是 1，滑杆会无法表示键入的精确值"
    )
    assert "addEventListener('keydown'" in (ROOT / "web" / "ui.js").read_text(encoding="utf-8"), (
        "step=1 之后方向键需要自己处理跳档，否则键盘导航失效"
    )


def test_single_change_dispatch():
    """松手只能派发一次 change。

    原来 release() 里连着调了两次 setValue，加上 change/pointerup 两个监听，
    一次松手派发 4 次 change，saveCfg 之类跟着跑 4 遍。
    """
    ui = (ROOT / "web" / "ui.js").read_text(encoding="utf-8")
    assert "addEventListener('pointerup'" not in ui, "range 上不该再挂 pointerup（和 change 重复触发）"
    # 写入口只有一个：apply()
    assert ui.count("dispatchEvent(new Event('change'") <= 3, "change 派发点过多，容易重复"


def test_cell_layout_prevents_label_wrap_misalignment():
    """标签折行不能让同排两列错位。

    「并发爬升（worker/s）」在 1280 宽下会折成两行，普通块布局会把输入框
    顶下去，导致同一行左右两列的输入框和刻度尺不在同一水平线上。
    靠 .row > div 纵向 flex + .numfield margin-top:auto 把输入区贴底对齐。
    """
    css = (ROOT / "web" / "style.css").read_text(encoding="utf-8")
    assert re.search(r"\.row > div \{[^}]*display: flex", css), ".row > div 不是 flex，标签折行会错位"
    assert re.search(r"\.numfield \{[^}]*margin-top: auto", css), ".numfield 没有贴底，折行时无法对齐"


def test_ticks_avoid_end_label_collision():
    """刻度线必须躲开两端的数值标签。

    「爬升时长」档位 0/30/60/300 在线性刻度下 0% 与 5% 几乎重合，
    5% 处的刻度线会正好盖住 "0"，看上去就像数字丢了。
    """
    ui = (ROOT / "web" / "ui.js").read_text(encoding="utf-8")
    assert "clash" in ui, "刻度抽稀逻辑没有避开端点标签"
    assert "is-end" in ui, "端点标签没有独立的 class，无法参与冲突判定"
    assert "dataset.active" in ui, "缺少「当前会吸附到哪一档」的落点提示"
