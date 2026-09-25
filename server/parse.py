"""粘贴解析：把任意形式的供应商配置拆成 Target 列表。

原则：**不猜格式，靠抽取**。无论用户贴的是键值对、JSON、curl、CSV/Markdown 表格、
环境变量、一行一个渠道、还是中文说明混排，都能抽出 URL / 密钥 / 模型 / 名称。

切块规则（任一命中即切）：
  1. 空行、`---`
  2. 新出现一个 URL，而当前块里已经有 URL
  3. 出现「渠道 / 供应商 / 名称 / N.」这类记录头，而当前块已有 URL
"""

from __future__ import annotations

import json
import re
import shlex
from urllib.parse import urlparse

from .schemas import Provider, Target

# --------------------------------------------------------------------------
# 预处理
# --------------------------------------------------------------------------
_FENCE_RE = re.compile(r"^\s*```[a-zA-Z0-9_-]*\s*$")
_MD_SEP_RE = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$")
_BULLET_RE = re.compile(
    r"^\s*(?:[-*•·]|\(?\d{1,2}[).、]|[①②③④⑤⑥⑦⑧⑨⑩]|[（(][一二三四五六七八九十]+[)）])\s*"
)
_SEP_LINE_RE = re.compile(r"^\s*[-=_*~]{3,}\s*$")
_RECORD_HEAD_RE = re.compile(
    r"^\s*(?:#{1,6}\s*)?(?:渠道|线路|供应商|节点|账号|名称|备注|name|channel|provider|item)\s*[#\d零一二三四五六七八九十]*\s*[:：]",
    re.I,
)

FULLWIDTH = {
    "：": ":",
    "＝": "=",
    "，": ",",
    "；": ";",
    "　": " ",
    "｜": "|",
    "（": "(",
    "）": ")",
    "／": "/",
}


