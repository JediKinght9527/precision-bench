"""粘贴解析：覆盖各种真实粘贴形式。"""

from server.parse import detect_provider, parse_paste
from server.schemas import Provider


def _sig(ts):
    return [(t.base_url, t.api_key, t.model, t.provider.value) for t in ts]


def test_kv_three_piece():
    ts = parse_paste(
        "base_url: https://api.example.com\napi_key: sk-abc123456789\nmodel: gpt-4o"
    )
    assert len(ts) == 1
    t = ts[0]
    assert t.base_url == "https://api.example.com"
    assert t.api_key == "sk-abc123456789"
    assert t.model == "gpt-4o"
    assert t.provider == Provider.openai


def test_chinese_labels_fullwidth():
    ts = parse_paste(
        "接口地址：https://api.foo.com/v1\n密钥：sk-xyz123456789\n模型：claude-3-5-sonnet"
    )
    assert len(ts) == 1
    assert ts[0].provider == Provider.anthropic
    assert ts[0].model.startswith("claude")


def test_url_only_plus_bare_key():
    """没有标签也能抽：只有 URL 和密钥、模型。"""
    ts = parse_paste("https://api.relay.com\nsk-abcdefgh12345678\ngpt-4o-mini")
    assert len(ts) == 1
    assert ts[0].base_url == "https://api.relay.com"
    assert ts[0].api_key == "sk-abcdefgh12345678"
    assert ts[0].model == "gpt-4o-mini"


def test_env_style():
    ts = parse_paste(
        "OPENAI_BASE_URL=https://api.env.com\nOPENAI_API_KEY=sk-env1234567890\nOPENAI_MODEL=gpt-4o"
    )
    assert len(ts) == 1
    assert ts[0].base_url == "https://api.env.com"
    assert ts[0].api_key == "sk-env1234567890"


def test_one_channel_per_line():
    """一行一个渠道，无标签、无空行。"""
    text = (
        "https://a.example.com  sk-aaaa123456789  gpt-4o\n"
        "https://b.example.com  sk-bbbb123456789  claude-3-5-sonnet\n"
        "https://c.example.com  sk-cccc123456789  deepseek-chat\n"
    )
    ts = parse_paste(text)
    assert len(ts) == 3, _sig(ts)
    assert [t.base_url for t in ts] == [
        "https://a.example.com",
        "https://b.example.com",
        "https://c.example.com",
    ]
    assert ts[1].provider == Provider.anthropic


def test_numbered_blocks():
    text = (
        "1. 接口地址: https://one.example.com\n"
        "   API Key: sk-one1234567890\n"
        "   模型: gpt-4o\n"
        "2. 接口地址: https://two.example.com\n"
        "   API Key: sk-two1234567890\n"
        "   模型: qwen-max\n"
    )
    ts = parse_paste(text)
    assert len(ts) == 2, _sig(ts)
    assert ts[1].model == "qwen-max"


def test_markdown_table():
    text = (
        "| 名称 | base_url | api_key | model |\n"
        "|------|----------|---------|-------|\n"
        "| 甲 | https://a.com | sk-tab1111111111 | gpt-4o |\n"
        "| 乙 | https://b.com | sk-tab2222222222 | claude-3-opus |\n"
    )
    ts = parse_paste(text)
    assert len(ts) == 2, _sig(ts)
    assert ts[0].name == "甲"
    assert ts[1].provider == Provider.anthropic


def test_csv_table():
    text = "url,key,model\nhttps://x.com,sk-csv1234567890,gpt-4o-mini\nhttps://y.com,sk-csv2234567890,gemini-1.5-pro\n"
    ts = parse_paste(text)
    assert len(ts) == 2, _sig(ts)
    assert ts[0].base_url == "https://x.com"
    assert ts[1].model == "gemini-1.5-pro"


def test_tsv_from_excel():
    text = "https://e1.com\tsk-tsv1234567890\tgpt-4o\nhttps://e2.com\tsk-tsv2234567890\tgpt-4o-mini\n"
    ts = parse_paste(text)
    assert len(ts) == 2, _sig(ts)


