"""Context-local execution ownership markers.

Hermes can run a delegated child in the same process as a dispatcher-owned
parent. Process environment variables therefore identify the parent worker,
not the child. This scope keeps that distinction explicit without mutating
``os.environ`` across concurrent threads.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator


_DELEGATED_CHILD: ContextVar[bool] = ContextVar(
    "hermes_delegated_child",
    default=False,
)


def in_delegated_child_scope() -> bool:
    """Return whether the current context is a ``delegate_task`` child."""

    return _DELEGATED_CHILD.get()


@contextmanager
def delegated_child_scope() -> Iterator[None]:
    """Mark construction or execution as a delegated child contribution."""

    token = _DELEGATED_CHILD.set(True)
    try:
        yield
    finally:
        _DELEGATED_CHILD.reset(token)


__all__ = ["delegated_child_scope", "in_delegated_child_scope"]
