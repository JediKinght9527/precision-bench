"""定时巡检：APScheduler 驱动周期任务。"""

from __future__ import annotations

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from .engine import Engine
from .schemas import ScheduleConfig
from .store import Store


class SchedulerManager:
    def __init__(self, engine: Engine, store: Store):
        self.engine = engine
        self.store = store
        self.scheduler = AsyncIOScheduler()
        self._started = False

    def start(self) -> None:
        if not self._started:
            self.scheduler.start()
            self._started = True

    def shutdown(self) -> None:
        if self._started:
            self.scheduler.shutdown(wait=False)
            self._started = False

    def _job(self, sc: ScheduleConfig, sid: str):
        async def run():
            await self.engine.start_many(sc.run, schedule_id=sid, alert_cfg=sc.alert)

        return run

    @staticmethod
    def validate(cron: str) -> None:
        """只校验不注册——用于落库前拦住无效表达式。"""
        try:
            CronTrigger.from_crontab(cron)
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"cron 表达式无效: {exc}")

    def register(self, sc: ScheduleConfig, sid: str) -> None:
        self.validate(sc.cron)
        trigger = CronTrigger.from_crontab(sc.cron)
        self.scheduler.add_job(
            self._job(sc, sid),
            trigger=trigger,
            id=sid,
            replace_existing=True,
            misfire_grace_time=60,
            coalesce=True,
            max_instances=1,
        )

    def remove(self, sid: str) -> None:
        try:
            self.scheduler.remove_job(sid)
        except Exception:
            pass

    def load_all(self, rows: list[dict]) -> None:
        import json

        for row in rows:
            if not row.get("enabled"):
                continue
            try:
                run = json.loads(row["config_json"])
                alert = json.loads(row["alert_json"] or "{}")
                sc = ScheduleConfig(
                    schedule_id=row["schedule_id"],
                    name=row["name"],
                    cron=row["cron"],
                    enabled=bool(row["enabled"]),
                    run=run,
                    alert=alert,
                )
                self.register(sc, row["schedule_id"])
            except Exception:
                continue
