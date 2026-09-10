"""Contract tests for plugin-owned Kanban transition admission."""

from __future__ import annotations

from pathlib import Path

import pytest

from hermes_cli import kanban_db as kb
from hermes_cli.middleware import (
    KanbanTransitionDenied,
    apply_kanban_transition_middleware,
)


@pytest.fixture
def kanban_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


def _deny_transition(monkeypatch: pytest.MonkeyPatch, reason: str) -> None:
    monkeypatch.setattr(
        "hermes_cli.plugins.has_middleware",
        lambda kind: kind == "kanban_transition",
    )
    monkeypatch.setattr(
        "hermes_cli.plugins.invoke_middleware",
        lambda _kind, **_kwargs: [
            {"decision": "deny", "reason": reason, "source": "test"}
        ],
    )


def test_transition_middleware_can_rewrite_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "hermes_cli.plugins.has_middleware",
        lambda kind: kind == "kanban_transition",
    )
    monkeypatch.setattr(
        "hermes_cli.plugins.invoke_middleware",
        lambda _kind, **_kwargs: [
            {
                "payload": {"metadata": {"validated": True}},
                "source": "test-policy",
            }
        ],
    )

    result = apply_kanban_transition_middleware(
        "complete",
        {"metadata": {}},
        task={"id": "t_test", "status": "running"},
    )

    assert result.payload == {"metadata": {"validated": True}}
    assert result.changed is True
    assert result.trace == [{"source": "test-policy"}]


def test_transition_middleware_can_deny() -> None:
    from hermes_cli import plugins

    manager = plugins.PluginManager()
    manager._middleware["kanban_transition"] = [
        lambda **_kwargs: {
            "decision": "deny",
            "reason": "missing receipt",
            "source": "agency-policy",
        }
    ]
    previous = plugins._plugin_manager
    plugins._plugin_manager = manager
    try:
        with pytest.raises(KanbanTransitionDenied, match="missing receipt") as exc_info:
            apply_kanban_transition_middleware(
                "complete",
                {"metadata": {}},
                task={"id": "t_test", "status": "running"},
            )
    finally:
        plugins._plugin_manager = previous

    assert exc_info.value.source == "agency-policy"


def test_complete_task_denial_is_atomic(
    kanban_home: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _deny_transition(monkeypatch, "receipt required")
    conn = kb.connect()
    try:
        task_id = kb.create_task(
            conn, title="guarded", body="required_receipt: test/v1"
        )
        original_status = kb.get_task(conn, task_id).status
        with pytest.raises(KanbanTransitionDenied, match="receipt required"):
            kb.complete_task(conn, task_id, summary="done", metadata={})
        assert kb.get_task(conn, task_id).status == original_status
        assert not conn.execute(
            "SELECT 1 FROM task_events WHERE task_id = ? AND kind = 'completed'",
            (task_id,),
        ).fetchone()
    finally:
        conn.close()


def test_request_review_denial_is_atomic(
    kanban_home: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _deny_transition(monkeypatch, "invalid handoff")
    conn = kb.connect()
    try:
        task_id = kb.create_task(conn, title="guarded", assignee="implementer")
        original_status = kb.get_task(conn, task_id).status
        with pytest.raises(KanbanTransitionDenied, match="invalid handoff"):
            kb.request_review(conn, task_id, summary="ready")
        assert kb.get_task(conn, task_id).status == original_status
        assert not conn.execute(
            "SELECT 1 FROM task_events WHERE task_id = ? AND kind = 'review_requested'",
            (task_id,),
        ).fetchone()
    finally:
        conn.close()


def test_block_task_denial_is_atomic(
    kanban_home: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _deny_transition(monkeypatch, "block receipt required")
    conn = kb.connect()
    try:
        task_id = kb.create_task(conn, title="guarded")
        original_status = kb.get_task(conn, task_id).status
        with pytest.raises(KanbanTransitionDenied, match="block receipt required"):
            kb.block_task(
                conn,
                task_id,
                reason="external input missing",
                kind="needs_input",
                metadata={},
            )
        assert kb.get_task(conn, task_id).status == original_status
        assert not conn.execute(
            "SELECT 1 FROM task_events WHERE task_id = ? AND kind = 'blocked'",
            (task_id,),
        ).fetchone()
    finally:
        conn.close()


def test_request_review_middleware_routes_reviewer(
    kanban_home: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "hermes_cli.plugins.has_middleware",
        lambda kind: kind == "kanban_transition",
    )
    monkeypatch.setattr(
        "hermes_cli.plugins.invoke_middleware",
        lambda _kind, **kwargs: [
            {
                "payload": {**kwargs["payload"], "reviewer": "reviewer"},
                "source": "test",
            }
        ],
    )
    conn = kb.connect()
    try:
        task_id = kb.create_task(conn, title="review me", assignee="implementer")
        metadata = {"handoff_version": "example/v1"}
        assert (
            kb.request_review(
                conn,
                task_id,
                summary="ready",
                metadata=metadata,
            )
            is True
        )
        task = kb.get_task(conn, task_id)
        assert task.status == "review"
        assert task.assignee == "reviewer"
        run = kb.latest_run(conn, task_id)
        assert run is not None
        assert run.metadata == metadata
    finally:
        conn.close()


def test_request_changes_denial_is_atomic(
    kanban_home: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = kb.connect()
    try:
        task_id = kb.create_task(conn, title="review me", assignee="implementer")
        implementation = kb.claim_task(conn, task_id, claimer="implementer:test")
        assert implementation is not None
        assert kb.request_review(
            conn,
            task_id,
            summary="ready",
            reviewer="reviewer",
            expected_run_id=implementation.current_run_id,
        )
        review = kb.claim_review_task(conn, task_id, claimer="reviewer:test")
        assert review is not None
        _deny_transition(monkeypatch, "review receipt required")
        with pytest.raises(KanbanTransitionDenied, match="review receipt required"):
            kb.request_changes(
                conn,
                task_id,
                reason="fix this",
                metadata={},
                expected_run_id=review.current_run_id,
            )
        task = kb.get_task(conn, task_id)
        assert task.status == "running"
        assert task.current_run_id == review.current_run_id
        assert not conn.execute(
            "SELECT 1 FROM task_events WHERE task_id = ? AND kind = 'changes_requested'",
            (task_id,),
        ).fetchone()
    finally:
        conn.close()


def test_complete_middleware_sees_review_source_status(
    kanban_home: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed: list[dict] = []
    monkeypatch.setattr(
        "hermes_cli.plugins.has_middleware",
        lambda kind: kind == "kanban_transition",
    )
    monkeypatch.setattr(
        "hermes_cli.plugins.invoke_middleware",
        lambda _kind, **kwargs: observed.append(kwargs["payload"]) or [],
    )
    conn = kb.connect()
    try:
        task_id = kb.create_task(conn, title="review me", assignee="implementer")
        assert kb.request_review(conn, task_id, reviewer="reviewer")
        review = kb.claim_review_task(conn, task_id, claimer="reviewer:test")
        assert review is not None
        assert kb.complete_task(
            conn,
            task_id,
            summary="approved",
            expected_run_id=review.current_run_id,
        )
        complete_payload = next(
            payload for payload in observed if payload.get("summary") == "approved"
        )
        assert complete_payload["source_status"] == "review"
    finally:
        conn.close()