def _preprocess(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    for a, b in FULLWIDTH.items():
        text = text.replace(a, b)
    lines = []
    for ln in text.split("\n"):
        if _FENCE_RE.match(ln):
            continue
        if _MD_SEP_RE.match(ln):
            continue
        ln = _BULLET_RE.sub("", ln)
        lines.append(ln.rstrip())
    return "\n".join(lines)


# --------------------------------------------------------------------------
# 词元抽取
# --------------------------------------------------------------------------
_URL_RE = re.compile(r"(?:https?://|www\.)[^\s\"'`,;|)\]}>]+", re.I)
_BARE_HOST_RE = re.compile(
    r"\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|cn|net|org|io|ai|dev|app|top|xyz|cc|me|co|info|cloud|run|sh)(?::\d{2,5})?(?:/[^\s\"'`,;|)\]}>]*)?",
    re.I,
)
_KEY_RE = re.compile(
    r"\b(sk-ant-[A-Za-z0-9_\-]{8,}|sk-[A-Za-z0-9_\-]{8,}|[A-Za-z0-9]{32,}|[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{8,})\b"
)
_BEARER_RE = re.compile(r"bearer\s+([A-Za-z0-9_\-.]{8,})", re.I)

_MODEL_HINTS = (
    "gpt",
    "o1",
    "o3",
    "o4",
    "chatgpt",
    "davinci",
    "claude",
    "gemini",
    "gemma",
    "qwen",
    "deepseek",
    "glm",
    "chatglm",
    "moonshot",
    "kimi",
    "yi-",
    "llama",
    "mistral",
    "mixtral",
    "command-r",
    "grok",
    "phi",
    "internlm",
    "baichuan",
    "hunyuan",
    "ernie",
    "spark",
    "abab",
    "minimax",
    "doubao",
    "step-",
    "nova",
    "sonar",
    "wizardlm",
    "vicuna",
    "codex",
    "text-embedding",
    "dall-e",
    "flux",
    "suno",
    "whisper",
    "bge-",
    "jina",
    "voyage",
    "rerank",
    "sd3",
    "sdxl",
)
_MODEL_TOKEN_RE = re.compile(r"\b([A-Za-z][\w.\-]*\/[\w.\-]+|[A-Za-z][\w.\-]{2,63})\b")
_HOSTLIKE_RE = re.compile(r"^[\w\-]+(\.[\w\-]+)+$")
_NOISE_WORDS = {
    "api",
    "key",
    "token",
    "url",
    "uri",
    "http",
    "https",
    "sk",
    "bearer",
    "authorization",
    "model",
    "name",
    "host",
    "endpoint",
    "proxy",
}

_LABELS = {
    "base_url": (
        "base_url",
        "baseurl",
        "base-url",
        "api_base",
        "apibase",
        "api-base",
        "api_url",
        "url",
        "uri",
        "endpoint",
        "host",
        "address",
        "接口地址",
        "接口",
        "地址",
        "域名",
        "网址",
    ),
    "api_key": (
        "api_key",
        "apikey",
        "api-key",
        "key",
        "token",
        "access_token",
        "secret",
        "auth",
        "authorization",
        "密钥",
        "秘钥",
        "令牌",
        "key值",
        "订阅",
    ),
    "model": (
        "model",
        "model_name",
        "modelname",
        "models",
        "模型",
        "模型名",
        "模型名称",
    ),
    "name": (
        "name",
        "channel",
        "provider",
        "title",
        "label",
        "名称",
        "渠道",
        "供应商",
        "线路",
        "节点",
        "账号",
        "备注",
        "商家",
    ),
    "proxy": (
        "proxy",
        "代理",
    ),
}


def _label_map() -> dict[str, str]:
    m = {}
    for canon, names in _LABELS.items():
        for n in names:
            m[n] = canon
    return m


_LABEL_LOOKUP = _label_map()
# 标签允许多个词（如 "API Key"、"base url"、"模型 名称"）
_KV_RE = re.compile(
    r"^\s*([A-Za-z_][\w.\-]*(?:\s+[A-Za-z_][\w.\-]*){0,3}|[\u4e00-\u9fff]{1,8})\s*[:=]\s*(.+?)\s*$"
)


def _norm_label(s: str) -> str | None:
    s = s.strip().lower().replace("-", "_").replace(" ", "")
    if s in _LABEL_LOOKUP:
        return _LABEL_LOOKUP[s]
    # 前缀式：OPENAI_BASE_URL / DEEPSEEK_API_KEY
    for name in sorted(_LABEL_LOOKUP, key=len, reverse=True):
        if s.endswith(name):
            return _LABEL_LOOKUP[name]
    return None


def _clean_value(v: str) -> str:
    v = v.strip().strip('"').strip("'").strip("`")
    v = v.rstrip(",;")
    return v


def _norm_url(u: str) -> str:
    u = _clean_value(u)
    if not u:
        return u
    if not u.startswith(("http://", "https://")):
        u = "https://" + u.lstrip("/")
    # 去掉常见的接口路径尾巴，保留根地址
    u = re.sub(
        r"/(v1/)?(chat/completions|completions|messages|responses|embeddings|models)/?$",
        "",
        u,
        flags=re.I,
    )
    return u.rstrip("/")


OPENROUTER_BASE = "https://openrouter.ai/api/v1"


def detect_provider(base_url: str, model: str = "", api_key: str = "") -> Provider:
    """识别协议供应商。优先 openrouter（聚合网关走 OpenAI 兼容协议，claude 也经它）。"""
    blob = f"{base_url} {model}".lower()
    key = (api_key or "").lower()
    if "openrouter" in blob or key.startswith("sk-or-"):
        return Provider.openrouter
    if "anthropic" in blob or "claude" in blob:
        return Provider.anthropic
    return Provider.openai


def _apply_openrouter(targets: list[Target], text: str = "") -> list[Target]:
    """OpenRouter：补默认 base_url；正文提到 openrouter 时整批归类（缺 URL 也能测）。"""
    blob = (text or "").lower()
    for t in targets:
        b = (t.base_url or "").lower()
        if (
            t.provider != Provider.openrouter
            and (
                "openrouter" in b
                or "openrouter" in blob
                or (t.api_key or "").lower().startswith("sk-or-")
                or "openrouter" in (t.model or "").lower()
            )
            and "anthropic" not in b  # 直连 Anthropic 官方时优先 anthropic
        ):
            # 正文提到 openrouter 且尚未明确是官方 Anthropic 直连
            if (
                "openrouter" in b
                or (t.api_key or "").lower().startswith("sk-or-")
                or not t.base_url
            ):
                t.provider = Provider.openrouter
            elif "openrouter" in blob and "api.anthropic.com" not in b:
                t.provider = Provider.openrouter
        if t.provider == Provider.openrouter and not t.base_url:
            t.base_url = OPENROUTER_BASE
    return targets


def _looks_like_model(tok: str) -> bool:
    t = tok.lower()
    if "/" in t and re.match(r"^[\w.\-]+/[\w.\-]+$", t):
        head = t.split("/")[0]
        if head in ("v1", "api", "chat", "https:", "http:"):
            return False
        # 形如 h.com/v1 是 URL 路径，不是 org/model
        if _HOSTLIKE_RE.match(head):
            return False
        return True
    return any(t.startswith(h) for h in _MODEL_HINTS)


# --------------------------------------------------------------------------
# 单个块 → 若干 Target
# --------------------------------------------------------------------------
def _extract_fields(block: str) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {
        k: [] for k in ("base_url", "api_key", "model", "name")
    }
    seen: dict[str, set[str]] = {k: set() for k in out}

    def add(kind: str, val: str) -> None:
        val = _clean_value(val)
        if kind == "api_key":
            val = re.sub(r"^(?:bearer|token|key|authorization)\s+", "", val, flags=re.I)
        if not val or val in seen[kind]:
            return
        seen[kind].add(val)
        out[kind].append(val)

    # 1) 带标签的行（含 env 风格）
    rest_lines: list[str] = []
    for ln in block.split("\n"):
        m = _KV_RE.match(ln)
        handled = False
        if m:
            kind = _norm_label(m.group(1))
            if kind in out:
                add(kind, m.group(2))
                handled = True
        if not handled:
            rest_lines.append(ln)
    rest = "\n".join(rest_lines)

    # 2) Bearer / 明文密钥
    for m in _BEARER_RE.finditer(block):
        add("api_key", m.group(1))

    # 3) 无标签扫描
    for m in _URL_RE.finditer(rest):
        add("base_url", m.group(0))
    if not out["base_url"]:
        for m in _BARE_HOST_RE.finditer(rest):
            host = m.group(0)
            if not re.match(r"^\d", host) and "sk-" not in host:
                add("base_url", host)
    for m in _KEY_RE.finditer(rest):
        tok = m.group(1)
        if not tok.startswith(("http", "www")):
            add("api_key", tok)
    if not out["model"]:
        url_blob = " ".join(out["base_url"])
        for m in _MODEL_TOKEN_RE.finditer(rest):
            tok = m.group(1)
            if tok in url_blob or tok.split("/")[0] in url_blob:
                continue
            if _looks_like_model(tok):
                add("model", tok)

    # 4) 名称：只在明确不像 地址/密钥/模型 时才当渠道名
    if not out["name"]:
        skip = (
            set(out["base_url"])
            | set(out["api_key"])
            | set(out["model"])
            | _NOISE_WORDS
        )
        blob = " ".join(out["base_url"])
        for m in _MODEL_TOKEN_RE.finditer(rest):
            tok = m.group(1)
            if (
                tok in skip
                or tok in blob
                or _looks_like_model(tok)
                or tok.startswith(("http", "www", "sk-"))
                or _HOSTLIKE_RE.match(tok)
            ):
                continue
            if re.search(r"[\u4e00-\u9fff]", tok) or len(tok) <= 24:
                add("name", tok)
                break
    return out


def _host(url: str) -> str:
    try:
        u = urlparse(url)
        path = (u.path or "").rstrip("/")
        return (u.netloc + path) or url
    except Exception:
        return url


def _label(name: str, key: str, model: str, host: str, index: int, total: int) -> str:
    """给渠道起名，优先级：显式名称 > （多目标时用 host / 模型）> 模型 > 密钥前 6 位。"""
    explicit = name.strip() if name and len(name) <= 32 else ""
    if explicit:
        if total == 1:
            return explicit
        # 多目标时加后缀，优先用 host（比序号可读）
        tail = host or str(index + 1)
        return f"{explicit} · {tail}"
    if total > 1 and host:
        return host
    if total > 1 and model:
        return model if index == 0 else f"{model}-{index + 1}"
    return model or (key[:6] if key else "") or host or f"target-{index + 1}"


def _targets_from_fields(f: dict[str, list[str]], block: str) -> list[Target]:
    urls, keys, models, names = f["base_url"], f["api_key"], f["model"], f["name"]
    if not urls:
        # 没给地址也要列出来：供应商常只给模型名或模型+密钥，地址稍后补
        if not models and not keys:
            return []
        name = names[0] if names else ""
        key = keys[0] if keys else ""
        if len(models) > 1:
            return [
                Target(
                    name=_label(name, key, m, "", i, len(models)),
                    provider=detect_provider("", m, key),
                    base_url="",
                    api_key=key,
                    model=m,
                )
                for i, m in enumerate(models)
            ]
        model = models[0] if models else ""
        return [
            Target(
                name=_label(name, key, model, "", 0, 1),
                provider=detect_provider("", model, key),
                base_url="",
                api_key=key,
                model=model,
            )
        ]

    urls = [_norm_url(u) for u in urls]
    name = names[0] if names else ""

    # 一个 url + 多个 key → 每个 key 一个目标（密钥前缀天然不同）
    if len(urls) == 1 and len(keys) > 1 and len(models) <= 1:
        model = models[0] if models else ""
        return [
            Target(
                name=_label(name, k, model, "", 0, 1),
                provider=detect_provider(urls[0], model, k),
                base_url=urls[0],
                api_key=k,
                model=model,
            )
            for i, k in enumerate(keys)
        ]

    # 多个 url + 等量 key → 一一配对
    if len(urls) == len(keys) and len(urls) > 1:
        hosts = [_host(u) for u in urls]
        return [
            Target(
                name=_label(
                    name,
                    keys[i],
                    models[i] if i < len(models) else (models[0] if models else ""),
                    hosts[i],
                    i,
                    len(urls),
                ),
                provider=detect_provider(
                    urls[i],
                    models[i] if i < len(models) else (models[0] if models else ""),
                    keys[i],
                ),
                base_url=urls[i],
                api_key=keys[i],
                model=(models[i] if i < len(models) else (models[0] if models else "")),
            )
            for i in range(len(urls))
        ]

    # 一个 url + 多个 model → 每个模型一个目标
    if len(urls) == 1 and len(models) > 1:
        key = keys[0] if keys else ""
        return [
            Target(
                name=_label(name, key, m, "", 0, 1),
                provider=detect_provider(urls[0], m, key),
                base_url=urls[0],
                api_key=key,
                model=m,
            )
            for i, m in enumerate(models)
        ]

    # 一般情况：每个 url 一个目标，共享首个 key / model
    key = keys[0] if keys else ""
    model = models[0] if models else ""
    hosts = [_host(u) for u in urls]
    total = len(urls) if len(set(hosts)) < len(hosts) else 1
    return [
        Target(
            name=_label(name, key, model, hosts[i], i, total),
            provider=detect_provider(u, model, key),
            base_url=u,
            api_key=key,
            model=model,
        )
        for i, u in enumerate(urls)
    ]


# --------------------------------------------------------------------------
# 表格（CSV / TSV / Markdown）
# --------------------------------------------------------------------------
def _split_row(line: str) -> list[str]:
    for d in ("\t", "|", ","):
        if line.count(d) >= 2:
            parts = [p.strip() for p in line.split(d)]
            return [p for p in parts if p != ""]
    return [line.strip()]


def _parse_table(text: str) -> list[Target]:
    lines = [ln for ln in text.split("\n") if ln.strip() and not _SEP_LINE_RE.match(ln)]
    if len(lines) < 2:
        return []
    rows = [_split_row(ln) for ln in lines]
    widths = {len(r) for r in rows}
    if len(widths) != 1 or min(widths) < 2 or max(widths) < 2:
        return []
    if not any(len(_split_row(ln)) == max(widths) for ln in lines[:2]):
        return []
    header = [_norm_label(c) for c in rows[0]]
    labeled = sum(1 for h in header if h) >= 1
    if not labeled:
        # 没有可识别表头：把首行也当数据，靠内容判断列
        header = [None] * len(rows[0])
        body = rows
    else:
        body = rows[1:]
    out: list[Target] = []
    for r in body:
        f: dict[str, list[str]] = {
            k: [] for k in ("base_url", "api_key", "model", "name")
        }
        for i, cell in enumerate(r):
            if not cell:
                continue
            col = header[i] if i < len(header) else None
            if col in f:
                f[col].append(cell)
            else:
                # 无表头列：靠内容判断
                if _URL_RE.search(cell) or _BARE_HOST_RE.search(cell):
                    f["base_url"].append(cell)
                elif _KEY_RE.search(cell):
                    f["api_key"].append(cell)
                elif _looks_like_model(cell):
                    f["model"].append(cell)
        out.extend(_targets_from_fields(f, ""))
    return out


# --------------------------------------------------------------------------
# 切块
# --------------------------------------------------------------------------
def _has_url(s: str) -> bool:
    return bool(_URL_RE.search(s) or _BARE_HOST_RE.search(s))


_START_URL_RE = re.compile(r"^\s*(?:https?://|www\.)", re.I)


def _split_blocks(text: str) -> list[str]:
    blocks: list[list[str]] = [[]]
    for ln in text.split("\n"):
        if not ln.strip() or _SEP_LINE_RE.match(ln):
            if blocks[-1]:
                blocks.append([])
            continue
        cur = "\n".join(blocks[-1])
        if blocks[-1] and _START_URL_RE.match(ln) and _has_url(cur):
            # 一行一个渠道：本行以地址开头，且当前块已经有地址
            blocks.append([])
        elif blocks[-1] and _RECORD_HEAD_RE.match(ln) and _has_url(cur):
            blocks.append([])
        blocks[-1].append(ln)
    return ["\n".join(b) for b in blocks if "\n".join(b).strip()]


def _delim(line: str) -> str:
    for d in ("\t", "|", ","):
        if line.count(d) >= 2:
            return d
    return ""


def _records_from_text(text: str) -> list:
    """把任意文本切成记录：表格整组、curl 整条、以地址开头的行各成一条，其余归入当前记录。"""
    lines = text.split("\n")
    records: list = []
    cur: list[str] = []

    def flush() -> None:
        if any(l.strip() for l in cur):
            records.append("\n".join(cur))
        cur.clear()

    i = 0
    while i < len(lines):
        ln = lines[i]

        # 表格组：连续同分隔符且列数一致
        d = _delim(ln)
        if d and len(_split_row(ln)) >= 2:
            j, grp = i, []
            while (
                j < len(lines)
                and _delim(lines[j]) == d
                and len(_split_row(lines[j])) >= 2
            ):
                grp.append(lines[j])
                j += 1
            if len(grp) >= 2:
                flush()
                for t in _parse_table("\n".join(grp)):
                    records.append(("__target__", t))
                i = j
                continue

        # curl 整条（含反斜杠续行）
        if ln.strip().startswith("curl"):
            flush()
            j, buf = i, []
            while j < len(lines):
                buf.append(lines[j])
                cont = lines[j].rstrip().endswith("\\")
                j += 1
                if not cont:
                    break
            t = _parse_curl("\n".join(buf))
            if t:
                records.append(("__target__", t))
            i = j
            continue

        # 以地址开头，且当前记录已有地址 → 新记录
        if _START_URL_RE.match(ln) and _has_url("\n".join(cur)):
            flush()
        cur.append(ln)
        i += 1

    flush()
    return records


# --------------------------------------------------------------------------
# 入口
# --------------------------------------------------------------------------
def parse_paste(text: str) -> list[Target]:
    if not text or not text.strip():
        return []
    clean = _preprocess(text)

    # 1) 整体 JSON
    j = _try_json(clean)
    if j:
        return _dedupe(_apply_openrouter(j, clean))

    # 2) 逐记录解析（表格 / curl / 键值 / 裸词混排都能拆）
    out: list[Target] = []
    for rec in _records_from_text(clean):
        if isinstance(rec, tuple):
            out.append(rec[1])
            continue
        j = _try_json(rec)
        if j:
            out.extend(_apply_openrouter(j, rec))
            continue
        out.extend(_targets_from_fields(_extract_fields(rec), rec))
    return _dedupe(_apply_openrouter(out, clean))


def _try_json(text: str) -> list[Target] | None:
    s = text.strip()
    if not s.startswith(("{", "[")):
        return None
    try:
        data = json.loads(s)
    except Exception:
        return None
    items: list[dict] = []
    if isinstance(data, dict):
        for key in ("targets", "channels", "list", "data", "items"):
            if isinstance(data.get(key), list):
                items = [x for x in data[key] if isinstance(x, dict)]
                break
        if not items:
            items = [data]
    elif isinstance(data, list):
        items = [x for x in data if isinstance(x, dict)]
    out: list[Target] = []
    for d in items:
        f: dict[str, list[str]] = {
            k: [] for k in ("base_url", "api_key", "model", "name")
        }
        for k, v in d.items():
            kind = _norm_label(str(k))
            if kind in f and isinstance(v, (str, int, float)):
                f[kind].append(str(v))
        out.extend(_targets_from_fields(f, s))
    return out


def _parse_curl(block: str) -> Target | None:
    block = re.sub(r"\\\s*\n", " ", block)
    try:
        toks = shlex.split(block)
    except ValueError:
        toks = block.split()
    if not toks or toks[0] != "curl":
        return None
    url, key, headers, body = "", "", {}, {}
    i = 1
    while i < len(toks):
        t = toks[i]
        if t in ("-H", "--header") and i + 1 < len(toks):
            hv = toks[i + 1]
            if ":" in hv:
                k, v = hv.split(":", 1)
                headers[k.strip().lower()] = v.strip()
            i += 2
        elif t in ("-d", "--data", "--data-raw", "--data-binary") and i + 1 < len(toks):
            try:
                body = json.loads(toks[i + 1])
            except Exception:
                body = {}
            i += 2
        elif t.startswith(("http://", "https://")):
            url = t
            i += 1
        elif t in (
            "-X",
            "--request",
            "-o",
            "--output",
            "-A",
            "--user-agent",
            "-b",
            "--cookie",
            "-u",
            "--user",
        ) and i + 1 < len(toks):
            i += 2
        else:
            i += 1
    url = url or str(body.get("url") or "")
    if not url:
        return None
    for k, v in headers.items():
        if k == "authorization":
            key = v.split()[-1]
        elif k in ("x-api-key", "api-key"):
            key = v
    model = str(body.get("model", "")) if isinstance(body, dict) else ""
    base = _norm_url(url)
    return _apply_openrouter(
        [
            Target(
                name=model or "target",
                provider=detect_provider(base, model, key),
                base_url=base,
                api_key=key,
                model=model,
            )
        ],
        block,
    )[0]


def _dedupe(targets: list[Target]) -> list[Target]:
    seen, out = set(), []
    for t in targets:
        sig = (t.base_url, t.api_key, t.model)
        if sig in seen:
            continue
        seen.add(sig)
        out.append(t)
    return _uniquify_names(out)


def _uniquify_names(targets: list[Target]) -> list[Target]:
    """显示名不得重复：冲突时用 host（再不行用序号）区分。"""
    counts: dict[str, int] = {}
    for t in targets:
        counts[t.name] = counts.get(t.name, 0) + 1
    used: dict[str, int] = {}
    for t in targets:
        if counts[t.name] <= 1:
            continue
        tag = _host(t.base_url) or t.model or ""
        cand = f"{t.name}（{tag}）" if (tag and tag != t.name) else t.name
        n = used.get(cand, 0)
        used[cand] = n + 1
        t.name = cand if n == 0 else f"{cand} #{n + 1}"
    return targets
