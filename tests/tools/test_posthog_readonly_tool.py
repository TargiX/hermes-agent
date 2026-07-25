from __future__ import annotations

import json
import urllib.error

import pytest

from tools.posthog_readonly_tool import (
    _posthog_aggregate_readonly,
    _validate_query,
)


VALID_QUERY = """
SELECT event, properties.surface, count() AS total
FROM events
WHERE timestamp >= toDateTime('2026-07-14 00:00:00')
  AND timestamp < toDateTime('2026-07-21 00:00:00')
  AND event ILIKE '%generation%'
GROUP BY event, properties.surface
ORDER BY total DESC
"""


class _FakeResponse:
    def __init__(self, payload: dict):
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return None

    def read(self):
        return json.dumps(self._payload).encode()


def test_validate_appends_bounded_limit():
    normalized = _validate_query(VALID_QUERY, max_rows=25)
    assert normalized.endswith("LIMIT 25")


@pytest.mark.parametrize(
    ("query", "message"),
    [
        ("DELETE FROM events", "only a single SELECT"),
        (
            "SELECT count() FROM events; SELECT count() FROM events",
            "semicolons",
        ),
        (
            "SELECT distinct_id, count() FROM events "
            "WHERE timestamp >= now() - INTERVAL 1 DAY "
            "AND timestamp < now() GROUP BY distinct_id",
            "raw identifiers",
        ),
        (
            "SELECT properties, count() FROM events "
            "WHERE timestamp >= now() - INTERVAL 1 DAY "
            "AND timestamp < now() GROUP BY properties",
            "full properties",
        ),
        (
            "SELECT event, count() FROM events GROUP BY event",
            "toDateTime",
        ),
        (
            "SELECT event, count() FROM events "
            "WHERE timestamp >= now() - INTERVAL 1 DAY "
            "AND timestamp < now() GROUP BY event LIMIT 101",
            "may not exceed",
        ),
        (
            "SELECT event, count() FROM events "
            "JOIN persons ON events.person_id = persons.id "
            "WHERE timestamp >= now() - INTERVAL 1 DAY "
            "AND timestamp < now() GROUP BY event",
            "joins",
        ),
        (
            "SELECT properties.generation_id, count() FROM events "
            "WHERE timestamp >= now() - INTERVAL 1 DAY "
            "AND timestamp < now() GROUP BY properties.generation_id",
            "allowlist",
        ),
        (
            "SELECT event, count() FROM events "
            "WHERE timestamp >= toDateTime('2020-01-01 00:00:00') "
            "AND timestamp < toDateTime('2026-01-01 00:00:00') "
            "GROUP BY event",
            "90 days",
        ),
    ],
)
def test_validate_rejects_unsafe_queries(query: str, message: str):
    with pytest.raises(ValueError, match=message):
        _validate_query(query, max_rows=100)


def test_handler_returns_only_bounded_aggregate_rows(monkeypatch):
    monkeypatch.setenv("MCP_POSTHOG_API_KEY", "secret-test-key")
    monkeypatch.delenv("MCP_POSTHOG_API_HOST", raising=False)

    captured = {}

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["authorization"] = request.headers["Authorization"]
        captured["body"] = json.loads(request.data)
        captured["timeout"] = timeout
        return _FakeResponse(
            {
                "columns": ["event", "surface", "total"],
                "results": [["image_generation_started", "simple_create", 12]],
                "hasMore": False,
            }
        )

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    result = json.loads(
        _posthog_aggregate_readonly(
            {"project_id": 172109, "query": VALID_QUERY, "max_rows": 25}
        )
    )

    assert result["success"] is True
    assert result["read_only"] is True
    assert result["results"] == [["image_generation_started", "simple_create", 12]]
    assert result["row_count"] == 1
    assert "secret-test-key" not in json.dumps(result)
    assert captured["url"] == "https://us.posthog.com/api/projects/172109/query/"
    assert captured["authorization"] == "Bearer secret-test-key"
    assert captured["body"]["query"]["kind"] == "HogQLQuery"
    assert captured["body"]["query"]["query"].endswith("LIMIT 25")
    assert captured["timeout"] == 30


def test_handler_rejects_non_posthog_host_without_network(monkeypatch):
    monkeypatch.setenv("MCP_POSTHOG_API_KEY", "secret-test-key")
    monkeypatch.setenv("MCP_POSTHOG_API_HOST", "https://attacker.invalid")

    result = json.loads(
        _posthog_aggregate_readonly(
            {"project_id": 172109, "query": VALID_QUERY}
        )
    )

    assert "posthog.com" in result["error"]
    assert result["read_only"] is True


def test_handler_sanitizes_http_error_without_leaking_key(monkeypatch):
    monkeypatch.setenv("MCP_POSTHOG_API_KEY", "secret-test-key")
    monkeypatch.delenv("MCP_POSTHOG_API_HOST", raising=False)

    def fake_urlopen(*_args, **_kwargs):
        raise urllib.error.HTTPError(
            "https://us.posthog.com/api/projects/1/query/",
            403,
            "Forbidden",
            {},
            None,
        )

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    result = json.loads(
        _posthog_aggregate_readonly(
            {"project_id": 172109, "query": VALID_QUERY}
        )
    )

    assert result["error"] == "PostHog query failed with HTTP 403"
    assert "secret-test-key" not in json.dumps(result)
