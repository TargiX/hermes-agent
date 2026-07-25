"""Strictly bounded, read-only PostHog aggregate queries.

The normal PostHog MCP ``exec`` surface multiplexes read and write tools. That
is useful interactively, but it is too broad to auto-approve inside unattended
Codex app-server workers. This tool deliberately exposes a much smaller
capability:

* one HogQL ``SELECT`` over the ``events`` table;
* aggregate results only;
* an explicit lower and upper timestamp bound;
* no joins, subqueries, unions, comments, identifiers, or raw properties;
* at most 100 result rows.

The personal API key stays in the worker environment and is never accepted as
an argument or returned in a result.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any

from tools.registry import registry, tool_error, tool_result

_DEFAULT_API_HOST = "https://us.posthog.com"
_MAX_QUERY_CHARS = 12_000
_MAX_ROWS = 100
_MAX_CELL_CHARS = 500
_MAX_ERROR_CHARS = 500

_MUTATION_RE = re.compile(
    r"\b(?:alter|attach|copy|create|delete|detach|drop|grant|insert|kill|"
    r"optimize|rename|replace|revoke|system|truncate|update)\b",
    re.IGNORECASE,
)
_AGGREGATE_RE = re.compile(
    r"\b(?:avg|avgIf|count|countIf|median|quantile|sum|sumIf|uniq|"
    r"uniqExact|uniqIf)\s*\(",
    re.IGNORECASE,
)
_SENSITIVE_COLUMN_RE = re.compile(
    r"\b(?:distinct_id|person|persons|person_id|session_id|uuid|email|phone|"
    r"prompt|input|output|content|text|current_url|url|pathname|ip)\b",
    re.IGNORECASE,
)
_FULL_PROPERTIES_RE = re.compile(
    r"\bproperties\b(?!\s*(?:\.|\[))",
    re.IGNORECASE,
)
_DATE_BOUND_RE = re.compile(
    r"\btimestamp\s*(>=|>|<=|<)\s*toDateTime\s*\(\s*"
    r"'(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?)'\s*\)",
    re.IGNORECASE,
)
_RELATIVE_LOWER_RE = re.compile(
    r"\btimestamp\s*(?:>=|>)\s*now\s*\(\s*\)\s*-\s*"
    r"interval\s+(\d+)\s+(hour|day|week)s?\b",
    re.IGNORECASE,
)
_RELATIVE_UPPER_RE = re.compile(
    r"\btimestamp\s*(?:<=|<)\s*now\s*\(\s*\)",
    re.IGNORECASE,
)
_LIMIT_RE = re.compile(r"\blimit\s+(\d+)\b", re.IGNORECASE)
_PROPERTY_ACCESS_RE = re.compile(
    r"\bproperties\s*(?:\.\s*([A-Za-z_$][A-Za-z0-9_$]*)|"
    r"\[\s*'([^']+)'\s*\])",
    re.IGNORECASE,
)

# Deliberately small: every allowed key is expected to be low-cardinality and
# non-personal. Additions require a code review instead of letting an
# unattended prompt widen the privacy boundary at runtime.
_SAFE_PROPERTY_KEYS = frozenset(
    {
        "$browser",
        "$device_type",
        "$geoip_country_code",
        "$lib",
        "$lib_version",
        "$os",
        "auth_state",
        "error_code",
        "event_category",
        "failure_reason",
        "flow",
        "funnel_surface",
        "generation_surface",
        "generation_type",
        "is_authenticated",
        "media_type",
        "model",
        "model_name",
        "outcome",
        "placement",
        "product_area",
        "provider",
        "result",
        "route_name",
        "source",
        "status",
        "success",
        "surface",
    }
)


def _strip_string_literals(query: str) -> str:
    """Replace single-quoted literals before keyword/privacy inspection."""
    out: list[str] = []
    index = 0
    in_string = False
    while index < len(query):
        char = query[index]
        if not in_string:
            if char == "'":
                in_string = True
                out.append("''")
            else:
                out.append(char)
            index += 1
            continue

        if char == "\\" and index + 1 < len(query):
            index += 2
            continue
        if char == "'" and index + 1 < len(query) and query[index + 1] == "'":
            index += 2
            continue
        if char == "'":
            in_string = False
        index += 1

    if in_string:
        raise ValueError("Unterminated SQL string literal")
    return "".join(out)


def _validate_time_window(query: str) -> None:
    """Require a complete, explicit window no wider than 90 days."""
    date_bounds = _DATE_BOUND_RE.findall(query)
    if date_bounds:
        if len(date_bounds) != 2:
            raise ValueError("events queries require exactly two timestamp bounds")
        lower_values = [
            value for operator, value in date_bounds if operator in {">", ">="}
        ]
        upper_values = [
            value for operator, value in date_bounds if operator in {"<", "<="}
        ]
        if len(lower_values) != 1 or len(upper_values) != 1:
            raise ValueError("timestamp bounds must contain one lower and one upper bound")
        try:
            lower = datetime.fromisoformat(lower_values[0].replace(" ", "T")).replace(
                tzinfo=timezone.utc
            )
            upper = datetime.fromisoformat(upper_values[0].replace(" ", "T")).replace(
                tzinfo=timezone.utc
            )
        except ValueError as exc:
            raise ValueError("timestamp bounds must use ISO date/time literals") from exc
        if upper <= lower:
            raise ValueError("timestamp upper bound must be after the lower bound")
        if upper - lower > timedelta(days=90):
            raise ValueError("timestamp window may not exceed 90 days")
        if upper > datetime.now(timezone.utc) + timedelta(days=1):
            raise ValueError("timestamp upper bound may not be in the distant future")
        return

    relative_lower = _RELATIVE_LOWER_RE.findall(query)
    relative_upper = _RELATIVE_UPPER_RE.findall(query)
    if len(relative_lower) != 1 or len(relative_upper) != 1:
        raise ValueError(
            "events queries require either two toDateTime bounds or one "
            "bounded now() - INTERVAL window"
        )
    amount_text, unit = relative_lower[0]
    amount = int(amount_text)
    days = amount / 24 if unit.casefold() == "hour" else amount
    if unit.casefold() == "week":
        days *= 7
    if amount < 1 or days > 90:
        raise ValueError("relative timestamp window must be between 1 hour and 90 days")


def _validate_query(query: str, *, max_rows: int) -> str:
    """Validate and normalize one bounded aggregate events query."""
    if not isinstance(query, str) or not query.strip():
        raise ValueError("query must be a non-empty string")
    if len(query) > _MAX_QUERY_CHARS:
        raise ValueError(f"query exceeds {_MAX_QUERY_CHARS} characters")
    if not isinstance(max_rows, int) or isinstance(max_rows, bool):
        raise ValueError("max_rows must be an integer")
    if max_rows < 1 or max_rows > _MAX_ROWS:
        raise ValueError(f"max_rows must be between 1 and {_MAX_ROWS}")

    stripped = query.strip()
    if ";" in stripped:
        raise ValueError("semicolons and multiple statements are not allowed")
    if "--" in stripped or "/*" in stripped or "*/" in stripped:
        raise ValueError("SQL comments are not allowed")
    if '"' in stripped or "`" in stripped:
        raise ValueError("quoted identifiers are not allowed")

    inspected = _strip_string_literals(stripped)
    lowered = inspected.casefold()
    if not lowered.startswith("select "):
        raise ValueError("only a single SELECT statement is allowed")
    if _MUTATION_RE.search(inspected):
        raise ValueError("mutation keywords are not allowed")
    if re.search(r"\b(?:join|union|with|into|format)\b", inspected, re.IGNORECASE):
        raise ValueError("joins, unions, CTEs, INTO, and FORMAT are not allowed")
    if re.search(r"\bfrom\s*\(", inspected, re.IGNORECASE):
        raise ValueError("subqueries are not allowed")
    if len(re.findall(r"\bfrom\s+events\b", inspected, re.IGNORECASE)) != 1:
        raise ValueError("query must read exactly once from the events table")
    if re.search(r"\bfrom\s+(?!events\b)[a-zA-Z0-9_.]+", inspected, re.IGNORECASE):
        raise ValueError("only the events table is allowed")
    if re.search(r"\bselect\s+(?:distinct\s+)?\*", inspected, re.IGNORECASE):
        raise ValueError("SELECT * is not allowed")
    if not _AGGREGATE_RE.search(inspected):
        raise ValueError("query must contain an aggregate function")
    if _FULL_PROPERTIES_RE.search(inspected):
        raise ValueError("full properties objects are not allowed")
    if _SENSITIVE_COLUMN_RE.search(inspected):
        raise ValueError("raw identifiers or high-risk content columns are not allowed")
    property_keys = {
        (dot_key or bracket_key).casefold()
        for dot_key, bracket_key in _PROPERTY_ACCESS_RE.findall(stripped)
    }
    disallowed_property_keys = sorted(property_keys - _SAFE_PROPERTY_KEYS)
    if disallowed_property_keys:
        raise ValueError(
            "property keys are outside the low-cardinality allowlist: "
            + ", ".join(disallowed_property_keys)
        )

    select_clause = re.split(r"\bfrom\s+events\b", inspected, maxsplit=1, flags=re.IGNORECASE)[0]
    if re.search(r"\btimestamp\b", select_clause, re.IGNORECASE):
        raise ValueError("raw timestamps may not be projected")

    _validate_time_window(stripped)

    limits = _LIMIT_RE.findall(inspected)
    if len(limits) > 1:
        raise ValueError("only one LIMIT clause is allowed")
    if limits:
        if int(limits[0]) > max_rows:
            raise ValueError(f"query LIMIT may not exceed max_rows={max_rows}")
        return stripped
    return f"{stripped}\nLIMIT {max_rows}"


def _api_host() -> str:
    raw = os.getenv("MCP_POSTHOG_API_HOST", _DEFAULT_API_HOST).strip().rstrip("/")
    parsed = urllib.parse.urlparse(raw)
    hostname = (parsed.hostname or "").casefold()
    if parsed.scheme != "https" or (
        hostname != "posthog.com" and not hostname.endswith(".posthog.com")
    ):
        raise ValueError("MCP_POSTHOG_API_HOST must be an HTTPS posthog.com host")
    if parsed.path not in {"", "/"} or parsed.params or parsed.query or parsed.fragment:
        raise ValueError("MCP_POSTHOG_API_HOST must not include a path or query")
    return raw


def _sanitize_cell(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value[:_MAX_CELL_CHARS]
    return str(value)[:_MAX_CELL_CHARS]


def _posthog_aggregate_readonly(args: dict, **_: Any) -> str:
    query = args.get("query")
    project_id = args.get("project_id")
    max_rows = args.get("max_rows", _MAX_ROWS)

    if not isinstance(project_id, int) or isinstance(project_id, bool) or project_id < 1:
        return tool_error("project_id must be a positive integer")

    try:
        safe_query = _validate_query(query, max_rows=max_rows)
        host = _api_host()
    except ValueError as exc:
        return tool_error(str(exc), read_only=True)

    api_key = os.getenv("MCP_POSTHOG_API_KEY", "").strip()
    if not api_key:
        return tool_error(
            "MCP_POSTHOG_API_KEY is not configured",
            read_only=True,
        )

    endpoint = f"{host}/api/projects/{project_id}/query/"
    body = json.dumps(
        {"query": {"kind": "HogQLQuery", "query": safe_query}},
        separators=(",", ":"),
    ).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "Hermes-PostHog-Readonly/1",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read())
    except urllib.error.HTTPError as exc:
        try:
            error_payload = json.loads(exc.read())
            detail = str(error_payload.get("detail") or error_payload.get("error") or "")
        except Exception:
            detail = ""
        return tool_error(
            f"PostHog query failed with HTTP {exc.code}",
            detail=detail[:_MAX_ERROR_CHARS] or None,
            read_only=True,
        )
    except (urllib.error.URLError, TimeoutError) as exc:
        return tool_error(
            f"PostHog query transport failed: {type(exc).__name__}",
            read_only=True,
        )
    except (ValueError, TypeError, json.JSONDecodeError):
        return tool_error("PostHog returned an invalid JSON response", read_only=True)

    raw_columns = payload.get("columns")
    raw_results = payload.get("results")
    if not isinstance(raw_columns, list) or not isinstance(raw_results, list):
        return tool_error("PostHog response omitted columns or results", read_only=True)

    columns = [str(column)[:_MAX_CELL_CHARS] for column in raw_columns]
    rows: list[list[Any]] = []
    for row in raw_results[:max_rows]:
        if not isinstance(row, list):
            return tool_error("PostHog returned a malformed result row", read_only=True)
        rows.append([_sanitize_cell(value) for value in row])

    return tool_result(
        success=True,
        read_only=True,
        project_id=project_id,
        query=safe_query,
        columns=columns,
        results=rows,
        row_count=len(rows),
        truncated=bool(payload.get("hasMore")) or len(raw_results) > max_rows,
    )


POSTHOG_AGGREGATE_READONLY_SCHEMA = {
    "name": "posthog_aggregate_readonly",
    "description": (
        "Run one strictly read-only, aggregate HogQL SELECT over PostHog events. "
        "The query must have explicit lower and upper timestamp bounds, contain "
        "an aggregate, avoid raw identifiers/content/properties, and return at "
        "most 100 rows. Use it for bounded event counts and low-cardinality "
        "breakdowns only; it cannot mutate PostHog."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "project_id": {
                "type": "integer",
                "minimum": 1,
                "description": "Numeric PostHog project id.",
            },
            "query": {
                "type": "string",
                "minLength": 1,
                "maxLength": _MAX_QUERY_CHARS,
                "description": (
                    "One aggregate SELECT from events with explicit lower and "
                    "upper timestamp bounds. No semicolon, joins, subqueries, "
                    "raw identifiers, raw timestamps, or full properties."
                ),
            },
            "max_rows": {
                "type": "integer",
                "minimum": 1,
                "maximum": _MAX_ROWS,
                "default": _MAX_ROWS,
                "description": "Maximum aggregate rows returned (1-100).",
            },
        },
        "required": ["project_id", "query"],
        "additionalProperties": False,
    },
}


registry.register(
    name="posthog_aggregate_readonly",
    toolset="posthog_readonly",
    schema=POSTHOG_AGGREGATE_READONLY_SCHEMA,
    handler=_posthog_aggregate_readonly,
    requires_env=["MCP_POSTHOG_API_KEY"],
    emoji="📊",
    max_result_size_chars=24_000,
)
