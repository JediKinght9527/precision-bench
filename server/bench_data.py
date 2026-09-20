"""降智检测题库与自动判分。

题集为自建curated子集，思路对齐主流 benchmark：
  math        ← GSM8K / MATH 风格（数值精确匹配）
  knowledge   ← MMLU 风格（英文单选）
  chinese     ← C-Eval / CMMLU 风格（中文单选）
  instruction ← IFEval 风格（可程序化校验的约束）
  format      ← 结构化输出（JSON schema）
  code        ← HumanEval 风格（预测输出）
  needle      ← 长上下文检索（运行时按长度构造）
  consistency ← 低温自洽性（同题两问需一致）

判分完全由代码完成，不看"感觉"，避免人为打分。
"""

from __future__ import annotations

import hashlib
import json
import random
import re
from typing import Any

DIMENSIONS: dict[str, dict[str, Any]] = {
    "math": {"name": "数学推理", "bench": "GSM8K-style"},
    "knowledge": {"name": "知识选择", "bench": "MMLU-style"},
    "chinese": {"name": "中文能力", "bench": "C-Eval-style"},
    "instruction": {"name": "指令遵循", "bench": "IFEval-style"},
    "format": {"name": "结构化输出", "bench": "JSON"},
    "code": {"name": "代码推理", "bench": "HumanEval-style"},
    "needle": {"name": "长上下文检索", "bench": "Needle-in-Haystack"},
    "consistency": {"name": "自洽性", "bench": "Self-consistency"},
}

