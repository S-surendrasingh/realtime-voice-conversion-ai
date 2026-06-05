import asyncio

import numpy as np
import pytest

from app.server.session import BackpressureError, ResidentStreamSession
from tests.fakes import FakeStreamSession, FakeVoiceConversionEngine


def _make_session(max_queue_depth=4, delay=0.0):
    engine = FakeVoiceConversionEngine(process_delay_seconds=delay)
    stream = FakeStreamSession(engine)
    return ResidentStreamSession(stream, "session-1", max_queue_depth=max_queue_depth), stream


async def test_submit_and_process_single_chunk():
    session, _stream = _make_session()
    results = []

    async def on_result(seq, result, err):
        results.append((seq, result, err))

    runner = asyncio.ensure_future(session.run(on_result))
    await session.submit(1, 22050, np.ones(10, dtype="float32"))
    await session.close()
    await runner

    assert len(results) == 1
    seq, (samples, sr), err = results[0]
    assert seq == 1
    assert sr == 22050
    assert err is None
    assert session.metrics.processed_chunks == 1


async def test_processes_multiple_chunks_in_order():
    session, _stream = _make_session(max_queue_depth=10)
    results = []

    async def on_result(seq, result, err):
        results.append(seq)

    runner = asyncio.ensure_future(session.run(on_result))
    for i in range(5):
        await session.submit(i, 22050, np.ones(10, dtype="float32"))
    await session.close()
    await runner

    assert results == [0, 1, 2, 3, 4]


async def test_backpressure_rejects_when_queue_full():
    session, _stream = _make_session(max_queue_depth=2, delay=0.2)
    runner = asyncio.ensure_future(session.run(lambda *a: asyncio.sleep(0)))

    await session.submit(0, 22050, np.zeros(10, dtype="float32"))
    await session.submit(1, 22050, np.zeros(10, dtype="float32"))
    with pytest.raises(BackpressureError):
        await session.submit(2, 22050, np.zeros(10, dtype="float32"))

    assert session.metrics.dropped_chunks == 1
    await session.close()
    runner.cancel()


async def test_metrics_snapshot_reports_queue_depth_and_latency():
    session, _stream = _make_session()

    async def on_result(seq, result, err):
        pass

    runner = asyncio.ensure_future(session.run(on_result))
    await session.submit(0, 22050, np.ones(10, dtype="float32"))
    await session.close()
    await runner

    snapshot = session.metrics_snapshot()
    assert snapshot["processed_chunks"] == 1
    assert snapshot["dropped_chunks"] == 0
    assert snapshot["avg_processing_latency_ms"] >= 0


async def test_engine_error_is_reported_not_swallowed():
    engine = FakeVoiceConversionEngine()
    stream = FakeStreamSession(engine)
    engine.fail_next_chunk = True
    session = ResidentStreamSession(stream, "session-err", max_queue_depth=4)
    results = []

    async def on_result(seq, result, err):
        results.append((seq, result, err))

    runner = asyncio.ensure_future(session.run(on_result))
    await session.submit(0, 22050, np.ones(10, dtype="float32"))
    await session.close()
    await runner

    seq, result, err = results[0]
    assert result is None
    assert isinstance(err, RuntimeError)


async def test_close_is_idempotent():
    session, _stream = _make_session()
    runner = asyncio.ensure_future(session.run(lambda *a: asyncio.sleep(0)))
    await session.close()
    await session.close()  # must not raise or hang
    await runner
    assert _stream.closed is True
