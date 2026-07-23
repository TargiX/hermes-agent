"""Tests for typed block reasons + the unblock-loop breaker.

Covers the built-in fix for the kanban "blocked loop" — a worker blocks a
task, a cron unblocks it, the worker re-blocks for the same reason, repeat
forever. The fix gives ``block_task`` a typed ``kind`` and a persistent
``block_recurrences`` counter:

* ``dependency`` blocks route to ``todo`` (parent-gated, auto-resumed) and
  never enter the human ``blocked`` bucket a cron would keep unblocking.
* ``needs_input`` / ``capability`` / un-typed blocks land in ``blocked``;
  each same-cause re-block after an unblock increments ``block_recurrences``,
  and at ``BLOCK_RECURRENCE_LIMIT`` the task routes to ``triage`` for a human.
* ``review_required`` blocks are healthy frozen-artifact handoffs. They stay
  blocked without accumulating failure recurrences across review/rework cycles.
* ``unblock_task`` deliberately does NOT reset ``block_recurrences`` (the
  amnesia that let the loop run unbounded).
* A successful ``complete_task`` resets the loop memory.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from hermes_cli import kanban_db as kb


@pytest.fixture
def kanban_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


def _running_task(conn, title="t"):
    """Create a task and drive it to ``running`` so block_task can act."""
    tid = kb.create_task(conn, title=title, assignee="worker")
    with kb.write_txn(conn):
        conn.execute("UPDATE tasks SET status='ready' WHERE id=?", (tid,))
    claimed = kb.claim_task(conn, tid, claimer="worker")
    assert claimed is not None
    return tid


def _make_running_again(conn, tid):
    with kb.write_txn(conn):
        conn.execute("UPDATE tasks SET status='ready' WHERE id=?", (tid,))
    assert kb.claim_task(conn, tid, claimer="worker") is not None


# ---------------------------------------------------------------------------
# Loop breaker
# ---------------------------------------------------------------------------


def test_first_typed_block_lands_in_blocked(kanban_home: Path) -> None:
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        assert kb.block_task(conn, tid, reason="which key?", kind="needs_input")
        t = kb.get_task(conn, tid)
        assert t.status == "blocked"
        assert t.block_kind == "needs_input"
        assert t.block_recurrences == 1


def test_unblock_does_not_reset_recurrence_counter(kanban_home: Path) -> None:
    """The crux of the fix: unblock must preserve the loop counter."""
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        kb.block_task(conn, tid, reason="x", kind="needs_input")
        assert kb.get_task(conn, tid).block_recurrences == 1
        assert kb.unblock_task(conn, tid)
        t = kb.get_task(conn, tid)
        assert t.status == "ready"
        assert t.block_recurrences == 1  # NOT reset to 0
        assert t.block_kind == "needs_input"  # kind preserved for comparison


def test_same_cause_reblock_routes_to_triage(kanban_home: Path) -> None:
    """Dale's loop: block → unblock → re-block same kind → triage."""
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        kb.block_task(conn, tid, reason="need creds", kind="needs_input")
        kb.unblock_task(conn, tid)
        _make_running_again(conn, tid)
        kb.block_task(conn, tid, reason="still need creds", kind="needs_input")
        t = kb.get_task(conn, tid)
        assert t.status == "triage"
        assert t.block_recurrences == 2


def test_untyped_block_loop_also_protected(kanban_home: Path) -> None:
    """Legacy un-typed blocks (kind=None) still trip the breaker."""
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        kb.block_task(conn, tid, reason="a")
        kb.unblock_task(conn, tid)
        _make_running_again(conn, tid)
        kb.block_task(conn, tid, reason="a again")
        assert kb.get_task(conn, tid).status == "triage"


def test_different_kinds_do_not_compound(kanban_home: Path) -> None:
    """A re-block for a DIFFERENT reason resets the counter to 1."""
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        kb.block_task(conn, tid, reason="a", kind="needs_input")
        kb.unblock_task(conn, tid)
        _make_running_again(conn, tid)
        kb.block_task(conn, tid, reason="b", kind="capability")
        t = kb.get_task(conn, tid)
        assert t.status == "blocked"
        assert t.block_recurrences == 1