# --------------------------------------------------------------------------
# 题库
# --------------------------------------------------------------------------
ITEMS: list[dict[str, Any]] = [
    # ---- math ----
    {
        "id": "math-01",
        "dim": "math",
        "q": "小明有3个苹果，又买了5个，然后吃掉2个。还剩几个？只回答数字。",
        "g": {"type": "numeric", "answer": 6},
    },
    {
        "id": "math-02",
        "dim": "math",
        "q": "一个班有24名学生，其中三分之一是女生。女生有多少人？只回答数字。",
        "g": {"type": "numeric", "answer": 8},
    },
    {
        "id": "math-03",
        "dim": "math",
        "q": "A train travels 60 km/h for 2.5 hours. How far (km)? Answer with the number only.",
        "g": {"type": "numeric", "answer": 150},
    },
    {
        "id": "math-04",
        "dim": "math",
        "q": "If 7x = 91, what is x? Answer with the number only.",
        "g": {"type": "numeric", "answer": 13},
    },
    {
        "id": "math-05",
        "dim": "math",
        "q": "What is 15% of 240? Answer with the number only.",
        "g": {"type": "numeric", "answer": 36},
    },
    {
        "id": "math-06",
        "dim": "math",
        "q": "What is the sum of the first 10 positive integers? Answer with the number only.",
        "g": {"type": "numeric", "answer": 55},
    },
    {
        "id": "math-07",
        "dim": "math",
        "q": "A rectangle is 12 cm by 5 cm. What is its area in cm^2? Answer with the number only.",
        "g": {"type": "numeric", "answer": 60},
    },
    {
        "id": "math-08",
        "dim": "math",
        "q": "An item costs 80 and is discounted 25%. What is the final price? Answer with the number only.",
        "g": {"type": "numeric", "answer": 60},
    },
    {
        "id": "math-09",
        "dim": "math",
        "q": "How many minutes are there in 3.5 hours? Answer with the number only.",
        "g": {"type": "numeric", "answer": 210},
    },
    {
        "id": "math-10",
        "dim": "math",
        "q": "鸡兔同笼，共10个头、28只脚。鸡有多少只？只回答数字。",
        "g": {"type": "numeric", "answer": 6},
    },
    {
        "id": "math-11",
        "dim": "math",
        "q": "What is the next number: 2, 6, 12, 20, 30, ? Answer with the number only.",
        "g": {"type": "numeric", "answer": 42},
    },
    {
        "id": "math-12",
        "dim": "math",
        "q": "A cube has side length 4. What is its volume? Answer with the number only.",
        "g": {"type": "numeric", "answer": 64},
    },
    # ---- knowledge (MMLU-style MCQ) ----
    {
        "id": "know-01",
        "dim": "knowledge",
        "q": "Which planet is known as the Red Planet?\nA) Venus\nB) Mars\nC) Jupiter\nD) Mercury\nAnswer with the letter only.",
        "g": {"type": "mcq", "answer": "B"},
    },
    {
        "id": "know-02",
        "dim": "knowledge",
        "q": "What is the chemical symbol for gold?\nA) Ag\nB) Au\nC) Gd\nD) Go\nAnswer with the letter only.",
        "g": {"type": "mcq", "answer": "B"},
    },
    {
        "id": "know-03",
        "dim": "knowledge",
        "q": "Who wrote 'Pride and Prejudice'?\nA) Jane Austen\nB) Emily Bronte\nC) Charles Dickens\nD) Virginia Woolf\nAnswer with the letter only.",
        "g": {"type": "mcq", "answer": "A"},
    },
    {
        "id": "know-04",
        "dim": "knowledge",
        "q": "What is the capital of Australia?\nA) Sydney\nB) Melbourne\nC) Canberra\nD) Perth\nAnswer with the letter only.",
        "g": {"type": "mcq", "answer": "C"},
    },
    {
        "id": "know-05",
        "dim": "knowledge",
        "q": "The largest ocean on Earth is:\nA) Atlantic\nB) Indian\nC) Arctic\nD) Pacific\nAnswer with the letter only.",
        "g": {"type": "mcq", "answer": "D"},
    },
    {
        "id": "know-06",
        "dim": "knowledge",
        "q": "In which year did the Berlin Wall fall?\nA) 1987\nB) 1989\nC) 1991\nD) 1993\nAnswer with the letter only.",
        "g": {"type": "mcq", "answer": "B"},
    },
    {
        "id": "know-07",
        "dim": "knowledge",
        "q": "Which organelle is called the powerhouse of the cell?\nA) Nucleus\nB) Ribosome\nC) Mitochondria\nD) Golgi apparatus\nAnswer with the letter only.",
        "g": {"type": "mcq", "answer": "C"},
    },
    {
        "id": "know-08",
        "dim": "knowledge",
        "q": "Which gas is most abundant in Earth's atmosphere?\nA) Oxygen\nB) Carbon dioxide\nC) Nitrogen\nD) Argon\nAnswer with the letter only.",
        "g": {"type": "mcq", "answer": "C"},
    },
    {
        "id": "know-09",
        "dim": "knowledge",
        "q": "HTTP status code 404 means:\nA) Unauthorized\nB) Not Found\nC) Server Error\nD) Forbidden\nAnswer with the letter only.",
        "g": {"type": "mcq", "answer": "B"},
    },
    {
        "id": "know-10",
        "dim": "knowledge",
        "q": "What is 100 in binary?\nA) 1100100\nB) 1010100\nC) 1001100\nD) 1110000\nAnswer with the letter only.",
        "g": {"type": "mcq", "answer": "A"},
    },
    {
        "id": "know-11",
        "dim": "knowledge",
        "q": "Which data structure uses FIFO order?\nA) Stack\nB) Queue\nC) Heap\nD) Tree\nAnswer with the letter only.",
        "g": {"type": "mcq", "answer": "B"},
    },
    {
        "id": "know-12",
        "dim": "knowledge",
        "q": "The time complexity of binary search on a sorted array of n elements is:\nA) O(n)\nB) O(log n)\nC) O(n log n)\nD) O(1)\nAnswer with the letter only.",
        "g": {"type": "mcq", "answer": "B"},
    },
    # ---- chinese (C-Eval-style) ----
    {
        "id": "zh-01",
        "dim": "chinese",
        "q": "下列哪一项属于中国古代四大发明？\nA) 瓷器\nB) 造纸术\nC) 丝绸\nD) 茶叶\n只回答字母。",
        "g": {"type": "mcq", "answer": "B"},
    },
    {
        "id": "zh-02",
        "dim": "chinese",
        "q": "《红楼梦》的作者是？\nA) 罗贯中\nB) 施耐庵\nC) 曹雪芹\nD) 吴承恩\n只回答字母。",
        "g": {"type": "mcq", "answer": "C"},
    },
    {
        "id": "zh-03",
        "dim": "chinese",
        "q": "中国最长的河流是？\nA) 黄河\nB) 长江\nC) 珠江\nD) 黑龙江\n只回答字母。",
        "g": {"type": "mcq", "answer": "B"},
    },
    {
        "id": "zh-04",
        "dim": "chinese",
        "q": "“光年”是什么单位？\nA) 时间\nB) 距离\nC) 速度\nD) 亮度\n只回答字母。",
        "g": {"type": "mcq", "answer": "B"},
    },
    {
        "id": "zh-05",
        "dim": "chinese",
        "q": "“卧薪尝胆”与哪位历史人物有关？\nA) 勾践\nB) 项羽\nC) 韩信\nD) 曹操\n只回答字母。",
        "g": {"type": "mcq", "answer": "A"},
    },
    {
        "id": "zh-06",
        "dim": "chinese",
        "q": "下列哪个不是编程语言？\nA) Python\nB) Java\nC) Rust\nD) HTTP\n只回答字母。",
        "g": {"type": "mcq", "answer": "D"},
    },
    {
        "id": "zh-07",
        "dim": "chinese",
        "q": "一年中北半球白昼最长的节气通常是？\nA) 春分\nB) 夏至\nC) 秋分\nD) 冬至\n只回答字母。",
        "g": {"type": "mcq", "answer": "B"},
    },
    {
        "id": "zh-08",
        "dim": "chinese",
        "q": "水的化学式是？\nA) CO2\nB) H2O\nC) O2\nD) NaCl\n只回答字母。",
        "g": {"type": "mcq", "answer": "B"},
    },
    # ---- instruction (IFEval-style) ----
    {
        "id": "ins-01",
        "dim": "instruction",
        "q": "只输出三个词，用空格分隔，用来形容大海。不要输出任何其它内容。",
        "g": {"type": "word_count", "value": 3},
    },
    {
        "id": "ins-02",
        "dim": "instruction",
        "q": "用一句话回答，且整句不超过20个汉字：天空为什么是蓝色？",
        "g": {"type": "max_chars", "value": 20, "unit": "cjk"},
    },
    {
        "id": "ins-03",
        "dim": "instruction",
        "q": "只回答一句话，且必须包含“因此”这个词：2加2等于几？",
        "g": {
            "type": "all",
            "checks": [
                {"type": "contains", "all": ["因此"]},
                {"type": "max_sentences", "value": 1},
            ],
        },
    },
    {
        "id": "ins-04",
        "dim": "instruction",
        "q": "答案中不得出现“不”字，用一句话描述太阳。",
        "g": {"type": "not_contains", "values": ["不"]},
    },
    {
        "id": "ins-05",
        "dim": "instruction",
        "q": "回答必须以“首先”开头，并用分号分隔两个步骤：如何煮鸡蛋？",
        "g": {
            "type": "all",
            "checks": [
                {"type": "startswith", "value": "首先"},
                {"type": "contains", "all": ["；"]},
            ],
        },
    },
    {
        "id": "ins-06",
        "dim": "instruction",
        "q": "回答必须恰好以“完毕。”三个字结尾：简单介绍一下你自己。",
        "g": {"type": "endswith", "value": "完毕。"},
    },
    {
        "id": "ins-07",
        "dim": "instruction",
        "q": "请用全大写英文回答，且必须包含 FOUR：What is 2+2?",
        "g": {
            "type": "all",
            "checks": [
                {"type": "uppercase_latin"},
                {"type": "contains", "all": ["FOUR"]},
            ],
        },
    },
    {
        "id": "ins-08",
        "dim": "instruction",
        "q": "输出一个无序列表，恰好3项，每行以“- ”开头，不要其它内容。",
        "g": {"type": "bullet_count", "value": 3},
    },
    {
        "id": "ins-09",
        "dim": "instruction",
        "q": "重复单词 alpha 三次，用小写逗号分隔，不要空格，不要其它内容。",
        "g": {"type": "exact_ci", "answer": "alpha,alpha,alpha"},
    },
    {
        "id": "ins-10",
        "dim": "instruction",
        "q": "只输出一个词，且这个词必须由5个字母组成，表示一种水果。",
        "g": {"type": "regex", "pattern": "^[a-zA-Z]{5}$"},
    },
    # ---- format (JSON) ----
    {
        "id": "fmt-01",
        "dim": "format",
        "q": "只返回 JSON，不要任何解释或代码块标记：字段 name 为字符串 bench，字段 score 为数字 100。",
        "g": {"type": "json", "checks": {"name": "bench", "score": 100}},
    },
    {
        "id": "fmt-02",
        "dim": "format",
        "q": "只返回一个 JSON 数组，包含3个数字：1、2、3。不要解释。",
        "g": {"type": "json", "list_len": 3, "list_values": [1, 2, 3]},
    },
    {
        "id": "fmt-03",
        "dim": "format",
        "q": "只返回一个 JSON 对象，含键 a 和 b，值分别为布尔 true 和 false。",
        "g": {"type": "json", "bool_keys": ["a", "b"]},
    },
    {
        "id": "fmt-04",
        "dim": "format",
        "q": "用 JSON 表示：城市 Beijing，人口 2189（数字类型）。只输出 JSON。",
        "g": {"type": "json_contains", "text": ["Beijing"], "numbers": [2189]},
    },
    {
        "id": "fmt-05",
        "dim": "format",
        "q": "返回 JSON 对象，只要一个键 result，其值为 4 的平方（数字）。只输出 JSON。",
        "g": {"type": "json", "checks": {"result": 16}},
    },
    {
        "id": "fmt-06",
        "dim": "format",
        "q": '返回 JSON 对象，键 status 为 "ok"，键 items 为长度恰好 3 的数组。只输出 JSON。',
        "g": {
            "type": "json",
            "checks": {"status": "ok"},
            "list_len_keys": {"items": 3},
        },
    },
    # ---- code (predict output) ----
    {
        "id": "code-01",
        "dim": "code",
        "q": "这段 Python 输出什么？只回答结果。\nprint(sum(range(1,5)))",
        "g": {"type": "numeric", "answer": 10},
    },
    {
        "id": "code-02",
        "dim": "code",
        "q": "输出是什么？只回答结果。\nx=[1,2,3]\nprint(x[::-1])",
        "g": {"type": "exact_nospace", "answer": "[3,2,1]"},
    },
    {
        "id": "code-03",
        "dim": "code",
        "q": "输出是什么？只回答结果。\nprint(len('hello'))",
        "g": {"type": "numeric", "answer": 5},
    },
    {
        "id": "code-04",
        "dim": "code",
        "q": "输出是什么？只回答结果。\na=5\nb=3\nprint(a%b)",
        "g": {"type": "numeric", "answer": 2},
    },
    {
        "id": "code-05",
        "dim": "code",
        "q": "输出是什么？只回答结果。\nprint('ab'*2)",
        "g": {"type": "exact_nospace", "answer": "abab"},
    },
    {
        "id": "code-06",
        "dim": "code",
        "q": "输出是什么？只回答结果。\nprint(sorted([3,1,2]))",
        "g": {"type": "exact_nospace", "answer": "[1,2,3]"},
    },
    # ---- consistency (same question asked twice, must match) ----
    {
        "id": "con-01",
        "dim": "consistency",
        "q": "12 乘以 12 等于多少？只回答数字。",
        "g": {"type": "numeric", "answer": 144},
        "pair": "con-01",
    },
    {
        "id": "con-02",
        "dim": "consistency",
        "q": "法国的首都是哪座城市？只回答城市名。",
        "g": {"type": "contains", "all": ["paris", "巴黎"], "mode": "any"},
        "pair": "con-02",
    },
    {
        "id": "con-03",
        "dim": "consistency",
        "q": "元素周期表中铁的原子序数是多少？只回答数字。",
        "g": {"type": "numeric", "answer": 26},
        "pair": "con-03",
    },
]


