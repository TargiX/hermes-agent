"""Regression tests for concurrent cron workdir isolation.

Cron workdirs are ContextVar/task scoped. Two projects must be able to run in
parallel without replacing process-global ``TERMINAL_CWD`` or leaking their
project root into each other's child-process environment.
"""

from __future__ import annotations

import os
import threading


def test_parallel_contexts_bridge_their_own_workdir(tmp_path, monkeypatch):
    from agent.runtime_cwd import resolve_context_cwd
    from gateway.session_context import clear_session_vars, set_session_vars
    from tools.environments.local import _make_run_env

    project_a = tmp_path / "a"
    project_b = tmp_path / "b"
    project_a.mkdir()
    project_b.mkdir()
    monkeypatch.setenv("TERMINAL_CWD", "/foreign/process/global")

    barrier = threading.Barrier(2, timeout=5)
    observations: dict[str, tuple[str, str | None]] = {}

    def observe(name: str, workdir: str) -> None:
        tokens = set_session_vars(cwd=workdir)
        try:
            barrier.wait()
            child_env = _make_run_env({})
            resolved = resolve_context_cwd()
            observations[name] = (
                str(resolved) if resolved is not None else "",
                child_env.get("TERMINAL_CWD"),
            )
        finally:
            clear_session_vars(tokens)

    threads = [
        threading.Thread(target=observe, args=("a", str(project_a))),
        threading.Thread(target=observe, args=("b", str(project_b))),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)
        assert not thread.is_alive()

    assert observations == {
        "a": (str(project_a), str(project_a)),
        "b": (str(project_b), str(project_b)),
    }
    assert os.environ["TERMINAL_CWD"] == "/foreign/process/global"


def test_explicit_empty_context_strips_foreign_global(monkeypatch):
    from gateway.session_context import clear_session_vars, set_session_vars
    from tools.environments.local import _make_run_env

    monkeypatch.setenv("TERMINAL_CWD", "/foreign/process/global")
    tokens = set_session_vars(cwd="")
    try:
        child_env = _make_run_env({})
    finally:
        clear_session_vars(tokens)

    assert "TERMINAL_CWD" not in child_env