def test_json_variants():
    a = parse_paste(
        '[{"base_url":"https://a.com","api_key":"sk-j1111111111","model":"gpt-4o"}]'
    )
    assert len(a) == 1 and a[0].base_url == "https://a.com"
    b = parse_paste(
        '{"channels":[{"url":"https://b.com","token":"sk-j2222222222","model":"claude-3"}]}'
    )
    assert len(b) == 1 and b[0].provider == Provider.anthropic
    c = parse_paste(
        '{"baseUrl":"https://c.com","apiKey":"sk-j3333333333","model":"gpt-4o"}'
    )
    assert len(c) == 1 and c[0].base_url == "https://c.com"


def test_curl():
    text = (
        "curl https://api.example.com/v1/chat/completions "
        '-H "Authorization: Bearer sk-curl1234567890" '
        "-H 'Content-Type: application/json' "
        '-d \'{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}\''
    )
    ts = parse_paste(text)
    assert len(ts) == 1
    assert ts[0].base_url == "https://api.example.com"
    assert ts[0].api_key == "sk-curl1234567890"
    assert ts[0].model == "gpt-4o-mini"


def test_multiple_models_one_channel():
    text = (
        "base_url: https://multi.com\napi_key: sk-multi1234567890\n"
        "model: gpt-4o\nmodel: gpt-4o-mini\nmodel: claude-3-haiku\n"
    )
    ts = parse_paste(text)
    assert len(ts) == 3, _sig(ts)
    assert {t.model for t in ts} == {"gpt-4o", "gpt-4o-mini", "claude-3-haiku"}


def test_mixed_chinese_prose():
    text = "这是老王的渠道，速度不错\n地址 https://laowang.com 密钥 sk-lw1234567890 模型 gpt-4o\n"
    ts = parse_paste(text)
    assert len(ts) == 1
    assert ts[0].base_url == "https://laowang.com"
    assert ts[0].model == "gpt-4o"


def test_duplicate_dedup():
    ts = parse_paste(
        "https://a.com sk-dup1234567890 gpt-4o\nhttps://a.com sk-dup1234567890 gpt-4o"
    )
    assert len(ts) == 1


def test_bearer_header_only():
    ts = parse_paste(
        "Authorization: Bearer sk-bearer123456789\nhttps://bearer.com\ngpt-4o"
    )
    assert len(ts) == 1 and ts[0].api_key == "sk-bearer123456789"


def test_detect_provider():
    assert (
        detect_provider("https://api.anthropic.com", "claude-3") == Provider.anthropic
    )
    assert detect_provider("https://api.openai.com", "gpt-4o") == Provider.openai
    assert detect_provider("https://relay.com", "claude-3-opus") == Provider.anthropic
    assert (
        detect_provider("https://openrouter.ai/api/v1", "stealth/space-bunny-alpha")
        == Provider.openrouter
    )
    assert detect_provider("", "gpt-4o", "sk-or-v1-abc123") == Provider.openrouter


def test_openrouter_key_only_autofills_base_url():
    """只有 sk-or- 密钥 + 模型：自动归类 openrouter 并补默认地址。"""
    ts = parse_paste("api_key: sk-or-v1-abc123456789\nmodel: stealth/space-bunny-alpha")
    assert len(ts) == 1
    t = ts[0]
    assert t.provider == Provider.openrouter
    assert t.base_url == "https://openrouter.ai/api/v1"
    assert t.model == "stealth/space-bunny-alpha"


def test_openrouter_prose_mention_autofills():
    ts = parse_paste("openrouter\nsk-or-v1-xyz987654321\ngpt-4o-mini")
    assert len(ts) == 1
    assert ts[0].provider == Provider.openrouter
    assert ts[0].base_url == "https://openrouter.ai/api/v1"


def test_openrouter_url_keeps_existing_base():
    ts = parse_paste(
        "base_url: https://openrouter.ai/api/v1\n"
        "api_key: sk-or-v1-keepme00000001\n"
        "model: anthropic/claude-3.5-sonnet"
    )
    assert len(ts) == 1
    assert ts[0].provider == Provider.openrouter
    assert ts[0].base_url == "https://openrouter.ai/api/v1"
    # 经 OpenRouter 走 OpenAI 兼容协议，不因 claude 误判 anthropic 直连
    assert ts[0].model.startswith("anthropic/")


def test_anthropic_direct_not_overridden_by_openrouter_prose():
    """官方 Anthropic 直连地址不因正文提 openrouter 被改写。"""
    ts = parse_paste(
        "openrouter can use claude too\n"
        "base_url: https://api.anthropic.com\n"
        "api_key: sk-ant-api03-direct000001\n"
        "model: claude-3-5-sonnet-20241022"
    )
    assert len(ts) == 1
    assert ts[0].provider == Provider.anthropic
    assert ts[0].base_url == "https://api.anthropic.com"