def test_block_loop_detected_event_emitted(kanban_home: Path) -> None:
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        kb.block_task(conn, tid, reason="x", kind="capability")
        kb.unblock_task(conn, tid)
        _make_running_again(conn, tid)
        kb.block_task(conn, tid, reason="x", kind="capability")
        events = [e for e in kb.list_events(conn, tid)
                  if e.kind == "block_loop_detected"]
        assert events, "expected a block_loop_detected event"
        payload = events[-1].payload or {}
        assert payload.get("recurrences") == 2
        assert payload.get("kind") == "capability"


def test_review_required_reblock_never_routes_to_triage(kanban_home: Path) -> None:
    """A REQUEST_CHANGES cycle is normal lifecycle progress, not a block loop."""
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        assert kb.block_task(
            conn,
            tid,
            reason="review-required: frozen head one",
            kind="review_required",
        )
        first = kb.get_task(conn, tid)
        assert first.status == "blocked"
        assert first.block_kind == "review_required"
        assert first.block_recurrences == 0

        assert kb.unblock_task(conn, tid)
        _make_running_again(conn, tid)
        assert kb.block_task(
            conn,
            tid,
            reason="review-required: corrected frozen head two",
            kind="review_required",
        )
        second = kb.get_task(conn, tid)
        assert second.status == "blocked"
        assert second.block_kind == "review_required"
        assert second.block_recurrences == 0
        blocked_events = [
            event
            for event in kb.list_events(conn, tid)
            if event.kind == "blocked"
        ]
        assert blocked_events
        assert blocked_events[-1].payload.get("kind") == "review_required"


def test_review_required_preserves_structured_run_metadata(kanban_home: Path) -> None:
    """Frozen implementation receipts survive the healthy block boundary."""
    receipt = {
        "schema": "phosphene-implementation/v1",
        "diff_sha256": "abc123",
        "changed_files": ["components/Create.vue"],
        "next_owner": "agencyreviewer",
    }
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        assert kb.block_task(
            conn,
            tid,
            reason="review-required: frozen implementation",
            kind="review_required",
            metadata=receipt,
        )
        run = kb.latest_run(conn, tid)
        assert run is not None
        assert run.status == "blocked"
        assert run.metadata == receipt


def test_review_required_cannot_bypass_declared_receipt_through_db(
    kanban_home: Path,
) -> None:
    """Every block path must enforce the task's immutable handoff contract."""
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET body = ? WHERE id = ?",
                (
                    "task_class: implementation\n"
                    "required_receipt: phosphene-implementation/v1\n",
                    tid,
                ),
            )

        with pytest.raises(ValueError, match="declared implementation receipt"):
            kb.block_task(
                conn,
                tid,
                reason="review-required without machine metadata",
                kind="review_required",
            )

        assert kb.get_task(conn, tid).status == "running"
        assert kb.block_task(
            conn,
            tid,
            reason="review-required with machine metadata",
            kind="review_required",
            metadata={
                "handoff_version": "phosphene-implementation/v1",
                "diff_sha256": "a" * 64,
                "diff_fingerprint": "a" * 64,
                "changed_files": ["feature.ts"],
                "diff_fingerprint_details": {
                    "changed_files": ["feature.ts"],
                    "patch_bytes": 42,
                },
                "next_owner": "agencyreviewer",
            },
        )


