"""Pydantic 数据模型。"""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field


class Provider(str, Enum):
    openai = "openai"
    anthropic = "anthropic"
    openrouter = "openrouter"  # OpenAI 兼容聚合网关（Bearer + /v1/chat/completions）


class LoadMode(str, Enum):
    closed = "closed"  # 并发闭模型
    open = "open"  # 定频开模型（含 CO 修正）
    duration = "duration"  # 时长模式：ramp -> steady -> cooldown


class DistKind(str, Enum):
    fixed = "fixed"
    uniform = "uniform"
    normal = "normal"


class Target(BaseModel):
    """单个供应商配置（粘贴解析产物）。"""

    name: str = "target"
    provider: Provider = Provider.openai
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    extra_headers: dict[str, str] = Field(default_factory=dict)
    extra_body: dict[str, Any] = Field(default_factory=dict)
    path: str | None = None  # 覆盖默认路径


class TrafficConfig(BaseModel):
    """场景化流量配置。"""

    prompt_mode: Literal["tiny", "sample", "custom"] = "tiny"
    prompt: str = ""
    system_prompt: str = ""
    # 输入长度分布（当 prompt_mode=sample 时按 token 数生成）
    input_dist: DistKind = DistKind.fixed
    input_tokens: int = 128
    output_dist: DistKind = DistKind.fixed
    output_tokens: int = 256
    max_tokens: int = 512
    temperature: float = 0.0
    top_p: float | None = None


class SLO(BaseModel):
    # 合格线：默认按"可接受"而非"优秀"设定，用户可在侧栏调整
    ttft_ms: float = 1500.0  # 首字延迟
    tpot_ms: float = 50.0  # 每 token 时间（=20 tok/s）
    e2e_ms: float = 5000.0  # 端到端（含长输出）


class RunConfig(BaseModel):
    targets: list[Target] = Field(default_factory=list, max_length=20)
    name: str = "run"

    mode: LoadMode = LoadMode.closed
    concurrency: int = Field(default=1, ge=1, le=256)  # closed / duration
    rate: float = Field(default=1.0, gt=0, le=10000)  # open: req/s；duration 可选
    request_count: int = Field(default=20, ge=1, le=1_000_000)  # closed: 总请求数
    duration_s: float = Field(default=60.0, gt=0, le=86400)  # duration/open 上限时间
    ramp_s: float = Field(default=0.0, ge=0, le=3600)
    cooldown_s: float = Field(default=0.0, ge=0, le=3600)
    warmup: int = Field(default=3, ge=0, le=1000)

    timeout_s: float = Field(default=120.0, gt=0, le=3600)
    retries: int = Field(default=0, ge=0, le=10)
    stream: bool = True
    connection_reuse: bool = True

    proxy: str | None = None
    verify_tls: bool = True

    # 成本估算（可选，单位：元/百万 token）
    price_in: float = 0.0
    price_out: float = 0.0
    # 缓存命中的输入单价；0 表示与 price_in 相同
    price_cache_in: float = 0.0
    # 缓存写入单价；0 表示与 price_in 相同
    price_cache_write: float = 0.0

    # 并发 ramp（仅 closed 模式）：每秒新增 worker 数，0=不 ramp
    ramp_rate: float = Field(default=0.0, ge=0, le=1000)

    slo: SLO = Field(default_factory=SLO)
    traffic: TrafficConfig = Field(default_factory=TrafficConfig)

    # 反识别：请求间隔抖动、随机化
    jitter: float = 0.0  # 0~1，百分比抖动
    randomize: bool = True
    cache_mode: bool = False


class SampleRecord(BaseModel):
    run_id: str
    target: str
    seq: int
    ts: float
    scheduled_ts: float | None = None
    send_ts: float | None = None
    dns_ms: float | None = None
    tcp_ms: float | None = None
    tls_ms: float | None = None
    ttft_ms: float | None = None
    e2e_ms: float | None = None
    observed_e2e_ms: float | None = None
    corrected_e2e_ms: float | None = None
    tpot_ms: float | None = None
    itl_mean_ms: float | None = None
    itl_p99_ms: float | None = None
    out_tokens: int = 0
    in_tokens: int = 0
    cached_tokens: int = 0  # 命中提示缓存的输入 token（各厂商结构归一后）
    cache_write_tokens: int = (
        0  # 写入缓存的 token（Anthropic cache_creation / OpenAI cache_write）
    )
    cache_reported: bool = False  # usage 是否出现过缓存字段（False=渠道未上报）
    tokens_estimated: bool = False
    status_code: int | None = None
    ok: bool = False
    retry_no: int = 0
    error_class: str | None = None
    error_msg: str | None = None
    bytes_rx: int = 0
    conn_reused: bool | None = None


class RunStatus(str, Enum):
    pending = "pending"
    running = "running"
    paused = "paused"
    stopping = "stopping"
    stopped = "stopped"
    done = "done"
    error = "error"


class RunSummary(BaseModel):
    run_id: str
    name: str
    status: RunStatus
    total: int = 0
    ok: int = 0
    started_at: float | None = None
    ended_at: float | None = None


class ScheduleConfig(BaseModel):
    schedule_id: str | None = None
    name: str
    cron: str  # 标准 5 段 cron
    enabled: bool = True
    run: RunConfig
    alert: "AlertConfig" = Field(default_factory=lambda: AlertConfig())


class AlertConfig(BaseModel):
    webhook_url: str | None = None  # 通用 webhook / 飞书机器人地址
    webhook_kind: Literal["generic", "feishu", "none"] = "none"
    min_success_rate: float | None = 0.95
    max_ttft_ms: float | None = None
    max_e2e_ms: float | None = None
    consecutive_failures: int | None = None
    cooldown_s: float = 300.0


ScheduleConfig.model_rebuild()
