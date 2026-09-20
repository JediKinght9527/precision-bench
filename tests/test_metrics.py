from server.metrics import summarize
from server.schemas import SampleRecord, SLO
from server.stats import percentiles


def test_percentiles():
    vals = [float(v) for v in range(1, 101)]
    p = percentiles(vals, [50, 90, 99])
    assert 49 <= p[50] <= 51
    assert 89 <= p[90] <= 92
    assert p[99] >= 98


def test_summary_goodput():
    slo = SLO(ttft_ms=200, tpot_ms=50)
    samples = []
    for i in range(10):
        ok = i < 8
        samples.append(
            SampleRecord(
                run_id="r",
                target="t",
                seq=i,
                ts=1000 + i,
                ttft_ms=(100 if i < 5 else 500),
                e2e_ms=1000,
                tpot_ms=(20 if i < 5 else 100),
                out_tokens=10,
                ok=ok,
                error_class=None if ok else "rate_limit",
            )
        )
    s = summarize(samples, slo)
    assert s["total"] == 10
    assert s["ok"] == 8
    assert abs(s["success_rate"] - 0.8) < 1e-6
    # 前 5 条满足 SLO
    assert abs(s["goodput"] - 0.5) < 1e-6
    assert s["errors"]["rate_limit"] == 2


def test_goodput_requires_all_three():
    """Goodput 必须三项（首字/逐token/端到端）同时达标。"""
    from server.schemas import SLO as S
    samples = [
        SampleRecord(run_id="r", target="t", seq=0, ts=1, ttft_ms=100, tpot_ms=20, e2e_ms=900, ok=True),
        SampleRecord(run_id="r", target="t", seq=1, ts=2, ttft_ms=100, tpot_ms=20, e2e_ms=9000, ok=True),  # 端到端超标
    ]
    assert summarize(samples, S(ttft_ms=1500, tpot_ms=50, e2e_ms=5000))["goodput"] == 0.5
    assert summarize(samples, S(ttft_ms=1500, tpot_ms=50, e2e_ms=10000))["goodput"] == 1.0


def test_cache_metrics_and_cost():
    """缓存命中率、命中/未命中 TTFT 对比、缓存计价。"""
    from server.schemas import SLO as S

    def mk(n, cached, ttft):
        return [SampleRecord(run_id="r", target="t", seq=i, ts=1000 + i,
                             ttft_ms=ttft, e2e_ms=900, tpot_ms=20,
                             out_tokens=10, in_tokens=200, cached_tokens=cached, ok=True)
                for i in range(n)]

    r = summarize(mk(5, 150, 120) + mk(5, 0, 300), S(), 1.0, 2.0, 0.1)
    c = r["cache"]
    assert abs(c["hit_rate"] - 0.375) < 1e-6          # 750 / 2000
    assert c["cached_tokens"] == 750
    assert c["requests_hit"] == 5 and c["requests_miss"] == 5
    assert c["ttft_hit"]["mean"] == 120 and c["ttft_miss"]["mean"] == 300
    assert c["ttft_speedup"] == 2.5
    # 输入共 2000 tok：未命中 1250 按 1.0，命中 750 按 0.1；输出 100 按 2.0
    want = 1250 / 1e6 * 1.0 + 750 / 1e6 * 0.1 + 100 / 1e6 * 2.0
    assert abs(r["cost"]["total"] - want) < 1e-6


def test_no_cache_reports_zero():
    from server.schemas import SLO as S
    r = summarize([SampleRecord(run_id="r", target="t", seq=0, ts=1, ttft_ms=100,
                                e2e_ms=200, tpot_ms=20, out_tokens=5, in_tokens=50, ok=True)], S())
    assert r["cache"]["hit_rate"] == 0.0
    assert r["cache"]["ttft_speedup"] is None


def test_goodput_without_tpot():
    """非流式测不到 TPOT，健康渠道不能被误判为 0% Goodput。"""
    from server.schemas import SLO as S
    samples = [SampleRecord(run_id="r", target="t", seq=i, ts=1000 + i,
                            ttft_ms=100, e2e_ms=900, tpot_ms=None, out_tokens=10, ok=True)
               for i in range(4)]
    r = summarize(samples, S(ttft_ms=1500, tpot_ms=50, e2e_ms=5000))
    assert r["goodput"] == 1.0
    assert r["measurable"]["tpot"] is False
    assert r["tpot"]["mean"] is None      # 不能显示 0.0
    assert r["itl"]["p99"] is None


def test_summary_checks():
    """内容级 checks（对齐 k6）：ok 但 0 输出 token 记为空输出（假成功）。"""
    slo = SLO(ttft_ms=1500, tpot_ms=50)
    samples = [
        SampleRecord(run_id="r", target="t", seq=0, ts=1, ttft_ms=100, e2e_ms=500, out_tokens=10, ok=True),
        SampleRecord(run_id="r", target="t", seq=1, ts=2, ttft_ms=100, e2e_ms=500, out_tokens=0, ok=True),
        SampleRecord(run_id="r", target="t", seq=2, ts=3, out_tokens=0, ok=False, error_class="timeout"),
    ]
    s = summarize(samples, slo)
    assert s["checks"]["empty_output"] == 1
    assert abs(s["checks"]["nonempty_rate"] - 0.5) < 1e-6
    # 全部失败时无从校验内容 → None，界面显示 n/a
    s0 = summarize([samples[2]], slo)
    assert s0["checks"]["nonempty_rate"] is None
    assert s0["checks"]["empty_output"] == 0
