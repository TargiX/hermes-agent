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


def test_transition_middleware_can_rewrite_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "hermes_cli.middleware._has_middleware",
        lambda kind: kind == "kanban_transition",
    )
    monkeypatch.setattr(
        "hermes_cli.middleware._invoke_middleware",
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
    monkeypatch.setattr(
        "hermes_cli.middleware._has_middleware",
        lambda kind: kind == "kanban_transition",
    )
    monkeypatch.setattr(
        "hermes_cli.middleware._invoke_middleware",
        lambda _kind, **_kwargs: [
            {"decision": "deny", "reason": "receipt required", "source": "test"}
        ],
    )
    conn = kb.connect()
    try:
        task_id = kb.create_task(conn, title="guarded", body="required_receipt: test/v1")
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


def test_block_task_denial_is_atomic(
    kanban_home: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "hermes_cli.middleware._has_middleware",
        lambda kind: kind == "kanban_transition",
    )
    monkeypatch.setattr(
        "hermes_cli.middleware._invoke_middleware",
        lambda _kind, **_kwargs: [
            {"decision": "deny", "reason": "invalid handoff", "source": "test"}
        ],
    )
    conn = kb.connect()
    try:
        task_id = kb.create_task(conn, title="guarded")
        original_status = kb.get_task(conn, task_id).status
        with pytest.raises(KanbanTransitionDenied, match="invalid handoff"):
            kb.block_task(conn, task_id, reason="review")
        assert kb.get_task(conn, task_id).status == original_status
        assert not conn.execute(
            "SELECT 1 FROM task_events WHERE task_id = ? AND kind = 'blocked'",
            (task_id,),
        ).fetchone()
    finally:
        conn.close()


def test_review_transition_routes_to_review_column_and_reviewer(
    kanban_home: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "hermes_cli.middleware._has_middleware",
        lambda kind: kind == "kanban_transition",
    )
    monkeypatch.setattr(
        "hermes_cli.middleware._invoke_middleware",
        lambda _kind, **kwargs: [
            {
                "payload": {**kwargs["payload"], "assignee": "reviewer"},
                "source": "test",
            }
        ],
    )
    conn = kb.connect()
    try:
        task_id = kb.create_task(conn, title="review me", assignee="implementer")
        metadata = {"handoff_version": "example/v1"}
        assert kb.block_task(
            conn,
            task_id,
            reason="ready",
            kind="review",
            metadata=metadata,
        ) is True
        task = kb.get_task(conn, task_id)
        assert task.status == "review"
        assert task.assignee == "reviewer"
        run = kb.latest_run(conn, task_id)
        assert run is not None
        assert run.metadata == metadata
        event = conn.execute(
            "SELECT kind FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 1",
            (task_id,),
        ).fetchone()
        assert event["kind"] == "review_requested"
    finally:
        conn.close()