def test_review_required_accepts_singular_fingerprint_detail_alias(
    kanban_home: Path,
) -> None:
    """Older singular receipts retain one validated compatibility path."""
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET body = ? WHERE id = ?",
                (
                    "task_class: implementation\n"
                    "required_receipt: phosphene-implementation/v1\n",
                    tid,
                ),
            )

        assert kb.block_task(
            conn,
            tid,
            reason="review-required with singular fingerprint detail",
            kind="review_required",
            metadata={
                "handoff_version": "phosphene-implementation/v1",
                "diff_sha256": "b" * 64,
                "diff_fingerprint": "b" * 64,
                "changed_files": ["feature.ts"],
                "diff_fingerprint_detail": {
                    "changed_files": ["feature.ts"],
                    "patch_bytes": 42,
                },
                "next_owner": "agencyreviewer",
            },
        )


def test_review_required_rejects_missing_or_conflicting_fingerprint_detail(
    kanban_home: Path,
) -> None:
    """Alias spelling cannot bypass the positive patch/manifest proof."""
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET body = ? WHERE id = ?",
                (
                    "task_class: implementation\n"
                    "required_receipt: phosphene-implementation/v1\n",
                    tid,
                ),
            )
        common = {
            "handoff_version": "phosphene-implementation/v1",
            "diff_sha256": "c" * 64,
            "diff_fingerprint": "c" * 64,
            "changed_files": ["feature.ts"],
            "next_owner": "agencyreviewer",
        }

        with pytest.raises(ValueError, match="fingerprint_details is required"):
            kb.block_task(
                conn,
                tid,
                reason="missing fingerprint detail",
                kind="review_required",
                metadata=common,
            )

        with pytest.raises(ValueError, match="must not conflict"):
            kb.block_task(
                conn,
                tid,
                reason="conflicting fingerprint aliases",
                kind="review_required",
                metadata={
                    **common,
                    "diff_fingerprint_detail": {
                        "changed_files": ["feature.ts"],
                        "patch_bytes": 42,
                    },
                    "diff_fingerprint_details": {
                        "changed_files": ["feature.ts"],
                        "patch_bytes": 43,
                    },
                },
            )

        assert kb.get_task(conn, tid).status == "running"


def test_review_required_rejects_collision_disguised_as_empty_diff(
    kanban_home: Path,
) -> None:
    """A no-byte collision is not an implementation artifact for Sol review."""
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET body = ? WHERE id = ?",
                (
                    "task_class: implementation\n"
                    "required_receipt: phosphene-implementation/v1\n",
                    tid,
                ),
            )

        with pytest.raises(ValueError, match="non-reviewable"):
            kb.block_task(
                conn,
                tid,
                reason="historical REST file list collision",
                kind="review_required",
                metadata={
                    "handoff_version": "phosphene-implementation/v1",
                    "outcome": "COLLISION",
                    "diff_sha256": hashlib.sha256(b"").hexdigest(),
                    "diff_fingerprint": hashlib.sha256(b"").hexdigest(),
                    "changed_files": ["feature.ts"],
                    "diff_fingerprint_detail": {
                        "changed_files": [],
                        "patch_bytes": 0,
                    },
                    "next_owner": "agencyreviewer",
                },
            )

        assert kb.get_task(conn, tid).status == "running"


def test_open_pr_collision_requires_current_base_three_dot_proof(
    kanban_home: Path,
) -> None:
    """REST PR-files alone cannot terminally block an implementation."""
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET body = ? WHERE id = ?",
                (
                    "task_class: implementation\n"
                    "required_receipt: phosphene-implementation/v1\n",
                    tid,
                ),
            )

        with pytest.raises(ValueError, match="current_base_manifest_verification"):
            kb.block_task(
                conn,
                tid,
                reason="REST says overlap",
                metadata={
                    "handoff_version": "phosphene-implementation/v1",
                    "outcome": "COLLISION",
                    "collision_kind": "open_pr_manifest_overlap",
                },
            )

        assert kb.get_task(conn, tid).status == "running"
        assert kb.block_task(
            conn,
            tid,
            reason="verified current-base overlap",
            metadata={
                "handoff_version": "phosphene-implementation/v1",
                "outcome": "COLLISION",
                "collision_kind": "open_pr_manifest_overlap",
                "current_base_manifest_verification": {
                    "verified": True,
                    "measurement": "git_current_base_three_dot",
                    "overlapping_files": ["feature.ts"],
                },
            },
        )


