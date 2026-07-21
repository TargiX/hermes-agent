"""Regression tests for delegated-child Kanban lifecycle isolation.

A child spawned by ``delegate_task`` contributes evidence back to its parent.
It must never inherit authority to complete, block, or time out the parent's
dispatcher task merely because both agents share one process environment.
"""

from __future__ import annotations

import json


def test_delegated_child_scope_hides_parent_kanban_tools(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_parent")
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / ".hermes"))
    (tmp_path / ".hermes").mkdir()

    import tools.kanban_tools  # noqa: F401 - register schemas
    import model_tools
    from agent.execution_scope import delegated_child_scope
    from tools.registry import invalidate_check_fn_cache

    invalidate_check_fn_cache()
    model_tools._clear_tool_defs_cache()
    with delegated_child_scope():
        definitions = model_tools.get_tool_definitions(
            enabled_toolsets=["hermes-cli"],
            quiet_mode=True,
            skip_tool_search_assembly=True,
        )

    names = {item["function"]["name"] for item in definitions}
    assert not {name for name in names if name.startswith("kanban_")}

    invalidate_check_fn_cache()
    model_tools._clear_tool_defs_cache()
    parent_definitions = model_tools.get_tool_definitions(
        enabled_toolsets=["hermes-cli"],
        quiet_mode=True,
        skip_tool_search_assembly=True,
    )
    parent_names = {item["function"]["name"] for item in parent_definitions}
    assert {"kanban_complete", "kanban_block"} <= parent_names


def test_delegated_child_cannot_call_parent_terminal_handler(monkeypatch):
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_parent")

    from agent.execution_scope import delegated_child_scope
    from tools import kanban_tools

    monkeypatch.setattr(
        kanban_tools,
        "_connect",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("delegated child reached the board database")
        ),
    )

    with delegated_child_scope():
        result = json.loads(
            kanban_tools._handle_complete({"summary": "child review finished"})
        )

    assert "delegated child" in result["error"].lower()


def test_delegated_child_scope_disables_parent_stop_nudge(monkeypatch):
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_parent")

    from agent.execution_scope import delegated_child_scope
    from agent.kanban_stop import build_kanban_stop_nudge

    with delegated_child_scope():
        assert build_kanban_stop_nudge(messages=[]) is None


def test_delegated_child_subprocesses_do_not_inherit_parent_kanban_identity(
    monkeypatch,
):
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_parent")
    monkeypatch.setenv("HERMES_KANBAN_RUN_ID", "42")
    monkeypatch.setenv("HERMES_KANBAN_DB", "/tmp/parent-kanban.db")

    from agent.execution_scope import delegated_child_scope
    from tools.environments.local import (
        _sanitize_subprocess_env,
        hermes_subprocess_env,
    )

    source = {
        "PATH": "/usr/bin:/bin",
        "HERMES_KANBAN_TASK": "t_parent",
        "HERMES_KANBAN_RUN_ID": "42",
        "HERMES_KANBAN_DB": "/tmp/parent-kanban.db",
    }
    with delegated_child_scope():
        terminal_env = _sanitize_subprocess_env(source)
        cli_env = hermes_subprocess_env(inherit_credentials=True)

    assert not any(key.startswith("HERMES_KANBAN_") for key in terminal_env)
    assert not any(key.startswith("HERMES_KANBAN_") for key in cli_env)
