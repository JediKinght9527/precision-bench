"""SQLite 持久化（WAL + 异步批量写）。"""

from __future__ import annotations

import asyncio
import json
import re
import time
from pathlib import Path
from typing import Any

import aiosqlite

from .schemas import RunConfig, RunStatus, SampleRecord, ScheduleConfig

_SCHEMA_TABLES = """
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  name TEXT, provider TEXT, base_url_masked TEXT, model TEXT,
  params_json TEXT, slo_json TEXT, schedule_cron TEXT,
  started_at REAL, ended_at REAL, status TEXT
);
CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT, target TEXT, seq INTEGER, ts REAL,
  scheduled_ts REAL, send_ts REAL,
  dns_ms REAL, tcp_ms REAL, tls_ms REAL,
  ttft_ms REAL, e2e_ms REAL, observed_e2e_ms REAL, corrected_e2e_ms REAL,
  tpot_ms REAL, itl_mean_ms REAL, itl_p99_ms REAL,
  out_tokens INTEGER, in_tokens INTEGER,
  cached_tokens INTEGER, cache_write_tokens INTEGER,
  tokens_estimated INTEGER,
  status_code INTEGER, ok INTEGER, retry_no INTEGER,
  error_class TEXT, error_msg TEXT, bytes_rx INTEGER, conn_reused INTEGER
);
CREATE TABLE IF NOT EXISTS schedules (
  schedule_id TEXT PRIMARY KEY, name TEXT, cron TEXT, enabled INTEGER,
  config_json TEXT, alert_json TEXT
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT, rule TEXT, metric TEXT, threshold REAL, value REAL,
  triggered_at REAL, recovered_at REAL, notified INTEGER
);
CREATE TABLE IF NOT EXISTS bench_runs (
  run_id TEXT PRIMARY KEY, ts REAL, name TEXT, provider TEXT,
  base_url_masked TEXT, model TEXT, dims_json TEXT, opts_json TEXT,
  scores_json TEXT, total_score REAL, n_items INTEGER, completed INTEGER,
  fingerprint TEXT, status TEXT,
  engine TEXT, task_key TEXT, lm_eval_version TEXT,
  fewshot INTEGER, limit_n INTEGER, seed INTEGER
);
CREATE TABLE IF NOT EXISTS bench_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, dim TEXT, item_id TEXT,
  passed INTEGER, latency_ms REAL, detail TEXT, got TEXT, expected TEXT
);
CREATE TABLE IF NOT EXISTS bench_baselines (
  base_url TEXT, model TEXT, task_key TEXT, bench_run_id TEXT,
  total_score REAL, fingerprint TEXT, ts REAL,
  PRIMARY KEY (base_url, model, task_key)
);
CREATE TABLE IF NOT EXISTS cache_checks (
  id TEXT PRIMARY KEY, ts REAL, name TEXT, provider TEXT,
  base_url_masked TEXT, model TEXT, params_json TEXT,
  rounds_json TEXT, summary_json TEXT, status TEXT
);
CREATE TABLE IF NOT EXISTS cache_baselines (
  base_url TEXT, model TEXT, check_id TEXT, speedup REAL,
  ts REAL, PRIMARY KEY (base_url, model)
);
"""

# 索引单独一段：必须先建表、补齐老库缺失列，最后才建索引
_SCHEMA_INDEXES = """
CREATE INDEX IF NOT EXISTS idx_samples_run_ts ON samples(run_id, ts);
CREATE INDEX IF NOT EXISTS idx_bench_runs_pair ON bench_runs(base_url_masked, model, ts);
CREATE INDEX IF NOT EXISTS idx_bench_items_run ON bench_items(run_id);
CREATE INDEX IF NOT EXISTS idx_cache_checks_pair ON cache_checks(base_url_masked, model, ts);
"""