def test_review_complete_cannot_bypass_declared_receipt_through_db(
    kanban_home: Path,
) -> None:
    """CLI/direct DB completion must enforce the same review receipt as MCP."""
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET body = ? WHERE id = ?",
                (
                    "task_class: review\n"
                    "required_receipt: phosphene-review/v1\n"
                    "implementation_task_id: t_impl1234\n",
                    tid,
                ),
            )

        with pytest.raises(ValueError, match="declared review receipt"):
            kb.complete_task(conn, tid, result="APPROVE")

        assert kb.get_task(conn, tid).status == "running"
        assert kb.complete_task(
            conn,
            tid,
            result="APPROVE",
            metadata={
                "handoff_version": "phosphene-review/v1",
                "outcome": "APPROVE",
                "approved": True,
                "implementation_task_id": "t_impl1234",
                "reviewed_fingerprint": "a" * 64,
                "blocking_findings": [],
                "authorized_next_task_ids": ["t_impl1234"],
            },
        )


def test_recovery_review_separates_reviewed_implementation_from_authorized_target(
    kanban_home: Path,
) -> None:
    """Recovery reviews must identify both the artifact and the task they unblock.

    ``implementation_task_id`` is the implementation whose bytes were reviewed;
    ``recovery_target`` is the blocked downstream card authorized to continue.
    Conflating the two makes an exact receipt impossible for publication recovery.
    """
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET body = ? WHERE id = ?",
                (
                    "task_class: review\n"
                    "required_receipt: phosphene-review/v1\n"
                    "implementation_task_id: t_impl1234\n"
                    "recovery_target: t_publish5678\n",
                    tid,
                ),
            )

        assert kb.complete_task(
            conn,
            tid,
            result="APPROVE publication recovery",
            metadata={
                "handoff_version": "phosphene-review/v1",
                "outcome": "APPROVE",
                "approved": True,
                "implementation_task_id": "t_impl1234",
                "reviewed_fingerprint": "a" * 64,
                "blocking_findings": [],
                "authorized_next_task_ids": ["t_publish5678"],
            },
        )


def test_independent_review_alias_cannot_bypass_declared_receipt_through_db(
    kanban_home: Path,
) -> None:
    """Review class aliases must not disable the immutable receipt contract."""
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET body = ? WHERE id = ?",
                (
                    "task_class: independent_review\n"
                    "required_receipt: portfolio-review/v1\n"
                    "implementation_task_id: t_impl1234\n",
                    tid,
                ),
            )

        with pytest.raises(ValueError, match="metadata.handoff_version"):
            kb.complete_task(
                conn,
                tid,
                result="APPROVE",
                metadata={
                    "handoff_version": "phosphene-review/v1",
                    "outcome": "APPROVE",
                    "approved": True,
                    "implementation_task_id": "t_impl1234",
                    "reviewed_fingerprint": "a" * 64,
                    "blocking_findings": [],
                    "authorized_next_task_ids": ["t_impl1234"],
                },
            )

        assert kb.get_task(conn, tid).status == "running"


def test_current_source_evidence_requires_top_level_source_authority(
    kanban_home: Path,
) -> None:
    """Nested source SHAs must fail while the original worker can repair them."""
    expected_sha = "a" * 40
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET body = ? WHERE id = ?",
                (
                    "task_class: reproduction\n"
                    "required_receipt: phosphene-evidence/v1\n"
                    f"expected_source_sha: {expected_sha}\n",
                    tid,
                ),
            )

        with pytest.raises(ValueError, match="declared evidence receipt"):
            kb.complete_task(
                conn,
                tid,
                result="reproduced",
                metadata={
                    "handoff_version": "phosphene-evidence/v1",
                    "evidence": {
                        "expected_source_sha": expected_sha,
                        "observed_source_sha": expected_sha,
                    },
                },
            )

        assert kb.get_task(conn, tid).status == "running"


