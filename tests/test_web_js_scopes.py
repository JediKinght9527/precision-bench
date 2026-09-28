"""前端 JS 的静态契约检查（不引入 node 依赖）。

挡住的是真实发生过的错：`renderCompareChart` 里没有 `S` 这个变量
（它用 `series`），但批量注入图表动画参数时被写成了 `UI.anim(S.length)`，
浏览器直接抛 `ReferenceError: S is not defined`，对比图整个不渲染。
`node --check` 抓不到这类错（语法合法），pytest 也不会跑浏览器，
所以这里用括号配平做一次作用域内的声明检查。

检查项：
  · 括号/花括号配平（截断或多余的块结构）
  · `UI.anim(...)` 的实参所用标识符，在所在函数作用域内确实有声明或形参
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
APP_JS = (ROOT / "web" / "app.js").read_text(encoding="utf-8")
LINES = APP_JS.split("\n")

FUNC_RE = re.compile(r"^function\s+(\w+)\s*\((.*?)\)\s*\{")


def _top_level_decls(body: str) -> set[str]:
    """只取函数**顶层**的 const/let/var 声明，排除嵌套回调里的同名变量。

    renderCompareChart 里有一句 `const S = visSamples(r).filter(...)`，
    但它在 `.map()` 回调内部，回调结束后 S 就不存在了。
    若把这种嵌套声明也算作"已声明"，就会漏掉真实存在的 ReferenceError。

    深度用缩进判断，不用花括号计数 —— 本文件里有
    `const ln = (a, b, w = 1.5, x = {}) => ({ ... })` 这种单行箭头函数，
    它一行里就出现了配对的花括号，会让纯计数法从此行起整体错位。
    顶层声明的缩进与函数体首行一致，嵌套回调一律更深。
    """
    lines = body.split("\n")
    # 以函数体的第一条实际语句确定顶层缩进
    base = None
    for line in lines[1:]:
        if line.strip():
            base = len(line) - len(line.lstrip())
            break
    if base is None:
        return set()

    names: set[str] = set()
    for line in lines:
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip())
        if indent <= base:
            m = re.match(r"\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=", line)
            if m:
                names.add(m.group(1))
    return names


def _function_body(start: int) -> str:
    """从 `function` 定义行开始，按花括号配平取出整个函数体。"""
    depth = 0
    out: list[str] = []
    for line in LINES[start:]:
        out.append(line)
        depth += line.count("{") - line.count("}")
        if depth == 0:
            break
    else:
        raise AssertionError(f"第 {start + 1} 行起的函数花括号没配平")
    return "\n".join(out)


def test_braces_are_balanced() -> None:
    """整份 app.js 的花括号必须配平（防止编辑时截断）。"""
    depth = 0
    for n, line in enumerate(LINES, 1):
        depth += line.count("{") - line.count("}")
        assert depth >= 0, f"第 {n} 行花括号闭合过早：{line.strip()!r}"
    assert depth == 0, f"app.js 花括号最终未配平，剩余 {depth} 个未闭合"


# 允许的自递归：断线重连是刻意设计，不是 bug
ALLOWED_SELF_RECURSION = {
    # connectSSE 在收到 reset 事件后递归重连（带退避），属正常控制流
    "connectSSE",
}


def test_no_self_recursive_functions() -> None:
    """函数体内不得调用自身 —— 无限递归会抛 RangeError，且常常只在有数据时才走到。

    真实 bug：ringVerdicts 里误写成 `const rp = ringVerdicts(sum, run)`
    （本该是 ringParts），导致判定区三环永远停在空态。
    白名单里的 connectSSE 是断线重连的刻意设计。
    """
    for i, line in enumerate(LINES):
        m = FUNC_RE.match(line)
        if not m:
            continue
        name = m.group(1)
        if name in ALLOWED_SELF_RECURSION:
            continue
        body = _function_body(i)
        # 去掉函数自身的定义行，避免把 `function ringVerdicts(...)` 误判为调用
        body = "\n".join(body.split("\n")[1:])
        assert not re.search(rf"\b{re.escape(name)}\s*\(", body), (
            f"app.js:{i + 1} 的 {name}() 在自身函数体内调用了自己，会无限递归"
        )


@pytest.mark.parametrize("idx", [i for i, l in enumerate(LINES) if "UI.anim(" in l])
def test_ui_anim_argument_in_scope(idx: int) -> None:
    """UI.anim(...) 的实参标识符必须在所在函数内声明或是形参。

    曾经的真实 bug：renderCompareChart 内没有 S（它用 series），
    却被注入 `UI.anim(S.length)`，运行时 ReferenceError 导致对比图不渲染。
    """
    line = LINES[idx]
    arg = line.split("UI.anim(", 1)[1].split(")", 1)[0].strip()
    if not arg.endswith(".length"):
        # 复杂表达式（如 series.reduce(...)）不做标识符检查
        return

    ident = arg[: -len(".length")].strip()
    assert re.fullmatch(r"[A-Za-z_$][\w$]*", ident), f"无法解析的实参：{arg!r}"

    # 往上找最近的 function 定义
    start = None
    params = ""
    for j in range(idx, -1, -1):
        m = FUNC_RE.match(LINES[j])
        if m:
            start, params = j, m.group(2)
            break
    if start is None:
        return  # 顶层代码（如初始化时），无法判定作用域

    body = _function_body(start)
    declared = ident in _top_level_decls(body)
    is_param = re.search(rf"\b{re.escape(ident)}\b", params)
    assert declared or is_param, (
        f"app.js:{idx + 1} 的 UI.anim({arg}) 用了 `{ident}`，"
        f"但它不是所在函数的形参、函数体内也没有声明 —— 运行时会 ReferenceError"
    )