class Store:
    def __init__(self, path: str | Path):
        self.path = str(path)
        self._db: aiosqlite.Connection | None = None
        self._queue: asyncio.Queue[SampleRecord | None] = asyncio.Queue()
        self._writer: asyncio.Task | None = None

    async def init(self) -> None:
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._db = await aiosqlite.connect(self.path)
        await self._db.execute("PRAGMA journal_mode=WAL")
        await self._db.execute("PRAGMA synchronous=NORMAL")
        await self._db.executescript(_SCHEMA_TABLES)
        await self._migrate()
        await self._db.executescript(_SCHEMA_INDEXES)  # 补齐列之后才建索引
        await self._db.commit()
        self._writer = asyncio.create_task(self._write_loop())

    async def _migrate(self) -> None:
        """按当前 schema 补齐老库缺失的列。

        服务是 KeepAlive 的：init() 一旦抛异常就会无限崩溃重启，
        所以这里必须能自愈，而不是要求用户手工重建数据库。
        """
        assert self._db
        # 老库的 bench_baselines 主键是 (base_url, model)，缺 task_key：
        # 不迁移会导致"轻量集基线"和"官方集基线"互相覆盖，判定全乱。
        try:
            async with self._db.execute("PRAGMA table_info(bench_baselines)") as cur:
                cols = {row[1] for row in await cur.fetchall()}
            if cols and "task_key" not in cols:
                await self._db.executescript("""
                    ALTER TABLE bench_baselines RENAME TO bench_baselines_old;
                    CREATE TABLE bench_baselines (
                      base_url TEXT, model TEXT, task_key TEXT, bench_run_id TEXT,
                      total_score REAL, fingerprint TEXT, ts REAL,
                      PRIMARY KEY (base_url, model, task_key)
                    );
                    INSERT INTO bench_baselines (base_url, model, task_key, bench_run_id, total_score, fingerprint, ts)
                      SELECT base_url, model, 'curated', bench_run_id, total_score, fingerprint, ts FROM bench_baselines_old;
                    DROP TABLE bench_baselines_old;
                """)
        except Exception:
            pass  # 迁移失败不能拖垮服务启动

        # H1 止血：历史 runs.params_json 曾整存含 api_key 的完整配置，
        # 启动时幂等清洗（commit 由 init() 统一提交）。
        try:
            async with self._db.execute(
                "SELECT run_id, params_json FROM runs WHERE params_json LIKE '%api_key%'"
            ) as cur:
                rows = await cur.fetchall()
            for run_id, pj in rows:
                try:
                    cfg = json.loads(pj)
                    scrubbed = _cfg_json_safe(cfg)
                except Exception:
                    continue
                if scrubbed == cfg:
                    continue
                await self._db.execute(
                    "UPDATE runs SET params_json=? WHERE run_id=?",
                    (json.dumps(scrubbed, ensure_ascii=False), run_id),
                )
        except Exception:
            pass  # 清洗失败不能拖垮服务启动

        for table, cols in _expected_columns().items():
            try:
                async with self._db.execute(f"PRAGMA table_info({table})") as cur:
                    have = {row[1] for row in await cur.fetchall()}
            except Exception:
                continue
            if not have:
                continue
            for name, typ in cols:
                if name not in have:
                    try:
                        await self._db.execute(
                            f"ALTER TABLE {table} ADD COLUMN {name} {typ}"
                        )
                    except Exception:
                        pass

    async def close(self) -> None:
        if self._writer:
            await self._queue.put(None)
            await self._writer
        if self._db:
            await self._db.close()

    async def _write_loop(self) -> None:
        assert self._db
        batch: list[SampleRecord] = []
        while True:
            item = await self._queue.get()
            if item is None:
                if batch:
                    await self._flush(batch)
                return
            batch.append(item)
            if len(batch) >= 50:
                await self._flush(batch)
                batch = []
            else:
                # 尝试小批量聚合
                try:
                    while len(batch) < 50:
                        nxt = self._queue.get_nowait()
                        if nxt is None:
                            await self._flush(batch)
                            return
                        batch.append(nxt)
                except asyncio.QueueEmpty:
                    pass
                await self._flush(batch)
                batch = []

    async def _flush(self, batch: list[SampleRecord]) -> None:
        assert self._db
        rows = [
            (
                s.run_id,
                s.target,
                s.seq,
                s.ts,
                s.scheduled_ts,
                s.send_ts,
                s.dns_ms,
                s.tcp_ms,
                s.tls_ms,
                s.ttft_ms,
                s.e2e_ms,
                s.observed_e2e_ms,
                s.corrected_e2e_ms,
                s.tpot_ms,
                s.itl_mean_ms,
                s.itl_p99_ms,
                s.out_tokens,
                s.in_tokens,
                s.cached_tokens,
                s.cache_write_tokens,
                int(s.tokens_estimated),
                s.status_code,
                int(s.ok),
                s.retry_no,
                s.error_class,
                s.error_msg,
                s.bytes_rx,
                None if s.conn_reused is None else int(s.conn_reused),
            )
            for s in batch
        ]
        await self._db.executemany(
            """INSERT INTO samples (run_id,target,seq,ts,scheduled_ts,send_ts,
               dns_ms,tcp_ms,tls_ms,ttft_ms,e2e_ms,observed_e2e_ms,corrected_e2e_ms,
               tpot_ms,itl_mean_ms,itl_p99_ms,out_tokens,in_tokens,
               cached_tokens,cache_write_tokens,tokens_estimated,
               status_code,ok,retry_no,error_class,error_msg,bytes_rx,conn_reused)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            rows,
        )
        await self._db.commit()

    def enqueue(self, sample: SampleRecord) -> None:
        self._queue.put_nowait(sample)

    async def create_run(
        self, run_id: str, cfg: RunConfig, schedule_cron: str | None = None
    ) -> None:
        assert self._db
        t = cfg.targets[0]
        await self._db.execute(
            "INSERT OR REPLACE INTO runs (run_id,name,provider,base_url_masked,model,params_json,slo_json,schedule_cron,started_at,status) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                run_id,
                cfg.name,
                t.provider.value,
                _mask(t.base_url),
                t.model,
                json.dumps(_cfg_json_safe(cfg.model_dump()), ensure_ascii=False),
                cfg.slo.model_dump_json(),
                schedule_cron,
                time.time(),
                RunStatus.pending.value,
            ),
        )
        await self._db.commit()

    async def set_status(
        self, run_id: str, status: RunStatus, ended: bool = False
    ) -> None:
        assert self._db
        if ended:
            await self._db.execute(
                "UPDATE runs SET status=?, ended_at=? WHERE run_id=?",
                (status.value, time.time(), run_id),
            )
        else:
            await self._db.execute(
                "UPDATE runs SET status=? WHERE run_id=?", (status.value, run_id)
            )
        await self._db.commit()

    async def get_run(self, run_id: str) -> dict | None:
        assert self._db
        self._db.row_factory = aiosqlite.Row
        async with self._db.execute(
            "SELECT * FROM runs WHERE run_id=?", (run_id,)
        ) as cur:
            row = await cur.fetchone()
        return dict(row) if row else None

    async def mark_stale_runs(self) -> int:
        """进程重启后，内存里的运行态已丢失——把库中残留的 running/pending/paused 标为 stopped，
        否则界面会一直显示幽灵运行。"""
        assert self._db
        cur = await self._db.execute(
            "UPDATE runs SET status='stopped', ended_at=? WHERE status IN ('running','pending','paused')",
            (time.time(),),
        )
        await self._db.execute(
            "UPDATE bench_runs SET status='stopped' WHERE status IN ('running','pending')"
        )
        await self._db.commit()
        return cur.rowcount or 0

    async def list_runs(self, limit: int = 100) -> list[dict]:
        assert self._db
        self._db.row_factory = aiosqlite.Row
        async with self._db.execute(
            "SELECT r.*, (SELECT COUNT(*) FROM samples s WHERE s.run_id=r.run_id) AS total, (SELECT COUNT(*) FROM samples s WHERE s.run_id=r.run_id AND s.ok=1) AS ok FROM runs r ORDER BY started_at DESC LIMIT ?",
            (limit,),
        ) as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def get_samples(
        self, run_id: str, since: float | None = None, until: float | None = None
    ) -> list[dict]:
        assert self._db
        self._db.row_factory = aiosqlite.Row
        q = "SELECT * FROM samples WHERE run_id=?"
        args: list[Any] = [run_id]
        if since is not None:
            q += " AND ts>=?"
            args.append(since)
        if until is not None:
            q += " AND ts<=?"
            args.append(until)
        q += " ORDER BY seq ASC"
        async with self._db.execute(q, args) as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def delete_run(self, run_id: str) -> None:
        assert self._db
        await self._db.execute("DELETE FROM samples WHERE run_id=?", (run_id,))
        await self._db.execute("DELETE FROM runs WHERE run_id=?", (run_id,))
        await self._db.commit()

    # --- schedules ---
    async def save_schedule(self, sc: ScheduleConfig) -> str:
        assert self._db
        sid = sc.schedule_id or f"sch_{int(time.time() * 1000)}"
        await self._db.execute(
            "INSERT OR REPLACE INTO schedules (schedule_id,name,cron,enabled,config_json,alert_json) VALUES (?,?,?,?,?,?)",
            (
                sid,
                sc.name,
                sc.cron,
                int(sc.enabled),
                sc.run.model_dump_json(),
                sc.alert.model_dump_json(),
            ),
        )
        await self._db.commit()
        return sid

    async def list_schedules(self) -> list[dict]:
        assert self._db
        self._db.row_factory = aiosqlite.Row
        async with self._db.execute("SELECT * FROM schedules ORDER BY name") as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def delete_schedule(self, sid: str) -> None:
        assert self._db
        await self._db.execute("DELETE FROM schedules WHERE schedule_id=?", (sid,))
        await self._db.commit()

    # --- alerts ---
    async def add_alert(
        self, run_id: str, rule: str, metric: str, threshold: float, value: float
    ) -> None:
        assert self._db
        await self._db.execute(
            "INSERT INTO alerts (run_id,rule,metric,threshold,value,triggered_at,notified) VALUES (?,?,?,?,?,?,0)",
            (run_id, rule, metric, threshold, value, time.time()),
        )
        await self._db.commit()

    async def list_alerts(self, limit: int = 100) -> list[dict]:
        assert self._db
        self._db.row_factory = aiosqlite.Row
        async with self._db.execute(
            "SELECT * FROM alerts ORDER BY triggered_at DESC LIMIT ?", (limit,)
        ) as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    # ---------------- 降智检测 ----------------
    async def create_bench_run(
        self, run_id: str, target, opts: dict, n_items: int
    ) -> None:
        assert self._db
        dims = opts.get("dims", [])
        engine = opts.get("engine", "curated")
        task_key = f"{engine}:" + ",".join(sorted(dims))
        await self._db.execute(
            "INSERT OR REPLACE INTO bench_runs (run_id,ts,name,provider,base_url_masked,model,"
            "dims_json,opts_json,scores_json,total_score,n_items,completed,fingerprint,status,"
            "engine,task_key,fewshot,limit_n,seed) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                run_id,
                time.time(),
                opts.get("name") or target.model,
                target.provider.value,
                _mask(target.base_url),
                target.model,
                json.dumps(dims),
                # 排除 proxy（可能含凭据）与 api_key（不应出现但防漏）；
                # 注：api_key 由调用方 Target 持有，正常不进 opts
                json.dumps(
                    {k: v for k, v in opts.items() if k not in ("proxy", "api_key")},
                    ensure_ascii=False,
                ),
                "{}",
                0.0,
                n_items,
                0,
                "",
                "pending",
                engine,
                task_key,
                opts.get("fewshot"),
                opts.get("limit"),
                opts.get("seed"),
            ),
        )
        await self._db.commit()

    async def update_bench_meta(self, run_id: str, meta: dict) -> None:
        """跑完后才知道的元信息（lm-eval 版本 / few-shot）回填到运行记录。"""
        assert self._db
        await self._db.execute(
            "UPDATE bench_runs SET lm_eval_version=COALESCE(?, lm_eval_version), fewshot=COALESCE(?, fewshot) WHERE run_id=?",
            (meta.get("lm_eval_version"), meta.get("fewshot"), run_id),
        )
        await self._db.commit()

    async def set_bench_status(self, run_id: str, status: str) -> None:
        assert self._db
        await self._db.execute(
            "UPDATE bench_runs SET status=? WHERE run_id=?", (status, run_id)
        )
        await self._db.commit()

    async def finish_bench_run(
        self, run_id: str, scores: dict, fingerprint: str, items: list[dict]
    ) -> None:
        assert self._db
        await self._db.executemany(
            "INSERT INTO bench_items (run_id,dim,item_id,passed,latency_ms,detail,got,expected) VALUES (?,?,?,?,?,?,?,?)",
            [
                (
                    run_id,
                    it["dim"],
                    it["item_id"],
                    int(it["passed"]),
                    it.get("latency_ms") or 0,
                    it.get("detail"),
                    (it.get("got") or "")[:2000],
                    it.get("expected"),
                )
                for it in items
            ],
        )
        await self._db.execute(
            "UPDATE bench_runs SET scores_json=?, total_score=?, completed=?, fingerprint=? WHERE run_id=?",
            (
                json.dumps(scores, ensure_ascii=False),
                scores.get("total", 0.0),
                scores.get("completed", len(items)),
                fingerprint,
                run_id,
            ),
        )
        await self._db.commit()

    async def list_bench_runs(self, limit: int = 100) -> list[dict]:
        assert self._db
        self._db.row_factory = aiosqlite.Row
        async with self._db.execute(
            "SELECT * FROM bench_runs ORDER BY ts DESC LIMIT ?", (limit,)
        ) as cur:
            rows = await cur.fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["scores"] = json.loads(d.pop("scores_json") or "{}")
            out.append(d)
        return out

    async def get_bench_run(self, run_id: str) -> dict | None:
        assert self._db
        self._db.row_factory = aiosqlite.Row
        async with self._db.execute(
            "SELECT * FROM bench_runs WHERE run_id=?", (run_id,)
        ) as cur:
            row = await cur.fetchone()
        if not row:
            return None
        d = dict(row)
        d["scores"] = json.loads(d.pop("scores_json") or "{}")
        d["opts"] = json.loads(d.pop("opts_json") or "{}")
        return d

    async def get_bench_items(self, run_id: str) -> list[dict]:
        assert self._db
        self._db.row_factory = aiosqlite.Row
        async with self._db.execute(
            "SELECT dim,item_id,passed,latency_ms,detail,got,expected FROM bench_items WHERE run_id=? ORDER BY id",
            (run_id,),
        ) as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def delete_bench_run(self, run_id: str) -> None:
        assert self._db
        await self._db.execute("DELETE FROM bench_items WHERE run_id=?", (run_id,))
        await self._db.execute("DELETE FROM bench_runs WHERE run_id=?", (run_id,))
        await self._db.commit()

    async def get_baseline(
        self, base_url: str, model: str, task_key: str
    ) -> dict | None:
        assert self._db
        self._db.row_factory = aiosqlite.Row
        async with self._db.execute(
            "SELECT * FROM bench_baselines WHERE base_url=? AND model=? AND task_key=?",
            (base_url, model, task_key),
        ) as cur:
            row = await cur.fetchone()
        if not row:
            return None
        d = dict(row)
        run = await self.get_bench_run(d["bench_run_id"])
        d["scores"] = run["scores"] if run else {}
        return d

    async def set_baseline(
        self,
        base_url: str,
        model: str,
        task_key: str,
        run_id: str,
        total: float,
        fingerprint: str,
    ) -> None:
        assert self._db
        await self._db.execute(
            "INSERT OR REPLACE INTO bench_baselines (base_url,model,task_key,bench_run_id,total_score,fingerprint,ts) VALUES (?,?,?,?,?,?,?)",
            (base_url, model, task_key, run_id, total, fingerprint, time.time()),
        )
        await self._db.commit()

    async def list_baselines(self) -> list[dict]:
        assert self._db
        self._db.row_factory = aiosqlite.Row
        async with self._db.execute(
            "SELECT * FROM bench_baselines ORDER BY ts DESC"
        ) as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    # ---------- 缓存检测 ----------

    async def save_cache_check(self, record: dict) -> None:
        assert self._db
        await self._db.execute(
            "INSERT OR REPLACE INTO cache_checks (id,ts,name,provider,base_url_masked,model,params_json,rounds_json,summary_json,status) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                record["check_id"],
                record.get("ts") or time.time(),
                record.get("name"),
                record.get("provider"),
                record.get("base_url_masked"),
                record.get("model"),
                json.dumps(record.get("params") or {}, ensure_ascii=False),
                json.dumps(record.get("rounds") or [], ensure_ascii=False),
                json.dumps(record.get("summary") or {}, ensure_ascii=False),
                "done",
            ),
        )
        await self._db.commit()

    async def list_cache_checks(self, limit: int = 100) -> list[dict]:
        assert self._db
        self._db.row_factory = aiosqlite.Row
        async with self._db.execute(
            "SELECT * FROM cache_checks ORDER BY ts DESC LIMIT ?", (limit,)
        ) as cur:
            rows = await cur.fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["summary"] = json.loads(d.pop("summary_json") or "{}")
            d["params"] = json.loads(d.pop("params_json") or "{}")
            d.pop("rounds_json", None)  # 列表不带明细，详情接口再取
            out.append(d)
        return out

    async def get_cache_check(self, check_id: str) -> dict | None:
        assert self._db
        self._db.row_factory = aiosqlite.Row
        async with self._db.execute(
            "SELECT * FROM cache_checks WHERE id=?", (check_id,)
        ) as cur:
            row = await cur.fetchone()
        if not row:
            return None
        d = dict(row)
        d["summary"] = json.loads(d.pop("summary_json") or "{}")
        d["params"] = json.loads(d.pop("params_json") or "{}")
        d["rounds"] = json.loads(d.pop("rounds_json") or "[]")
        return d

    async def delete_cache_check(self, check_id: str) -> None:
        assert self._db
        await self._db.execute("DELETE FROM cache_checks WHERE id=?", (check_id,))
        await self._db.execute(
            "DELETE FROM cache_baselines WHERE check_id=?", (check_id,)
        )
        await self._db.commit()

    async def get_cache_baseline(self, base_url: str, model: str) -> dict | None:
        assert self._db
        self._db.row_factory = aiosqlite.Row
        async with self._db.execute(
            "SELECT * FROM cache_baselines WHERE base_url=? AND model=?",
            (base_url, model),
        ) as cur:
            row = await cur.fetchone()
        if not row:
            return None
        d = dict(row)
        check = await self.get_cache_check(d["check_id"])
        if check:
            s = check.get("summary") or {}
            d["ttft_hit_mean"] = s.get("ttft_hit_mean")
            d["ttft_first"] = s.get("ttft_first")
            d["verdict"] = s.get("verdict")
        return d

    async def set_cache_baseline(
        self, base_url: str, model: str, check_id: str, speedup: float | None
    ) -> None:
        assert self._db
        await self._db.execute(
            "INSERT OR REPLACE INTO cache_baselines (base_url,model,check_id,speedup,ts) VALUES (?,?,?,?,?)",
            (base_url, model, check_id, speedup or 0.0, time.time()),
        )
        await self._db.commit()


def _cfg_json_safe(cfg: dict) -> dict:
    """递归剔除 targets[].api_key，供 runs.params_json 落库前脱敏。"""
    if not isinstance(cfg, dict):
        return cfg
    out = dict(cfg)
    targets = out.get("targets")
    if isinstance(targets, list):
        out["targets"] = [
            {k: v for k, v in t.items() if k != "api_key"} if isinstance(t, dict) else t
            for t in targets
        ]
    return out


def _mask(url: str) -> str:
    """剥掉 URL userinfo（user:pass@），host 本身不含密钥。"""
    return re.sub(r"(?i)^([a-z][a-z0-9+.\-]*://)[^/@\s]+@", r"\1***@", url)


_TYPE_RE = re.compile(
    r"([A-Za-z_][A-Za-z0-9_]*)\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC)", re.I
)


def _expected_columns() -> dict[str, list[tuple[str, str]]]:
    """从建表语句里提取每张表的 (列名, 类型)，用于自愈式迁移。

    注意：列可能写在同一行的多个逗号分隔段里，所以要按整段文本扫描，
    不能只匹配行首。
    """
    out: dict[str, list[tuple[str, str]]] = {}
    for m in re.finditer(
        r"CREATE TABLE IF NOT EXISTS (\w+)\s*\((.*?)\n\);", _SCHEMA_TABLES, re.S
    ):
        table, body = m.group(1), m.group(2)
        cols = [(cm.group(1), cm.group(2).upper()) for cm in _TYPE_RE.finditer(body)]
        out[table] = cols
    return out