def list_datasets() -> list[dict[str, Any]]:
    counts: dict[str, int] = {}
    for it in ITEMS:
        counts[it["dim"]] = counts.get(it["dim"], 0) + 1
    out = []
    for k, meta in DIMENSIONS.items():
        out.append(
            {
                "dim": k,
                "name": meta["name"],
                "bench": meta["bench"],
                "count": counts.get(k, 0),
                "dynamic": k == "needle",
            }
        )
    return out


def build_items(
    dims: list[str], needle_tokens: int = 4000, seed: int | None = None
) -> list[dict[str, Any]]:
    rng = random.Random(seed)
    items = [dict(it) for it in ITEMS if it["dim"] in dims]
    # consistency：每题问两遍，第二遍作为配对项
    expanded: list[dict[str, Any]] = []
    for it in items:
        expanded.append(it)
        if it["dim"] == "consistency":
            dup = dict(it)
            dup["id"] = it["id"] + "-b"
            dup["q"] = it["q"]
            dup["_pair_of"] = it["id"]
            expanded.append(dup)
    # needle：运行时构造
    if "needle" in dims:
        for i, tok in enumerate([needle_tokens // 2, needle_tokens]):
            code = "".join(
                rng.choice("ABCDEFGHJKMNPQRSTUVWXYZ23456789") for _ in range(10)
            )
            filler_unit = (
                "The system maintains a rolling buffer for diagnostics and telemetry. "
                "Records are rotated periodically to keep storage bounded and queries fast. "
            )
            filler = filler_unit * max(1, (tok * 4) // len(filler_unit))
            mid = len(filler) // 2
            prompt = (
                filler[:mid]
                + f"\nThe secret access code is {code}.\n"
                + filler[mid:]
                + f"\nQuestion: What is the secret access code? Answer with the code only. Do not explain."
            )
            expanded.append(
                {
                    "id": f"needle-{i}",
                    "dim": "needle",
                    "q": prompt,
                    "g": {"type": "contains", "all": [code]},
                    "_approx_tokens": tok,
                }
            )
    return expanded


# --------------------------------------------------------------------------
# 判分
# --------------------------------------------------------------------------
def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def _norm_nospace(s: str) -> str:
    return re.sub(r"\s+", "", _norm(s).strip("`\"'"))


def _extract_mcq(text: str) -> str | None:
    m = re.search(
        r"(?:答案|answer|选项)\s*(?:是|为|is|:)?\s*[\(（]?\s*([ABCD])\b", text, re.I
    )
    if m:
        return m.group(1).upper()
    m = re.search(r"\*\*([ABCD])\*\*", text)
    if m:
        return m.group(1).upper()
    m = re.search(r"(?<![A-Za-z])([ABCD])(?![A-Za-z])", text)
    return m.group(1).upper() if m else None


def _numbers(text: str) -> list[float]:
    out = []
    for m in re.findall(r"-?\d+(?:\.\d+)?", text.replace(",", "")):
        try:
            out.append(float(m))
        except ValueError:
            pass
    return out


def _cjk_len(s: str) -> int:
    return len(re.findall(r"[\u4e00-\u9fff]", s))


def _sentences(s: str) -> int:
    parts = [p for p in re.split(r"[。！？!?\.\n]+", s.strip()) if p.strip()]
    return len(parts)


def grade(spec: dict[str, Any], text: str) -> tuple[bool, str]:
    """返回 (是否通过, 说明)。"""
    t = spec.get("type")
    if not text:
        return False, "空回答"
    if t == "numeric":
        want = float(spec["answer"])
        nums = _numbers(text)
        # 只看最后 3 个数字，避免把中间推理数值误判为答案
        tail = nums[-3:] if nums else []
        ok = any(abs(n - want) <= float(spec.get("tol", 1e-6)) for n in tail)
        return ok, f"期望 {want:g}，末尾数字 {tail or '无'}"
    if t == "mcq":
        got = _extract_mcq(text)
        return got == spec["answer"], f"期望 {spec['answer']}，取到 {got or '未识别'}"
    if t == "exact_ci":
        return _norm_nospace(text) == _norm_nospace(
            spec["answer"]
        ), f"期望 {spec['answer']}"
    if t == "exact_nospace":
        return _norm_nospace(text) == _norm_nospace(
            spec["answer"]
        ), f"期望 {spec['answer']}"
    if t == "contains":
        low = _norm(text)
        alts: list[str] = spec.get("all", [])
        ok = (
            any(_norm(a) in low for a in alts)
            if spec.get("mode") == "any"
            else all(_norm(a) in low for a in alts)
        )
        return ok, f"需包含 {alts}"
    if t == "not_contains":
        low = text
        ok = all(v not in low for v in spec["values"])
        return ok, f"需不含 {spec['values']}"
    if t == "startswith":
        return text.strip().startswith(spec["value"]), f"需以 {spec['value']} 开头"
    if t == "endswith":
        return text.strip().rstrip("。.!！").endswith(
            spec["value"].rstrip("。")
        ), f"需以 {spec['value']} 结尾"
    if t == "regex":
        return bool(
            re.search(spec["pattern"], text.strip())
        ), f"需匹配 {spec['pattern']}"
    if t == "max_chars":
        n = _cjk_len(text) if spec.get("unit") == "cjk" else len(text.strip())
        return n <= spec["value"], f"长度 {n} ≤ {spec['value']}"
    if t == "word_count":
        n = len(text.split())
        return n == spec["value"], f"词数 {n} == {spec['value']}"
    if t == "max_sentences":
        n = _sentences(text)
        return n <= spec["value"], f"句数 {n} ≤ {spec['value']}"
    if t == "bullet_count":
        lines = [ln for ln in text.strip().splitlines() if ln.strip()]
        bullets = [ln for ln in lines if ln.strip().startswith("- ")]
        ok = len(bullets) == spec["value"] and len(lines) == spec["value"]
        return ok, f"『- 』行数 {len(bullets)}，总行数 {len(lines)}"
    if t == "uppercase_latin":
        letters = re.findall(r"[A-Za-z]", text)
        ok = bool(letters) and all(c.isupper() for c in letters)
        return ok, "需全大写英文"
    if t == "json" or t == "json_contains":
        obj, err = _parse_json(text)
        if err:
            return False, err
        if t == "json_contains":
            blob = json.dumps(obj, ensure_ascii=False)
            ok = all(x in blob for x in spec.get("text", []))
            nums = _numbers(blob)
            ok = ok and all(
                any(abs(n - w) < 1e-6 for n in nums) for w in spec.get("numbers", [])
            )
            return ok, f"需含 {spec.get('text')}/{spec.get('numbers')}"
        for k, v in (spec.get("checks") or {}).items():
            if not isinstance(obj, dict) or obj.get(k) != v:
                return (
                    False,
                    f"字段 {k} 应为 {v!r}，实为 {obj.get(k) if isinstance(obj, dict) else 'N/A'!r}",
                )
        for k, n in (spec.get("list_len_keys") or {}).items():
            val = obj.get(k) if isinstance(obj, dict) else None
            if not isinstance(val, list) or len(val) != n:
                return False, f"{k} 应为长度 {n} 的数组"
        if spec.get("list_len") is not None:
            if not isinstance(obj, list) or len(obj) != spec["list_len"]:
                return False, f"应为长度 {spec['list_len']} 的数组"
        if spec.get("list_values") is not None:
            if obj != spec["list_values"]:
                return False, f"数组应为 {spec['list_values']}"
        for k in spec.get("bool_keys") or []:
            if not isinstance(obj, dict) or not isinstance(obj.get(k), bool):
                return False, f"{k} 应为布尔"
        return True, "JSON 校验通过"
    if t == "all":
        details = []
        for c in spec["checks"]:
            ok, d = grade(c, text)
            details.append(d)
            if not ok:
                return False, d
        return True, "；".join(details)
    return False, f"未知判分类型 {t}"


def _parse_json(text: str) -> tuple[Any, str | None]:
    s = text.strip()
    s = re.sub(r"^```(?:json)?\s*|\s*```$", "", s, flags=re.I).strip()
    try:
        return json.loads(s), None
    except Exception:
        m = re.search(r"[\[{].*[\]}]", s, re.S)
        if m:
            try:
                return json.loads(m.group(0)), None
            except Exception:
                pass
        return None, "非法 JSON"


def fingerprint(texts: list[str]) -> str:
    h = hashlib.sha256()
    for t in texts:
        h.update(_norm_nospace(t)[:400].encode("utf-8"))
        h.update(b"\x1f")
    return h.hexdigest()[:16]
