"""Turn-end guard for kanban workers.

Kanban workers must end with ``kanban_complete`` or ``kanban_block``. Models
(especially GLM / Qwen families) sometimes narrate the next step
("Let me write the report now") and stop with ``finish_reason=stop`` and no
tool calls. Hermes treats that as a clean exit → ``rc=0`` → dispatcher
``protocol_violation``.

This module is policy-only: when a kanban worker tries to finish without a
terminal board tool, return a bounded synthetic nudge so the conversation
loop continues instead of exiting.
"""

from __future__ import annotations

import os
from typing import Any, Iterable, MutableSequence, Optional


_TERMINAL_KANBAN_TOOLS = frozenset({"kanban_complete", "kanban_block"})

_DEFAULT_MAX_ATTEMPTS = 2
_DEFAULT_CLOSEOUT_RESERVE = 4


def kanban_stop_nudge_enabled() -> bool:
    """Return whether the kanban stop-guard is active for this process.

    On when ``HERMES_KANBAN_TASK`` is set (dispatcher-spawned worker), unless
    ``HERMES_KANBAN_STOP_NUDGE`` explicitly disables it.
    """
    from agent.execution_scope import in_delegated_child_scope

    if in_delegated_child_scope():
        return False
    env = os.environ.get("HERMES_KANBAN_STOP_NUDGE")
    if env is not None and env.strip().lower() in {"0", "false", "no", "off"}:
        return False
    task = (os.environ.get("HERMES_KANBAN_TASK") or "").strip()
    return bool(task)


def _tool_call_name(tc: Any) -> str:
    if isinstance(tc, dict):
        fn = tc.get("function")
        if isinstance(fn, dict):
            return str(fn.get("name") or "")
        return str(tc.get("name") or "")
    fn = getattr(tc, "function", None)
    if fn is not None:
        return str(getattr(fn, "name", "") or "")
    return str(getattr(tc, "name", "") or "")


def _is_terminal_kanban_tool(name: str) -> bool:
    """Accept native names and Codex MCP-projected names for terminal tools."""
    if name in _TERMINAL_KANBAN_TOOLS:
        return True
    return any(
        name.endswith(f"{separator}{tool}")
        for separator in (".", "__")
        for tool in _TERMINAL_KANBAN_TOOLS
    )


def session_called_kanban_terminal(messages: Iterable[dict] | None) -> bool:
    """True if this conversation already invoked a terminal kanban tool."""
    if not messages:
        return False
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        if role == "assistant":
            for tc in msg.get("tool_calls") or []:
                if _is_terminal_kanban_tool(_tool_call_name(tc)):
                    return True
        elif role == "tool":
            name = str(msg.get("name") or "")
            if _is_terminal_kanban_tool(name):
                return True
    return False


def build_kanban_stop_nudge(
    *,
    messages: Iterable[dict] | None = None,
    attempts: int = 0,
    max_attempts: int = _DEFAULT_MAX_ATTEMPTS,
    task_id: Optional[str] = None,
) -> Optional[str]:
    """Return a synthetic follow-up when a kanban worker exits without a terminal tool.

    Returns ``None`` when the guard should not fire (not a kanban worker,
    already completed/blocked, or nudge budget exhausted).
    """
    if not kanban_stop_nudge_enabled():
        return None
    if attempts >= max_attempts:
        return None
    if session_called_kanban_terminal(messages):
        return None

    tid = (task_id or os.environ.get("HERMES_KANBAN_TASK") or "").strip() or "this task"
    return (
        "[System: You are a Hermes kanban worker. A plain-text reply is NOT a "
        "terminal state for the board.\n\n"
        f"Task `{tid}` is still `running`. Ending now without a board tool "
        "causes a protocol violation (clean exit with no "
        "`kanban_complete` / `kanban_block`).\n\n"
        "Do this immediately in your next response — do not narrate intent:\n"
        "1. Finish any remaining deliverable (write the required file(s) now).\n"
        "2. Call `kanban_complete(summary=..., artifacts=[...])` if the work "
        "is done, OR `kanban_block(reason=...)` if you are blocked.\n\n"
        "Never end a turn with only a promise of future action. Repeated "
        "protocol violations will block this task and require manual intervention.]"
    )


def inject_kanban_prelimit_nudge(
    messages: MutableSequence[dict[str, Any]],
    *,
    remaining_calls: int,
    reserve_calls: int = _DEFAULT_CLOSEOUT_RESERVE,
    task_id: Optional[str] = None,
) -> bool:
    """Inject one early closeout directive before the terminal tool budget is gone.

    The caller owns once-per-turn deduplication. This helper only fires inside
    the final bounded reserve and never after a terminal Kanban callback.
    """

    if not kanban_stop_nudge_enabled():
        return False
    if remaining_calls <= 0 or remaining_calls > reserve_calls:
        return False
    if session_called_kanban_terminal(messages):
        return False

    tid = (task_id or os.environ.get("HERMES_KANBAN_TASK") or "").strip()
    nudge = (
        "KANBAN_CLOSEOUT_REQUIRED_V1: "
        f"Task `{tid or 'this task'}` has {remaining_calls} model calls left. "
        "Stop optional work now; use the remaining calls only to assemble the exact "
        "required receipt and call `kanban_complete` or `kanban_block` directly. "
        "Do not explore, poll, sleep, delegate, or end with narrative only."
    )
    if messages and messages[-1].get("role") == "user":
        content = messages[-1].get("content")
        if isinstance(content, str):
            messages[-1]["content"] = f"{content}\n\n{nudge}"
        elif isinstance(content, list):
            content.append({"type": "text", "text": nudge})
        else:
            messages[-1]["content"] = nudge
    else:
        messages.append(
            {
                "role": "user",
                "content": nudge,
                "_kanban_prelimit_synthetic": True,
            }
        )
    return True


__all__ = [
    "build_kanban_stop_nudge",
    "inject_kanban_prelimit_nudge",
    "kanban_stop_nudge_enabled",
    "session_called_kanban_terminal",
]