def test_openrouter_prose_with_other_base_url():
    """正文提 openrouter + 其他中转地址（非 Anthropic 官方）→ 整批归 openrouter，URL 保留。"""
    ts = parse_paste(
        "please use openrouter for this\n"
        "base_url: https://relay.example.com/v1\n"
        "api_key: sk-relay-abcdef123456\n"
        "model: gpt-4o"
    )
    assert len(ts) == 1
    assert ts[0].provider == Provider.openrouter
    assert ts[0].base_url == "https://relay.example.com/v1"


def test_openrouter_prose_without_url_and_non_or_key():
    """仅正文提 openrouter：无地址、密钥非 sk-or → provider=openrouter 并补默认 base。"""
    ts = parse_paste("use openrouter\nmodel: gpt-4o-mini\napi_key: sk-plain-xyz000001")
    assert len(ts) == 1
    assert ts[0].provider == Provider.openrouter
    assert ts[0].base_url == "https://openrouter.ai/api/v1"


def test_garbage_returns_empty():
    assert parse_paste("你好，今天天气不错") == []
    assert parse_paste("") == []


def test_model_only_no_url():
    """只给模型名也要能识别（地址稍后补）。"""
    ts = parse_paste("gpt-4o")
    assert len(ts) == 1
    assert ts[0].model == "gpt-4o"
    assert ts[0].base_url == ""


def test_labelled_model_only():
    ts = parse_paste("模型：gpt-4o")
    assert len(ts) == 1 and ts[0].model == "gpt-4o"


def test_key_and_model_no_url():
    ts = parse_paste("sk-abcdefgh12345678\ngpt-4o")
    assert len(ts) == 1
    assert ts[0].api_key == "sk-abcdefgh12345678"
    assert ts[0].model == "gpt-4o"
    assert ts[0].base_url == ""


def test_multiple_models_only():
    ts = parse_paste("gpt-4o\ngpt-4o-mini\nclaude-3-5-sonnet")
    assert len(ts) == 3
    assert {t.model for t in ts} == {"gpt-4o", "gpt-4o-mini", "claude-3-5-sonnet"}


def test_channel_lines_then_extra_model():
    """两行渠道 + 末尾单独一行模型：末尾模型归到上一个渠道。"""
    text = (
        "https://a.example.com  sk-aaaa123456789  gpt-4o\n"
        "https://b.example.com  sk-bbbb123456789  claude-3-5-sonnet\n"
        "gpt-4o-mini"
    )
    ts = parse_paste(text)
    assert len(ts) == 3, _sig(ts)
    assert (ts[2].base_url, ts[2].model) == ("https://b.example.com", "gpt-4o-mini")


def test_labeled_url_not_split():
    """base_url: https://… 这种带标签的行不能被当成新渠道切开。"""
    text = (
        "base_url: https://a.com\napi_key: sk-aaa123456789\nmodel: gpt-4o\n"
        "base_url: https://b.com\napi_key: sk-bbb123456789\nmodel: qwen-max"
    )
    ts = parse_paste(text)
    assert len(ts) == 2, _sig(ts)
    assert [t.base_url for t in ts] == ["https://a.com", "https://b.com"]


def test_names_never_duplicate():
    """同 host 同模型的两个入口，显示名必须可区分。"""
    text = (
        "https://h.com/v1  sk-1aaaa1234567890  gpt-4o\n"
        "https://h.com/v2  sk-2bbbb1234567890  gpt-4o"
    )
    ts = parse_paste(text)
    assert len(ts) == 2
    assert len({t.name for t in ts}) == 2, [t.name for t in ts]


def test_url_path_not_treated_as_model():
    ts = parse_paste("https://api.host.com/v1  sk-abc1234567890  gpt-4o")
    assert len(ts) == 1
    assert ts[0].model == "gpt-4o", ts[0].model


def test_hf_style_model_kept():
    ts = parse_paste(
        "https://api.silicon.com  sk-sil1234567890  Qwen/Qwen2.5-72B-Instruct"
    )
    assert len(ts) == 1
    assert ts[0].model == "Qwen/Qwen2.5-72B-Instruct"
