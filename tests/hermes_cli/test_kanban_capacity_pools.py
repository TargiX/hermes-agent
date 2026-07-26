"""Independent role-capacity pools for the Kanban dispatcher."""

from __future__ import annotations

import os
import sys
import tempfile

import pytest


@pytest.fixture()
def isolated_pool_board(monkeypatch):
    test_home = tempfile.mkdtemp(prefix="kanban_capacity_pool_test_")
    profiles = (
        "lead-a",
        "lead-b",
        "worker-a",
        "worker-b",
        "worker-c",
        "worker-d",
        "worker-e",
        "ideator",
        "reviewer",
        "operator",
        "default",
    )
    for profile in profiles:
        os.makedirs(os.path.join(test_home, "profiles", profile), exist_ok=True)
    monkeypatch.setenv("HERMES_HOME", test_home)
    for module_name in list(sys.modules):
        if (
            module_name.startswith("hermes_cli")
            or module_name.startswith("hermes_state")
            or module_name == "hermes_constants"
        ):
            del sys.modules[module_name]
    from hermes_cli import kanban_db

    yield kanban_db


def _spawn(*_args, **_kwargs):
    return 12345


def _pools():
    return {
        "leads": {
            "max_in_progress": 2,
            "profiles": ["lead-a", "lead-b"],
        },
        "workers": {
            "max_in_progress": 4,
            "profiles": [
                "worker-a",
                "worker-b",
                "worker-c",
                "worker-d",
                "worker-e",
            ],
        },
        "ideation": {
            "max_in_progress": 1,
            "profiles": ["ideator"],
        },
        "review": {
            "max_in_progress": 1,
            "profiles": ["reviewer"],
        },
        "control": {
            "max_in_progress": 1,
            "profiles": ["operator"],
        },
    }


def test_full_worker_pool_does_not_take_lead_or_ideation_slots(
    isolated_pool_board,
):
    kb = isolated_pool_board
    with kb.connect_closing() as conn:
        kb.create_board(slug="default", name="Test")
        for profile in (
            "worker-a",
            "worker-b",
            "worker-c",
            "worker-d",
            "worker-e",
            "lead-a",
            "lead-b",
            "ideator",
            "reviewer",
            "operator",
        ):
            kb.create_task(conn, title=profile, assignee=profile)

    with kb.connect_closing() as conn:
        result = kb.dispatch_once(
            conn,
            spawn_fn=_spawn,
            dry_run=True,
            max_spawn=20,
            max_in_progress=20,
            max_in_progress_per_profile=1,
            capacity_pools=_pools(),
        )

    assignees = {item[1] for item in result.spawned}
    assert {
        "lead-a",
        "lead-b",
        "ideator",
        "reviewer",
        "operator",
    }.issubset(assignees)
    assert len(assignees & {
        "worker-a",
        "worker-b",
        "worker-c",
        "worker-d",
        "worker-e",
    }) == 4
    assert len(result.skipped_capacity_pool_capped) == 1
    assert result.skipped_capacity_pool_capped[0][2:] == ("workers", 4, 4)


def test_existing_running_work_counts_only_against_its_pool(
    isolated_pool_board,
):
    kb = isolated_pool_board
    with kb.connect_closing() as conn:
        kb.create_board(slug="default", name="Test")
        running_ids = [
            kb.create_task(conn, title=f"running-{i}", assignee=profile)
            for i, profile in enumerate(
                ("worker-a", "worker-b", "worker-c", "worker-d")
            )
        ]
        with kb.write_txn(conn):
            conn.executemany(
                "UPDATE tasks SET status='running', claim_lock='test' WHERE id=?",
                [(task_id,) for task_id in running_ids],
            )
        kb.create_task(conn, title="extra worker", assignee="worker-e")
        kb.create_task(conn, title="lead", assignee="lead-a")

    with kb.connect_closing() as conn:
        result = kb.dispatch_once(
            conn,
            spawn_fn=_spawn,
            dry_run=True,
            max_spawn=20,
            max_in_progress=20,
            capacity_pools=_pools(),
        )

    assert [item[1] for item in result.spawned] == ["lead-a"]
    assert result.skipped_capacity_pool_capped[0][1:] == (
        "worker-e",
        "workers",
        4,
        4,
    )


def test_global_cap_remains_a_final_machine_backstop(isolated_pool_board):
    kb = isolated_pool_board
    with kb.connect_closing() as conn:
        kb.create_board(slug="default", name="Test")
        for profile in ("worker-a", "lead-a", "ideator"):
            kb.create_task(conn, title=profile, assignee=profile)

    with kb.connect_closing() as conn:
        result = kb.dispatch_once(
            conn,
            spawn_fn=_spawn,
            dry_run=True,
            max_spawn=2,
            max_in_progress=2,
            capacity_pools=_pools(),
        )

    assert len(result.spawned) == 2


def test_dispatch_result_exposes_pool_deferrals():
    from hermes_cli.kanban_db import DispatchResult

    result = DispatchResult()
    assert result.skipped_capacity_pool_capped == []
