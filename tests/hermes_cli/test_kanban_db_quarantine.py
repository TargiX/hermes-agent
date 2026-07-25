"""Regression coverage for fleet-wide Kanban DB containment.

A corruption verdict from one short-lived process must stop every other
process, including a gateway that initialized the path hours earlier and a
worker that still owns an open SQLite connection.  Normal writes are also
serialized by a host-wide lock before entering SQLite.
"""

from __future__ import annotations

import multiprocessing as mp
import sqlite3
import threading
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from hermes_cli import kanban_db as kb


def _write_tasks_in_child(db_path: str, worker: int, count: int) -> None:
    from hermes_cli import kanban_db as child_kb

    path = Path(db_path)
    for index in range(count):
        conn = child_kb.connect(path)
        try:
            child_kb.create_task(
                conn,
                title=f"worker-{worker}-task-{index}",
                assignee="stress",
            )
        finally:
            conn.close()


@pytest.fixture
def db_path(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_KANBAN_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    path = kb.kanban_db_path(board="default")
    kb._INITIALIZED_PATHS.discard(str(path.resolve()))
    kb.init_db()
    return path


def test_quarantine_stops_initialized_fast_path(db_path):
    with kb.connect(db_path) as conn:
        kb.create_task(conn, title="preserved")

    marker = kb._mark_db_quarantined(db_path, "test corruption verdict")

    with pytest.raises(kb.KanbanDbCorruptError, match="quarantined"):
        kb.connect(db_path)
    assert marker.exists()


def test_quarantine_stops_an_already_open_connection_before_write(db_path):
    conn = kb.connect(db_path)
    try:
        kb._mark_db_quarantined(db_path, "another process detected corruption")

        with pytest.raises(kb.KanbanDbCorruptError, match="quarantined"):
            with kb.write_txn(conn):
                conn.execute(
                    "INSERT INTO task_comments (task_id, author, body, created_at) "
                    "VALUES ('missing', 'worker', 'must not commit', 1)"
                )

        count = conn.execute("SELECT COUNT(*) FROM task_comments").fetchone()[0]
        assert count == 0
    finally:
        conn.close()


def test_invalid_header_creates_shared_quarantine_marker(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_KANBAN_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    path = home / "kanban.db"
    path.write_bytes(b"not-a-sqlite-database")
    kb._INITIALIZED_PATHS.discard(str(path.resolve()))

    with pytest.raises(kb.KanbanDbCorruptError, match="invalid SQLite header"):
        kb.connect(path)

    assert kb._db_quarantine_path(path).is_file()


def test_recovery_clear_requires_a_validated_database(db_path):
    marker = kb._mark_db_quarantined(db_path, "maintenance test")

    archived = kb.clear_db_quarantine_after_recovery(db_path)

    assert not marker.exists()
    assert archived.is_file()
    with kb.connect(db_path) as conn:
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_recovery_clear_keeps_marker_when_validation_fails(tmp_path):
    path = tmp_path / "kanban.db"
    path.write_bytes(b"broken")
    marker = kb._mark_db_quarantined(path, "known bad")

    with pytest.raises(kb.KanbanDbCorruptError, match="recovery validation"):
        kb.clear_db_quarantine_after_recovery(path)

    assert marker.is_file()


def test_transient_malformed_write_needs_fresh_probe_confirmation(db_path):
    """One poisoned connection must not quarantine an independently healthy DB.

    SQLite can surface ``database disk image is malformed`` from a stale WAL
    view even though a fresh connection proves the database is intact.  The
    write still fails and must be retried by its caller, but the fleet-wide
    quarantine marker is too destructive without independent confirmation.
    """

    class TransientMalformedConnection:
        def __init__(self, real: sqlite3.Connection):
            self._real = real
            self._armed = True

        def execute(self, sql, *args, **kwargs):
            if (
                self._armed
                and sql.lstrip().upper().startswith("INSERT")
                and "task_events" in sql.lower()
            ):
                self._armed = False
                try:
                    self._real.execute("ROLLBACK")
                except sqlite3.OperationalError:
                    pass
                raise sqlite3.DatabaseError("database disk image is malformed")
            return self._real.execute(sql, *args, **kwargs)

        def __getattr__(self, name):
            return getattr(self._real, name)

    with kb.connect(db_path) as conn:
        wrapper = TransientMalformedConnection(conn)
        with pytest.raises(
            sqlite3.DatabaseError, match="database disk image is malformed"
        ):
            with kb.write_txn(wrapper):
                kb._append_event(wrapper, "t_missing", "test", None)

    assert not kb._db_quarantine_path(db_path).exists()
    with kb.connect(db_path) as probe:
        assert probe.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_write_lock_timeout_fails_closed(db_path, monkeypatch):
    monkeypatch.setenv("HERMES_KANBAN_BUSY_TIMEOUT_MS", "100")
    conn = kb.connect(db_path)
    holding = threading.Event()
    release = threading.Event()

    def hold_lock():
        with kb._cross_process_write_lock(db_path):
            holding.set()
            release.wait(timeout=5)

    holder = threading.Thread(target=hold_lock, daemon=True)
    holder.start()
    assert holding.wait(timeout=2)
    try:
        with pytest.raises(TimeoutError, match="write lock"):
            with kb.write_txn(conn):
                pass
    finally:
        release.set()
        holder.join(timeout=2)
        conn.close()


def test_write_lock_serializes_independent_connections(db_path):
    first = kb.connect(db_path)
    second = kb.connect(db_path)
    try:
        with kb.write_txn(first):
            first.execute(
                "INSERT INTO tasks "
                "(id, title, status, priority, created_at, workspace_kind) "
                "VALUES ('t_one', 'one', 'ready', 0, 1, 'scratch')"
            )
        with kb.write_txn(second):
            second.execute(
                "INSERT INTO tasks "
                "(id, title, status, priority, created_at, workspace_kind) "
                "VALUES ('t_two', 'two', 'ready', 0, 2, 'scratch')"
            )
        assert second.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        first.close()
        second.close()


def test_mock_connection_does_not_materialize_a_magicmock_write_lock(
    tmp_path, monkeypatch
):
    """Non-SQLite test doubles must not turn their repr into an on-disk lock path."""
    monkeypatch.chdir(tmp_path)
    conn = MagicMock()

    assert kb._connection_db_path(conn) is None
    with kb.write_txn(conn):
        pass

    assert list(tmp_path.glob("*MagicMock*.write.lock")) == []


def test_cold_connect_preserves_existing_wal_database(tmp_path):
    """Never live-downgrade a WAL database while other openers may exist."""
    path = tmp_path / "kanban.db"
    raw = sqlite3.connect(path)
    assert raw.execute("PRAGMA journal_mode=WAL").fetchone()[0].lower() == "wal"
    raw.execute("CREATE TABLE legacy_probe (id INTEGER PRIMARY KEY)")
    raw.commit()
    raw.close()
    kb._INITIALIZED_PATHS.discard(str(path.resolve()))

    with kb.connect(path) as conn:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"


def test_multiprocess_writers_preserve_integrity(db_path):
    workers = 4
    tasks_per_worker = 20
    ctx = mp.get_context("spawn")
    processes = [
        ctx.Process(
            target=_write_tasks_in_child,
            args=(str(db_path), worker, tasks_per_worker),
        )
        for worker in range(workers)
    ]
    for process in processes:
        process.start()
    for process in processes:
        process.join(timeout=20)
        assert process.exitcode == 0

    conn = sqlite3.connect(db_path)
    try:
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == (
            workers * tasks_per_worker
        )
        from hermes_state import is_sqlite_wal_reset_vulnerable

        expected = "delete" if is_sqlite_wal_reset_vulnerable() else "wal"
        assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == expected
    finally:
        conn.close()
