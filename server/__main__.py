"""precision-bench 命令行入口。

    precision-bench                 # 启动仪表盘（默认 127.0.0.1:8787）
    precision-bench --port 9000     # 换端口
    precision-bench --host 0.0.0.0  # 监听所有网卡（务必放在带认证的反向代理后）

数据默认落在包同级的 data/bench.db，可用 LLMBENCH_DB 覆盖。
"""

from __future__ import annotations

import argparse
import os
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="precision-bench",
        description="LLM 中转 API 压测 / 缓存验真 / 降智检测",
    )
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8787")))
    parser.add_argument(
        "--db", default=os.environ.get("LLMBENCH_DB"), help="SQLite 路径"
    )
    parser.add_argument("--reload", action="store_true", help="开发模式热重载")
    args = parser.parse_args(argv)

    if args.db:
        os.environ["LLMBENCH_DB"] = args.db

    try:
        import uvicorn
    except ImportError:  # pragma: no cover
        print("缺少 uvicorn，请先安装：pip install 'precision-bench'", file=sys.stderr)
        return 1

    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print(
            f"警告：正在监听 {args.host}，服务无内置认证，请仅放在带认证的反向代理后。",
            file=sys.stderr,
        )

    print(f"LLM Bench → http://{args.host}:{args.port}")
    uvicorn.run(
        "server.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        access_log=False,
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