def test_current_source_evidence_accepts_exact_top_level_source_authority(
    kanban_home: Path,
) -> None:
    """The canonical evidence receipt closes without a recovery-only rerun."""
    expected_sha = "b" * 40
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET body = ? WHERE id = ?",
                (
                    "task_class: reproduction\n"
                    "required_receipt: phosphene-evidence/v1\n"
                    f"expected_source_sha: {expected_sha}\n",
                    tid,
                ),
            )

        assert kb.complete_task(
            conn,
            tid,
            result="reproduced",
            metadata={
                "handoff_version": "phosphene-evidence/v1",
                "expected_source_sha": expected_sha,
                "observed_source_sha": expected_sha,
            },
        )


# ---------------------------------------------------------------------------
# Dependency routing
# ---------------------------------------------------------------------------


def test_dependency_block_requires_an_unfinished_parent(kanban_home: Path) -> None:
    """A dependency label without a linked wait target must fail closed.

    Otherwise a standalone task lands in ``todo`` and is immediately promoted
    by ``recompute_ready`` because the empty parent set is vacuously complete,
    creating a worker retry storm.
    """
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        with pytest.raises(ValueError, match="unfinished parent"):
            kb.block_task(conn, tid, reason="need X first", kind="dependency")
        t = kb.get_task(conn, tid)
        assert t.status == "running"
        assert t.block_kind is None


def test_dependency_block_routes_to_todo_with_unfinished_parent(
    kanban_home: Path,
) -> None:
    """A real linked dependency waits in todo without human intervention."""
    with kb.connect_closing() as conn:
        parent = kb.create_task(conn, title="parent", assignee="worker")
        tid = _running_task(conn)
        kb.link_tasks(conn, parent_id=parent, child_id=tid)
        assert kb.block_task(conn, tid, reason="need parent first", kind="dependency")
        task = kb.get_task(conn, tid)
        assert task.status == "todo"
        assert task.block_kind == "dependency"


def test_dependency_then_parent_done_promotes(kanban_home: Path) -> None:
    """A dependency-parked child becomes ready once its parent completes."""
    with kb.connect_closing() as conn:
        parent = kb.create_task(conn, title="parent", assignee="worker")
        child = _running_task(conn, title="child")
        kb.link_tasks(conn, parent_id=parent, child_id=child)
        kb.block_task(conn, child, reason="wait", kind="dependency")
        assert kb.get_task(conn, child).status == "todo"
        # Finish the parent, then let recompute_ready run.
        with kb.write_txn(conn):
            conn.execute("UPDATE tasks SET status='ready' WHERE id=?", (parent,))
        kb.claim_task(conn, parent, claimer="worker")
        kb.complete_task(conn, parent, result="done")
        kb.recompute_ready(conn)
        assert kb.get_task(conn, child).status == "ready"


# ---------------------------------------------------------------------------
# Completion resets loop memory
# ---------------------------------------------------------------------------


def test_completion_clears_block_memory(kanban_home: Path) -> None:
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        kb.block_task(conn, tid, reason="x", kind="capability")
        kb.unblock_task(conn, tid)
        assert kb.get_task(conn, tid).block_recurrences == 1
        kb.complete_task(conn, tid, result="done")
        t = kb.get_task(conn, tid)
        assert t.status == "done"
        assert t.block_recurrences == 0
        assert t.block_kind is None


# ---------------------------------------------------------------------------
# Validation + back-compat
# ---------------------------------------------------------------------------


def test_invalid_kind_rejected(kanban_home: Path) -> None:
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        with pytest.raises(ValueError):
            kb.block_task(conn, tid, reason="x", kind="bogus")


def test_block_without_kind_is_backward_compatible(kanban_home: Path) -> None:
    """Existing callers that pass no kind keep the old single-block behaviour."""
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        assert kb.block_task(conn, tid, reason="legacy")
        t = kb.get_task(conn, tid)
        assert t.status == "blocked"
        assert t.block_kind is None
