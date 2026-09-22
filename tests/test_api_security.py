"""密钥三连回归：落库剔除、API 出口脱敏、models 无 GET。"""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile

# 必须在 import server.main 之前设置（DB_PATH 在 import 时求值）
os.environ["LLMBENCH_DB"] = os.path.join(
    tempfile.mkdtemp(prefix="llmbench-sec-"), "bench.db"
)

from fastapi.testclient import TestClient  # noqa: E402

from server.main import app  # noqa: E402
from server.store import _cfg_json_safe, _mask  # noqa: E402

SECRET = "sk-SECRET-DO-NOT-LEAK"
DB = os.environ["LLMBENCH_DB"]

CFG = {
    "targets": [
        {
            "name": "t1",
            "provider": "openai",
            "base_url": "http://127.0.0.1:1",
            "api_key": SECRET,
            "model": "m",
        }
    ],
    "name": "sec",
    "request_count": 1,
    "warmup": 0,
    "timeout_s": 1.0,
}


def test_mask_strips_userinfo():
    assert _mask("https://user:pass@example.com/v1") == "https://***@example.com/v1"
    assert _mask("http://user@h.com/") == "http://***@h.com/"
    assert _mask("https://example.com/v1") == "https://example.com/v1"


def test_cfg_json_safe_drops_api_key():
    out = _cfg_json_safe({"targets": [{"api_key": SECRET, "model": "m"}], "name": "x"})
    assert "api_key" not in out["targets"][0]
    assert out["targets"][0]["model"] == "m"
    assert out["name"] == "x"


def test_api_endpoints_do_not_leak_key():
    with TestClient(app) as client:
        # 无 GET query 版本
        r = client.get(
            "/api/targets/models",
            params={"base_url": "http://x", "api_key": SECRET},
        )
        assert r.status_code in (404, 405)

        rid = client.post("/api/runs", json=CFG).json()["run_ids"][0]

        detail = client.get(f"/api/runs/{rid}").text
        assert SECRET not in detail
        assert "api_key" not in json.loads(detail).get("target") or (
            "api_key" not in (json.loads(detail).get("target") or {})
        )

        exp = client.get(f"/api/runs/{rid}/export.json").text
        assert SECRET not in exp

        lst = client.get("/api/runs").text
        assert SECRET not in lst

        md = client.get(f"/api/runs/{rid}/export.md").text
        assert SECRET not in md

        # schedule：enabled=False 避免注册 cron；DB 保留 key，出口无 key
        sc = dict(CFG)
        sid = client.post(
            "/api/schedules",
            json={
                "name": "sec-sch",
                "cron": "0 3 * * *",
                "enabled": False,
                "run": sc,
                "alert": {},
            },
        ).json()["schedule_id"]
        sch = client.get("/api/schedules").text
        assert SECRET not in sch
        assert f'"schedule_id": "{sid}"' in sch or sid in sch

        with sqlite3.connect(DB) as con:
            row = con.execute(
                "SELECT config_json FROM schedules WHERE schedule_id=?", (sid,)
            ).fetchone()
            assert row and SECRET in row[0]

            # runs.params_json 落库已剔除 key
            n_leak = con.execute(
                "SELECT COUNT(*) FROM runs WHERE params_json LIKE ?", (f"%{SECRET}%",)
            ).fetchone()[0]
            assert n_leak == 0

            # base_url_masked 已打码
            masked = con.execute(
                "SELECT base_url_masked FROM runs WHERE run_id=?", (rid,)
            ).fetchone()[0]
            assert "127.0.0.1:1" in masked

            # DB 里 runs 不应再出现完整 secret
            total = con.execute(
                "SELECT COUNT(*) FROM runs WHERE params_json LIKE '%sk-%'"
            ).fetchone()[0]
            assert total == 0
