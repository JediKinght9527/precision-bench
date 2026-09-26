# syntax=docker/dockerfile:1
# 多阶段构建：依赖层走缓存，最终镜像不带 uv（对齐 uv 官方 docker 示例）

FROM ghcr.io/astral-sh/uv:python3.12-trixie-slim AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_DEV=1 \
    UV_PYTHON_DOWNLOADS=0

WORKDIR /app

RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project

# 只拷贝运行必需内容，避免 data/、.venv/、.shots/ 进入镜像
# LICENSE 与 README.md 是构建元数据（license / readme 字段）的来源，缺一不可
COPY pyproject.toml uv.lock LICENSE README.md ./
COPY server ./server
COPY web ./web

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked

# ---------- 最终镜像 ----------
FROM python:3.12-slim-trixie

RUN groupadd --system --gid 999 nonroot \
 && useradd --system --gid 999 --uid 999 --create-home nonroot

COPY --from=builder --chown=nonroot:nonroot /app /app

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=8787

# SQLite 与历史数据落在此目录，交给具名卷持久化
RUN mkdir -p /app/data && chown nonroot:nonroot /app/data
VOLUME ["/app/data"]

USER nonroot
WORKDIR /app
EXPOSE 8787

CMD [".venv/bin/python", "-m", "uvicorn", "server.main:app", \
     "--host", "0.0.0.0", "--port", "8787", "--no-access-log"]
