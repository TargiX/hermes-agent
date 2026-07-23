/**
 * Hermes Kanban — Dashboard Plugin
 *
 * Board view for the multi-agent collaboration board backed by
 * ~/.hermes/kanban.db. Calls the plugin's backend at /api/plugins/kanban/
 * and tails task_events over a WebSocket for live updates.
 *
 * Plain IIFE, no build step. Uses window.__HERMES_PLUGIN_SDK__ for React +
 * shadcn primitives; HTML5 drag-and-drop for card movement on desktop and
 * a pointer-based fallback for touch.
 */
(function () {
  "use strict";

  const SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK) return;

  const { React } = SDK;
  const h = React.createElement;
  const {
    Card, CardContent,
    Badge, Button, Input, Label, Select, SelectOption,
  } = SDK.components;
  const { useState, useEffect, useCallback, useMemo, useRef } = SDK.hooks;
  const { cn, timeAgo } = SDK.utils;

  // Newer host dashboards expose a DS-styled Checkbox on the plugin SDK.
  // Fall back to a native <input type="checkbox"> shim so older hosts that
  // predate the design-system rollout still render. The shim normalises
  // Radix's onCheckedChange(checked) signature to native onChange(event).
  const Checkbox = SDK.components.Checkbox || function (props) {
    const { checked, onCheckedChange, className, onClick, ...rest } = props;
    return h("input", Object.assign({
      type: "checkbox",
      checked: !!checked,
      className: className,
      onClick: onClick,
      onChange: function (e) {
        if (onCheckedChange) onCheckedChange(e.target.checked);
      },
    }, rest));
  };

  // useI18n is a hook each component calls locally. Older host dashboards
  // may not expose it yet; fall back to a shim so the bundle still renders
  // English against an older host SDK. English fallback strings live
  // alongside each call site (passed as the third arg of tx()).
  const useI18n = SDK.useI18n || function () { return { t: { kanban: null }, locale: "en" }; };

  // Resolve a translation by dotted path under the kanban namespace
  // (e.g. "columnLabels.triage"); fall back to the English string passed in.
  function tx(t, path, fallback, vars) {
    let node = t && t.kanban;
    if (node) {
      const parts = path.split(".");
      for (let i = 0; i < parts.length; i++) {
        if (node && typeof node === "object" && parts[i] in node) {
          node = node[parts[i]];
        } else { node = null; break; }
      }
    }
    let str = (typeof node === "string") ? node : fallback;
    if (vars) {
      for (const k in vars) {
        str = str.replace(new RegExp("\\{" + k + "\\}", "g"), vars[k]);
      }
    }
    return str;
  }

  // ``fetchJSON`` throws ``Error("<status>: <raw body>")`` on non-2xx, and
  // FastAPI bodies look like ``{"detail":"<message>"}``.  Pull the
  // human-readable message out so banners/toasts don't have to leak HTTP
  // plumbing at the user (e.g. ``409: {"detail":"…"}``).  See #26744.
  function parseApiErrorMessage(err) {
    const raw = (err && err.message) ? String(err.message) : String(err || "");
    const m = raw.match(/^(\d{3}):\s*(.*)$/s);
    const body = m ? m[2] : raw;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed.detail === "string") return parsed.detail;
      if (parsed && parsed.detail && typeof parsed.detail.message === "string") {
        return parsed.detail.message;
      }
    } catch (_e) { /* not JSON — fall through to raw body */ }
    return body || raw;
  }

  // Order matches BOARD_COLUMNS in plugin_api.py.
  const COLUMN_ORDER = ["triage", "todo", "ready", "running", "blocked", "done"];
  // English fallback dictionaries — used when the i18n catalog is missing
  // a key, and as defaults for the get*() helpers below so callers running
  // outside any React component (where there's no `t`) still get sane text.
  const FALLBACK_COLUMN_LABEL = {
    triage: "Triage",
    todo: "Todo",
    ready: "Ready",
    running: "In Progress",
    blocked: "Blocked",
    done: "Done",
    archived: "Archived",
  };
  const FALLBACK_COLUMN_HELP = {
    triage: "Raw ideas — a specifier will flesh out the spec",
    todo: "Waiting on dependencies or unassigned",
    ready: "Dependencies satisfied; assign a profile to dispatch",
    running: "Claimed by a worker — in-flight",
    blocked: "Worker asked for human input",
    done: "Completed",
    archived: "Archived",
  };
  const FALLBACK_DESTRUCTIVE = {
    done: "Mark this task as done? The worker's claim is released and dependent children become ready.",
    archived: "Archive this task? It disappears from the default board view.",
    blocked: "Mark this task as blocked? The worker's claim is released.",
  };
  const FALLBACK_DIAGNOSTIC_EVENT_LABELS = {
    completion_blocked_hallucination: "⚠ Completion blocked — phantom card ids",
    suspected_hallucinated_references: "⚠ Prose referenced phantom card ids",
  };
  const FALLBACK_TRASH = {
    label: "Trash",
    title: "Drag a card here to permanently delete it",
    confirm: "Permanently delete this task? This cannot be undone.",
    dropHint: "Drop to delete",
  };
  const DIAGNOSTIC_EVENT_KIND_KEYS = {
    completion_blocked_hallucination: "completionBlockedHallucination",
    suspected_hallucinated_references: "suspectedHallucinatedReferences",
  };
  const DESTRUCTIVE_KEYS = {
    done: "confirmDone",
    archived: "confirmArchive",
    blocked: "confirmBlocked",
  };

  function getColumnLabel(t, status) {
    return tx(t, "columnLabels." + status, FALLBACK_COLUMN_LABEL[status] || status);
  }
  function getColumnHelp(t, status) {
    return tx(t, "columnHelp." + status, FALLBACK_COLUMN_HELP[status] || "");
  }
  function getDestructiveConfirm(t, status) {
    const key = DESTRUCTIVE_KEYS[status];
    if (!key) return null;
    return tx(t, key, FALLBACK_DESTRUCTIVE[status]);
  }
  function getDiagnosticEventLabel(t, kind) {
    const key = DIAGNOSTIC_EVENT_KIND_KEYS[kind];
    if (!key) return null;
    return tx(t, key, FALLBACK_DIAGNOSTIC_EVENT_LABELS[kind]);
  }

  const COLUMN_DOT = {
    triage: "hermes-kanban-dot-triage",
    todo: "hermes-kanban-dot-todo",
    ready: "hermes-kanban-dot-ready",
    running: "hermes-kanban-dot-running",
    blocked: "hermes-kanban-dot-blocked",
    done: "hermes-kanban-dot-done",
    archived: "hermes-kanban-dot-archived",
  };

  function isDiagnosticEvent(kind) {
    return Object.prototype.hasOwnProperty.call(FALLBACK_DIAGNOSTIC_EVENT_LABELS, kind);
  }

  function phantomIdsFromEvent(ev) {
    if (!ev || !ev.payload) return [];
    const p = ev.payload;
    return p.phantom_cards || p.phantom_refs || [];
  }

  // Takes an optional `t` so the prompt/alert text is localised. Callers
  // outside React components can pass null and fall through to English.
  function withCompletionSummary(patch, count, t) {
    if (!patch || patch.status !== "done") return patch;
    const label = count && count > 1 ? `${count} selected task(s)` : "this task";
    const value = window.prompt(
      tx(t, "completionSummary",
        "Completion summary for {label}. This is stored as the task result.",
        { label: label }),
      "",
    );
    if (value === null) return null;
    const summary = value.trim();
    if (!summary) {
      window.alert(tx(t, "completionSummaryRequired",
        "Completion summary is required before marking a task done."));
      return null;
    }
    return Object.assign({}, patch, { result: summary, summary });
  }

  const API = "/api/plugins/kanban";
  const MIME_TASK = "text/x-hermes-task";

  // Docs link — surfaced as a `?` icon next to the board switcher and as
  // `title=` hints on unlabelled controls. Kept in one place so rebrands or
  // path changes are a single edit.
  const DOCS_URL = "https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban";
  const DOCS_TUTORIAL_URL = "https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban-tutorial";

  // localStorage key for the user's selected board. Independent of the
  // CLI's on-disk ``<root>/kanban/current`` pointer so browser users
  // can inspect any board without shifting the CLI's active board out
  // from under a terminal they left open.
  const LS_BOARD_KEY = "hermes.kanban.selectedBoard";
  const LS_VIEW_KEY = "hermes.kanban.viewMode";

  function readSelectedBoard() {
    try {
      const v = window.localStorage.getItem(LS_BOARD_KEY);
      return (v || "").trim() || null;
    } catch (_e) { return null; }
  }

  function writeSelectedBoard(slug) {
    try {
      // Persist the user's dashboard-side board pin even for "default".
      // Previously this stripped "default" to keep localStorage empty,
      // but the fetch layer read that absence as "no opinion" and fell
      // through to the server-side ``current`` file — which the board
      // switcher also writes. Result: selecting the default tab after
      // creating a new board with "switch" checked showed the new
      // board's (wrong) data because the URL omitted ``?board=`` and
      // the backend happily returned whichever board was "current".
      // Persisting every selection keeps the dashboard's board opinion
      // independent of the CLI's active board, which was the original
      // design intent. Regression: #20879.
      if (slug) window.localStorage.setItem(LS_BOARD_KEY, slug);
      else window.localStorage.removeItem(LS_BOARD_KEY);
    } catch (_e) { /* ignore quota / private mode */ }
  }

  function readViewMode() {
    try {
      const value = window.localStorage.getItem(LS_VIEW_KEY);
      if (value === "yard" || value === "board") return value;
    } catch (_e) { /* ignore quota / private mode */ }
    // Make the live staffing view discoverable on first use. The user's
    // explicit choice persists immediately, so column-first users only see
    // this default once.
    return "yard";
  }

  function writeViewMode(mode) {
    try {
      window.localStorage.setItem(LS_VIEW_KEY, mode === "yard" ? "yard" : "board");
    } catch (_e) { /* ignore quota / private mode */ }
  }

  function withBoard(url, board) {
    // Always append ?board=<slug> when we have one picked — including
    // "default". Omitting the param would fall through to the backend's
    // resolution chain (env var → ``current`` file → default), which
    // means the dashboard's tab selection gets silently overridden by
    // whatever board the CLI or "switch" checkbox last activated.
    // Regression: #20879.
    if (!board) return url;
    const sep = url.indexOf("?") >= 0 ? "&" : "?";
    return `${url}${sep}board=${encodeURIComponent(board)}`;
  }

  // The SDK's Select component fires ``onValueChange(value)`` directly
  // (it's a shadcn-style popup, not a native <select>). Older plugin
  // code calls ``onChange({target: {value}})`` which silently never
  // fires. This helper wires both signatures so a setter works with
  // either API — use it as:
  //
  //   h(Select, {..., ...selectChangeHandler(setState), ...})
  function selectChangeHandler(setter) {
    return {
      onValueChange: function (v) { setter(v == null ? "" : v); },
      onChange: function (e) {
        const v = e && e.target ? e.target.value : e;
        setter(v == null ? "" : v);
      },
    };
  }

  // -------------------------------------------------------------------------
  // Minimal safe markdown renderer.
  //
  // Recognises a small subset (headings, bold, italic, inline code, fenced
  // code, links, bullet lists, paragraphs). HTML escaping first, then
  // inline replacements against the escaped string — no raw HTML from the
  // user is ever executed.
  // -------------------------------------------------------------------------

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function renderInline(esc) {
    // Fenced code has already been extracted before this runs; process
    // inline replacements on the escaped string.
    return esc
      // inline code
      .replace(/`([^`\n]+)`/g, (_m, c) => `<code>${c}</code>`)
      // bold
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      // italic
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      // safe links — only http(s) and mailto
      .replace(
        /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
        (_m, text, href) =>
          `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`,
      );
  }
  function renderMarkdown(src) {
    if (!src) return "";
    // Split out fenced code blocks first so their contents aren't mangled.
    const blocks = [];
    let working = String(src).replace(/```([\s\S]*?)```/g, (_m, code) => {
      blocks.push(code);
      return `\u0000CODE${blocks.length - 1}\u0000`;
    });
    const escaped = escapeHtml(working);
    const lines = escaped.split(/\r?\n/);
    const out = [];
    let inList = false;
    for (const raw of lines) {
      const line = raw;
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (bullet) {
        if (!inList) { out.push("<ul>"); inList = true; }
        out.push(`<li>${renderInline(bullet[1])}</li>`);
        continue;
      }
      if (inList) { out.push("</ul>"); inList = false; }
      if (heading) {
        const level = heading[1].length;
        out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      } else if (line.trim() === "") {
        out.push("");
      } else {
        out.push(`<p>${renderInline(line)}</p>`);
      }
    }
    if (inList) out.push("</ul>");
    let html = out.join("\n");
    // Re-insert fenced code blocks.
    html = html.replace(/\u0000CODE(\d+)\u0000/g, (_m, i) =>
      `<pre class="hermes-kanban-md-code"><code>${escapeHtml(blocks[Number(i)])}</code></pre>`,
    );
    return html;
  }
  const MARKDOWN_ALLOWED_TAGS = new Set([
    "a",
    "code",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "li",
    "p",
    "pre",
    "strong",
    "ul",
  ]);
  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }
  function sanitizeMarkdownAttrs(tag, attrs) {
    if (tag === "a") {
      const hrefMatch =
        /\shref=(["'])(.*?)\1/i.exec(attrs) ||
        /\shref=([^\s>]+)/i.exec(attrs);
      const href = hrefMatch ? (hrefMatch[2] || hrefMatch[1] || "").trim() : "";
      if (!/^(https?:\/\/|mailto:)/i.test(href)) return "";
      return ` href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer"`;
    }
    if (tag === "pre" && /\sclass=(["'])hermes-kanban-md-code\1/i.test(attrs)) {
      return ' class="hermes-kanban-md-code"';
    }
    return "";
  }
  function sanitizeMarkdownHtml(html) {
    return String(html || "").replace(
      /<\/?([a-zA-Z][A-Za-z0-9-]*)([^>]*)>/g,
      (match, rawTag, attrs) => {
        const tag = rawTag.toLowerCase();
        if (!MARKDOWN_ALLOWED_TAGS.has(tag)) return "";
        if (/^<\s*\//.test(match)) return `</${tag}>`;
        return `<${tag}${sanitizeMarkdownAttrs(tag, attrs || "")}>`;
      },
    );
  }

  function MarkdownBlock(props) {
    const enabled = props.enabled !== false;
    if (!enabled) {
      return h("pre", { className: "hermes-kanban-pre" }, props.source || "");
    }
    return h("div", {
      className: "hermes-kanban-md",
      dangerouslySetInnerHTML: { __html: sanitizeMarkdownHtml(renderMarkdown(props.source || "")) },
    });
  }

  // -------------------------------------------------------------------------
  // Touch drag-drop helper.
  //
  // HTML5 DnD is desktop-only. On touch devices we attach a pointerdown
  // handler that simulates a drag proxy and fires a custom event on the
  // column under the finger when released. Columns listen for both the
  // standard `drop` event and our `hermes-kanban:drop` event.
  // -------------------------------------------------------------------------

  function attachTouchDrag(el, taskId) {
    if (!el) return;
    function onDown(e) {
      if (e.pointerType !== "touch") return;
      e.preventDefault();
      const proxy = el.cloneNode(true);
      proxy.classList.add("hermes-kanban-touch-proxy");
      document.body.appendChild(proxy);
      let lastTarget = null;

      function move(ev) {
        proxy.style.left = `${ev.clientX - proxy.offsetWidth / 2}px`;
        proxy.style.top = `${ev.clientY - 24}px`;
        proxy.style.display = "none";
        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        proxy.style.display = "";
        const col = under && under.closest && under.closest("[data-kanban-column]");
        const trash = under && under.closest && under.closest("[data-kanban-trash]");
        const target = col || trash;
        if (target !== lastTarget) {
          if (lastTarget) lastTarget.classList.remove("hermes-kanban-column--drop");
          if (target) target.classList.add("hermes-kanban-column--drop");
          lastTarget = target;
        }
      }
      function up() {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        document.removeEventListener("pointercancel", up);
        if (lastTarget) {
          lastTarget.classList.remove("hermes-kanban-column--drop");
          const status = lastTarget.getAttribute("data-kanban-column");
          const isTrash = lastTarget.hasAttribute("data-kanban-trash");
          if (isTrash) {
            lastTarget.dispatchEvent(new CustomEvent("hermes-kanban:delete", {
              detail: { taskId },
              bubbles: true,
            }));
          } else if (status) {
            lastTarget.dispatchEvent(new CustomEvent("hermes-kanban:drop", {
              detail: { taskId, status },
              bubbles: true,
            }));
          }
        }
        proxy.remove();
      }
      // Kick off proxy at the pointer origin.
      proxy.style.position = "fixed";
      proxy.style.pointerEvents = "none";
      proxy.style.opacity = "0.85";
      proxy.style.zIndex = "9999";
      proxy.style.width = `${el.offsetWidth}px`;
      proxy.style.left = `${e.clientX - el.offsetWidth / 2}px`;
      proxy.style.top = `${e.clientY - 24}px`;
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
      document.addEventListener("pointercancel", up);
    }
    el.addEventListener("pointerdown", onDown);
    return function () { el.removeEventListener("pointerdown", onDown); };
  }

  // -------------------------------------------------------------------------
  // Error boundary
  // -------------------------------------------------------------------------

  // Wrap the boundary's fallback in a tiny function component so we can
  // call useI18n() — class components can't use hooks directly.
  function ErrorBoundaryFallback(props) {
    const { t } = useI18n();
    return h(Card, null,
      h(CardContent, { className: "p-6 text-sm" },
        h("div", { className: "text-destructive font-semibold mb-1" },
          tx(t, "renderingError", "Kanban tab hit a rendering error")),
        h("div", { className: "text-muted-foreground text-xs mb-3" },
          props.message),
        h(Button, {
          onClick: props.onReset,
          size: "sm",
        }, tx(t, "reloadView", "Reload view")),
      ),
    );
  }

  class ErrorBoundary extends React.Component {
    constructor(props) { super(props); this.state = { error: null }; }
    static getDerivedStateFromError(error) { return { error }; }
    componentDidCatch(error, info) {
      // eslint-disable-next-line no-console
      console.error("Kanban plugin crashed:", error, info);
    }
    render() {
      if (this.state.error) {
        return h(ErrorBoundaryFallback, {
          message: String(this.state.error && this.state.error.message || this.state.error),
          onReset: () => this.setState({ error: null }),
        });
      }
      return this.props.children;
    }
  }

  // -------------------------------------------------------------------------
  // Root page
  // -------------------------------------------------------------------------

  function KanbanPage() {
    const { t } = useI18n();
    const [board, setBoard] = useState(() => readSelectedBoard() || null);
    const [boardList, setBoardList] = useState([]);      // [{slug, name, counts, ...}]
    const [showNewBoard, setShowNewBoard] = useState(false);
    const [showBoardSettings, setShowBoardSettings] = useState(false);

    const [kanbanBoard, setKanbanBoard] = useState(null);  // the grid data
    // Alias so the rest of the function can keep using `board` semantically
    // for the grid data (card columns + tenants + assignees) without
    // colliding with the selected-board slug above. History: the old
    // component had `const [board, setBoard]` for the grid data. We
    // renamed the grid data to `kanbanBoard` so the more useful name
    // (`board`) belongs to the selected slug.
    const boardData = kanbanBoard;
    const setBoardData = setKanbanBoard;
    const [config, setConfig] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const [tenantFilter, setTenantFilter] = useState("");
    const [assigneeFilter, setAssigneeFilter] = useState("");
    const [includeArchived, setIncludeArchived] = useState(false);
    const [search, setSearch] = useState("");
    const [laneByProfile, setLaneByProfile] = useState(true);
    const [configApplied, setConfigApplied] = useState(false);
    const [viewMode, setViewMode] = useState(readViewMode);

    const [selectedTaskId, setSelectedTaskId] = useState(null);
    const [selectedIds, setSelectedIds] = useState(() => new Set());
    const [lastSelectedId, setLastSelectedId] = useState(null);
    const [failedIds, setFailedIds] = useState(() => new Set());
    const [draggingTaskId, setDraggingTaskId] = useState(null);
    const handleDragStart = useCallback(function (taskId) { setDraggingTaskId(taskId); }, []);
    const handleDragEnd = useCallback(function () { setDraggingTaskId(null); }, []);
    const changeViewMode = useCallback(function (mode) {
      const next = mode === "yard" ? "yard" : "board";
      setViewMode(next);
      writeViewMode(next);
    }, []);
    // Per-task event counter incremented whenever the WS stream reports
    // a new event for that task id. TaskDrawer useEffect-depends on its
    // own task's counter so it reloads itself on live events instead of
    // showing stale data.
    const [taskEventTick, setTaskEventTick] = useState({});

    const cursorRef = useRef(0);
    const reloadTimerRef = useRef(null);
    const wsRef = useRef(null);
    const wsBackoffRef = useRef(1000);
    const wsClosedRef = useRef(false);

    // --- load config once ---------------------------------------------------
    useEffect(function () {
      SDK.fetchJSON(withBoard(`${API}/config`, board))
        .then(function (c) {
          setConfig(c);
          if (!configApplied) {
            if (c.default_tenant) setTenantFilter(c.default_tenant);
            if (typeof c.lane_by_profile === "boolean") setLaneByProfile(c.lane_by_profile);
            if (typeof c.include_archived_by_default === "boolean") setIncludeArchived(c.include_archived_by_default);
            setConfigApplied(true);
          }
        })
        .catch(function () { setConfig({ render_markdown: true }); });
    }, []);  // eslint-disable-line react-hooks/exhaustive-deps

    // --- fetch full board ---------------------------------------------------
    const loadBoard = useCallback(() => {
      const qs = new URLSearchParams();
      if (tenantFilter) qs.set("tenant", tenantFilter);
      if (includeArchived) qs.set("include_archived", "true");
      const url = qs.toString() ? `${API}/board?${qs}` : `${API}/board`;
      return SDK.fetchJSON(withBoard(url, board))
        .then(function (data) {
          setBoardData(data);
          cursorRef.current = data.latest_event_id || 0;
          setError(null);
        })
        .catch(function (err) {
          setError(String(err && err.message ? err.message : err));
        })
        .finally(function () { setLoading(false); });
    }, [tenantFilter, includeArchived, board]);

    // --- load list of boards for the switcher ------------------------------
    const loadBoardList = useCallback(function () {
      return SDK.fetchJSON(withBoard(`${API}/boards`, board))
        .then(function (data) {
          const boards = (data && data.boards) || [];
          const storedBoard = readSelectedBoard();
          setBoardList(boards);
          if (!storedBoard && !board && data && data.current) {
            setBoard(data.current);
            return;
          }
          // If the stored slug isn't in the list any longer (board was
          // deleted in the CLI while dashboard was open), fall back to
          // default so the UI doesn't hang on a 404.
          if (board && board !== "default" && !boards.find(function (b) { return b.slug === board; })) {
            setBoard("default");
            writeSelectedBoard("default");
          }
        })
        .catch(function () { /* non-fatal */ });
    }, [board]);

    useEffect(function () { loadBoardList(); }, [loadBoardList]);

    const scheduleReload = useCallback(function () {
      if (reloadTimerRef.current) return;
      reloadTimerRef.current = setTimeout(function () {
        reloadTimerRef.current = null;
        loadBoard();
      }, 250);
    }, [loadBoard]);

    useEffect(function () {
      loadBoard();
      return function () {
        if (reloadTimerRef.current) {
          clearTimeout(reloadTimerRef.current);
          reloadTimerRef.current = null;
        }
      };
    }, [loadBoard]);

    // --- WebSocket ---------------------------------------------------------
    useEffect(function () {
      if (!boardData) return undefined;
      wsClosedRef.current = false;
      function openWs() {
        if (wsClosedRef.current) return;
        // Build the WS URL via the host SDK so the correct auth param is used
        // in BOTH modes: single-use ?ticket= in gated OAuth mode, ?token= in
        // loopback. Reading window.__HERMES_SESSION_TOKEN__ directly (the old
        // path) sends an empty token and is rejected in gated mode. buildWsUrl
        // also applies the dashboard base-path prefix for reverse-proxied
        // deployments, which the old inline URL did not. It's async (gated
        // mode mints a fresh ticket per connect), so resolve then open.
        const wsParams = { since: String(cursorRef.current || 0) };
        // Pin the WS stream to the currently-selected board so events
        // from other boards don't bleed in. Includes "default" so the
        // dashboard's own board pin always wins over the server-side
        // ``current`` file — same rationale as ``withBoard()`` above.
        // Regression: #20879.
        if (board) wsParams.board = board;
        SDK.buildWsUrl(`${API}/events`, wsParams).then(function (url) {
          if (wsClosedRef.current) return;
          let ws;
          try { ws = new WebSocket(url); } catch (_e) { return; }
          wsRef.current = ws;
          ws.onopen = function () { wsBackoffRef.current = 1000; };
          ws.onmessage = function (ev) {
            try {
              const msg = JSON.parse(ev.data);
              if (msg && Array.isArray(msg.events) && msg.events.length > 0) {
                cursorRef.current = msg.cursor || cursorRef.current;
                // Stamp per-task signal so the TaskDrawer can reload itself.
                setTaskEventTick(function (prev) {
                  const next = Object.assign({}, prev);
                  for (const e of msg.events) {
                    if (e && e.task_id) next[e.task_id] = (next[e.task_id] || 0) + 1;
                  }
                  return next;
                });
                scheduleReload();
              }
            } catch (_e) { /* ignore */ }
          };
          ws.onclose = function (ev) {
            if (wsClosedRef.current) return;
            if (ev && ev.code === 1008) {
              setError(tx(t, "wsAuthFailed",
                "WebSocket auth failed — reload the page to refresh the session token."));
              return;
            }
            const delay = Math.min(wsBackoffRef.current, 30000);
            wsBackoffRef.current = Math.min(wsBackoffRef.current * 2, 30000);
            setTimeout(openWs, delay);
          };
        }).catch(function () {
          // Ticket mint / URL build failed (e.g. session expired). Back off
          // and retry; a hard auth failure surfaces via the 1008 close path.
          if (wsClosedRef.current) return;
          const delay = Math.min(wsBackoffRef.current, 30000);
          wsBackoffRef.current = Math.min(wsBackoffRef.current * 2, 30000);
          setTimeout(openWs, delay);
        });
      }
      openWs();
      return function () {
        wsClosedRef.current = true;
        try { wsRef.current && wsRef.current.close(); } catch (_e) { /* noop */ }
      };
    }, [!!boardData, board, scheduleReload]);

    // --- filtering ----------------------------------------------------------
    const filteredBoard = useMemo(function () {
      if (!boardData) return null;
      const q = search.trim().toLowerCase();
      const filterTask = function (t) {
        if (tenantFilter && t.tenant !== tenantFilter) return false;
        if (assigneeFilter && t.assignee !== assigneeFilter) return false;
        if (q) {
          const hay = `${t.id} ${t.title || ""} ${t.body || ""} ${t.result || ""} ${t.latest_summary || ""} ${t.assignee || ""} ${t.tenant || ""}`.toLowerCase();
          if (hay.indexOf(q) === -1) return false;
        }
        return true;
      };
      return Object.assign({}, boardData, {
        columns: boardData.columns.map(function (col) {
          return Object.assign({}, col, { tasks: col.tasks.filter(filterTask) });
        }),
      });
    }, [boardData, tenantFilter, assigneeFilter, search]);

    // --- actions ------------------------------------------------------------
    const moveTask = useCallback(function (taskId, newStatus) {
      const confirmMsg = getDestructiveConfirm(t, newStatus);
      if (confirmMsg && !window.confirm(confirmMsg)) return;
      const patch = withCompletionSummary({ status: newStatus }, 1, t);
      if (!patch) return;
      setBoardData(function (b) {
        if (!b) return b;
        let moved = null;
        const columns = b.columns.map(function (col) {
          const next = col.tasks.filter(function (t) {
            if (t.id === taskId) { moved = Object.assign({}, t, { status: newStatus }); return false; }
            return true;
          });
          return Object.assign({}, col, { tasks: next });
        });
        if (moved) {
          const dest = columns.find(function (c) { return c.name === newStatus; });
          if (dest) dest.tasks = [moved].concat(dest.tasks);
        }
        return Object.assign({}, b, { columns });
      });
      SDK.fetchJSON(withBoard(`${API}/tasks/${encodeURIComponent(taskId)}`, board), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(function (err) {
        setError(tx(t, "moveFailed", "Move failed: ") + parseApiErrorMessage(err));
        loadBoard();
      });
    }, [loadBoard, board, t]);

    const clearSelected = useCallback(function () {
      setSelectedIds(new Set());
      setLastSelectedId(null);
      setFailedIds(new Set());
    }, []);
    const moveSelected = useCallback(function (newStatus) {
      const confirmMsg = DESTRUCTIVE_TRANSITIONS[newStatus];
      if (confirmMsg && !window.confirm(confirmMsg)) return;
      if (selectedIds.size === 0) return;
      const patch = withCompletionSummary({ status: newStatus }, selectedIds.size);
      if (!patch) return;
      const ids = Array.from(selectedIds);
      // Optimistic UI: remove selected from all columns and prepend to target.
      setBoardData(function (b) {
        if (!b) return b;
        const moved = [];
        const columns = b.columns.map(function (col) {
          const kept = [];
          for (const t of col.tasks) {
            if (selectedIds.has(t.id)) moved.push(Object.assign({}, t, { status: newStatus }));
            else kept.push(t);
          }
          return Object.assign({}, col, { tasks: kept });
        });
        const dest = columns.find(function (c) { return c.name === newStatus; });
        if (dest) dest.tasks = moved.concat(dest.tasks);
        return Object.assign({}, b, { columns });
      });
      SDK.fetchJSON(withBoard(`${API}/tasks/bulk`, board), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ ids }, patch)),
      }).then(function (res) {
        const failed = (res.results || []).filter(function (r) { return !r.ok; });
        if (failed.length > 0) {
          setError(`Bulk move: ${failed.length} of ${res.results.length} failed`);
          setFailedIds(new Set(failed.map(function (f) { return f.id; })));
        } else {
          setFailedIds(new Set());
        }
        setSelectedIds(new Set());
        setLastSelectedId(null);
        loadBoard();
      }).catch(function (err) {
        setError(`Move failed: ${err.message || err}`);
        setFailedIds(new Set(selectedIds));
        loadBoard();
      });
    }, [selectedIds, loadBoard, board]);

    const createTask = useCallback(function (body) {
      return SDK.fetchJSON(withBoard(`${API}/tasks`, board), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(function (res) {
        // Surface dispatcher-presence warnings (e.g. "no gateway is
        // running") via the existing error banner channel. Not fatal —
        // the task was created successfully — but the user should know
        // their ready task will sit idle until the gateway is up.
        if (res && res.warning) {
          setError(tx(t, "taskCreatedWarning", "Task created, but: ") + res.warning);
        }
        loadBoard();
        loadBoardList();  // refresh counts in the switcher
        return res;
      });
    }, [loadBoard, loadBoardList, board, t]);

    const toggleSelected = useCallback(function (id, additive) {
      setSelectedIds(function (prev) {
        const next = new Set(additive ? prev : []);
        if (prev.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setLastSelectedId(id);
      setFailedIds(function (prev) {
        if (prev.has(id)) {
          const next = new Set(prev);
          next.delete(id);
          return next;
        }
        return prev;
      });
    }, []);

    const toggleRange = useCallback(function (toId) {
      // Build flat visible task order from filteredBoard columns.
      setSelectedIds(function (prev) {
        const next = new Set(prev);
        if (!filteredBoard || !filteredBoard.columns) return next;
        const order = [];
        for (const col of filteredBoard.columns) {
          for (const t of col.tasks || []) order.push(t.id);
        }
        const anchor = lastSelectedId;
        if (!anchor || anchor === toId) {
          next.add(toId);
          return next;
        }
        const aIdx = order.indexOf(anchor);
        const bIdx = order.indexOf(toId);
        if (aIdx === -1 || bIdx === -1) {
          next.add(toId);
          return next;
        }
        const lo = Math.min(aIdx, bIdx);
        const hi = Math.max(aIdx, bIdx);
        for (let i = lo; i <= hi; i++) next.add(order[i]);
        return next;
      });
      setLastSelectedId(toId);
    }, [filteredBoard, lastSelectedId]);

    const selectAllVisible = useCallback(function () {
      if (!filteredBoard || !filteredBoard.columns) return;
      const next = new Set();
      for (const col of filteredBoard.columns) {
        for (const t of col.tasks || []) next.add(t.id);
      }
      setSelectedIds(next);
      if (next.size > 0) {
        const first = Array.from(next)[0];
        setLastSelectedId(first);
      }
    }, [filteredBoard]);

    const selectAllInColumn = useCallback(function (columnName) {
      if (!filteredBoard || !filteredBoard.columns) return;
      const col = filteredBoard.columns.find(function (c) { return c.name === columnName; });
      if (!col) return;
      const allSelected = col.tasks && col.tasks.length > 0 && col.tasks.every(function (t) { return selectedIds.has(t.id); });
      const next = new Set(selectedIds);
      if (allSelected) {
        for (const t of col.tasks || []) next.delete(t.id);
      } else {
        for (const t of col.tasks || []) next.add(t.id);
      }
      setSelectedIds(next);
      if (col.tasks && col.tasks.length > 0) setLastSelectedId(col.tasks[0].id);
    }, [filteredBoard, selectedIds]);

    const applyBulk = useCallback(function (patch, confirmMsg) {
      if (selectedIds.size === 0) return;
      if (confirmMsg && !window.confirm(confirmMsg)) return;
      const finalPatch = withCompletionSummary(patch, selectedIds.size, t);
      if (!finalPatch) return;
      const body = Object.assign({ ids: Array.from(selectedIds) }, finalPatch);
      // Optimistic UI for status moves (same pattern as moveSelected).
      if (finalPatch.status) {
        setBoardData(function (b) {
          if (!b) return b;
          const moved = [];
          const columns = b.columns.map(function (col) {
            const kept = [];
            for (const t of col.tasks) {
              if (selectedIds.has(t.id)) moved.push(Object.assign({}, t, { status: finalPatch.status }));
              else kept.push(t);
            }
            return Object.assign({}, col, { tasks: kept });
          });
          const dest = columns.find(function (c) { return c.name === finalPatch.status; });
          if (dest) dest.tasks = moved.concat(dest.tasks);
          return Object.assign({}, b, { columns });
        });
      }
      SDK.fetchJSON(withBoard(`${API}/tasks/bulk`, board), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(function (res) {
          const failed = (res.results || []).filter(function (r) { return !r.ok; });
          if (failed.length > 0) {
            setError(tx(t, "bulkFailed", "Bulk: ") +
              `${failed.length} of ${res.results.length} failed: ` +
              failed.slice(0, 3).map(function (f) { return `${f.id} (${f.error})`; }).join("; "));
            setFailedIds(new Set(failed.map(function (f) { return f.id; })));
          } else {
            setFailedIds(new Set());
          }
          setSelectedIds(new Set());
          setLastSelectedId(null);
          loadBoard();
        })
        .catch(function (e) {
          setError(String(e.message || e));
          setFailedIds(new Set(selectedIds));
          loadBoard();
        });
    }, [selectedIds, loadBoard, board, t]);

    // --- board switching ----------------------------------------------------
    const switchBoard = useCallback(function (nextSlug) {
      if (!nextSlug || nextSlug === board) return;
      // Optimistic UI: clear the current grid + show loading, reset the
      // event cursor so the WS reopens aligned to the new board's
      // latest_event_id on the next loadBoard.
      setBoardData(null);
      cursorRef.current = 0;
      setLoading(true);
      setBoard(nextSlug);
      writeSelectedBoard(nextSlug);
      // Reset filters so stale search/tenant/assignee don't persist across boards.
      setSearch("");
      setTenantFilter("");
      setAssigneeFilter("");
      setIncludeArchived(false);
      clearSelected();
    }, [board, clearSelected]);

    const createNewBoard = useCallback(function (payload) {
      return SDK.fetchJSON(`${API}/boards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then(function (res) {
        loadBoardList();
        const slug = res && res.board && res.board.slug;
        if (slug && payload.switch) switchBoard(slug);
        return res;
      });
    }, [loadBoardList, switchBoard, board]);

    // PATCH board metadata (name / description / default project directory).
    // Refreshes the board list so InlineCreate's workspace defaults pick up
    // the new default_workdir immediately.
    const updateBoard = useCallback(function (slug, payload) {
      return SDK.fetchJSON(`${API}/boards/${encodeURIComponent(slug)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then(function (res) {
        loadBoardList();
        return res;
      });
    }, [loadBoardList]);

    const deleteBoard = useCallback(function (slug) {
      if (!slug || slug === "default") return Promise.resolve();
      return SDK.fetchJSON(`${API}/boards/${encodeURIComponent(slug)}`, {
        method: "DELETE",
      }).then(function () {
        loadBoardList();
        if (board === slug) switchBoard("default");
      });
    }, [board, loadBoardList, switchBoard]);

   const deleteTask = useCallback(function (taskId) {
     if (!window.confirm(tx(t, "trash.confirm", FALLBACK_TRASH.confirm))) return Promise.resolve();
     return SDK.fetchJSON(`${API}/tasks/${encodeURIComponent(taskId)}`, {
       method: "DELETE",
     }).then(function () {
       loadBoard();
       setSelectedIds(function (prev) {
         const next = new Set(prev);
         next.delete(taskId);
         return next;
       });
     }).catch(function (e) { setError(String(e.message || e)); });
   }, [board, loadBoard, t]);

    const deleteSelected = useCallback(function (count) {
      if (selectedIds.size === 0) return Promise.resolve();
      if (!window.confirm(tx(t, "trash.confirmMany", "Permanently delete {n} selected tasks? This cannot be undone.", { n: count }))) return Promise.resolve();
      const ids = Array.from(selectedIds);
      setSelectedIds(new Set());
      return Promise.all(ids.map(function (id) {
        return SDK.fetchJSON(`${API}/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
      })).then(function () {
        loadBoard();
      }).catch(function (e) { setError(String(e.message || e)); });
    }, [selectedIds, board, loadBoard, t]);

    // --- render -------------------------------------------------------------
    if (loading && !boardData) {
      return h("div", { className: "p-8 text-sm text-muted-foreground" },
        tx(t, "loading", "Loading Kanban board…"));
    }
    if (error && !boardData) {
      return h(Card, null,
        h(CardContent, { className: "p-6" },
          h("div", { className: "text-sm text-destructive" },
            tx(t, "loadFailed", "Failed to load Kanban board: "), error),
          h("div", { className: "text-xs text-muted-foreground mt-2" },
            tx(t, "loadFailedHint",
              "The backend auto-creates kanban.db on first read. If this persists, check the dashboard logs.")),
        ),
      );
    }
    if (!filteredBoard) return null;

    const renderMd = !config || config.render_markdown !== false;
    const allTasks = boardData.columns.reduce(function (acc, c) {
      return acc.concat(c.tasks);
    }, []);

    return h(ErrorBoundary, null,
      h("div", { className: "hermes-kanban flex flex-col gap-4" },
        h(BoardSwitcher, {
          board: board,
          boardList: boardList,
          onSwitch: switchBoard,
          onNewClick: function () { setShowNewBoard(true); },
          onSettingsClick: function () { setShowBoardSettings(true); },
          onDeleteBoard: deleteBoard,
        }),
        showNewBoard ? h(NewBoardDialog, {
          onCancel: function () { setShowNewBoard(false); },
          onCreate: function (payload) {
            return createNewBoard(payload).then(function () { setShowNewBoard(false); });
          },
        }) : null,
        showBoardSettings ? h(BoardSettingsDialog, {
          board: boardList.find(function (item) { return item.slug === board; })
            || { slug: board },
          onCancel: function () { setShowBoardSettings(false); },
          onSave: function (payload) {
            return updateBoard(board, payload).then(function () { setShowBoardSettings(false); });
          },
        }) : null,
        h(KanbanViewSwitcher, {
          mode: viewMode,
          onChange: changeViewMode,
        }),
        error ? h("div", { className: "text-xs text-destructive px-2" }, error) : null,
        viewMode === "yard"
          ? h(AgencyYard, {
              board: boardData,
              onOpen: function (task) {
                if (!task) return;
                if (task.board_slug && task.board_slug !== board) {
                  switchBoard(task.board_slug);
                }
                setSelectedTaskId(task.id);
              },
              onRefresh: loadBoard,
            })
          : h(React.Fragment, null,
              h(OrchestrationPanel, null),
              h(AttentionStrip, {
                boardData,
                onOpen: setSelectedTaskId,
              }),
              h(BoardToolbar, {
                board: boardData,
                tenantFilter, setTenantFilter,
                assigneeFilter, setAssigneeFilter,
                includeArchived, setIncludeArchived,
                laneByProfile, setLaneByProfile,
                search, setSearch,
                onNudgeDispatch: function () {
                  SDK.fetchJSON(withBoard(`${API}/dispatch?max=8`, board), { method: "POST" })
                    .then(loadBoard)
                    .catch(function (e) { setError(String(e.message || e)); });
                },
                onRefresh: loadBoard,
              }),
              selectedIds.size > 0 ? h(BulkActionBar, {
                count: selectedIds.size,
                assignees: (boardData && boardData.assignees) || [],
                onApply: applyBulk,
                onClear: clearSelected,
                onSelectAllVisible: selectAllVisible,
                onDelete: deleteSelected,
              }) : null,
              h(BoardColumns, {
                board: filteredBoard,
                boardMeta: boardList.find(function (item) { return item.slug === board; }) || null,
                laneByProfile,
                selectedIds,
                failedIds,
                draggingTaskId,
                onDragStart: handleDragStart,
                onDragEnd: handleDragEnd,
                toggleSelected,
                toggleRange,
                selectAllInColumn,
                onMove: moveTask,
                onMoveSelected: moveSelected,
                onDelete: deleteTask,
                onOpen: setSelectedTaskId,
                onCreate: createTask,
                allTasks,
              }),
            ),
        selectedTaskId ? h(TaskDrawer, {
          taskId: selectedTaskId,
          boardSlug: board,
          onClose: function () { setSelectedTaskId(null); },
          onOpenTask: setSelectedTaskId,
          onRefresh: loadBoard,
          renderMarkdown: renderMd,
          allTasks,
          assignees: (boardData && boardData.assignees) || [],
          eventTick: taskEventTick[selectedTaskId] || 0,
        }) : null,
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Agency yard — a live, truthful staffing map over the same board data.
  //
  // This is deliberately a view, not a second orchestration system. Position
  // comes only from persisted task status, and only ``running`` is described
  // as active work. Clicking the workshop opens the canonical task drawer.
  // -------------------------------------------------------------------------

  const YARD_FOCUS_RANK = {
    supervising: -1,
    running: 0,
    ready: 1,
    review: 2,
    triage: 3,
    todo: 4,
    scheduled: 5,
    blocked: 6,
  };

  function yardOperationalState(task) {
    if (!task) return "idle";
    if (task.status === "blocked" && task.block_kind === "review_required") {
      return "review";
    }
    return task.status;
  }

  function yardPlacementForState(state) {
    if (state === "supervising") return "control";
    if (state === "running") return "mission";
    if (state === "review") return "review";
    if (state === "blocked") return "blocked";
    return "base";
  }

  function KanbanViewSwitcher(props) {
    const setMode = function (mode) {
      if (props.onChange) props.onChange(mode);
    };
    return h("div", {
      className: "hermes-kanban-view-switcher",
      role: "group",
      "aria-label": "Kanban view",
    },
      h("button", {
        type: "button",
        className: cn(
          "hermes-kanban-view-button",
          props.mode === "yard" ? "hermes-kanban-view-button--active" : "",
        ),
        "aria-pressed": props.mode === "yard",
        onClick: function () { setMode("yard"); },
      },
        h("span", { className: "hermes-kanban-view-icon", "aria-hidden": "true" }, "⌂"),
        "Agency yard",
      ),
      h("button", {
        type: "button",
        className: cn(
          "hermes-kanban-view-button",
          props.mode === "board" ? "hermes-kanban-view-button--active" : "",
        ),
        "aria-pressed": props.mode === "board",
        onClick: function () { setMode("board"); },
      },
        h("span", { className: "hermes-kanban-view-icon", "aria-hidden": "true" }, "▦"),
        "Board",
      ),
    );
  }

  function yardInitials(name) {
    const pieces = String(name || "?").split(/[-_\s]+/).filter(Boolean);
    if (pieces.length === 0) return "?";
    if (pieces.length === 1) return pieces[0].slice(0, 2).toUpperCase();
    return (pieces[0][0] + pieces[pieces.length - 1][0]).toUpperCase();
  }

  function yardTaskSort(a, b) {
    const stateA = yardOperationalState(a);
    const stateB = yardOperationalState(b);
    const rankA = YARD_FOCUS_RANK[stateA] == null ? 99 : YARD_FOCUS_RANK[stateA];
    const rankB = YARD_FOCUS_RANK[stateB] == null ? 99 : YARD_FOCUS_RANK[stateB];
    if (rankA !== rankB) return rankA - rankB;
    if ((a.priority || 0) !== (b.priority || 0)) return (b.priority || 0) - (a.priority || 0);
    return (b.created_at || 0) - (a.created_at || 0);
  }

  function buildYardRoster(board, profiles) {
    const openTasks = [];
    for (const column of (board && board.columns) || []) {
      for (const task of column.tasks || []) {
        if (task.status !== "done" && task.status !== "archived") openTasks.push(task);
      }
    }

    const profileByName = {};
    const controllerByName = {};
    const names = new Set();
    for (const profile of profiles || []) {
      profileByName[profile.name] = profile;
      names.add(profile.name);
    }
    for (const controller of (board && board.controllers) || []) {
      if (!controller || !controller.profile) continue;
      controllerByName[controller.profile] = controller;
      names.add(controller.profile);
    }

    const tasksByName = {};
    for (const task of openTasks) {
      if (!task.assignee) continue;
      names.add(task.assignee);
      (tasksByName[task.assignee] = tasksByName[task.assignee] || []).push(task);
    }

    const rows = Array.from(names).map(function (name) {
      const tasks = (tasksByName[name] || []).slice().sort(yardTaskSort);
      const focus = tasks[0] || null;
      const controller = controllerByName[name] || null;
      const state = controller && controller.state === "running"
        ? "supervising"
        : yardOperationalState(focus);
      return {
        name,
        profile: profileByName[name] || null,
        controller,
        agency: yardAgency(profileByName[name] || null),
        focus,
        state,
        placement: yardPlacementForState(state),
        openCount: tasks.length,
      };
    });

    rows.sort(function (a, b) {
      const rankA = YARD_FOCUS_RANK[a.state] == null ? 98 : YARD_FOCUS_RANK[a.state];
      const rankB = YARD_FOCUS_RANK[b.state] == null ? 98 : YARD_FOCUS_RANK[b.state];
      if (rankA !== rankB) return rankA - rankB;
      const priorityA = a.focus ? (a.focus.priority || 0) : 0;
      const priorityB = b.focus ? (b.focus.priority || 0) : 0;
      if (priorityA !== priorityB) return priorityB - priorityA;
      return a.name.localeCompare(b.name);
    });

    return { rows, openTasks };
  }

  function YardMetric(props) {
    return h("div", { className: cn("hermes-yard-metric", `hermes-yard-metric--${props.tone}`) },
      h("span", { className: "hermes-yard-metric-value" }, props.value),
      h("span", { className: "hermes-yard-metric-label" }, props.label),
    );
  }

  function agencyHealthSignalLabel(signal) {
    if (signal === "improving") return "improving";
    if (signal === "regressing") return "worsening";
    if (signal === "steady") return "flat";
    return "baseline";
  }

  function agencyHealthValue(value, unit) {
    if (value == null) return "—";
    if (unit === "%") return `${value}%`;
    if (unit === "m") return `${value}m`;
    return String(value);
  }

  function AgencyHealthMetric(props) {
    const direction = agencyHealthSignalLabel(props.signal);
    return h("div", {
      className: cn(
        "hermes-agency-health-metric",
        `hermes-agency-health-metric--${props.signal || "insufficient"}`,
      ),
      title: props.title || "",
    },
      h("div", { className: "hermes-agency-health-metric-label" }, props.label),
      h("div", { className: "hermes-agency-health-metric-reading" },
        h("strong", null, agencyHealthValue(props.value, props.unit)),
        h("span", null, direction),
      ),
      h("div", { className: "hermes-agency-health-metric-compare" },
        `prior ${agencyHealthValue(props.previous, props.unit)}`,
      ),
    );
  }

  function agencyHealthVerdict(health) {
    if (!health) return "Loading durable agency receipts…";
    const signals = health.signals || {};
    if (signals.failure_rate === "improving" &&
        signals.intervention_rate === "regressing") {
      return "Execution faults are falling, but intervention load is rising.";
    }
    if (signals.failure_rate === "regressing" &&
        signals.intervention_rate === "improving") {
      return "Manual load is falling, but execution reliability has regressed.";
    }
    if (health.trend === "improving") {
      return "The agency is getting more reliable at its current throughput.";
    }
    if (health.trend === "regressing") {
      return "The agency needs more rescue work than in the preceding window.";
    }
    if (health.trend === "mixed") {
      return "Some reliability signals improved while others regressed.";
    }
    if (health.trend === "steady") {
      return "Reliability is flat; no learning trend is proven yet.";
    }
    return "Collecting enough comparable runs to establish a baseline.";
  }

  function AgencyHealthPanel(props) {
    const health = props.health;
    if (!health) {
      return h("section", {
        className: "hermes-agency-health hermes-agency-health--loading",
        "aria-label": "Agency reliability trend loading",
      }, "Reading the agency incident ledger…");
    }
    const current = health.current || {};
    const previous = health.previous || {};
    const signals = health.signals || {};
    const daily = health.daily || [];
    const dailyMax = Math.max(1, ...daily.map(function (day) {
      return Math.max(
        day.failure_rate_per_10 || 0,
        day.interventions_per_10 || 0,
      );
    }));
    const recoverySignal = (
      current.median_recovery_minutes == null ||
      previous.median_recovery_minutes == null
    ) ? "insufficient" : (
      current.median_recovery_minutes < previous.median_recovery_minutes - 5
        ? "improving"
        : current.median_recovery_minutes > previous.median_recovery_minutes + 5
          ? "regressing"
          : "steady"
    );
    const coverage = health.coverage || {};
    const windowLabel = `rolling ${health.window_hours || 24}h`;

    return h("section", {
      className: cn(
        "hermes-agency-health",
        `hermes-agency-health--${health.trend || "collecting_baseline"}`,
      ),
      "aria-labelledby": "agency-health-title",
    },
      h("div", { className: "hermes-agency-health-head" },
        h("div", null,
          h("div", { className: "hermes-agency-health-kicker" },
            "SELF-IMPROVEMENT · ", windowLabel.toUpperCase(),
          ),
          h("h3", { id: "agency-health-title" }, agencyHealthVerdict(health)),
        ),
        h("span", {
          className: cn(
            "hermes-agency-health-verdict",
            `is-${health.trend || "collecting_baseline"}`,
          ),
        }, String(health.trend || "collecting baseline").replaceAll("_", " ")),
      ),
      h("div", { className: "hermes-agency-health-grid" },
        h(AgencyHealthMetric, {
          label: "execution faults / 10",
          value: current.failure_rate_per_10,
          previous: previous.failure_rate_per_10,
          signal: signals.failure_rate,
          title: "Failed worker attempts divided by completed plus failed attempts. Review handoffs are excluded.",
        }),
        h(AgencyHealthMetric, {
          label: "interventions / 10",
          value: current.interventions_per_10,
          previous: previous.interventions_per_10,
          signal: signals.intervention_rate,
          title: coverage.manual_intervention_definition,
        }),
        h(AgencyHealthMetric, {
          label: "repeat faults",
          value: current.repeat_failure_rate,
          previous: previous.repeat_failure_rate,
          signal: signals.repeat_failure_rate,
          unit: "%",
          title: "Share of failed attempts that repeated inside the same unresolved incident episode.",
        }),
        h(AgencyHealthMetric, {
          label: "median recovery",
          value: current.median_recovery_minutes,
          previous: previous.median_recovery_minutes,
          signal: recoverySignal,
          unit: "m",
          title: "Median time from the first failed attempt in an episode to the next completed run.",
        }),
      ),
      h("div", { className: "hermes-agency-health-lower" },
        h("div", {
          className: "hermes-agency-health-chart",
          role: "img",
          "aria-label": "Daily execution faults and explicit interventions per ten decisive runs",
        },
          daily.map(function (day) {
            const faultHeight = Math.round(
              ((day.failure_rate_per_10 || 0) / dailyMax) * 100,
            );
            const interventionHeight = Math.round(
              ((day.interventions_per_10 || 0) / dailyMax) * 100,
            );
            return h("div", {
              className: "hermes-agency-health-day",
              key: day.date,
              title: `${day.date}: ${day.failure_rate_per_10 == null ? "—" : day.failure_rate_per_10} faults and ${day.interventions_per_10 == null ? "—" : day.interventions_per_10} interventions per 10`,
            },
              h("div", { className: "hermes-agency-health-bars" },
                h("i", {
                  className: "is-fault",
                  style: { height: `${faultHeight}%` },
                }),
                h("i", {
                  className: "is-intervention",
                  style: { height: `${interventionHeight}%` },
                }),
              ),
              h("span", null, day.date.slice(5)),
            );
          }),
        ),
        h("div", { className: "hermes-agency-health-details" },
          h("div", null,
            h("strong", null, `${current.completed_runs || 0} completed`),
            h("span", null, `${current.failed_runs || 0} failed attempts`),
          ),
          h("div", null,
            h("strong", null, `${current.explicit_interventions || 0} explicit interventions`),
            h("span", null, `${current.block_loops || 0} block loops · ${current.controller_failures || 0} controller faults`),
          ),
          h("div", null,
            h("strong", null,
              current.autonomous_recovery_rate == null
                ? "Recovery baseline pending"
                : `${current.autonomous_recovery_rate}% autonomous recovery`,
            ),
            h("span", null,
              `${current.unrecovered_episodes || 0} unresolved incident episodes`,
            ),
          ),
          h("div", null,
            h("strong", null,
              coverage.status === "ready"
                ? `${coverage.active_days} active days captured`
                : `Partial baseline · ${coverage.active_days || 0}/${coverage.requested_days || 7} active days`,
            ),
            h("span", {
              title: coverage.manual_intervention_definition || "",
            }, "Exact board receipts only; code-only repairs are not backfilled."),
          ),
        ),
      ),
      h("div", { className: "hermes-agency-health-legend" },
        h("span", null, h("i", { className: "is-fault" }), "Execution faults / 10"),
        h("span", null, h("i", { className: "is-intervention" }), "Explicit interventions / 10"),
        h("strong", null, "Lower is better. Review-required handoffs are not errors."),
      ),
    );
  }

  function yardMissionTitle(task) {
    const raw = String((task && task.title) || "Untitled mission");
    return raw
      .replace(/^(Phosphene|Portfolio(?: Lab)?|Agency|Hermes|Control-plane)\s+/i, "")
      .replace(/^(review|correction|publication|implementation|reproduction|evidence|mission implementation|current-source integration|current-base integration):\s*/i, "")
      .trim();
  }

  function yardTaskMissionKey(task, graphRoot) {
    const title = String(task.title || "");
    const body = String(task.body || "");
    // A PR mention in explanatory prose is not mission identity. Only the
    // visible title or an anchored machine-readable field may group cards.
    const pr = /\bPR\s*#(\d+)\b/i.exec(title) ||
      /\b(?:existing_)?pr_number:\s*#?(\d+)\b/i.exec(body);
    if (pr) return `pr:${pr[1]}`;
    const mission = /\bproduct_mission_id:\s*([a-z0-9._-]+)/i.exec(body);
    if (mission) return `mission:${mission[1]}`;
    return `graph:${graphRoot || task.id}`;
  }

  function yardGraphTaskKey(task) {
    return task.board_slug ? `${task.board_slug}:${task.id}` : task.id;
  }

  function buildYardScene(board, profiles) {
    const roster = buildYardRoster(board, profiles);
    const allTasks = [];
    for (const column of (board && board.columns) || []) {
      for (const task of column.tasks || []) allTasks.push(task);
    }
    const taskById = {};
    const parent = {};
    for (const task of allTasks) {
      const taskKey = yardGraphTaskKey(task);
      taskById[taskKey] = task;
      parent[taskKey] = taskKey;
    }
    const openIds = new Set(roster.openTasks.map(yardGraphTaskKey));
    const find = function (id) {
      let root = id;
      while (parent[root] && parent[root] !== root) root = parent[root];
      let cursor = id;
      while (parent[cursor] && parent[cursor] !== cursor) {
        const next = parent[cursor];
        parent[cursor] = root;
        cursor = next;
      }
      return root;
    };
    const union = function (left, right) {
      if (!taskById[left] || !taskById[right]) return;
      // One-hop terminal stages may connect two current assignments, but a
      // purely historical edge must not collapse the whole archive into one
      // giant mission.
      if (!openIds.has(left) && !openIds.has(right)) return;
      const a = find(left);
      const b = find(right);
      if (a !== b) parent[b] = a;
    };
    const graph = (board && board.graph) || {};
    for (const link of graph.links || []) union(link.parent_id, link.child_id);
    for (const relation of graph.relations || []) {
      union(relation.source_task_id, relation.target_task_id);
    }

    const missionByKey = {};
    for (const task of roster.openTasks) {
      const key = yardTaskMissionKey(task, find(yardGraphTaskKey(task)));
      const mission = missionByKey[key] || {
        id: key,
        tasks: [],
        agents: [],
      };
      mission.tasks.push(task);
      missionByKey[key] = mission;
    }

    for (const row of roster.rows) {
      if (!row.focus || row.placement !== "mission") continue;
      const key = yardTaskMissionKey(row.focus, find(yardGraphTaskKey(row.focus)));
      if (missionByKey[key]) missionByKey[key].agents.push(row);
    }

    const rosterByName = {};
    for (const row of roster.rows) rosterByName[row.name] = row;
    const missions = Object.values(missionByKey).map(function (mission) {
      const sortedTasks = mission.tasks.slice().sort(yardTaskSort);
      const anchor = sortedTasks[0];
      const agencyKeys = Array.from(new Set(mission.tasks.map(function (task) {
        const owner = task.assignee ? rosterByName[task.assignee] : null;
        return owner ? owner.agency.key : "unassigned";
      })));
      return Object.assign(mission, {
        anchor,
        status: yardOperationalState(anchor),
        title: yardMissionTitle(anchor),
        priority: anchor ? (anchor.priority || 0) : 0,
        agencyKeys,
      });
    }).sort(function (a, b) {
      const withPeopleA = a.agents.length > 0 ? 0 : 1;
      const withPeopleB = b.agents.length > 0 ? 0 : 1;
      if (withPeopleA !== withPeopleB) return withPeopleA - withPeopleB;
      const rankA = YARD_FOCUS_RANK[a.status] == null ? 99 : YARD_FOCUS_RANK[a.status];
      const rankB = YARD_FOCUS_RANK[b.status] == null ? 99 : YARD_FOCUS_RANK[b.status];
      if (rankA !== rankB) return rankA - rankB;
      return b.priority - a.priority;
    });

    const reviewTasks = roster.openTasks.filter(function (task) {
      return yardOperationalState(task) === "review";
    });
    const blockedTasks = roster.openTasks.filter(function (task) {
      return yardOperationalState(task) === "blocked";
    });
    const fieldMissions = missions.filter(function (mission) {
      return mission.status !== "review" && mission.status !== "blocked";
    });

    // The floor is for work that is executing now or can be picked up next.
    // Review handoffs and genuine blockers have their own shared operational
    // zones, so they cannot flood the field with identical red missions.
    const visibleMissions = [];
    const representedMissionIds = new Set();
    for (const agencyKey of ["development", "marketing", "unassigned"]) {
      const candidate = fieldMissions.find(function (mission) {
        return mission.agencyKeys.includes(agencyKey);
      });
      if (candidate) {
        visibleMissions.push(candidate);
        representedMissionIds.add(candidate.id);
      }
    }
    for (const mission of fieldMissions) {
      if (visibleMissions.length >= 6) break;
      if (representedMissionIds.has(mission.id)) continue;
      visibleMissions.push(mission);
      representedMissionIds.add(mission.id);
    }
    if (fieldMissions.length > visibleMissions.length) {
      const overflowMissions = fieldMissions.filter(function (mission) {
        return !representedMissionIds.has(mission.id);
      });
      const overflowTasks = [];
      const overflowAgents = [];
      for (const mission of overflowMissions) {
        overflowTasks.push.apply(overflowTasks, mission.tasks);
        overflowAgents.push.apply(overflowAgents, mission.agents);
      }
      visibleMissions.push({
        id: "mission:overflow",
        title: `${overflowMissions.length} other workstreams`,
        status: "todo",
        priority: 0,
        tasks: overflowTasks,
        agents: overflowAgents,
        anchor: overflowTasks.slice().sort(yardTaskSort)[0] || null,
        overflowCount: overflowMissions.length,
        agencyKeys: Array.from(new Set(overflowMissions.flatMap(function (mission) {
          return mission.agencyKeys;
        }))),
      });
    }

    const basesByKey = {};
    for (const row of roster.rows) {
      const base = basesByKey[row.agency.key] || {
        agency: row.agency,
        rows: [],
        idleAgents: [],
        residentAgents: [],
      };
      base.rows.push(row);
      if (!row.focus) base.idleAgents.push(row);
      if (row.placement === "base") base.residentAgents.push(row);
      basesByKey[row.agency.key] = base;
    }
    const baseOrder = { development: 0, marketing: 1, unassigned: 2 };
    const bases = Object.values(basesByKey).sort(function (a, b) {
      return (baseOrder[a.agency.key] == null ? 99 : baseOrder[a.agency.key]) -
        (baseOrder[b.agency.key] == null ? 99 : baseOrder[b.agency.key]);
    });

    const blockedCauseCounts = {};
    for (const task of blockedTasks) {
      const cause = task.block_kind || "unclassified";
      blockedCauseCounts[cause] = (blockedCauseCounts[cause] || 0) + 1;
    }
    const docks = [
      {
        key: "control",
        kind: "control",
        label: "Control Room",
        shortLabel: "SUPERVISING",
        state: "supervising",
        note: "Lead and Operator coordinating the agency control plane",
        tasks: [],
        agents: roster.rows.filter(function (row) {
          return row.placement === "control";
        }),
        causeCounts: {},
      },
      {
        key: "review",
        label: "Review Gate",
        shortLabel: "WAITING REVIEW",
        state: "review",
        note: "Handoffs awaiting independent review",
        tasks: reviewTasks,
        agents: roster.rows.filter(function (row) { return row.placement === "review"; }),
        causeCounts: { review_required: reviewTasks.length },
      },
      {
        key: "blocked",
        label: "Blocked Dock",
        shortLabel: "NEEDS ACTION",
        state: "blocked",
        note: "Input, capability, or recovery required",
        tasks: blockedTasks,
        agents: roster.rows.filter(function (row) { return row.placement === "blocked"; }),
        causeCounts: blockedCauseCounts,
      },
    ].filter(function (dock) {
      return dock.tasks.length > 0 || dock.agents.length > 0;
    });

    return {
      roster,
      missions: visibleMissions,
      idleAgents: roster.rows.filter(function (row) { return !row.focus; }),
      bases,
      docks,
      reviewTaskCount: reviewTasks.length,
      blockedTaskCount: blockedTasks.length,
      fieldMissionCount: fieldMissions.length,
      totalMissionCount: missions.length,
    };
  }

  const YARD_CANVAS_COLORS = {
    ink: "#0a1d25",
    deep: "#0f2934",
    blue: "#2d6c82",
    mint: "#55d6a3",
    amber: "#f4b942",
    coral: "#f06a5b",
    fog: "#eaf0ec",
    muted: "#78909a",
    review: "#75aef0",
    control: "#56c7dd",
    triage: "#b792da",
    marketing: "#d89bff",
    unassigned: "#94a3ad",
  };

  const YARD_AGENCIES = {
    development: {
      key: "development",
      label: "Developer Base",
      shortLabel: "DEV BASE",
      color: YARD_CANVAS_COLORS.review,
    },
    marketing: {
      key: "marketing",
      label: "Marketing Base",
      shortLabel: "MARKETING BASE",
      color: YARD_CANVAS_COLORS.marketing,
    },
    unassigned: {
      key: "unassigned",
      label: "Unassigned Base",
      shortLabel: "UNASSIGNED",
      color: YARD_CANVAS_COLORS.unassigned,
    },
  };

  function yardAgency(profile) {
    const key = String((profile && profile.agency) || "").trim().toLowerCase();
    return YARD_AGENCIES[key] || Object.assign({}, YARD_AGENCIES.unassigned, {
      key: key || "unassigned",
      label: key ? `${key.replace(/[-_]+/g, " ")} Base` : "Unassigned Base",
      shortLabel: key ? key.replace(/[-_]+/g, " ").toUpperCase() : "UNASSIGNED",
    });
  }

  function yardStateColor(status) {
    if (status === "supervising") return YARD_CANVAS_COLORS.control;
    if (status === "running") return YARD_CANVAS_COLORS.mint;
    if (status === "ready") return YARD_CANVAS_COLORS.amber;
    if (status === "blocked") return YARD_CANVAS_COLORS.coral;
    if (status === "review") return YARD_CANVAS_COLORS.review;
    if (status === "triage") return YARD_CANVAS_COLORS.triage;
    return YARD_CANVAS_COLORS.muted;
  }

  function yardRoundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function yardHexagon(ctx, x, y, radius) {
    ctx.beginPath();
    for (let i = 0; i < 6; i += 1) {
      const angle = Math.PI / 3 * i - Math.PI / 6;
      const px = x + Math.cos(angle) * radius;
      const py = y + Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  function yardDrawWrapped(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
        if (lines.length >= maxLines) break;
      }
    }
    if (line && lines.length < maxLines) lines.push(line);
    if (lines.length === maxLines && words.length > lines.join(" ").split(/\s+/).length) {
      lines[maxLines - 1] = lines[maxLines - 1].replace(/[.,;:]?$/, "…");
    }
    lines.forEach(function (value, index) {
      ctx.fillText(value, x, y + index * lineHeight);
    });
  }

  function yardDrawBase(ctx, x, y, base) {
    const color = base.agency.color;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.2;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-46, -6);
    ctx.lineTo(0, -48);
    ctx.lineTo(46, -6);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 0.78;
    ctx.stroke();
    yardRoundedRect(ctx, -37, -6, 74, 62, 6);
    ctx.fillStyle = "rgba(15,41,52,0.92)";
    ctx.globalAlpha = 1;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.62;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    yardRoundedRect(ctx, -27, 9, 54, 16, 4);
    ctx.globalAlpha = 0.16;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.font = "750 7px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText(base.agency.shortLabel, 0, 20);
    ctx.fillStyle = YARD_CANVAS_COLORS.fog;
    ctx.font = "700 10px ui-monospace, monospace";
    ctx.fillText(base.agency.label.toUpperCase(), 0, 76);
    ctx.fillStyle = "rgba(234,240,236,0.52)";
    ctx.font = "500 9px ui-monospace, monospace";
    ctx.fillText(
      `${base.residentAgents.length} here · ${base.rows.length} rostered`,
      0,
      91,
    );
    ctx.restore();
  }

  function yardDrawDock(ctx, x, y, dock) {
    const color = yardStateColor(dock.state);
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.82;
    yardRoundedRect(ctx, -49, -29, 98, 58, 9);
    ctx.fillStyle = "rgba(10,29,37,0.94)";
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = 0.15;
    ctx.fillStyle = color;
    yardRoundedRect(ctx, -43, -23, 86, 46, 6);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.font = "800 8px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText(dock.shortLabel, 0, -6);
    ctx.fillStyle = YARD_CANVAS_COLORS.fog;
    ctx.font = "780 17px ui-monospace, monospace";
    ctx.fillText(
      String(dock.kind === "control" ? dock.agents.length : dock.tasks.length),
      0,
      15,
    );
    ctx.fillStyle = YARD_CANVAS_COLORS.fog;
    ctx.font = "700 10px ui-monospace, monospace";
    ctx.fillText(dock.label.toUpperCase(), 0, 47);
    ctx.fillStyle = "rgba(234,240,236,0.5)";
    ctx.font = "500 7px ui-monospace, monospace";
    yardDrawWrapped(ctx, dock.note, 0, 60, 135, 9, 2);
    ctx.restore();
  }

  function yardDrawAgent(ctx, agent, x, y, selected, phase, labelMode) {
    const color = yardStateColor(agent.state);
    const moving = agent.state === "running" || agent.state === "supervising";
    const bob = moving ? Math.sin(phase * 3 + x * 0.01) * 2 : 0;
    const drawY = y + bob;
    ctx.save();
    if (selected) {
      ctx.strokeStyle = YARD_CANVAS_COLORS.fog;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, drawY, 19, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(6,18,22,0.72)";
    ctx.beginPath();
    ctx.ellipse(x, drawY + 17, 12, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(255,255,255,0.46)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, drawY - 8, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    yardRoundedRect(ctx, x - 10, drawY - 1, 20, 20, 7);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.font = "700 7px ui-monospace, monospace";
    ctx.fillText(yardInitials(agent.name), x, drawY + 12);
    ctx.fillStyle = YARD_CANVAS_COLORS.fog;
    ctx.font = "600 9px ui-monospace, monospace";
    const shortName = agent.name.length > 16 ? agent.name.slice(0, 14) + "…" : agent.name;
    if (labelMode === "list") {
      ctx.textAlign = "left";
      ctx.fillText("@" + shortName, x + 18, drawY + 5);
    } else if (labelMode === "above") {
      ctx.fillText("@" + shortName, x, drawY - 22);
    } else {
      ctx.fillText("@" + shortName, x, drawY + 34);
    }
    ctx.restore();
  }

  function yardDrawMission(ctx, mission, x, y, keyboardSelected, phase) {
    const color = yardStateColor(mission.status);
    const pulse = mission.status === "running" ? 5 + Math.sin(phase * 2.5) * 3 : 3;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = keyboardSelected ? 18 : pulse;
    yardHexagon(ctx, x, y, 38);
    ctx.fillStyle = "rgba(10,29,37,0.96)";
    ctx.fill();
    ctx.lineWidth = keyboardSelected ? 3 : 2;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(x, y, 19, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.18;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(234,240,236,0.56)";
    ctx.textAlign = "center";
    ctx.font = "700 8px ui-monospace, monospace";
    ctx.fillText(
      mission.overflowCount ? "BACKLOG HUB" : `${mission.tasks.length} TASK${mission.tasks.length === 1 ? "" : "S"}`,
      x,
      y - 49,
    );
    ctx.fillStyle = YARD_CANVAS_COLORS.fog;
    ctx.font = "650 11px ui-sans-serif, system-ui, sans-serif";
    yardDrawWrapped(ctx, mission.title, x, y + 57, 145, 14, 3);
    ctx.fillStyle = color;
    ctx.font = "700 8px ui-monospace, monospace";
    ctx.fillText(yardStatusLabel(mission.status).toUpperCase(), x, y + 103);
    ctx.restore();
  }

  function yardCanvasLayout(width, missionCount, bases, docks) {
    const compact = width < 680;
    const columns = compact ? 1 : (width < 900 ? 2 : 3);
    const fieldLeft = compact ? 26 : 196;
    const fieldRight = 34;
    const usable = Math.max(240, width - fieldLeft - fieldRight);
    const columnWidth = usable / columns;
    const rows = Math.max(1, Math.ceil(missionCount / columns));
    const rowHeight = compact ? 230 : 218;
    const baseStackHeight = (bases || []).reduce(function (height, base) {
      return height + 128 + base.residentAgents.length * 32;
    }, (docks || []).reduce(function (height, dock) {
      return height + 116 + dock.agents.length * 32;
    }, 18));
    const top = compact ? baseStackHeight + 54 : 108;
    const missionHeight = top + rows * rowHeight + 88;
    const height = compact
      ? missionHeight
      : Math.max(missionHeight, baseStackHeight + 58);
    return {
      compact,
      columns,
      fieldLeft,
      columnWidth,
      rowHeight,
      top,
      height,
      baseStackHeight,
    };
  }

  function yardStatusLabel(status) {
    const labels = {
      supervising: "Supervising now",
      running: "Running now",
      ready: "Ready to dispatch",
      review: "Waiting for review",
      blocked: "Needs action",
      triage: "Needs shaping",
      todo: "Waiting",
      scheduled: "Scheduled",
      idle: "Available",
    };
    return labels[status] || String(status || "Unknown");
  }

  function yardBlockCauseLabel(kind) {
    const labels = {
      review_required: "Review required",
      needs_input: "Needs input",
      capability: "Capability missing",
      transient: "Transient failure",
      unclassified: "Unclassified",
    };
    return labels[kind] || String(kind || "Unclassified").replace(/_/g, " ");
  }

  function YardTooltipStatus(props) {
    return h("span", {
      className: "hermes-canvas-tooltip-status",
      style: { "--tooltip-status": yardStateColor(props.status) },
    }, yardStatusLabel(props.status));
  }

  function AgencyHoverInspector(props) {
    const hover = props.hover;
    if (!hover) return null;
    const tone = hover.type === "agent"
      ? yardStateColor(hover.agent.state)
      : hover.type === "dock"
        ? yardStateColor(hover.dock.state)
        : yardStateColor(hover.mission.status);
    const style = {
      left: hover.left + "px",
      top: hover.top + "px",
      width: hover.width + "px",
      "--tooltip-tone": tone,
    };

    if (hover.type === "agent") {
      const agent = hover.agent;
      const profile = agent.profile || {};
      const focus = agent.focus;
      const modelLine = [profile.provider, profile.model].filter(Boolean).join(" · ");
      return h("aside", {
        className: "hermes-canvas-tooltip hermes-canvas-tooltip--agent",
        role: "tooltip",
        style,
      },
        h("div", { className: "hermes-canvas-tooltip-head" },
          h("div", { className: "hermes-canvas-tooltip-avatar", "aria-hidden": "true" },
            yardInitials(agent.name)),
          h("div", { className: "hermes-canvas-tooltip-heading" },
            h("span", { className: "hermes-canvas-tooltip-kicker" },
              agent.controller && agent.state === "supervising"
                ? "CONTROL ROOM · " + agent.controller.role.toUpperCase()
                : agent.agency.label.toUpperCase() + " · AGENT"),
            h("strong", null, "@" + agent.name),
          ),
          h(YardTooltipStatus, { status: agent.state }),
        ),
        modelLine
          ? h("div", { className: "hermes-canvas-tooltip-model" }, modelLine)
          : null,
        profile.description
          ? h("p", { className: "hermes-canvas-tooltip-description" }, profile.description)
          : h("p", { className: "hermes-canvas-tooltip-description is-muted" },
              "No profile description is recorded for this agent."),
        h("div", { className: "hermes-canvas-tooltip-facts" },
          h("span", null,
            h("small", null, "OPEN ASSIGNMENTS"),
            h("strong", null, String(agent.openCount || 0)),
          ),
          h("span", null,
            h("small", null, "LOADED SKILLS"),
            h("strong", null, String(profile.skill_count || 0)),
          ),
          h("span", null,
            h("small", null, "HOME BASE"),
            h("strong", null, agent.agency.label),
          ),
        ),
        agent.controller && agent.state === "supervising"
          ? h("div", { className: "hermes-canvas-tooltip-current" },
              h("span", { className: "hermes-canvas-tooltip-section-label" },
                "CURRENT CONTROL DUTY"),
              h("strong", null, agent.controller.role),
              h("code", null,
                `${agent.controller.job_id} · ${agent.controller.latest_execution && agent.controller.latest_execution.started_at
                  ? agent.controller.latest_execution.started_at
                  : "claimed"}`),
            )
          : focus
          ? h("div", { className: "hermes-canvas-tooltip-current" },
              h("span", { className: "hermes-canvas-tooltip-section-label" },
                "CURRENT ASSIGNMENT"),
              h("strong", null, focus.title || "Untitled task"),
              h("code", null,
                `${focus.board_name ? focus.board_name + " · " : ""}${focus.id} · P${focus.priority || 0}`),
            )
          : h("div", { className: "hermes-canvas-tooltip-current is-idle" },
              `No open assignment. This agent is at ${agent.agency.label}.`),
      );
    }

    if (hover.type === "dock") {
      const dock = hover.dock;
      const causes = Object.entries(dock.causeCounts || {}).sort(function (a, b) {
        return b[1] - a[1];
      });
      return h("aside", {
        className: "hermes-canvas-tooltip hermes-canvas-tooltip--mission",
        role: "tooltip",
        style,
      },
        h("div", { className: "hermes-canvas-tooltip-head" },
          h("div", { className: "hermes-canvas-tooltip-heading" },
            h("span", { className: "hermes-canvas-tooltip-kicker" }, "SHARED OPERATIONS ZONE"),
            h("strong", null, dock.label),
          ),
          h(YardTooltipStatus, { status: dock.state }),
        ),
        h("p", { className: "hermes-canvas-tooltip-description" }, dock.note + "."),
        h("div", { className: "hermes-canvas-tooltip-facts" },
          h("span", null,
            h("small", null, dock.kind === "control" ? "CONTROLLERS" : "CARDS"),
            h("strong", null, String(
              dock.kind === "control" ? dock.agents.length : dock.tasks.length
            )),
          ),
          h("span", null,
            h("small", null, "AGENTS HERE"),
            h("strong", null, String(dock.agents.length)),
          ),
          h("span", null,
            h("small", null, "EXECUTING"),
            h("strong", null, "0"),
          ),
        ),
        causes.length
          ? h("div", { className: "hermes-canvas-tooltip-task-list" },
              h("span", { className: "hermes-canvas-tooltip-section-label" }, "WHY THEY ARE HERE"),
              causes.map(function (entry) {
                return h("div", {
                  className: "hermes-canvas-tooltip-task",
                  key: entry[0],
                },
                  h("i", { style: { "--task-tone": tone } }),
                  h("span", null,
                    h("strong", null, yardBlockCauseLabel(entry[0])),
                    h("code", null, `${entry[1]} card${entry[1] === 1 ? "" : "s"}`),
                  ),
                );
              }),
            )
          : null,
        dock.agents.length
          ? h("div", { className: "hermes-canvas-tooltip-agents" },
              dock.agents.map(function (agent) {
                return h("span", {
                  key: agent.name,
                  style: { "--agent-tone": tone },
                }, "@" + agent.name);
              }),
            )
          : null,
        h("div", { className: "hermes-canvas-tooltip-foot" },
          dock.kind === "control"
            ? "These controllers coordinate or repair the agency; they are active, but are not product workers."
            : dock.state === "review"
            ? "These agents are waiting on a review handoff; they are not executing now."
            : "These agents need intervention or recovery; they are not executing now."),
      );
    }

    const mission = hover.mission;
    const tasks = (mission.tasks || []).slice().sort(yardTaskSort);
    const agents = mission.agents || [];
    const missionIdentity = mission.id.startsWith("pr:")
      ? `PR #${mission.id.slice(3)}`
      : mission.id.startsWith("mission:")
        ? mission.id.slice(8)
        : "Linked task group";
    const missionLabel = mission.anchor && mission.anchor.board_name
      ? `${mission.anchor.board_name} · ${missionIdentity}`
      : missionIdentity;
    return h("aside", {
      className: "hermes-canvas-tooltip hermes-canvas-tooltip--mission",
      role: "tooltip",
      style,
    },
      h("div", { className: "hermes-canvas-tooltip-head" },
        h("div", { className: "hermes-canvas-tooltip-heading" },
          h("span", { className: "hermes-canvas-tooltip-kicker" }, missionLabel),
          h("strong", null, mission.anchor ? mission.anchor.title : mission.title),
        ),
        h(YardTooltipStatus, { status: mission.status }),
      ),
      h("div", { className: "hermes-canvas-tooltip-facts" },
        h("span", null,
          h("small", null, "CARDS"),
          h("strong", null, String(tasks.length)),
        ),
        h("span", null,
          h("small", null, "AGENTS"),
          h("strong", null, String(agents.length)),
        ),
        h("span", null,
          h("small", null, "LEAD PRIORITY"),
          h("strong", null, "P" + String(mission.priority || 0)),
        ),
      ),
      agents.length
        ? h("div", { className: "hermes-canvas-tooltip-agents" },
            agents.map(function (agent) {
              return h("span", {
                key: agent.name,
                style: { "--agent-tone": yardStateColor(agent.state) },
              }, "@" + agent.name);
            }),
          )
        : h("p", { className: "hermes-canvas-tooltip-description is-muted" },
            "No agent currently owns an open card in this mission."),
      h("div", { className: "hermes-canvas-tooltip-task-list" },
        h("span", { className: "hermes-canvas-tooltip-section-label" },
          "RELATED CARDS"),
        tasks.slice(0, 4).map(function (task) {
          const taskState = yardOperationalState(task);
          return h("div", { className: "hermes-canvas-tooltip-task", key: task.id },
            h("i", { style: { "--task-tone": yardStateColor(taskState) } }),
            h("span", null,
              h("strong", null, task.title || "Untitled task"),
              h("code", null, `${task.id} · ${yardStatusLabel(taskState)}`),
            ),
          );
        }),
        tasks.length > 4
          ? h("small", { className: "hermes-canvas-tooltip-more" },
              `+${tasks.length - 4} more related card${tasks.length - 4 === 1 ? "" : "s"}`)
          : null,
      ),
      h("div", { className: "hermes-canvas-tooltip-foot" },
        "Click the mission to open its leading card."),
    );
  }

  function AgencyCanvas(props) {
    const canvasRef = useRef(null);
    const wrapRef = useRef(null);
    const hitRef = useRef([]);
    const [width, setWidth] = useState(0);
    const [selectedAgents, setSelectedAgents] = useState(function () { return new Set(); });
    const [keyboardMission, setKeyboardMission] = useState(0);
    const [hovered, setHovered] = useState(null);

    const layout = yardCanvasLayout(
      width || 900,
      props.scene.missions.length,
      props.scene.bases,
      props.scene.docks,
    );

    useEffect(function () {
      const element = wrapRef.current;
      if (!element) return undefined;
      const update = function () {
        const next = Math.max(300, Math.floor(element.getBoundingClientRect().width));
        setWidth(function (current) { return current === next ? current : next; });
      };
      update();
      if (typeof ResizeObserver === "undefined") {
        window.addEventListener("resize", update);
        return function () { window.removeEventListener("resize", update); };
      }
      const observer = new ResizeObserver(update);
      observer.observe(element);
      return function () { observer.disconnect(); };
    }, []);

    useEffect(function () {
      const clearOutsideCanvas = function (event) {
        if (event.target !== canvasRef.current) {
          setHovered(function (current) { return current ? null : current; });
        }
      };
      window.addEventListener("pointermove", clearOutsideCanvas, true);
      return function () {
        window.removeEventListener("pointermove", clearOutsideCanvas, true);
      };
    }, []);

    useEffect(function () {
      const canvas = canvasRef.current;
      if (!canvas || !width) return undefined;
      const ctx = canvas.getContext("2d");
      if (!ctx) return undefined;
      const height = layout.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.height = height + "px";
      canvas.style.width = width + "px";
      const reducedMotion = window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const animated = props.scene.roster.rows.some(function (row) {
        return row.state === "running" || row.state === "supervising";
      });
      let frame = null;
      let stopped = false;
      let lastPaint = -Infinity;

      const paint = function (timestamp) {
        if (stopped) return;
        // A full shared scene is materially larger than the old per-agent
        // sprites. Twelve frames per second keeps the live cue legible without
        // monopolising the dashboard's main thread.
        if (animated && !reducedMotion && timestamp - lastPaint < 80) {
          frame = requestAnimationFrame(paint);
          return;
        }
        lastPaint = timestamp;
        const phase = reducedMotion ? 0 : timestamp / 1000;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        const colors = YARD_CANVAS_COLORS;
        const background = ctx.createLinearGradient(0, 0, width, height);
        background.addColorStop(0, colors.ink);
        background.addColorStop(0.56, colors.deep);
        background.addColorStop(1, "#173844");
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);

        ctx.strokeStyle = "rgba(234,240,236,0.055)";
        ctx.lineWidth = 1;
        for (let gx = 0; gx < width; gx += 26) {
          ctx.beginPath();
          ctx.moveTo(gx, 0);
          ctx.lineTo(gx, height);
          ctx.stroke();
        }
        for (let gy = 0; gy < height; gy += 26) {
          ctx.beginPath();
          ctx.moveTo(0, gy);
          ctx.lineTo(width, gy);
          ctx.stroke();
        }

        const hits = [];
        let baseCursorY = 62;
        const baseLayouts = [];
        props.scene.bases.forEach(function (base) {
          const x = layout.compact ? width / 2 : 92;
          const y = baseCursorY;
          const idleStartY = y + 105;
          const agentX = layout.compact ? Math.max(34, x - 118) : 34;
          const placedBase = { base, x, y };
          baseLayouts.push(placedBase);
          yardDrawBase(ctx, x, y, base);
          base.residentAgents.forEach(function (agent, index) {
            const agentY = idleStartY + index * 32;
            yardDrawAgent(
              ctx,
              agent,
              agentX,
              agentY,
              selectedAgents.has(agent.name),
              phase,
              "list",
            );
            hits.push({ type: "agent", x: agentX, y: agentY, radius: 21, agent });
          });
          baseCursorY += 128 + base.residentAgents.length * 32;
        });

        props.scene.docks.forEach(function (dock) {
          const x = layout.compact ? width / 2 : 92;
          const y = baseCursorY + 12;
          const agentX = layout.compact ? Math.max(34, x - 118) : 34;
          const agentStartY = y + 92;
          yardDrawDock(ctx, x, y, dock);
          hits.push({
            type: "dock",
            x: x - 58,
            y: y - 34,
            width: 116,
            height: 108,
            dock,
          });
          dock.agents.forEach(function (agent, index) {
            const agentY = agentStartY + index * 32;
            yardDrawAgent(
              ctx,
              agent,
              agentX,
              agentY,
              selectedAgents.has(agent.name),
              phase,
              "list",
            );
            hits.push({ type: "agent", x: agentX, y: agentY, radius: 21, agent });
          });
          baseCursorY += 116 + dock.agents.length * 32;
        });

        const missionLayouts = [];
        props.scene.missions.forEach(function (mission, index) {
          const column = index % layout.columns;
          const row = Math.floor(index / layout.columns);
          const x = layout.fieldLeft + layout.columnWidth * (column + 0.5);
          const y = layout.top + layout.rowHeight * row;
          missionLayouts.push({ mission, x, y });
        });

        ctx.lineCap = "round";
        missionLayouts.forEach(function (item) {
          const agents = (item.mission.agents || []).filter(function (agent) {
            return agent.state === "running";
          });
          agents.forEach(function (agent, index) {
            const angleStart = -Math.PI + 0.3;
            const angleEnd = -0.3;
            const angle = angleStart +
              ((angleEnd - angleStart) * (index + 1) / (agents.length + 1));
            const baseRadius = 64;
            const x = item.x + Math.cos(angle) * baseRadius;
            const y = item.y + Math.sin(angle) * baseRadius * 0.64;
            const color = yardStateColor(agent.state);
            ctx.save();
            ctx.strokeStyle = color;
            ctx.globalAlpha = 0.72;
            ctx.lineWidth = 2.2;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(item.x, item.y);
            ctx.stroke();
            ctx.restore();
            item.agentLayouts = item.agentLayouts || [];
            item.agentLayouts.push({ agent, x, y });
          });
        });

        const baseLayoutByKey = {};
        for (const item of baseLayouts) baseLayoutByKey[item.base.agency.key] = item;
        missionLayouts.forEach(function (item) {
          const participatingBases = new Set((item.mission.agents || []).map(function (agent) {
            return agent.agency.key;
          }));
          for (const baseKey of participatingBases) {
            const baseLayout = baseLayoutByKey[baseKey];
            if (!baseLayout) continue;
            ctx.save();
            ctx.strokeStyle = baseLayout.base.agency.color;
            ctx.globalAlpha = 0.18;
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 9]);
            ctx.beginPath();
            ctx.moveTo(baseLayout.x, baseLayout.y);
            ctx.lineTo(item.x, item.y);
            ctx.stroke();
            ctx.restore();
          }
        });

        missionLayouts.forEach(function (item, index) {
          yardDrawMission(
            ctx,
            item.mission,
            item.x,
            item.y,
            keyboardMission === index,
            phase,
          );
          hits.push({
            type: "mission",
            x: item.x,
            y: item.y,
            radius: 48,
            mission: item.mission,
          });
          for (const placed of item.agentLayouts || []) {
            yardDrawAgent(
              ctx,
              placed.agent,
              placed.x,
              placed.y,
              selectedAgents.has(placed.agent.name),
              phase,
              "above",
            );
            hits.push({
              type: "agent",
              x: placed.x,
              y: placed.y,
              radius: 21,
              agent: placed.agent,
            });
          }
        });

        ctx.fillStyle = "rgba(234,240,236,0.44)";
        ctx.font = "600 9px ui-monospace, monospace";
        ctx.textAlign = "left";
        ctx.fillText("AGENCY COMMONS · SHARED MISSION MAP", 18, height - 20);
        hitRef.current = hits;

        if (animated && !reducedMotion) frame = requestAnimationFrame(paint);
      };

      frame = requestAnimationFrame(paint);
      return function () {
        stopped = true;
        if (frame) cancelAnimationFrame(frame);
      };
    }, [width, layout.height, layout.columns, layout.columnWidth, layout.fieldLeft,
      layout.rowHeight, layout.top, layout.compact, props.scene, selectedAgents,
      keyboardMission]);

    const pointFromEvent = function (event) {
      const rect = canvasRef.current.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) * (width / rect.width),
        y: (event.clientY - rect.top) * (layout.height / rect.height),
      };
    };
    const hitAt = function (point) {
      for (let index = hitRef.current.length - 1; index >= 0; index -= 1) {
        const hit = hitRef.current[index];
        if (hit.width != null && hit.height != null) {
          if (point.x >= hit.x && point.x <= hit.x + hit.width &&
              point.y >= hit.y && point.y <= hit.y + hit.height) {
            return hit;
          }
          continue;
        }
        const dx = point.x - hit.x;
        const dy = point.y - hit.y;
        if (dx * dx + dy * dy <= hit.radius * hit.radius) return hit;
      }
      return null;
    };
    const handleClick = function (event) {
      const hit = hitAt(pointFromEvent(event));
      if (!hit) {
        if (!event.shiftKey) setSelectedAgents(new Set());
        return;
      }
      if (hit.type === "mission") {
        if (hit.mission.anchor && props.onOpen) props.onOpen(hit.mission.anchor);
        return;
      }
      if (hit.type === "dock") return;
      setSelectedAgents(function (previous) {
        const next = new Set(event.shiftKey ? previous : []);
        if (next.has(hit.agent.name)) next.delete(hit.agent.name);
        else next.add(hit.agent.name);
        return next;
      });
    };
    const handlePointerMove = function (event) {
      const hit = hitAt(pointFromEvent(event));
      if (canvasRef.current) canvasRef.current.style.cursor = hit ? "pointer" : "default";
      if (!hit) {
        setHovered(null);
        return;
      }
      const pointerX = event.clientX;
      const pointerY = event.clientY;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const tooltipWidth = Math.min(340, Math.max(270, width - 24));
      const estimatedHeight = hit.type === "agent" ? 315 :
        hit.type === "dock" ? 330 : 350;
      let left = pointerX + 18;
      if (left + tooltipWidth > viewportWidth - 12) {
        left = pointerX - tooltipWidth - 18;
      }
      left = Math.max(12, Math.min(left, viewportWidth - tooltipWidth - 12));
      let top = pointerY + 16;
      if (top + estimatedHeight > viewportHeight - 12) {
        top = pointerY - estimatedHeight - 16;
      }
      top = Math.max(12, Math.min(top, viewportHeight - estimatedHeight - 12));
      const identity = hit.type === "agent" ? hit.agent.name :
        hit.type === "dock" ? hit.dock.key : hit.mission.id;
      setHovered(function (previous) {
        if (previous &&
            previous.type === hit.type &&
            previous.identity === identity &&
            Math.abs(previous.left - left) < 3 &&
            Math.abs(previous.top - top) < 3) {
          return previous;
        }
        const subject = hit.type === "agent"
          ? { agent: hit.agent }
          : hit.type === "dock"
            ? { dock: hit.dock }
            : { mission: hit.mission };
        return Object.assign({
          type: hit.type,
          identity,
          left,
          top,
          width: tooltipWidth,
        }, subject);
      });
    };
    const handleKeyDown = function (event) {
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        setKeyboardMission(function (current) {
          return props.scene.missions.length ? (current + 1) % props.scene.missions.length : 0;
        });
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        setKeyboardMission(function (current) {
          return props.scene.missions.length
            ? (current - 1 + props.scene.missions.length) % props.scene.missions.length
            : 0;
        });
      } else if (event.key === "Enter") {
        const mission = props.scene.missions[keyboardMission];
        if (mission && mission.anchor && props.onOpen) props.onOpen(mission.anchor);
      } else if (event.key === "Escape") {
        setSelectedAgents(new Set());
      }
    };

    const selectedRows = props.scene.roster.rows.filter(function (row) {
      return selectedAgents.has(row.name);
    });

    return h("div", { className: "hermes-agency-canvas-wrap", ref: wrapRef },
      h("canvas", {
        ref: canvasRef,
        className: "hermes-agency-canvas",
        height: layout.height,
        tabIndex: 0,
        role: "img",
        "data-visible-mission-states": props.scene.missions.map(function (mission) {
          return mission.status;
        }).join(","),
        "data-running-agents": props.scene.roster.rows.filter(function (row) {
          return row.state === "running";
        }).length,
        "data-supervising-agents": props.scene.roster.rows.filter(function (row) {
          return row.state === "supervising";
        }).length,
        "data-review-tasks": props.scene.reviewTaskCount,
        "data-blocked-tasks": props.scene.blockedTaskCount,
        "aria-label": `${props.scene.bases.length} agency bases, ${props.scene.missions.length} current or next missions, ${props.scene.reviewTaskCount} cards waiting for review, ${props.scene.blockedTaskCount} cards needing action, and ${props.scene.roster.rows.length} agent profiles. Green agents execute product work; cyan agents supervise the control plane. Use arrow keys to move between missions and Enter to open one.`,
        onClick: handleClick,
        onPointerMove: handlePointerMove,
        onPointerLeave: function () {
          if (canvasRef.current) canvasRef.current.style.cursor = "default";
          setHovered(null);
        },
        onMouseLeave: function () { setHovered(null); },
        onKeyDown: handleKeyDown,
      }),
      h(AgencyHoverInspector, { hover: hovered }),
      selectedRows.length > 0
        ? h("div", { className: "hermes-canvas-selection" },
            h("div", { className: "hermes-canvas-selection-copy" },
              h("strong", null, `${selectedRows.length} agent${selectedRows.length === 1 ? "" : "s"} selected`),
              h("span", null, selectedRows.map(function (row) { return "@" + row.name; }).join(" · ")),
            ),
            h("span", { className: "hermes-canvas-selection-note" },
              "Command actions are intentionally not wired yet; dispatch remains automation-owned."),
            h("button", {
              type: "button",
              onClick: function () { setSelectedAgents(new Set()); },
            }, "Clear"),
          )
        : h("div", { className: "hermes-canvas-hint" },
            "Click a mission to open it. Click agents to inspect selection; Shift-click selects several."),
    );
  }

  function AgencyYard(props) {
    const [profiles, setProfiles] = useState([]);
    const [overviewBoard, setOverviewBoard] = useState(null);
    const [agencyHealth, setAgencyHealth] = useState(null);

    useEffect(function () {
      let cancelled = false;
      SDK.fetchJSON(`${API}/profiles`)
        .then(function (data) {
          if (!cancelled) setProfiles((data && data.profiles) || []);
        })
        .catch(function () {
          // Board assignees still render truthfully if profile metadata is
          // temporarily unavailable; the view does not invent roster rows.
        });
      return function () { cancelled = true; };
    }, []);

    const loadOverview = useCallback(function () {
      return SDK.fetchJSON(`${API}/agency-overview`)
        .then(function (data) {
          setOverviewBoard(data);
          return data;
        })
        .catch(function () {
          // Keep the last truthful cross-board snapshot. On first-load failure,
          // the selected board remains a clearly narrower fallback.
          return null;
        });
    }, []);

    const loadAgencyHealth = useCallback(function () {
      return SDK.fetchJSON(`${API}/agency-health?history_days=7&window_hours=24`)
        .then(function (data) {
          setAgencyHealth(data);
          return data;
        })
        .catch(function () {
          // Preserve the last durable report. A temporarily unavailable health
          // endpoint must not replace known receipts with invented zeroes.
          return null;
        });
    }, []);

    useEffect(function () {
      loadOverview();
      loadAgencyHealth();
      const interval = setInterval(function () {
        loadOverview();
        loadAgencyHealth();
      }, 15000);
      return function () { clearInterval(interval); };
    }, [loadOverview, loadAgencyHealth]);

    useEffect(function () {
      if (props.board && props.board.latest_event_id != null) {
        loadOverview();
        loadAgencyHealth();
      }
    }, [
      props.board && props.board.latest_event_id,
      loadOverview,
      loadAgencyHealth,
    ]);

    const scene = useMemo(function () {
      return buildYardScene(overviewBoard || props.board, profiles);
    }, [overviewBoard, props.board, profiles]);

    const taskCounts = {
      supervising: scene.roster.rows.filter(function (row) {
        return row.state === "supervising";
      }).length,
      running: scene.roster.openTasks.filter(function (task) { return task.status === "running"; }).length,
      ready: scene.roster.openTasks.filter(function (task) { return task.status === "ready"; }).length,
      review: scene.reviewTaskCount,
      blocked: scene.blockedTaskCount,
    };

    return h("section", { className: "hermes-agency-yard", "aria-labelledby": "agency-yard-title" },
      h("div", { className: "hermes-yard-masthead" },
        h("div", { className: "hermes-yard-title-block" },
          h("div", { className: "hermes-yard-kicker" },
            h("span", { className: "hermes-yard-live-dot", "aria-hidden": "true" }),
            "LIVE FROM THE BOARD",
          ),
          h("h2", { id: "agency-yard-title" }, "The agencies, on one floor"),
          h("p", null,
            "Green agents execute product work. Cyan Lead and Operator supervise from Control Room; review and blocker queues stay separate.",
          ),
        ),
        h("div", { className: "hermes-yard-actions" },
          h("button", {
            type: "button",
            className: "hermes-yard-action",
            onClick: function () {
              loadOverview();
              loadAgencyHealth();
              if (props.onRefresh) props.onRefresh();
            },
          }, "Refresh"),
        ),
      ),
      h("div", { className: "hermes-yard-metrics", "aria-label": "Live task totals" },
        h(YardMetric, { value: taskCounts.supervising, label: "supervising now", tone: "supervising" }),
        h(YardMetric, { value: taskCounts.running, label: "running now", tone: "running" }),
        h(YardMetric, { value: taskCounts.ready, label: "ready to dispatch", tone: "ready" }),
        h(YardMetric, { value: taskCounts.review, label: "waiting for review", tone: "review" }),
        h(YardMetric, { value: taskCounts.blocked, label: "need action", tone: "blocked" }),
      ),
      h(AgencyHealthPanel, { health: agencyHealth }),
      scene.roster.rows.length === 0
        ? h("div", { className: "hermes-yard-empty" },
            "No installed profiles or assigned open tasks were found on this board.")
        : h(AgencyCanvas, {
            scene,
            onOpen: props.onOpen,
          }),
      h("div", { className: "hermes-yard-legend", "aria-label": "Map legend" },
        h("span", null, h("i", { className: "is-supervising" }), "Control-plane supervisor"),
        h("span", null, h("i", { className: "is-running" }), "Executing now"),
        h("span", null, h("i", { className: "is-ready" }), "Ready or queued at base"),
        h("span", null, h("i", { className: "is-review" }), "Waiting at review gate"),
        h("span", null, h("i", { className: "is-blocked" }), "Needs action at blocked dock"),
        h("strong", null, "Green = product execution · cyan = supervision."),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Attention strip — surfaces every task with active diagnostics,
  // severity-marked (warning/error/critical). Collapsed by default; click
  // Show to expand into per-task rows with Open buttons. Dismissible
  // per session via state flag.
  // -------------------------------------------------------------------------

  function collectDiagTasks(boardData) {
    if (!boardData || !boardData.columns) return [];
    const out = [];
    for (const col of boardData.columns) {
      for (const t of col.tasks || []) {
        if (t.diagnostics && t.diagnostics.length > 0) out.push(t);
        else if (t.warnings && t.warnings.count > 0) out.push(t);
      }
    }
    // Sort: highest severity first (critical > error > warning), then by
    // most recent latest_at.
    const sevIdx = function (s) {
      if (s === "critical") return 3;
      if (s === "error") return 2;
      if (s === "warning") return 1;
      return 0;
    };
    out.sort(function (a, b) {
      const aSev = sevIdx((a.warnings && a.warnings.highest_severity) || "warning");
      const bSev = sevIdx((b.warnings && b.warnings.highest_severity) || "warning");
      if (aSev !== bSev) return bSev - aSev;
      const aLa = (a.warnings && a.warnings.latest_at) || 0;
      const bLa = (b.warnings && b.warnings.latest_at) || 0;
      return bLa - aLa;
    });
    return out;
  }

  function AttentionStrip(props) {
    const { t } = useI18n();
    const [expanded, setExpanded] = useState(false);
    const [dismissed, setDismissed] = useState(false);
    const diagTasks = useMemo(
      function () { return collectDiagTasks(props.boardData); },
      [props.boardData]
    );
    if (dismissed || diagTasks.length === 0) return null;
    // Pick the highest severity present so we can colour the strip.
    let topSev = "warning";
    for (const td of diagTasks) {
      const s = (td.warnings && td.warnings.highest_severity) || "warning";
      if (s === "critical") { topSev = "critical"; break; }
      if (s === "error" && topSev !== "critical") topSev = "error";
    }
    return h("div", {
      className: cn(
        "hermes-kanban-attention",
        "hermes-kanban-attention--" + topSev,
      ),
    },
      h("div", { className: "hermes-kanban-attention-bar" },
        h("span", { className: "hermes-kanban-attention-icon" },
          topSev === "critical" ? "!!!" : topSev === "error" ? "!!" : "⚠"),
        h("span", { className: "hermes-kanban-attention-text" },
          diagTasks.length === 1
            ? tx(t, "taskNeedsAttention", "1 task needs attention")
            : tx(t, "tasksNeedAttention", "{n} tasks need attention",
                { n: diagTasks.length }),
        ),
        h("button", {
          className: "hermes-kanban-attention-toggle",
          onClick: function () { setExpanded(function (x) { return !x; }); },
          type: "button",
        }, expanded ? tx(t, "hide", "Hide") : tx(t, "show", "Show")),
        h("button", {
          className: "hermes-kanban-attention-dismiss",
          onClick: function () { setDismissed(true); },
          title: "Hide until next page reload",
          type: "button",
        }, "\u2715"),
      ),
      expanded
        ? h("div", { className: "hermes-kanban-attention-list" },
            diagTasks.map(function (task) {
              const sev = (task.warnings && task.warnings.highest_severity) || "warning";
              const kinds = task.warnings && task.warnings.kinds ? Object.keys(task.warnings.kinds) : [];
              return h("div", {
                key: task.id,
                className: cn(
                  "hermes-kanban-attention-row",
                  "hermes-kanban-attention-row--" + sev,
                ),
              },
                h("span", { className: "hermes-kanban-attention-row-sev" },
                  sev === "critical" ? "!!!" : sev === "error" ? "!!" : "⚠"),
                h("span", { className: "hermes-kanban-attention-row-id" }, task.id),
                h("span", { className: "hermes-kanban-attention-row-title" },
                  task.title || tx(t, "untitled", "(untitled)")),
                h("span", { className: "hermes-kanban-attention-row-meta" },
                  task.assignee ? "@" + task.assignee : tx(t, "unassigned", "unassigned"),
                  " \u00b7 ",
                  kinds.length > 0 ? kinds.join(", ") : tx(t, "diagnostic", "diagnostic"),
                ),
                h("button", {
                  className: "hermes-kanban-attention-row-btn",
                  onClick: function () { props.onOpen(task.id); },
                  type: "button",
                }, tx(t, "open", "Open")),
              );
            }),
          )
        : null,
    );
  }

  // -------------------------------------------------------------------------
  // Diagnostics section — generic renderer for a task's active distress
  // signals. Each diagnostic carries its own title, detail, data payload,
  // and a list of structured actions; the section renders them uniformly
  // regardless of kind. Replaces the hallucination-specific
  // ``RecoveryPopover`` from the previous iteration.
  //
  // Action kinds supported today:
  //   reclaim   → POST /tasks/:id/reclaim
  //   reassign  → POST /tasks/:id/reassign (with profile picker)
  //   unblock   → PATCH /tasks/:id  body: {status: "ready"}
  //   comment   → scroll to the comment input at the bottom of the drawer
  //   cli_hint  → copy payload.command to clipboard
  //   open_docs → open payload.url in a new tab
  // Unknown kinds are rendered as a disabled informational row so the
  // server can add new action kinds without breaking the UI.
  // -------------------------------------------------------------------------

  function DiagnosticActionButton(props) {
    const { t } = useI18n();
    const { action, onExec, busy, extra } = props;
    const label = (action.suggested ? "\u2606 " : "") + action.label;
    const cls = cn(
      "hermes-kanban-diag-action-btn",
      action.suggested ? "hermes-kanban-diag-action-btn--suggested" : "",
    );
    if (action.kind === "reclaim" || action.kind === "reassign" ||
        action.kind === "unblock") {
      return h("button", {
        className: cls,
        disabled: busy || (extra && extra.disabled),
        onClick: function () { onExec(action); },
        type: "button",
      }, label);
    }
    if (action.kind === "cli_hint") {
      return h("button", {
        className: cls,
        disabled: busy,
        onClick: function () { onExec(action); },
        type: "button",
        title: tx(t, "copyCommand", "Copy command to clipboard"),
      }, (extra && extra.copied) ? tx(t, "copied", "Copied") : label);
    }
    if (action.kind === "comment") {
      return h("button", {
        className: cls,
        onClick: function () { onExec(action); },
        type: "button",
      }, label);
    }
    if (action.kind === "open_docs") {
      return h("a", {
        className: cls,
        href: (action.payload && action.payload.url) || "#",
        target: "_blank",
        rel: "noreferrer",
      }, label);
    }
    // Unknown kind — render informational, non-interactive.
    return h("span", { className: cls + " hermes-kanban-diag-action-btn--unknown" },
      label);
  }

  function DiagnosticCard(props) {
    const { t } = useI18n();
    const { diag, task, boardSlug, assignees, onRefresh } = props;
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState(null);
    const [copiedKey, setCopiedKey] = useState(null);
    const [reassignProfile, setReassignProfile] = useState(task.assignee || "");

    const execAction = function (action) {
      if (busy) return;
      if (action.kind === "cli_hint") {
        const cmd = (action.payload && action.payload.command) || action.label;
        const fallback = function () { window.prompt("Copy this command:", cmd); };
        try {
          const p = navigator.clipboard && navigator.clipboard.writeText(cmd);
          if (p && p.then) {
            p.then(function () {
              setCopiedKey(action.label);
              setTimeout(function () { setCopiedKey(null); }, 2000);
            }).catch(fallback);
          } else {
            fallback();
          }
        } catch (_) {
          fallback();
        }
        return;
      }
      if (action.kind === "comment") {
        // Scroll the comment input into view; the drawer already has one
        // at the bottom. Focus it so the operator can start typing.
        const ta = document.querySelector(".hermes-kanban-drawer-comment-row input, .hermes-kanban-drawer-comment-row textarea");
        if (ta) {
          ta.scrollIntoView({ behavior: "smooth", block: "nearest" });
          ta.focus();
        }
        return;
      }
      if (action.kind === "unblock") {
        setBusy(true); setMsg(null);
        const url = withBoard(`${API}/tasks/${encodeURIComponent(task.id)}`, boardSlug);
        SDK.fetchJSON(url, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "ready" }),
        }).then(function () {
          setMsg({ ok: true, text: tx(t, "unblockedMessage",
            "Unblocked {id}. Task is ready for the next tick.", { id: task.id }) });
          if (onRefresh) onRefresh();
        }).catch(function (err) {
          setMsg({ ok: false, text: tx(t, "unblockFailed", "Unblock failed: ") + (err.message || err) });
        }).then(function () { setBusy(false); });
        return;
      }
      if (action.kind === "reclaim") {
        setBusy(true); setMsg(null);
        const url = withBoard(`${API}/tasks/${encodeURIComponent(task.id)}/reclaim`, boardSlug);
        SDK.fetchJSON(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: `recovery action for ${diag.kind}` }),
        }).then(function () {
          setMsg({ ok: true, text: tx(t, "reclaimedMessage",
            "Reclaimed {id}. Task is back to ready.", { id: task.id }) });
          if (onRefresh) onRefresh();
        }).catch(function (err) {
          setMsg({ ok: false, text: tx(t, "reclaimFailed", "Reclaim failed: ") + (err.message || err) });
        }).then(function () { setBusy(false); });
        return;
      }
      if (action.kind === "reassign") {
        if (!reassignProfile) {
          setMsg({ ok: false, text: tx(t, "pickProfileFirst", "Pick a profile first.") });
          return;
        }
        setBusy(true); setMsg(null);
        const url = withBoard(`${API}/tasks/${encodeURIComponent(task.id)}/reassign`, boardSlug);
        const body = {
          profile: reassignProfile || null,
          reclaim_first: !!(action.payload && action.payload.reclaim_first),
          reason: `recovery action for ${diag.kind}`,
        };
        SDK.fetchJSON(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }).then(function () {
          setMsg({
            ok: true,
            text: tx(t, "reassignedMessage", "Reassigned {id} to {profile}.",
              { id: task.id, profile: reassignProfile }),
          });
          if (onRefresh) onRefresh();
        }).catch(function (err) {
          setMsg({ ok: false, text: tx(t, "reassignFailed", "Reassign failed: ") + (err.message || err) });
        }).then(function () { setBusy(false); });
        return;
      }
    };

    // Pull out the reassign action so we can render its picker inline.
    const reassignAction = (diag.actions || []).find(function (a) {
      return a.kind === "reassign";
    });

    const sevClass = "hermes-kanban-diag--" + (diag.severity || "warning");
    return h("div", { className: cn("hermes-kanban-diag", sevClass) },
      h("div", { className: "hermes-kanban-diag-header" },
        h("span", { className: "hermes-kanban-diag-sev" },
          diag.severity === "critical" ? "!!!" :
          diag.severity === "error" ? "!!" : "\u26a0"),
        h("span", { className: "hermes-kanban-diag-title" },
          diag.title),
      ),
      h("div", { className: "hermes-kanban-diag-detail" },
        diag.detail),
      diag.data && Object.keys(diag.data).length > 0
        ? h("div", { className: "hermes-kanban-diag-data" },
            Object.keys(diag.data).map(function (k) {
              const v = diag.data[k];
              if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string" &&
                  v[0].indexOf("t_") === 0) {
                // Task-id list — render as chips.
                return h("div", { key: k, className: "hermes-kanban-diag-data-row" },
                  h("span", { className: "hermes-kanban-diag-data-key" }, k + ":"),
                  v.map(function (x) {
                    return h("code", {
                      key: x, className: "hermes-kanban-event-phantom-chip",
                    }, x);
                  }),
                );
              }
              return h("div", { key: k, className: "hermes-kanban-diag-data-row" },
                h("span", { className: "hermes-kanban-diag-data-key" }, k + ":"),
                h("span", { className: "hermes-kanban-diag-data-val" },
                  Array.isArray(v) ? v.join(", ") : String(v)),
              );
            }),
          )
        : null,
      // Inline reassign picker — only shown when the diagnostic offers
      // a reassign action. Profile list comes from the board payload.
      reassignAction
        ? h("div", { className: "hermes-kanban-diag-reassign-row" },
            h("span", { className: "hermes-kanban-diag-reassign-label" },
              tx(t, "reassignTo", "Reassign to:")),
            h("select", {
              className: "hermes-kanban-recovery-select",
              value: reassignProfile,
              onChange: function (e) { setReassignProfile(e.target.value); },
            },
              h("option", { value: "" }, "(unassigned)"),
              (assignees || []).map(function (a) {
                return h("option", { key: a, value: a }, a);
              }),
            ),
          )
        : null,
      h("div", { className: "hermes-kanban-diag-actions" },
        (diag.actions || []).map(function (a, i) {
          return h(DiagnosticActionButton, {
            key: a.kind + i,
            action: a,
            onExec: execAction,
            busy: busy,
            extra: {
              copied: copiedKey === a.label,
              disabled: (a.kind === "reassign" && !reassignProfile),
            },
          });
        }),
      ),
      msg
        ? h("div", {
            className: cn(
              "hermes-kanban-diag-msg",
              msg.ok ? "hermes-kanban-diag-msg--ok" : "hermes-kanban-diag-msg--err",
            ),
          }, msg.text)
        : null,
    );
  }

  function DiagnosticsSection(props) {
    const { t } = useI18n();
    const diags = props.diagnostics || [];
    const hasOpenDiags = diags.length > 0;
    const [open, setOpen] = useState(hasOpenDiags);
    useEffect(function () {
      if (hasOpenDiags) setOpen(true);
    }, [hasOpenDiags]);
    if (!hasOpenDiags && !props.alwaysVisible) {
      // Nothing active. Collapse the section entirely rather than showing
      // an empty "Recovery" header — keeps clean tasks visually clean.
      return null;
    }
    return h("div", { className: "hermes-kanban-section" },
      h("div", { className: "hermes-kanban-section-head-row" },
        h("span", { className: "hermes-kanban-section-head" },
          hasOpenDiags
            ? h("span", { className: "hermes-kanban-section-head-warning" },
                `\u26a0 ${tx(t, "diagnostics", "Diagnostics")} (${diags.length})`)
            : tx(t, "diagnostics", "Diagnostics"),
        ),
        h("button", {
          className: "hermes-kanban-section-toggle",
          onClick: function () { setOpen(function (x) { return !x; }); },
          type: "button",
        }, open ? tx(t, "hide", "Hide") : tx(t, "show", "Show")),
      ),
      open
        ? h("div", { className: "hermes-kanban-diag-list" },
            diags.map(function (d, i) {
              return h(DiagnosticCard, {
                key: props.task.id + ":" + d.kind + i,
                diag: d,
                task: props.task,
                boardSlug: props.boardSlug,
                assignees: props.assignees,
                onRefresh: props.onRefresh,
              });
            }),
          )
        : null,
    );
  }

    // -------------------------------------------------------------------------
  // Board switcher (multi-project)
  // -------------------------------------------------------------------------

  // Small `?` affordance next to the board controls. Opens the kanban docs
  // page in a new tab so users can look up what any of the widgets mean
  // without losing the current board view.
  function DocsLink() {
    return h("a", {
      href: DOCS_URL,
      target: "_blank",
      rel: "noopener noreferrer",
      className: "hermes-kanban-docs-link",
      title: "Open Hermes Kanban docs in a new tab",
      "aria-label": "Hermes Kanban documentation",
    }, "?");
  }

  // ---------------------------------------------------------------------
  // OrchestrationPanel — collapsible settings panel for the kanban
  // orchestrator (orchestrator profile picker, default assignee picker,
  // auto-decompose toggle, plus per-profile description editing with
  // auto-generate). Backed by /orchestration + /profiles endpoints.
  // ---------------------------------------------------------------------

  function OrchestrationPanel() {
    const [expanded, setExpanded] = useState(false);
    const [settings, setSettings] = useState(null);
    const [profiles, setProfiles] = useState([]);
    const [busy, setBusy] = useState({});
    const [msg, setMsg] = useState(null);

    const loadAll = useCallback(function () {
      Promise.all([
        SDK.fetchJSON(`${API}/orchestration`),
        SDK.fetchJSON(`${API}/profiles`),
      ]).then(function (results) {
        setSettings(results[0] || null);
        setProfiles((results[1] && results[1].profiles) || []);
        setMsg(null);
      }).catch(function (err) {
        setMsg({ ok: false, text: "Failed to load: " + (err.message || String(err)) });
      });
    }, []);

    useEffect(function () {
      // Load on mount so the collapsed pill shows the real mode without
      // requiring the user to expand the panel first.
      if (settings === null) loadAll();
    }, [settings, loadAll]);

    const saveSettings = function (patch) {
      setMsg(null);
      return SDK.fetchJSON(`${API}/orchestration`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }).then(function (res) {
        setSettings(res);
        setMsg({ ok: true, text: "Settings saved." });
        return res;
      }).catch(function (err) {
        setMsg({ ok: false, text: "Save failed: " + (err.message || String(err)) });
      });
    };

    const saveProfileDescription = function (name, description) {
      setBusy(function (b) { return Object.assign({}, b, { [name]: "save" }); });
      return SDK.fetchJSON(`${API}/profiles/${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: description }),
      }).then(function () {
        loadAll();
        setMsg({ ok: true, text: `Description saved for ${name}.` });
      }).catch(function (err) {
        setMsg({ ok: false, text: "Save failed: " + (err.message || String(err)) });
      }).then(function () {
        setBusy(function (b) {
          const next = Object.assign({}, b); delete next[name]; return next;
        });
      });
    };

    const autoGenerateDescription = function (name, overwrite) {
      setBusy(function (b) { return Object.assign({}, b, { [name]: "auto" }); });
      return SDK.fetchJSON(`${API}/profiles/${encodeURIComponent(name)}/describe-auto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overwrite: !!overwrite }),
      }).then(function (res) {
        if (res && res.ok) {
          loadAll();
          setMsg({ ok: true, text: `Auto-generated description for ${name}.` });
        } else {
          setMsg({
            ok: false,
            text: "Auto-generate failed: " + ((res && res.reason) || "unknown error"),
          });
        }
      }).catch(function (err) {
        setMsg({ ok: false, text: "Auto-generate failed: " + (err.message || String(err)) });
      }).then(function () {
        setBusy(function (b) {
          const next = Object.assign({}, b); delete next[name]; return next;
        });
      });
    };

    const headerLabel = expanded
      ? "▾ Orchestration settings"
      : "▸ Orchestration settings";

    // Mode pill — always visible (collapsed or expanded). One click flips
    // between Auto and Manual. Auto = dispatcher decomposes new triage tasks
    // every tick. Manual = pre-PR behavior, the user clicks ⚗ Decompose on
    // each triage card (or runs `hermes kanban decompose <id>`) and tasks
    // stay in triage until then.
    const autoOn = !!(settings && settings.auto_decompose);
    const modePillTitle = settings === null
      ? "Loading mode…"
      : (autoOn
          ? "Orchestration: Auto — the dispatcher decomposes new triage tasks automatically every tick. Click to switch to Manual (pre-PR behavior)."
          : "Orchestration: Manual — triage tasks stay in triage until you click ⚗ Decompose on each card. Click to switch to Auto.");
    const modePill = h("button", {
      type: "button",
      onClick: function () {
        if (settings === null) return;  // not loaded yet
        saveSettings({ auto_decompose: !autoOn });
      },
      disabled: settings === null,
      title: modePillTitle,
      className: "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 "
                 + "text-xs font-medium "
                 + (autoOn
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-muted-foreground/30 bg-muted/30 text-muted-foreground"),
    },
      "Orchestration: ",
      h("span", { className: "ml-1 font-semibold" },
        settings === null ? "…" : (autoOn ? "Auto" : "Manual"))
    );

    if (!expanded) {
      return h("div", { className: "flex items-center gap-3 text-xs" },
        modePill,
        h("button", {
          type: "button",
          onClick: function () { setExpanded(true); },
          className: "underline text-muted-foreground hover:text-foreground",
          title: "Configure the kanban orchestrator (profile picker, default assignee, auto-decompose, profile descriptions)",
        }, headerLabel),
      );
    }

    const profileOptions = profiles.map(function (p) {
      const tag = p.is_default ? " (default)" : "";
      return h(SelectOption, { key: p.name, value: p.name }, p.name + tag);
    });

    return h(Card, { className: "p-3" },
      h(CardContent, { className: "p-2 flex flex-col gap-3" },
        h("div", { className: "flex items-center justify-between" },
          h("button", {
            type: "button",
            onClick: function () { setExpanded(false); },
            className: "text-sm font-medium underline-offset-2 hover:underline",
          }, headerLabel),
          modePill,
          h(Button, { onClick: loadAll, size: "sm" }, "Reload"),
        ),
        msg ? h("div", {
          className: msg.ok ? "hermes-kanban-msg-ok" : "hermes-kanban-msg-err",
        }, msg.text) : null,

        settings ? h("div", { className: "grid gap-3 sm:grid-cols-3" },
          h("div", { className: "flex flex-col gap-1" },
            h(Label, { className: "text-xs text-muted-foreground" },
              "Orchestrator profile"),
            h(Select, Object.assign({
              value: settings.orchestrator_profile || "",
              className: "h-8",
            }, selectChangeHandler(function (v) {
              saveSettings({ orchestrator_profile: v });
            })),
              h(SelectOption, { value: "" },
                "(default: " + (settings.active_profile || "default") + ")"),
              profileOptions,
            ),
            h("div", { className: "text-[10px] text-muted-foreground" },
              "Resolved: " + (settings.resolved_orchestrator_profile || "default")),
            h("div", { className: "text-[10px] text-muted-foreground" },
              "Owns the root task after fan-out (wakes back up to judge completion). Does not drive how tasks split — configure the decomposer model under auxiliary.kanban_decomposer."),
          ),
          h("div", { className: "flex flex-col gap-1" },
            h(Label, { className: "text-xs text-muted-foreground" },
              "Default assignee"),
            h(Select, Object.assign({
              value: settings.default_assignee || "",
              className: "h-8",
            }, selectChangeHandler(function (v) {
              saveSettings({ default_assignee: v });
            })),
              h(SelectOption, { value: "" },
                "(default: " + (settings.active_profile || "default") + ")"),
              profileOptions,
            ),
            h("div", { className: "text-[10px] text-muted-foreground" },
              "Resolved: " + (settings.resolved_default_assignee || "default")),
          ),
          h("div", { className: "flex flex-col gap-1" },
            h(Label, { className: "text-xs text-muted-foreground" },
              "Orchestration mode"),
            h("label", { className: "flex items-center gap-2 text-xs h-8" },
              h(Checkbox, {
                checked: !!settings.auto_decompose,
                onCheckedChange: function (checked) {
                  saveSettings({ auto_decompose: checked === true });
                },
              }),
              "Auto-decompose triage tasks",
            ),
            h("div", { className: "text-[10px] text-muted-foreground" },
              settings.auto_decompose
                ? "The dispatcher decomposes new triage tasks automatically."
                : "Triage tasks stay in triage until you click ⚗ Decompose."),
          ),
        ) : h("div", { className: "text-xs text-muted-foreground" },
          "Loading…"),

        h("div", { className: "border-t pt-3" },
          h(Label, { className: "text-xs text-muted-foreground" },
            "Profile descriptions"),
          h("div", { className: "text-[10px] text-muted-foreground pb-2" },
            "Descriptions guide the decomposer's routing. Click ⚗ to auto-generate, or edit and save."),
          profiles.length === 0
            ? h("div", { className: "text-xs text-muted-foreground" }, "No profiles installed.")
            : h("div", { className: "flex flex-col gap-2" },
                profiles.map(function (p) {
                  return h(ProfileDescriptionRow, {
                    key: p.name,
                    profile: p,
                    busy: busy[p.name] || null,
                    onSave: saveProfileDescription,
                    onAuto: autoGenerateDescription,
                  });
                }),
              ),
        ),
      ),
    );
  }

  function ProfileDescriptionRow(props) {
    const p = props.profile;
    const [draft, setDraft] = useState(p.description || "");
    const busy = props.busy;
    // Re-sync the local draft if the server-side description changes (e.g.
    // after auto-generate). Cheap because re-runs only happen on prop change.
    useEffect(function () {
      setDraft(p.description || "");
    }, [p.description]);

    const tag = p.description_auto && p.description ? " [auto, review]" : "";
    return h("div", { className: "flex flex-col gap-1 border-l-2 pl-2",
      style: { borderColor: p.description ? "#888" : "#cc6" } },
      h("div", { className: "flex items-center gap-2 text-xs" },
        h("span", { className: "font-medium" }, p.name),
        p.is_default ? h("span", { className: "text-[10px] text-muted-foreground" }, "(default)") : null,
        p.description_auto && p.description
          ? h("span", { className: "text-[10px] text-yellow-600" }, "auto — review")
          : null,
        !p.description
          ? h("span", { className: "text-[10px] text-yellow-600" }, "⚠ no description")
          : null,
      ),
      h("div", { className: "flex items-center gap-2" },
        h(Input, {
          value: draft,
          onChange: function (e) { setDraft(e.target.value); },
          placeholder: "What is this profile good at?",
          className: "h-7 text-xs flex-1",
        }),
        h(Button, {
          onClick: function () { props.onSave(p.name, draft); },
          size: "sm",
          disabled: !!busy || draft === (p.description || ""),
          title: "Save the description above as user-authored",
        }, busy === "save" ? "Saving…" : "Save"),
        h(Button, {
          onClick: function () { props.onAuto(p.name, true); },
          size: "sm",
          disabled: !!busy,
          title: "Auto-generate a description from this profile's skills and model",
        }, busy === "auto" ? "Generating…" : "⚗ Auto"),
      ),
    );
  }

  function BoardSwitcher(props) {
    const { t } = useI18n();
    const list = props.boardList || [];
    const current = list.find(function (b) { return b.slug === props.board; });
    const currentName = current && current.name ? current.name : props.board;
    const currentTotal = current ? current.total : 0;
    const hasMultipleBoards = list.length > 1;

    // Hide entirely when only the default board exists AND it's empty —
    // single-project users never see boards UI unless they ask for it.
    // We show the [+ New board] affordance as soon as any board has a
    // task (so the user can discover multi-project before they need it)
    // OR when any non-default board exists.
    const totalAcrossAllBoards = list.reduce(function (n, b) { return n + (b.total || 0); }, 0);
    const shouldShow = hasMultipleBoards || totalAcrossAllBoards > 0;
    if (!shouldShow) {
      return h("div", {
        className: "hermes-kanban-boardswitcher-compact",
        title: tx(t, "boardSwitcherHint", "Boards let you separate unrelated streams of work"),
      },
        h(Button, {
          onClick: props.onNewClick,
          size: "sm",
          className: "h-7 text-xs",
        }, tx(t, "newBoard", "+ New board")),
        h(Button, {
          onClick: props.onSettingsClick,
          size: "sm",
          className: "h-7 text-xs",
          title: tx(t, "boardSettingsTitle",
            "Board settings — name, description, and the default project directory new tasks inherit"),
        }, tx(t, "boardSettings", "Settings")),
        h(DocsLink, null),
      );
    }

    return h("div", { className: "hermes-kanban-boardswitcher" },
      h("div", { className: "hermes-kanban-boardswitcher-inner" },
        h("div", { className: "flex flex-col gap-0.5" },
          h("div", { className: "text-[11px] tracking-wider text-muted-foreground" },
            tx(t, "board", "Board")),
          h("div", { className: "flex items-center gap-2" },
            h(Select, Object.assign({
              value: props.board,
              className: "h-8 min-w-[220px]",
              "aria-label": "Switch kanban board",
              title: "Boards are independent work streams. Each board has its own tasks, tenants, and assignees.",
            }, selectChangeHandler(function (v) { if (v) props.onSwitch(v); })),
              list.map(function (b) {
                const label = b.total > 0
                  ? `${b.name || b.slug} · ${b.total}`
                  : (b.name || b.slug);
                return h(SelectOption, { key: b.slug, value: b.slug }, label);
              }),
            ),
            h("span", { className: "text-xs text-muted-foreground" },
              `${currentTotal || 0} task${currentTotal === 1 ? "" : "s"}`),
          ),
        ),
        h("div", { className: "flex-1" }),
        h(DocsLink, null),
        h(Button, {
          onClick: props.onSettingsClick,
          size: "sm",
          className: "h-8",
          title: tx(t, "boardSettingsTitle",
            "Board settings — name, description, and the default project directory new tasks inherit"),
        }, tx(t, "boardSettings", "Settings")),
        h(Button, {
          onClick: props.onNewClick,
          size: "sm",
          className: "h-8",
          title: "Create a new board. Useful when you want an unrelated work stream (different project, different team, isolated scratch area).",
        }, tx(t, "newBoard", "+ New board")),
        props.board !== "default"
          ? h(Button, {
            onClick: function () {
              const msg = tx(t, "archiveBoardConfirm",
                "Archive board '{name}'? It will be moved to boards/_archived/ so you can recover it later. Tasks on this board will no longer appear anywhere in the UI.",
                { name: currentName });
              if (window.confirm(msg)) props.onDeleteBoard(props.board);
            },
            size: "sm",
            className: "h-8",
            title: tx(t, "archiveBoardTitle", "Archive this board"),
          }, tx(t, "archive", "Archive"))
          : null,
      ),
    );
  }

  function NewBoardDialog(props) {
    const { t } = useI18n();
    const [slug, setSlug] = useState("");
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [icon, setIcon] = useState("");
    const [projectDirectory, setProjectDirectory] = useState("");
    const [switchTo, setSwitchTo] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [err, setErr] = useState(null);

    // Auto-derive a name from the slug if the user hasn't typed one.
    const autoName = useMemo(function () {
      if (!slug) return "";
      return slug.replace(/[-_]+/g, " ")
        .split(" ")
        .filter(Boolean)
        .map(function (w) { return w[0].toUpperCase() + w.slice(1); })
        .join(" ");
    }, [slug]);

    function onSubmit(ev) {
      if (ev) ev.preventDefault();
      if (!slug.trim()) { setErr("slug is required"); return; }
      setSubmitting(true);
      setErr(null);
      props.onCreate({
        slug: slug.trim(),
        name: name.trim() || autoName || undefined,
        description: description.trim() || undefined,
        icon: icon.trim() || undefined,
        default_workdir: projectDirectory.trim() || undefined,
        switch: switchTo,
      }).catch(function (e) {
        setErr(String(e && e.message ? e.message : e));
        setSubmitting(false);
      });
    }

    return h("div", {
      className: "hermes-kanban-dialog-backdrop",
      onClick: function (e) { if (e.target === e.currentTarget) props.onCancel(); },
    },
      h("form", {
        className: "hermes-kanban-dialog",
        onSubmit: onSubmit,
      },
        h("div", { className: "hermes-kanban-dialog-title" },
          tx(t, "newBoardTitle", "New board")),
        h("div", { className: "text-xs text-muted-foreground mb-2" },
          tx(t, "newBoardDescription",
            "Boards let you separate unrelated streams of work — one per project, repo, or domain. Workers on one board never see another board's tasks.")),
        h("div", { className: "flex flex-col gap-3" },
          h("div", { className: "flex flex-col gap-1" },
            h(Label, { className: "text-xs" }, tx(t, "slug", "Slug"), " ",
              h("span", { className: "text-muted-foreground" },
                tx(t, "slugHint", "— lowercase, hyphens, e.g. atm10-server"))),
            h(Input, {
              value: slug,
              onChange: function (e) { setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9\-_]/g, "-")); },
              placeholder: "atm10-server",
              autoFocus: true,
              className: "h-8",
            }),
          ),
          h("div", { className: "flex flex-col gap-1" },
            h(Label, { className: "text-xs" }, tx(t, "displayName", "Display name"), " ",
              h("span", { className: "text-muted-foreground" },
                tx(t, "displayNameHint", "(optional)"))),
            h(Input, {
              value: name,
              onChange: function (e) { setName(e.target.value); },
              placeholder: autoName || tx(t, "displayName", "Display name"),
              className: "h-8",
            }),
          ),
          h("div", { className: "flex flex-col gap-1" },
            h(Label, { className: "text-xs" }, tx(t, "description", "Description"), " ",
              h("span", { className: "text-muted-foreground" },
                tx(t, "descriptionHint", "(optional)"))),
            h(Input, {
              value: description,
              onChange: function (e) { setDescription(e.target.value); },
              placeholder: "What goes on this board?",
              className: "h-8",
            }),
          ),
          h("div", { className: "flex flex-col gap-1" },
            h(Label, { className: "text-xs" },
              tx(t, "projectDirectory", "Project directory"), " ",
              h("span", { className: "text-muted-foreground" },
                tx(t, "projectDirectoryHint", "(recommended)"))),
            h(Input, {
              value: projectDirectory,
              onChange: function (e) { setProjectDirectory(e.target.value); },
              placeholder: tx(t, "projectDirectoryPlaceholder",
                "Absolute path to the project folder"),
              title: tx(t, "projectDirectoryHelp",
                "Git projects use preserved worktrees. Other folders use the directory directly. Leave blank only for temporary work."),
              className: "h-8",
              autoCapitalize: "none",
              autoCorrect: "off",
              spellCheck: false,
            }),
            h("div", { className: "text-xs text-muted-foreground" },
              tx(t, "projectDirectoryExplanation",
                "Sets the default location for task files so project output is preserved.")),
          ),
          h("div", { className: "flex flex-col gap-1" },
            h(Label, { className: "text-xs" }, tx(t, "icon", "Icon"), " ",
              h("span", { className: "text-muted-foreground" },
                tx(t, "iconHint", "(single character or emoji)"))),
            h(Input, {
              value: icon,
              onChange: function (e) { setIcon(e.target.value.slice(0, 4)); },
              placeholder: "📦",
              className: "h-8 w-24",
            }),
          ),
          h("label", { className: "flex items-center gap-2 text-xs" },
            h(Checkbox, {
              checked: switchTo,
              onCheckedChange: function (checked) { setSwitchTo(checked === true); },
            }),
            tx(t, "switchAfterCreate", "Switch to this board after creating it"),
          ),
        ),
        err ? h("div", { className: "text-xs text-destructive mt-2" }, err) : null,
        h("div", { className: "hermes-kanban-dialog-actions" },
          h(Button, {
            type: "button",
            onClick: props.onCancel,
            size: "sm",
            disabled: submitting,
          }, tx(t, "cancel", "Cancel")),
          h(Button, {
            type: "submit",
            size: "sm",
            disabled: submitting || !slug.trim(),
          }, submitting ? tx(t, "creating", "Creating…") : tx(t, "createBoard", "Create board")),
        ),
      ),
    );
  }

  // Board settings dialog — edit display name, description, and the
  // board-level default project directory (default_workdir). The workdir
  // is the board-level setting every new task's workspace kind/path is
  // seeded from; task-level values in the create dialog override it.
  function BoardSettingsDialog(props) {
    const { t } = useI18n();
    const b = props.board || {};
    const [name, setName] = useState(b.name || "");
    const [description, setDescription] = useState(b.description || "");
    const [projectDirectory, setProjectDirectory] = useState(b.default_workdir || "");
    const [submitting, setSubmitting] = useState(false);
    const [err, setErr] = useState(null);

    function onSubmit(ev) {
      if (ev) ev.preventDefault();
      setSubmitting(true);
      setErr(null);
      // Send default_workdir unconditionally: "" clears it on the server,
      // a path sets it (validated server-side: absolute + existing dir).
      props.onSave({
        name: name.trim() || undefined,
        description: description.trim() || undefined,
        default_workdir: projectDirectory.trim(),
      }).catch(function (e) {
        setErr(parseApiErrorMessage(e));
        setSubmitting(false);
      });
    }

    return h("div", {
      className: "hermes-kanban-dialog-backdrop",
      onClick: function (e) { if (e.target === e.currentTarget) props.onCancel(); },
      onKeyDown: function (e) { if (e.key === "Escape") props.onCancel(); },
    },
      h("form", {
        className: "hermes-kanban-dialog",
        onSubmit: onSubmit,
      },
        h("div", { className: "hermes-kanban-dialog-title" },
          tx(t, "boardSettingsTitleFor", "Board settings — {name}",
            { name: b.name || b.slug || "default" })),
        h("div", { className: "flex flex-col gap-3" },
          h("div", { className: "flex flex-col gap-1" },
            h(Label, { className: "text-xs" }, tx(t, "displayName", "Display name")),
            h(Input, {
              value: name,
              onChange: function (e) { setName(e.target.value); },
              className: "h-8",
            }),
          ),
          h("div", { className: "flex flex-col gap-1" },
            h(Label, { className: "text-xs" }, tx(t, "description", "Description")),
            h(Input, {
              value: description,
              onChange: function (e) { setDescription(e.target.value); },
              className: "h-8",
            }),
          ),
          h("div", { className: "flex flex-col gap-1" },
            h(Label, { className: "text-xs" },
              tx(t, "projectDirectory", "Project directory")),
            h(Input, {
              value: projectDirectory,
              onChange: function (e) { setProjectDirectory(e.target.value); },
              placeholder: tx(t, "projectDirectoryPlaceholder",
                "Absolute path to the project folder"),
              title: tx(t, "projectDirectoryHelp",
                "Git projects use preserved worktrees. Other folders use the directory directly. Leave blank only for temporary work."),
              className: "h-8",
              autoCapitalize: "none",
              autoCorrect: "off",
              spellCheck: false,
            }),
            h("div", { className: "text-xs text-muted-foreground" },
              tx(t, "projectDirectoryOverrideHint",
                "New tasks inherit this as their workspace default; each task can still override it in the create dialog.")),
          ),
        ),
        err ? h("div", { className: "text-xs text-destructive mt-2" }, err) : null,
        h("div", { className: "hermes-kanban-dialog-actions" },
          h(Button, {
            type: "button",
            onClick: props.onCancel,
            size: "sm",
            disabled: submitting,
          }, tx(t, "cancel", "Cancel")),
          h(Button, {
            type: "submit",
            size: "sm",
            disabled: submitting,
          }, submitting ? tx(t, "saving", "Saving…") : tx(t, "save", "Save")),
        ),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Toolbar
  // -------------------------------------------------------------------------

  function BoardToolbar(props) {
    const { t } = useI18n();
    const tenants = (props.board && props.board.tenants) || [];
    const assignees = (props.board && props.board.assignees) || [];
    return h("div", { className: "flex flex-wrap items-end gap-3" },
      h("div", { className: "flex flex-col gap-1",
                 title: "Fuzzy-match tasks by id, title, or description. Matches across all columns." },
        h(Label, { className: "text-xs text-muted-foreground" }, tx(t, "search", "Search")),
        h(Input, {
          placeholder: tx(t, "filterCards", "Filter cards…"),
          value: props.search,
          onChange: function (e) { props.setSearch(e.target.value); },
          className: "w-56 h-8",
        }),
      ),
      h("div", { className: "flex flex-col gap-1",
                 title: "Tenants are free-form tags on a task (e.g. customer, project, team). Set them via the task drawer or kanban_create." },
        h(Label, { className: "text-xs text-muted-foreground" }, tx(t, "tenant", "Tenant")),
        h(Select, Object.assign({
          value: props.tenantFilter,
          className: "h-8",
        }, selectChangeHandler(props.setTenantFilter)),
          h(SelectOption, { value: "" }, tx(t, "allTenants", "All tenants")),
          tenants.map(function (tn) {
            return h(SelectOption, { key: tn, value: tn }, tn);
          }),
        ),
      ),
      h("div", { className: "flex flex-col gap-1",
                 title: "Filter by assigned Hermes profile. Profiles are the named agent identities that claim and work on tasks." },
        h(Label, { className: "text-xs text-muted-foreground" }, tx(t, "assignee", "Assignee")),
        h(Select, Object.assign({
          value: props.assigneeFilter,
          className: "h-8",
        }, selectChangeHandler(props.setAssigneeFilter)),
          h(SelectOption, { value: "" }, tx(t, "allProfiles", "All profiles")),
          assignees.map(function (a) {
            return h(SelectOption, { key: a, value: a }, a);
          }),
        ),
      ),
      h("label", { className: "flex items-center gap-2 text-xs",
                   title: "Include archived tasks in the board view. Archived tasks are hidden by default." },
        h(Checkbox, {
          checked: props.includeArchived,
          onCheckedChange: function (checked) { props.setIncludeArchived(checked === true); },
        }),
        tx(t, "showArchived", "Show archived"),
      ),
      h("label", { className: "flex items-center gap-2 text-xs",
                   title: "Group the Running column by assigned profile" },
        h(Checkbox, {
          checked: props.laneByProfile,
          onCheckedChange: function (checked) { props.setLaneByProfile(checked === true); },
        }),
        tx(t, "lanesByProfile", "Lanes by profile"),
      ),
      h("div", { className: "flex-1" }),
      h(Button, {
        onClick: props.onNudgeDispatch,
        size: "sm",
        title: "Wake the dispatcher to claim ready tasks now instead of waiting for the next tick. Use this after adding tasks if you want them picked up immediately.",
      }, tx(t, "nudgeDispatcher", "Nudge dispatcher")),
      h(Button, {
        onClick: props.onRefresh,
        size: "sm",
        title: "Reload the board from the database. The board auto-refreshes on task events; this is for forcing a re-read.",
      }, tx(t, "refresh", "Refresh")),
      h(Button, {
        onClick: function () {
          props.setSearch("");
          props.setTenantFilter("");
          props.setAssigneeFilter("");
          props.setIncludeArchived(false);
        },
        size: "sm",
        title: "Clear all active filters (search, tenant, assignee, archived).",
      }, tx(t, "clearFilters", "Clear filters")),
    );
  }

  // -------------------------------------------------------------------------
  // Bulk action bar (appears when >= 1 card is selected)
  // -------------------------------------------------------------------------

  function BulkActionBar(props) {
    const { t } = useI18n();
    const [assignee, setAssignee] = useState("");
    const [reclaimFirst, setReclaimFirst] = useState(false);
    const [priority, setPriority] = useState("");
    return h("div", { className: "hermes-kanban-bulk" },
      h("span", { className: "hermes-kanban-bulk-count" },
        `${props.count} ${tx(t, "selected", "selected")}`),
      h(Button, {
        onClick: function () { props.onApply({ status: "todo" }); },
        size: "sm",
        title: "Move selected tasks to Todo.",
      }, "→ todo"),
      h(Button, {
        onClick: function () { props.onApply({ status: "ready" }); },
        size: "sm",
        title: "Move selected tasks to Ready. Ready tasks are picked up by the dispatcher on the next tick.",
      }, "→ ready"),
      h(Button, {
        onClick: function () { props.onApply({ status: "blocked" },
          `Block ${props.count} task(s)?`); },
        size: "sm",
        title: "Block selected tasks. Releases any active claims.",
      }, "Block"),
      h(Button, {
        onClick: function () { props.onApply({ status: "ready" },
          `Unblock ${props.count} task(s)?`); },
        size: "sm",
        title: "Unblock selected tasks (promote to Ready).",
      }, "Unblock"),
      h(Button, {
        onClick: function () {
          props.onApply({ status: "done" },
            tx(t, "markDone", "Mark {n} task(s) as done?", { n: props.count }));
        },
        size: "sm",
        title: "Mark selected tasks as done. Releases any claims and unblocks dependent children. You'll be asked for a completion summary.",
      }, tx(t, "complete", "Complete")),
      h(Button, {
        onClick: function () {
          props.onApply({ archive: true },
            tx(t, "markArchived", "Archive {n} task(s)?", { n: props.count }));
        },
        size: "sm",
        title: "Archive selected tasks. They disappear from the default board view but remain in the database.",
      }, tx(t, "archive", "Archive")),
      h(Button, {
        onClick: function () {
          props.onDelete(props.count);
        },
        size: "sm",
        variant: "destructive",
        title: "Permanently delete selected tasks. This cannot be undone.",
      }, tx(t, "delete", "Delete")),
      h("div", { className: "hermes-kanban-bulk-priority",
                 title: "Set priority on selected tasks. Higher = claimed first." },
        h(Input, {
          type: "number",
          value: priority,
          onChange: function (e) { setPriority(e.target.value); },
          placeholder: tx(t, "priority", "pri"),
          className: "h-7 text-xs w-16",
        }),
        h(Button, {
          onClick: function () {
            if (priority === "") return;
            props.onApply({ priority: Number(priority) });
            setPriority("");
          },
          disabled: priority === "",
          size: "sm",
        }, tx(t, "setPriority", "Set priority")),
      ),
      h("div", { className: "hermes-kanban-bulk-reassign",
                 title: "Reassign selected tasks to a different Hermes profile. Pick a profile (or unassign) and click Apply." },
        h(Select, Object.assign({
          value: assignee,
          className: "h-7 text-xs",
        }, selectChangeHandler(setAssignee)),
          h(SelectOption, { value: "" }, "— reassign —"),
          h(SelectOption, { value: "__none__" }, "(unassign)"),
          props.assignees.map(function (a) {
            return h(SelectOption, { key: a, value: a }, a);
          }),
        ),
        h(Button, {
          onClick: function () {
            if (!assignee) return;
            props.onApply({ assignee: assignee === "__none__" ? "" : assignee, reclaim_first: reclaimFirst });
            setAssignee("");
          },
          disabled: !assignee,
          size: "sm",
          title: "Apply the selected assignee to all selected tasks.",
        }, tx(t, "apply", "Apply")),
      ),
      h("label", { className: "hermes-kanban-bulk-reclaim-first", title: "Reclaim any active claims before reassigning" },
        h(Checkbox, {
          checked: reclaimFirst,
          onCheckedChange: function (checked) { setReclaimFirst(checked === true); },
        }),
        "Reclaim first",
      ),
      h("div", { className: "flex-1" }),
      h(Button, {
        onClick: props.onSelectAllVisible,
        size: "sm",
        title: "Select all visible cards across columns.",
      }, "Select all visible"),
      h(Button, {
        onClick: props.onClear,
        size: "sm",
        title: "Deselect all tasks and hide this bar.",
      }, tx(t, "clear", "Clear")),
    );
  }

  // -------------------------------------------------------------------------
  // Trash Drop Zone
  // -------------------------------------------------------------------------

  function TrashDropZone(props) {
    const { t } = useI18n();
    const [dragOver, setDragOver] = useState(false);
    const zoneRef = useRef(null);

    useEffect(function () {
      if (!zoneRef.current) return undefined;
      const el = zoneRef.current;
      function onTouchDelete(e) {
        const taskId = e.detail && e.detail.taskId;
        if (taskId && props.onDelete) props.onDelete(taskId);
      }
      el.addEventListener("hermes-kanban:delete", onTouchDelete);
      return function () { el.removeEventListener("hermes-kanban:delete", onTouchDelete); };
    }, [props.onDelete]);

    const handleDragOver = function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (!dragOver) setDragOver(true);
    };
    const handleDragLeave = function () { setDragOver(false); };
    const handleDrop = function (e) {
      e.preventDefault();
      setDragOver(false);
      const taskId = e.dataTransfer.getData(MIME_TASK);
      if (!taskId) return;
      if (props.selectedIds && props.selectedIds.has(taskId) && props.selectedIds.size > 1) {
        if (window.confirm(tx(t, "trash.confirmMany", "Permanently delete {n} selected tasks? This cannot be undone.", { n: props.selectedIds.size }))) {
          const ids = Array.from(props.selectedIds);
          Promise.all(ids.map(function (id) { return props.onDelete(id); })).catch(function () {});
        }
      } else {
        props.onDelete(taskId);
      }
    };

    return h("div", {
      ref: zoneRef,
      "data-kanban-trash": "true",
      className: cn(
        "hermes-kanban-trash",
        dragOver ? "hermes-kanban-trash--drop" : "",
        props.draggingTaskId ? "hermes-kanban-trash--active" : "",
      ),
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
      h("span", { className: "hermes-kanban-trash-icon" }, "🗑️"),
      h("span", { className: "hermes-kanban-trash-label" },
        tx(t, "trash.dropHint", FALLBACK_TRASH.dropHint)),
    );
  }

  // -------------------------------------------------------------------------
  // Columns
  // -------------------------------------------------------------------------

  function BoardColumns(props) {
    const columnsRef = useRef(null);
    const panRef = useRef({ isPanning: false, startX: 0, scrollLeft: 0 });
    const [isPanning, setIsPanning] = useState(false);
    const [isScrollable, setIsScrollable] = useState(false);

    const checkScrollable = useCallback(function () {
      const el = columnsRef.current;
      setIsScrollable(!!el && el.scrollWidth > el.clientWidth + 1);
    }, []);

    useEffect(function () {
      checkScrollable();
      const el = columnsRef.current;
      if (!el) return undefined;
      if (typeof ResizeObserver !== "undefined") {
        const observer = new ResizeObserver(checkScrollable);
        observer.observe(el);
        return function () { observer.disconnect(); };
      }
      window.addEventListener("resize", checkScrollable);
      return function () { window.removeEventListener("resize", checkScrollable); };
    }, [checkScrollable, props.board]);

    const isPanBlockedTarget = useCallback(function (target) {
      if (!target) return true;
      if (target.closest && target.closest(".hermes-kanban-card")) return true;
      if (target.closest && target.closest(".hermes-kanban-column-add")) return true;
      if (target.closest && target.closest(".hermes-kanban-col-check")) return true;
      if (target.closest && target.closest("button,input,textarea,select,a,[role='button']")) return true;
      return false;
    }, []);

    const stopPan = useCallback(function () {
      const el = columnsRef.current;
      if (!panRef.current.isPanning) return;
      panRef.current.isPanning = false;
      setIsPanning(false);
      if (el) {
        // Keep cursor feedback instant even before React flushes the state update.
        el.classList.remove("hermes-kanban-columns--panning");
        el.style.userSelect = "";
      }
      if (panRef.current.cleanup) panRef.current.cleanup();
      panRef.current.cleanup = null;
    }, []);

    useEffect(function () {
      return function () { stopPan(); };
    }, [stopPan]);

    const handleMouseDown = useCallback(function (e) {
      if (e.button !== 0) return;
      if (isPanBlockedTarget(e.target)) return;
      const el = columnsRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Preserve the native horizontal scrollbar as a fallback; grab-pan starts above it.
      if (e.clientY >= rect.bottom - 20) return;
      if (el.scrollWidth <= el.clientWidth) return;

      panRef.current.isPanning = true;
      panRef.current.startX = e.clientX;
      panRef.current.scrollLeft = el.scrollLeft;
      setIsPanning(true);
      el.classList.add("hermes-kanban-columns--panning");
      el.style.userSelect = "none";

      function onMouseMove(ev) {
        if (!panRef.current.isPanning) return;
        const dx = ev.clientX - panRef.current.startX;
        el.scrollLeft = panRef.current.scrollLeft - dx;
        ev.preventDefault();
      }
      function onMouseUp() { stopPan(); }

      if (panRef.current.cleanup) panRef.current.cleanup();
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp, { once: true });
      window.addEventListener("blur", onMouseUp, { once: true });
      panRef.current.cleanup = function () {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        window.removeEventListener("blur", onMouseUp);
      };
      e.preventDefault();
    }, [isPanBlockedTarget, stopPan]);

    const handleDragStart = useCallback(function (e) {
      const card = e.target.closest && e.target.closest(".hermes-kanban-card");
      if (!card) return;
      const taskId = card.getAttribute("data-task-id");
      if (taskId && props.onDragStart) props.onDragStart(taskId);
    }, [props.onDragStart]);
    const handleDragEnd = useCallback(function () {
      if (props.onDragEnd) props.onDragEnd();
    }, [props.onDragEnd]);
    return h("div", {
      ref: columnsRef,
      className: cn(
        "hermes-kanban-columns",
        isScrollable ? "hermes-kanban-columns--scrollable" : "",
        isPanning ? "hermes-kanban-columns--panning" : "",
      ),
      onDragStart: handleDragStart,
      onDragEnd: handleDragEnd,
      onMouseDown: handleMouseDown,
    },
      props.board.columns.map(function (col) {
        return h(Column, {
          key: col.name,
          column: col,
          boardMeta: props.boardMeta,
          laneByProfile: props.laneByProfile,
          selectedIds: props.selectedIds,
          failedIds: props.failedIds,
          draggingTaskId: props.draggingTaskId,
          toggleSelected: props.toggleSelected,
          toggleRange: props.toggleRange,
          selectAllInColumn: props.selectAllInColumn,
          onMove: props.onMove,
          onMoveSelected: props.onMoveSelected,
          onOpen: props.onOpen,
          onCreate: props.onCreate,
          allTasks: props.allTasks,
        });
      }),
      h(TrashDropZone, {
        draggingTaskId: props.draggingTaskId,
        selectedIds: props.selectedIds,
        onDelete: props.onDelete,
      }),
    );
  }

  function Column(props) {
    const { t } = useI18n();
    const [dragOver, setDragOver] = useState(false);
    const [showCreate, setShowCreate] = useState(false);
    const colRef = useRef(null);

    // Listen for our synthetic touch-drop events from attachTouchDrag().
    useEffect(function () {
      if (!colRef.current) return undefined;
      const el = colRef.current;
      function onTouchDrop(e) {
        if (e.detail && e.detail.status === props.column.name) {
          const taskId = e.detail.taskId;
          if (props.selectedIds && props.selectedIds.has(taskId) && props.selectedIds.size > 1 && props.onMoveSelected) {
            props.onMoveSelected(props.column.name);
          } else {
            props.onMove(taskId, props.column.name);
          }
        }
      }
      el.addEventListener("hermes-kanban:drop", onTouchDrop);
      return function () { el.removeEventListener("hermes-kanban:drop", onTouchDrop); };
    }, [props.column.name, props.onMove, props.selectedIds, props.onMoveSelected]);

    const handleDragOver = function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (!dragOver) setDragOver(true);
    };
    const handleDragLeave = function () { setDragOver(false); };
    const handleDrop = function (e) {
      e.preventDefault();
      setDragOver(false);
      const taskId = e.dataTransfer.getData(MIME_TASK);
      if (!taskId) return;
      if (props.selectedIds && props.selectedIds.has(taskId) && props.selectedIds.size > 1) {
        if (props.onMoveSelected) props.onMoveSelected(props.column.name);
      } else {
        props.onMove(taskId, props.column.name);
      }
    };

    const lanes = useMemo(function () {
      if (!props.laneByProfile || props.column.name !== "running") return null;
      const byProfile = {};
      for (const tk of props.column.tasks) {
        const key = tk.assignee || "(unassigned)";
        (byProfile[key] = byProfile[key] || []).push(tk);
      }
      return Object.keys(byProfile).sort().map(function (k) {
        return { assignee: k, tasks: byProfile[k] };
      });
    }, [props.column, props.laneByProfile]);

    const colHelp = getColumnHelp(t, props.column.name);
    const colLabel = getColumnLabel(t, props.column.name);

    return h("div", {
      ref: colRef,
      "data-kanban-column": props.column.name,
      className: cn(
        "hermes-kanban-column",
        dragOver ? "hermes-kanban-column--drop" : "",
      ),
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
      h("div", { className: "hermes-kanban-column-header",
                 title: colHelp || "" },
        h(Checkbox, {
          className: "hermes-kanban-col-check",
          title: "Select all tasks in this column",
          "aria-label": `Select all tasks in ${colLabel || props.column.name}`,
          checked: props.column.tasks.length > 0 && props.column.tasks.every(function (t) { return props.selectedIds.has(t.id); }),
          onCheckedChange: function () {
            if (props.selectAllInColumn) props.selectAllInColumn(props.column.name);
          },
          onClick: function (e) { e.stopPropagation(); },
        }),
        h("span", { className: cn("hermes-kanban-dot", COLUMN_DOT[props.column.name]) }),
        h("span", { className: "hermes-kanban-column-label" },
          colLabel || props.column.name),
        h("span", { className: "hermes-kanban-column-count",
                    title: `${props.column.tasks.length} task${props.column.tasks.length === 1 ? "" : "s"} in this column` },
          props.column.tasks.length),
        h("button", {
          type: "button",
          className: "hermes-kanban-column-add",
          title: tx(t, "createTask", "Create task in this column"),
          onClick: function () { setShowCreate(function (v) { return !v; }); },
        }, showCreate ? "×" : "+"),
      ),
      h("div", { className: "hermes-kanban-column-sub" },
        colHelp || ""),
      showCreate ? h(InlineCreate, {
        columnName: props.column.name,
        allTasks: props.allTasks,
        defaultWorkspaceKind: (props.boardMeta && props.boardMeta.default_workspace_kind) || "scratch",
        defaultWorkspacePath: (props.boardMeta && props.boardMeta.default_workdir) || "",
        onSubmit: function (body) {
          props.onCreate(body).then(function () { setShowCreate(false); });
        },
        onCancel: function () { setShowCreate(false); },
      }) : null,
      h("div", { className: "hermes-kanban-column-body" },
        props.column.tasks.length === 0
          ? h("div", { className: "hermes-kanban-empty" }, tx(t, "noTasks", "— no tasks —"))
          : lanes
            ? lanes.map(function (lane) {
                return h("div", { key: lane.assignee, className: "hermes-kanban-lane" },
                  h("div", { className: "hermes-kanban-lane-head" },
                    h("span", { className: "hermes-kanban-lane-name" }, lane.assignee),
                    h("span", { className: "hermes-kanban-lane-count" }, lane.tasks.length),
                  ),
                  lane.tasks.map(function (tk) {
                    return h(TaskCard, {
                      key: tk.id, task: tk,
                      selected: props.selectedIds.has(tk.id),
                      failed: props.failedIds && props.failedIds.has(tk.id),
                      draggingTaskId: props.draggingTaskId,
                      draggingSource: props.draggingTaskId && props.selectedIds.has(props.draggingTaskId) && props.selectedIds.size > 1 && props.selectedIds.has(tk.id),
                      toggleSelected: props.toggleSelected,
                      toggleRange: props.toggleRange,
                      onOpen: props.onOpen,
                    });
                  }),
                );
              })
            : props.column.tasks.map(function (tk) {
                return h(TaskCard, {
                  key: tk.id, task: tk,
                  selected: props.selectedIds.has(tk.id),
                  failed: props.failedIds && props.failedIds.has(tk.id),
                  draggingTaskId: props.draggingTaskId,
                  draggingSource: props.draggingTaskId && props.selectedIds.has(props.draggingTaskId) && props.selectedIds.size > 1 && props.selectedIds.has(tk.id),
                  toggleSelected: props.toggleSelected,
                  toggleRange: props.toggleRange,
                  onOpen: props.onOpen,
                });
              }),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Card
  // -------------------------------------------------------------------------

  // Staleness tiers — amber after a grace window, red when clearly stuck.
  // Values below are seconds.
  const STALENESS = {
    ready:   { amber: 1 * 60 * 60,   red: 24 * 60 * 60 },
    running: { amber: 10 * 60,       red: 60 * 60 },
    blocked: { amber: 1 * 60 * 60,   red: 24 * 60 * 60 },
    todo:    { amber: 7 * 24 * 60 * 60, red: 30 * 24 * 60 * 60 },
  };

  function stalenessClass(task) {
    if (!task || !task.age) return "";
    const age = task.status === "running"
      ? task.age.started_age_seconds
      : task.age.created_age_seconds;
    const tier = STALENESS[task.status];
    if (!tier || age == null) return "";
    if (age >= tier.red)   return "hermes-kanban-card--stale-red";
    if (age >= tier.amber) return "hermes-kanban-card--stale-amber";
    return "";
  }

  function TaskCard(props) {
    const { t: i18n } = useI18n();
    const t = props.task;
    const cardRef = useRef(null);

    useEffect(function () {
      return attachTouchDrag(cardRef.current, t.id);
    }, [t.id]);

    const handleDragStart = function (e) {
      e.dataTransfer.setData(MIME_TASK, t.id);
      e.dataTransfer.effectAllowed = "move";
      const selectedCards = document.querySelectorAll(".hermes-kanban-card--selected");
      if (selectedCards.length > 1 && props.selected) {
        const ghost = document.createElement("div");
        ghost.className = "hermes-kanban-drag-ghost";
        ghost.textContent = selectedCards.length + " cards";
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 0, 0);
        requestAnimationFrame(function () {
          if (ghost.parentNode) document.body.removeChild(ghost);
        });
      }
    };
    const handleClick = function (e) {
      if (e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (props.toggleRange) props.toggleRange(t.id);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        props.toggleSelected(t.id, true);
        return;
      }
      props.onOpen(t.id);
    };
    const handleKeyDown = function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        props.onOpen(t.id);
      }
      if (e.key === "Escape") {
        if (props.toggleSelected) props.toggleSelected(t.id, false);
      }
    };
    const handleCheckedChange = function () {
      props.toggleSelected(t.id, true);
    };

    const progress = t.progress;
    const needsAssignee = t.status === "ready" && !t.assignee;

    return h("div", {
      ref: cardRef,
      "data-task-id": t.id,
      className: cn(
        "hermes-kanban-card",
        props.selected ? "hermes-kanban-card--selected" : "",
        props.failed ? "hermes-kanban-card--failed" : "",
        props.draggingSource ? "hermes-kanban-card--dragging-source" : "",
        stalenessClass(t),
      ),
      draggable: true,
      tabIndex: 0,
      role: "button",
      "aria-label": `${t.title || "untitled"} — ${t.id} — ${t.status}`,
      onDragStart: handleDragStart,
      onClick: handleClick,
      onKeyDown: handleKeyDown,
    },
      h(Card, null,
        h(CardContent, { className: "hermes-kanban-card-content" },
          h("div", { className: "hermes-kanban-card-row" },
            h("label", {
              className: "hermes-kanban-card-check-wrap",
              title: tx(i18n, "selectForBulk", "Select for bulk actions"),
              onClick: function (e) { e.stopPropagation(); },
            },
              h(Checkbox, {
                className: "hermes-kanban-card-check",
                checked: props.selected,
                onCheckedChange: handleCheckedChange,
                onClick: function (e) { e.stopPropagation(); },
                "aria-label": `Select task ${t.id}`,
              }),
            ),
            h("span", { className: "hermes-kanban-card-id",
                        title: `Task id: ${t.id}. Use this id with kanban_show, /kanban show, or hermes kanban show.` }, t.id),
            t.warnings && t.warnings.count > 0
              ? h("span", {
                  className: cn(
                    "hermes-kanban-warning-badge",
                    "hermes-kanban-warning-badge--" + (t.warnings.highest_severity || "warning"),
                  ),
                  title: (
                    `${t.warnings.count} active diagnostic` +
                    (t.warnings.count === 1 ? "" : "s") +
                    ` (severity: ${t.warnings.highest_severity || "warning"}). ` +
                    `Click to open for details.`
                  ),
                }, t.warnings.highest_severity === "critical" ? "!!!" :
                   t.warnings.highest_severity === "error" ? "!!" : "⚠")
              : null,
            t.priority > 0
              ? h(Badge, { className: "hermes-kanban-priority",
                           title: `Priority ${t.priority}. Higher-priority tasks are claimed first by the dispatcher.` }, `P${t.priority}`)
              : null,
            t.tenant
              ? h(Badge, { variant: "outline", className: "hermes-kanban-tag",
                           title: `Tenant: ${t.tenant}. Free-form tag for grouping tasks (customer, project, team).` }, t.tenant)
              : null,
            progress
              ? h("span", {
                  className: cn(
                    "hermes-kanban-progress",
                    progress.done === progress.total ? "hermes-kanban-progress--full" : "",
                  ),
                  title: `${progress.done} of ${progress.total} child tasks done`,
                }, `${progress.done}/${progress.total}`)
              : null,
            needsAssignee
              ? h(Badge, {
                  variant: "outline",
                  className: "hermes-kanban-needs-assignee",
                  title: tx(i18n, "needsAssigneeHint", "Dependencies are satisfied, but the dispatcher skips this task until you assign a profile."),
                }, tx(i18n, "needsAssignee", "Needs assignee"))
              : null,
          ),
          h("div", { className: "hermes-kanban-card-title" },
            t.title || tx(i18n, "untitled", "(untitled)")),
          h("div", { className: "hermes-kanban-card-row hermes-kanban-card-meta" },
            t.assignee
              ? h("span", { className: "hermes-kanban-assignee",
                            title: `Assigned to Hermes profile @${t.assignee}` }, "@", t.assignee)
              : h("span", { className: "hermes-kanban-unassigned",
                            title: needsAssignee
                              ? tx(i18n, "needsAssigneeHint", "Dependencies are satisfied, but the dispatcher skips this task until you assign a profile.")
                              : "No profile assigned." },
                  tx(i18n, "unassigned", "unassigned")),
            t.comment_count > 0
              ? h("span", { className: "hermes-kanban-count",
                            title: `${t.comment_count} comment${t.comment_count === 1 ? "" : "s"} on this task` }, "💬 ", t.comment_count)
              : null,
            t.link_counts && (t.link_counts.parents + t.link_counts.children) > 0
              ? h("span", { className: "hermes-kanban-count",
                            title: `${t.link_counts.parents} parent${t.link_counts.parents === 1 ? "" : "s"}, ${t.link_counts.children} child${t.link_counts.children === 1 ? "" : "ren"}. Children stay blocked until their parent is done.` },
                  "↔ ", t.link_counts.parents + t.link_counts.children)
              : null,
            h("span", { className: "hermes-kanban-ago",
                        title: t.created_at ? `Created ${t.created_at}` : "" },
              timeAgo ? timeAgo(t.created_at) : ""),
          ),
        ),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Create-task dialog (modal, with parent selector)
  //
  // Launched from a column's [+] button. Was an inline form squeezed into
  // the ~280px column (8 fields, unlabeled, no room to breathe); now a
  // centered modal reusing the hermes-kanban-dialog chrome so the form is
  // resizable-window friendly and every field has a visible label.
  // -------------------------------------------------------------------------

  function InlineCreate(props) {
    const { t } = useI18n();
    const [title, setTitle] = useState("");
    const [assignee, setAssignee] = useState("");
    const [priority, setPriority] = useState(0);
    const [parent, setParent] = useState("");
    const [skills, setSkills] = useState("");
    // A board with a configured workdir defaults to a persistent workspace:
    // worktree for git repositories, dir for ordinary directories. Boards
    // without one keep scratch for disposable research and ops tasks.
    const defaultWorkspaceKind = props.defaultWorkspaceKind || "scratch";
    const defaultWorkspacePath = props.defaultWorkspacePath || "";
    const [workspaceKind, setWorkspaceKind] = useState(defaultWorkspaceKind);
    const [workspacePath, setWorkspacePath] = useState(defaultWorkspacePath);
    // Goal-mode: when on, the dispatched worker runs the Ralph-style /goal
    // loop — a judge re-checks the card after each turn and the worker keeps
    // going in the same session until done, or the turn budget runs out
    // (which blocks the card for review). goalMaxTurns is optional; blank
    // = backend default.
    const [goalMode, setGoalMode] = useState(false);
    const [goalMaxTurns, setGoalMaxTurns] = useState("");

    const submit = function () {
      const trimmed = title.trim();
      if (!trimmed) return;
      const body = {
        title: trimmed,
        assignee: assignee.trim() || null,
        priority: Number(priority) || 0,
        triage: props.columnName === "triage",
      };
      if (parent) body.parents = [parent];
      // Parse comma-separated skills into a clean list. Blank = no
      // extras (omit key so backend leaves it null). The dispatcher
      // always auto-loads kanban-worker; these are extras on top.
      const skillList = skills
        .split(",")
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s.length > 0; });
      if (skillList.length > 0) body.skills = skillList;
      // Only send workspace_kind when it's non-default. Keeps the request
      // shape small and interoperable with older dispatcher versions.
      if (workspaceKind && workspaceKind !== "scratch") {
        body.workspace_kind = workspaceKind;
      }
      const wpTrim = workspacePath.trim();
      if (wpTrim) body.workspace_path = wpTrim;
      // Goal-mode toggle. Only send the keys when enabled so the request
      // shape stays small and old dispatchers ignore it cleanly.
      if (goalMode) {
        body.goal_mode = true;
        const gmt = parseInt(goalMaxTurns, 10);
        if (Number.isFinite(gmt) && gmt > 0) body.goal_max_turns = gmt;
      }
      props.onSubmit(body);
      setTitle(""); setAssignee(""); setPriority(0); setParent(""); setSkills("");
      setWorkspaceKind(defaultWorkspaceKind); setWorkspacePath(defaultWorkspacePath);
      setGoalMode(false); setGoalMaxTurns("");
    };

    const showPathInput = workspaceKind !== "scratch";
    const pathPlaceholder = workspaceKind === "dir"
      ? tx(t, "workspacePathDir", "workspace path (required without a board workdir)")
      : tx(t, "workspacePathOptional",
          "repository path (optional when the board has a workdir)");

    const fieldLabel = function (text, hint) {
      return h(Label, { className: "text-xs" }, text,
        hint ? h("span", { className: "text-muted-foreground" }, " ", hint) : null);
    };

    return h("div", {
      className: "hermes-kanban-dialog-backdrop",
      onClick: function (e) { if (e.target === e.currentTarget) props.onCancel(); },
      onKeyDown: function (e) { if (e.key === "Escape") props.onCancel(); },
    },
      h("form", {
        className: "hermes-kanban-dialog hermes-kanban-create-dialog",
        onSubmit: function (e) { e.preventDefault(); submit(); },
      },
        h("div", { className: "hermes-kanban-dialog-title" },
          tx(t, "newTaskTitle", "New task — {column}",
            { column: getColumnLabel(t, props.columnName) || props.columnName })),
        h("div", { className: "flex flex-col gap-3" },
          h("div", { className: "flex flex-col gap-1" },
            fieldLabel(tx(t, "taskTitleLabel", "Title")),
            h("textarea", {
              value: title,
              onChange: function (e) { setTitle(e.target.value); },
              onKeyDown: function (e) {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
              },
              placeholder: props.columnName === "triage"
                ? tx(t, "triagePlaceholder", "Rough idea — AI will spec it…")
                : tx(t, "taskTitlePlaceholder", "New task title…"),
              autoFocus: true,
              className: "text-sm min-h-[3rem] max-h-48 resize-y w-full border border-input bg-transparent px-2 py-1 rounded-md focus:outline-none focus:ring-2 focus:ring-ring",
              rows: 3,
            }),
          ),
          h("div", { className: "flex gap-2" },
            h("div", { className: "flex flex-col gap-1 flex-1" },
              fieldLabel(props.columnName === "triage"
                ? tx(t, "specifier", "specifier")
                : tx(t, "assigneeLabel", "Assignee"),
                tx(t, "assigneeLabelHint", "(blank = dispatcher picks)")),
              h(Input, {
                value: assignee,
                onChange: function (e) { setAssignee(e.target.value); },
                placeholder: props.columnName === "triage"
                  ? tx(t, "specifier", "specifier")
                  : tx(t, "assigneePlaceholder", "assignee"),
                className: "h-8 text-sm",
                title: props.columnName === "triage"
                  ? "Hermes profile that will spec this task (default: the dispatcher's configured specifier). Leave blank to let the dispatcher pick."
                  : "Hermes profile to assign. Leave blank and the dispatcher will pick from available profiles when the task is Ready.",
                style: { textTransform: "none" },
                autoCapitalize: "none",
                autoCorrect: "off",
                spellCheck: false,
              }),
            ),
            h("div", { className: "flex flex-col gap-1 w-20" },
              fieldLabel(tx(t, "priority", "Priority")),
              h(Input, {
                type: "number",
                value: priority,
                onChange: function (e) { setPriority(e.target.value); },
                placeholder: "pri",
                className: "h-8 text-sm",
                title: "Priority. Higher-priority tasks are claimed first by the dispatcher. 0 = default.",
              }),
            ),
          ),
          h("div", { className: "flex flex-col gap-1" },
            fieldLabel(tx(t, "skillsLabel", "Skills"),
              tx(t, "skillsLabelHint", "(optional, comma-separated)")),
            h(Input, {
              value: skills,
              onChange: function (e) { setSkills(e.target.value); },
              placeholder: tx(t, "skillsPlaceholder",
                "skills (optional, comma-separated): translation, github-code-review"),
              title: "Force-load these skills into the worker (in addition to the built-in kanban-worker).",
              className: "h-8 text-sm",
            }),
          ),
          h("div", { className: "flex flex-col gap-1" },
            fieldLabel(tx(t, "workspace", "Workspace")),
            h("div", { className: "flex gap-2" },
              h(Select, Object.assign({
                value: workspaceKind,
                title: "Choose whether task files are temporary or preserved after completion.",
                className: "h-8 text-sm flex-1",
              }, selectChangeHandler(setWorkspaceKind)),
                h(SelectOption, { value: "scratch" },
                  tx(t, "workspaceScratch", "Temporary — deleted on completion")),
                h(SelectOption, { value: "worktree" },
                  tx(t, "workspaceWorktree", "Git worktree — preserved")),
                h(SelectOption, { value: "dir" },
                  tx(t, "workspaceDir", "Directory — preserved")),
              ),
              showPathInput ? h(Input, {
                value: workspacePath,
                onChange: function (e) { setWorkspacePath(e.target.value); },
                placeholder: pathPlaceholder,
                className: "h-8 text-sm flex-1",
              }) : null,
            ),
            workspaceKind === "scratch" ? h("div", {
              className: "text-xs text-destructive",
              role: "alert",
            }, tx(t, "workspaceScratchWarning",
              "This workspace and any files left in it are deleted when the task completes.")) : null,
          ),
          h("div", { className: "flex flex-col gap-1" },
            fieldLabel(tx(t, "parentLabel", "Parent task"),
              tx(t, "parentLabelHint", "(child stays blocked until the parent is done)")),
            h(Select, Object.assign({
              value: parent,
              className: "h-8 text-sm",
              title: "Optional parent task. A child stays blocked in its current column until the parent is marked done.",
            }, selectChangeHandler(setParent)),
              h(SelectOption, { value: "" }, tx(t, "noParent", "— no parent —")),
              (props.allTasks || []).map(function (task) {
                return h(SelectOption, { key: task.id, value: task.id },
                  `${task.id} — ${(task.title || "").slice(0, 50)}`);
              }),
            ),
          ),
          h("div", { className: "flex gap-2 items-center" },
            h("label", {
              className: "flex items-center gap-1.5 text-xs cursor-pointer select-none",
              title: "Goal mode: the worker keeps going in the same session until a judge agrees the card is done (or the turn budget runs out, which blocks it for review). Best for open-ended cards one shot rarely finishes.",
            },
              h("input", {
                type: "checkbox",
                checked: goalMode,
                onChange: function (e) { setGoalMode(!!e.target.checked); },
                className: "h-3.5 w-3.5 accent-current",
              }),
              tx(t, "goalMode", "goal mode"),
            ),
            goalMode ? h(Input, {
              type: "number",
              value: goalMaxTurns,
              onChange: function (e) { setGoalMaxTurns(e.target.value); },
              placeholder: tx(t, "goalMaxTurns", "max turns (default 20)"),
              className: "h-8 text-sm w-44",
              title: "Turn budget for the goal loop. Blank = backend default (20).",
              min: 1,
            }) : null,
          ),
        ),
        h("div", { className: "hermes-kanban-dialog-actions" },
          h(Button, {
            type: "button",
            onClick: props.onCancel,
            size: "sm",
          }, tx(t, "cancel", "Cancel")),
          h(Button, {
            type: "submit",
            size: "sm",
            disabled: !title.trim(),
          }, tx(t, "create", "Create")),
        ),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Task drawer
  // -------------------------------------------------------------------------

  function TaskDrawer(props) {
    const { t } = useI18n();
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState(null);
    // Surface PATCH failures (e.g. 409 "parent not done") right next to
    // the drawer's action row — without it, the drawer's only error
    // surface (``err``) is hidden behind the loaded ``data`` and the
    // Ready/Block/Complete buttons feel like no-ops.  See #26744.
    const [patchErr, setPatchErr] = useState(null);
    const [newComment, setNewComment] = useState("");
    const [uploadBusy, setUploadBusy] = useState(false);
    const [uploadErr, setUploadErr] = useState(null);
    const [editing, setEditing] = useState(false);
    // Home-channel notification toggles. homeChannels is the list of platforms
    // the user has a /sethome on; each entry has a `subscribed` bool telling
    // us whether this task is currently subscribed via that platform's home.
    const [homeChannels, setHomeChannels] = useState([]);
    const [homeBusy, setHomeBusy] = useState({});
    const boardSlug = props.boardSlug;

    const load = useCallback(function () {
      return SDK.fetchJSON(withBoard(`${API}/tasks/${encodeURIComponent(props.taskId)}`, boardSlug))
        .then(function (d) { setData(d); setErr(null); setPatchErr(null); })
        .catch(function (e) { setErr(String(e.message || e)); })
        .finally(function () { setLoading(false); });
    }, [props.taskId, boardSlug]);

    const loadHomeChannels = useCallback(function () {
      const qs = new URLSearchParams({ task_id: props.taskId });
      const url = withBoard(`${API}/home-channels?${qs}`, boardSlug);
      return SDK.fetchJSON(url)
        .then(function (d) { setHomeChannels(d.home_channels || []); })
        .catch(function () { /* silent — endpoint optional on older gateways */ });
    }, [props.taskId, boardSlug]);

    // Reload when the WS stream reports new events for this task id
    // (completion, block, crash, etc. — anything that'd make the drawer
    // show stale data if we only loaded on mount).
    useEffect(function () { load(); }, [load, props.eventTick]);
    useEffect(function () { loadHomeChannels(); }, [loadHomeChannels]);
    useEffect(function () {
      function onKey(e) { if (e.key === "Escape" && !editing) props.onClose(); }
      window.addEventListener("keydown", onKey);
      return function () { window.removeEventListener("keydown", onKey); };
    }, [props.onClose, editing]);

    const handleComment = function () {
      const body = newComment.trim();
      if (!body) return;
      SDK.fetchJSON(withBoard(`${API}/tasks/${encodeURIComponent(props.taskId)}/comments`, boardSlug), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      }).then(function () {
        setNewComment("");
        load();
        props.onRefresh();
      }).catch(function (e) { setErr(String(e.message || e)); });
    };

    // File upload uses raw fetch (not SDK.fetchJSON, which JSON-encodes)
    // so the browser sets the multipart boundary. Auth rides the session
    // cookie + bearer token, matching the rest of the dashboard.
    const handleUpload = function (fileList) {
      const files = Array.prototype.slice.call(fileList || []);
      if (!files.length) return;
      setUploadBusy(true);
      setUploadErr(null);
      const url = withBoard(`${API}/tasks/${encodeURIComponent(props.taskId)}/attachments`, boardSlug);
      // Upload sequentially so a partial failure leaves a clear state.
      let chain = Promise.resolve();
      files.forEach(function (f) {
        chain = chain.then(function () {
          const fd = new FormData();
          fd.append("file", f, f.name);
          // SDK.authedFetch handles auth in BOTH modes (loopback token header /
          // gated cookie) and applies the dashboard base-path prefix. The old
          // hand-rolled Authorization:Bearer + credentials:'same-origin' sent
          // an empty token and 401'd in gated mode.
          return SDK.authedFetch(url, { method: "POST", body: fd })
            .then(function (resp) {
              if (!resp.ok) {
                return resp.text().then(function (txt) {
                  throw new Error(parseApiErrorMessage(new Error(resp.status + ": " + txt)));
                });
              }
            });
        });
      });
      chain.then(function () {
        load();
        props.onRefresh();
      }).catch(function (e) {
        setUploadErr(String(e.message || e));
      }).finally(function () {
        setUploadBusy(false);
      });
    };

    const handleDeleteAttachment = function (attachmentId) {
      return SDK.fetchJSON(withBoard(`${API}/attachments/${attachmentId}`, boardSlug), { method: "DELETE" })
        .then(function () { load(); props.onRefresh(); })
        .catch(function (e) { setUploadErr(String(e.message || e)); });
    };

    const doPatch = function (patch, opts) {
      if (opts && opts.confirm && !window.confirm(opts.confirm)) {
        return Promise.resolve();
      }
      const finalPatch = withCompletionSummary(patch, 1);
      if (!finalPatch) return Promise.resolve();
      setPatchErr(null);
      return SDK.fetchJSON(withBoard(`${API}/tasks/${encodeURIComponent(props.taskId)}`, boardSlug), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(finalPatch),
      }).then(function () { load(); props.onRefresh(); })
        .catch(function (e) { setPatchErr(parseApiErrorMessage(e)); });
    };

    // Triage specifier — calls the auxiliary LLM to flesh out a rough
    // idea in the Triage column into a concrete spec (title + body with
    // goal, approach, acceptance criteria) and promotes it to todo.
    // Not a PATCH: runs through a dedicated POST endpoint because the
    // LLM call can take tens of seconds, and its outcome is richer than
    // a status flip (may update title AND body AND emit an audit
    // comment — or fail with a human-readable reason that the UI
    // surfaces inline without treating it as an HTTP error).
    const doSpecify = function () {
      return SDK.fetchJSON(
        withBoard(`${API}/tasks/${encodeURIComponent(props.taskId)}/specify`, boardSlug),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }
      ).then(function (res) {
        load();
        props.onRefresh();
        return res;
      });
    };

    // POST /tasks/:id/decompose — fan a triage task out into a graph
    // of child tasks routed to specialist profiles by description.
    // Refreshes both the drawer (so the user sees the root flip to
    // todo) and the board (so the new children appear in the columns).
    const doDecompose = function () {
      return SDK.fetchJSON(
        withBoard(`${API}/tasks/${encodeURIComponent(props.taskId)}/decompose`, boardSlug),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }
      ).then(function (res) {
        load();
        props.onRefresh();
        return res;
      });
    };

    const addLink = function (parentId) {
      return SDK.fetchJSON(withBoard(`${API}/links`, boardSlug), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent_id: parentId, child_id: props.taskId }),
      }).then(function () { load(); props.onRefresh(); })
        .catch(function (e) { setErr(String(e.message || e)); });
    };
    const removeLink = function (parentId) {
      const qs = new URLSearchParams({ parent_id: parentId, child_id: props.taskId });
      return SDK.fetchJSON(withBoard(`${API}/links?${qs}`, boardSlug), { method: "DELETE" })
        .then(function () { load(); props.onRefresh(); })
        .catch(function (e) { setErr(String(e.message || e)); });
    };
    const addChild = function (childId) {
      return SDK.fetchJSON(withBoard(`${API}/links`, boardSlug), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent_id: props.taskId, child_id: childId }),
      }).then(function () { load(); props.onRefresh(); })
        .catch(function (e) { setErr(String(e.message || e)); });
    };
    const removeChild = function (childId) {
      const qs = new URLSearchParams({ parent_id: props.taskId, child_id: childId });
      return SDK.fetchJSON(withBoard(`${API}/links?${qs}`, boardSlug), { method: "DELETE" })
        .then(function () { load(); props.onRefresh(); })
        .catch(function (e) { setErr(String(e.message || e)); });
    };

    const toggleHomeSubscription = function (platform, currentlySubscribed) {
      // Optimistic flip + busy flag to keep double-clicks idempotent.
      setHomeBusy(function (b) { return Object.assign({}, b, { [platform]: true }); });
      setHomeChannels(function (list) {
        return list.map(function (h) {
          return h.platform === platform
            ? Object.assign({}, h, { subscribed: !currentlySubscribed })
            : h;
        });
      });
      const method = currentlySubscribed ? "DELETE" : "POST";
      const url = withBoard(
        `${API}/tasks/${encodeURIComponent(props.taskId)}/home-subscribe/${encodeURIComponent(platform)}`,
        boardSlug,
      );
      return SDK.fetchJSON(url, { method: method })
        .then(function () { return loadHomeChannels(); })
        .catch(function (e) {
          // Revert optimistic flip on failure.
          setHomeChannels(function (list) {
            return list.map(function (h) {
              return h.platform === platform
                ? Object.assign({}, h, { subscribed: currentlySubscribed })
                : h;
            });
          });
          setErr(String(e.message || e));
        })
        .finally(function () {
          setHomeBusy(function (b) {
            const next = Object.assign({}, b);
            delete next[platform];
            return next;
          });
        });
    };

    return h("div", { className: "hermes-kanban-drawer-shade", onClick: props.onClose },
      h("div", {
        className: "hermes-kanban-drawer",
        onClick: function (e) { e.stopPropagation(); },
      },
        h("div", { className: "hermes-kanban-drawer-head" },
          h("span", { className: "text-xs text-muted-foreground" }, props.taskId),
          h("button", {
            type: "button",
            onClick: props.onClose,
            className: "hermes-kanban-drawer-close",
            title: tx(t, "close", "Close (Esc)"),
          }, "×"),
        ),
        loading ? h("div", { className: "p-4 text-sm text-muted-foreground" },
          tx(t, "loadingDetail", "Loading…")) :
        err ? h("div", { className: "p-4 text-sm text-destructive" }, err) :
        data ? h(TaskDetail, {
          data, editing, setEditing,
          renderMarkdown: props.renderMarkdown,
          allTasks: props.allTasks,
          assignees: props.assignees || [],
          boardSlug: boardSlug,
          onPatch: doPatch,
          onSpecify: doSpecify,
          onDecompose: doDecompose,
          onAddParent: addLink,
          onRemoveParent: removeLink,
          onAddChild: addChild,
          onRemoveChild: removeChild,
          homeChannels: homeChannels,
          homeBusy: homeBusy,
          onToggleHomeSub: toggleHomeSubscription,
          onRefresh: props.onRefresh,
          onUpload: handleUpload,
          onDeleteAttachment: handleDeleteAttachment,
          uploadBusy: uploadBusy,
          uploadErr: uploadErr,
          onOpenTask: function (taskId) {
            props.onClose();
            if (props.onOpenTask) props.onOpenTask(taskId);
          },
        }) : null,
        data ? h("div", { className: "hermes-kanban-drawer-comment-foot" },
          h("div", {
            className: "hermes-kanban-comment-hint text-xs text-muted-foreground",
            title: tx(t, "commentHintTitle",
              "Comments are the channel for talking to a task's worker. They land on the thread immediately — no need to block the task first. A running worker picks the thread up on its next kanban_show() or respawn; blocking is only for when you want the worker to STOP and wait for your input."),
          },
            "ⓘ ",
            tx(t, "commentHint",
              "Comments reach the worker on its next run or kanban_show() — no need to block the task first."),
          ),
          h("div", { className: "hermes-kanban-drawer-comment-row" },
            h(Input, {
              value: newComment,
              onChange: function (e) { setNewComment(e.target.value); },
              onKeyDown: function (e) {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault(); handleComment();
                }
              },
              placeholder: tx(t, "addComment", "Add a comment… (Enter to submit)"),
              className: "h-8 text-sm flex-1",
            }),
            h(Button, {
              onClick: handleComment,
              size: "sm",
            }, tx(t, "comment", "Comment")),
          ),
        ) : null,
      ),
    );
  }

  function _fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  // Attachments section in the task drawer (#35338). Upload button +
  // list with download links and a delete (×) per row. The download
  // link hits GET /attachments/:id which streams the file; the worker
  // context surfaces the same files' absolute paths so a kanban worker
  // can read them with the file/terminal tools.
  function AttachmentsSection(props) {
    const i18n = props.i18n;
    const atts = props.attachments || [];
    const fileRef = useRef(null);
    const [dlErr, setDlErr] = useState(null);
    // Download via authenticated fetch → blob → synthetic anchor click.
    // A plain <a href> can't carry the auth the dashboard middleware requires,
    // so fetch authenticated and hand the browser a blob URL instead.
    function downloadAttachment(a) {
      // SDK.authedFetch handles auth in BOTH modes (loopback token header /
      // gated cookie) and applies the dashboard base-path prefix. The old
      // hand-rolled Authorization:Bearer + credentials:'same-origin' sent an
      // empty token and 401'd in gated mode.
      const url = withBoard(`${API}/attachments/${a.id}`, props.boardSlug);
      setDlErr(null);
      SDK.authedFetch(url)
        .then(function (resp) {
          if (!resp.ok) {
            return resp.text().then(function (txt) {
              throw new Error(parseApiErrorMessage(new Error(resp.status + ": " + txt)));
            });
          }
          return resp.blob();
        })
        .then(function (blob) {
          const objUrl = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = objUrl;
          link.download = a.filename || "attachment";
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          setTimeout(function () { URL.revokeObjectURL(objUrl); }, 10000);
        })
        .catch(function (e) { setDlErr(String(e.message || e)); });
    }
    return h("div", { className: "hermes-kanban-section" },
      h("div", { className: "hermes-kanban-section-head" },
        `${tx(i18n, "attachments", "Attachments")} (${atts.length})`),
      h("input", {
        ref: fileRef,
        type: "file",
        multiple: true,
        style: { display: "none" },
        onChange: function (e) {
          if (props.onUpload) props.onUpload(e.target.files);
          // Reset so selecting the same file again re-triggers onChange.
          try { e.target.value = ""; } catch (_e) { /* ignore */ }
        },
      }),
      h("div", { className: "flex items-center gap-2 mb-2" },
        h(Button, {
          size: "sm",
          variant: "outline",
          disabled: !!props.uploadBusy,
          onClick: function () { if (fileRef.current) fileRef.current.click(); },
        }, props.uploadBusy
            ? tx(i18n, "uploading", "Uploading…")
            : tx(i18n, "uploadFile", "Upload file")),
      ),
      (props.uploadErr || dlErr)
        ? h("div", { className: "text-xs text-destructive mb-2" }, props.uploadErr || dlErr)
        : null,
      atts.length === 0
        ? h("div", { className: "text-xs text-muted-foreground" },
            tx(i18n, "noAttachments", "— no attachments —"))
        : atts.map(function (a) {
            return h("div", {
              key: a.id,
              className: "flex items-center justify-between gap-2 py-1 text-sm",
            },
              h("button", {
                type: "button",
                className: "hermes-kanban-attachment-link truncate",
                title: a.filename,
                onClick: function () { downloadAttachment(a); },
              }, a.filename),
              h("span", { className: "text-xs text-muted-foreground whitespace-nowrap" },
                _fmtBytes(a.size)),
              h("button", {
                type: "button",
                className: "hermes-kanban-drawer-close",
                title: tx(i18n, "removeAttachment", "Remove attachment"),
                onClick: function () {
                  if (window.confirm(tx(i18n, "confirmRemoveAttachment",
                      "Remove this attachment?"))) {
                    if (props.onDelete) props.onDelete(a.id);
                  }
                },
              }, "×"),
            );
          }),
    );
  }

  function TaskDetail(props) {
    const { t: i18n } = useI18n();
    const t = props.data.task;
    const comments = props.data.comments || [];
    const events = props.data.events || [];
    const attachments = props.data.attachments || [];
    const links = props.data.links || { parents: [], children: [] };
    const childResults = props.data.child_results || [];

    return h("div", { className: "hermes-kanban-drawer-body" },
      h("div", { className: "hermes-kanban-drawer-title" },
        h("span", { className: cn("hermes-kanban-dot", COLUMN_DOT[t.status]) }),
        props.editing
          ? h(TitleEditor, {
              initial: t.title || "",
              onSave: function (newTitle) {
                return props.onPatch({ title: newTitle }).then(function () { props.setEditing(false); });
              },
              onCancel: function () { props.setEditing(false); },
            })
          : h("span", {
              className: "hermes-kanban-drawer-title-text",
              title: tx(i18n, "clickToEdit", "Click to edit"),
              onClick: function () { props.setEditing(true); },
            }, t.title || tx(i18n, "untitled", "(untitled)")),
      ),
      h("div", { className: "hermes-kanban-drawer-meta" },
        h(MetaRow, { label: tx(i18n, "status", "Status"), value: t.status }),
        h(AssigneeEditor, { task: t, onPatch: props.onPatch }),
        h(PriorityEditor, { task: t, onPatch: props.onPatch }),
        t.tenant ? h(MetaRow, { label: tx(i18n, "tenant", "Tenant"), value: t.tenant }) : null,
        h(MetaRow, {
          label: tx(i18n, "workspace", "Workspace"),
          value: `${t.workspace_kind}${t.workspace_path ? ": " + t.workspace_path : ""}`,
        }),
        (t.skills && t.skills.length > 0) ? h(MetaRow, {
          label: tx(i18n, "skills", "Skills"),
          value: t.skills.join(", "),
        }) : null,
        t.goal_mode ? h(MetaRow, {
          label: tx(i18n, "goalMode", "Goal mode"),
          value: t.goal_max_turns
            ? `on (max ${t.goal_max_turns} turns)`
            : "on",
        }) : null,
        t.created_by ? h(MetaRow, { label: tx(i18n, "createdBy", "Created by"), value: t.created_by }) : null,
      ),
      h(StatusActions, {
        task: t,
        onPatch: props.onPatch,
        onSpecify: props.onSpecify,
        onDecompose: props.onDecompose,
      }),
      h(DiagnosticsSection, {
        task: t,
        boardSlug: props.boardSlug,
        assignees: props.assignees,
        diagnostics: t.diagnostics || [],
        onRefresh: props.onRefresh,
      }),
      h(HomeSubsSection, {
        homeChannels: props.homeChannels || [],
        homeBusy: props.homeBusy || {},
        onToggle: props.onToggleHomeSub,
      }),
      h(BodyEditor, {
        task: t,
        renderMarkdown: props.renderMarkdown,
        onPatch: props.onPatch,
      }),
      h(DependencyEditor, {
        task: t,
        links, allTasks: props.allTasks,
        onAddParent: props.onAddParent,
        onRemoveParent: props.onRemoveParent,
        onAddChild: props.onAddChild,
        onRemoveChild: props.onRemoveChild,
      }),
      (function () {
        var finalResult = t.result || t.latest_summary || null;
        var isDone = t.status === "done";
        var isParent = links.children.length > 0;
        if (finalResult) {
          var label = t.result
            ? tx(i18n, "result", "Result")
            : tx(i18n, "finalResult", "Final Result (run summary)");
          return h("div", { className: "hermes-kanban-section" },
            h("div", { className: "hermes-kanban-section-head" }, label),
            h(MarkdownBlock, { source: finalResult, enabled: props.renderMarkdown }),
          );
        }
        if (isDone && isParent) {
          return h("div", { className: "hermes-kanban-section" },
            h("div", { className: "hermes-kanban-section-head" }, tx(i18n, "result", "Result")),
            h("div", { className: "hermes-kanban-done-no-result hermes-kanban-done-parent-note" },
              tx(i18n, "doneParentNote",
                "This card is an orchestrator / parent task. Review the child results section for the substantive work."),
            ),
          );
        }
        if (isDone) {
          return h("div", { className: "hermes-kanban-section" },
            h("div", { className: "hermes-kanban-section-head" }, tx(i18n, "result", "Result")),
            h("div", { className: "hermes-kanban-done-no-result" },
              tx(i18n, "doneNoResult",
                "No final result was recorded. Check Run History, Logs, or Child Tasks for the worker output."),
            ),
          );
        }
        return null;
      })(),
      childResults.length > 0 ? h("div", { className: "hermes-kanban-section" },
        h("div", { className: "hermes-kanban-section-head" },
          `${tx(i18n, "childResults", "Child Results")} (${childResults.length})`),
        childResults.map(function (child) {
          var childResult = child.result || child.latest_summary || null;
          return h("div", { key: child.id, className: "hermes-kanban-comment" },
            h("div", { className: "hermes-kanban-comment-head" },
              h("span", { className: "hermes-kanban-comment-author" },
                `${child.id} · ${child.title || tx(i18n, "untitled", "(untitled)")}`),
              h(Badge, { variant: "outline" }, child.status),
              h("button", {
                type: "button",
                className: "hermes-kanban-diag-action-btn",
                onClick: function () { if (props.onOpenTask) props.onOpenTask(child.id); },
              }, tx(i18n, "open", "Open")),
            ),
            childResult
              ? h(MarkdownBlock, { source: childResult, enabled: props.renderMarkdown })
              : h("div", { className: "text-xs text-muted-foreground" },
                  tx(i18n, "noChildResult", "No result recorded yet.")),
          );
        }),
      ) : null,
      h(AttachmentsSection, {
        attachments: attachments,
        boardSlug: props.boardSlug,
        onUpload: props.onUpload,
        onDelete: props.onDeleteAttachment,
        uploadBusy: props.uploadBusy,
        uploadErr: props.uploadErr,
        i18n: i18n,
      }),
      h("div", { className: "hermes-kanban-section" },
        h("div", { className: "hermes-kanban-section-head" },
          `${tx(i18n, "comments", "Comments")} (${comments.length})`),
        comments.length === 0
          ? h("div", { className: "text-xs text-muted-foreground" },
              tx(i18n, "noComments", "— no comments —"))
          : comments.map(function (c) {
              return h("div", { key: c.id, className: "hermes-kanban-comment" },
                h("div", { className: "hermes-kanban-comment-head" },
                  h("span", { className: "hermes-kanban-comment-author" }, c.author || "anon"),
                  h("span", { className: "hermes-kanban-comment-ago" },
                    timeAgo ? timeAgo(c.created_at) : ""),
                ),
                h(MarkdownBlock, { source: c.body, enabled: props.renderMarkdown }),
              );
            }),
      ),
      h("div", { className: "hermes-kanban-section" },
        h("div", { className: "hermes-kanban-section-head" },
          `${tx(i18n, "events", "Events")} (${events.length})`),
        events.slice().reverse().slice(0, 20).map(function (e) {
          const isDiag = isDiagnosticEvent(e.kind);
          const phantoms = isDiag ? phantomIdsFromEvent(e) : [];
          return h("div", {
            key: e.id,
            className: cn(
              "hermes-kanban-event",
              isDiag ? "hermes-kanban-event--hallucination" : "",
            ),
          },
            isDiag
              ? h("div", { className: "hermes-kanban-event-header" },
                  h("span", { className: "hermes-kanban-event-warning-icon" }, "⚠"),
                  h("span", { className: "hermes-kanban-event-warning-label" },
                    getDiagnosticEventLabel(i18n, e.kind) || e.kind),
                  h("span", { className: "hermes-kanban-event-ago" },
                    timeAgo ? timeAgo(e.created_at) : ""),
                )
              : h("div", { className: "hermes-kanban-event-header-plain" },
                  h("span", { className: "hermes-kanban-event-kind" }, e.kind),
                  h("span", { className: "hermes-kanban-event-ago" },
                    timeAgo ? timeAgo(e.created_at) : ""),
                ),
            isDiag && phantoms.length > 0
              ? h("div", { className: "hermes-kanban-event-phantom-row" },
                  h("span", { className: "hermes-kanban-event-phantom-label" },
                    tx(i18n, "phantomIds", "Phantom ids:")),
                  phantoms.map(function (pid) {
                    return h("code", {
                      key: pid,
                      className: "hermes-kanban-event-phantom-chip",
                    }, pid);
                  }),
                )
              : null,
            e.payload && !isDiag
              ? h("code", { className: "hermes-kanban-event-payload" },
                  JSON.stringify(e.payload))
              : null,
          );
        }),
      ),
      h(WorkerLogSection, { taskId: t.id, boardSlug: props.boardSlug }),
      h(RunHistorySection, { runs: props.data.runs || [] }),
    );
  }

  // Per-attempt history. Closed runs first (most recent last), then the
  // active run if any. Each row shows profile / outcome / elapsed /
  // summary. Collapsed by default when there are more than three runs.
  function RunHistorySection(props) {
    const { t } = useI18n();
    const runs = props.runs || [];
    const [expanded, setExpanded] = useState(false);
    if (runs.length === 0) return null;
    const showAll = expanded || runs.length <= 3;
    const visible = showAll ? runs : runs.slice(-3);

    const fmtElapsed = function (run) {
      if (!run || !run.started_at) return "";
      const end = run.ended_at || Math.floor(Date.now() / 1000);
      const secs = Math.max(0, end - run.started_at);
      if (secs < 60) return `${secs}s`;
      if (secs < 3600) return `${Math.round(secs / 60)}m`;
      return `${(secs / 3600).toFixed(1)}h`;
    };

    return h("div", { className: "hermes-kanban-section" },
      h("div", { className: "hermes-kanban-section-head-row" },
        h("span", { className: "hermes-kanban-section-head" },
          `${tx(t, "runHistory", "Run history")} (${runs.length})`),
        !showAll
          ? h("button", {
              type: "button",
              onClick: function () { setExpanded(true); },
              className: "hermes-kanban-edit-link",
              title: tx(t, "showAllAttempts", "Show all attempts"),
            }, `+${runs.length - 3} earlier`)
          : null,
      ),
      visible.map(function (r) {
        const outcomeClass = r.ended_at
          ? `hermes-kanban-run--${r.outcome || r.status || "ended"}`
          : "hermes-kanban-run--active";
        return h("div", { key: r.id, className: cn("hermes-kanban-run", outcomeClass) },
          h("div", { className: "hermes-kanban-run-head" },
            h("span", { className: "hermes-kanban-run-outcome" },
              r.ended_at ? (r.outcome || r.status || tx(t, "ended", "ended")) : tx(t, "active", "active")),
            h("span", { className: "hermes-kanban-run-profile" },
              r.profile ? `@${r.profile}` : tx(t, "noProfile", "(no profile)")),
            h("span", { className: "hermes-kanban-run-elapsed" }, fmtElapsed(r)),
            h("span", { className: "hermes-kanban-run-ago" },
              timeAgo ? timeAgo(r.started_at) : ""),
          ),
          r.summary
            ? h("div", { className: "hermes-kanban-run-summary" }, r.summary)
            : null,
          r.error
            ? h("div", { className: "hermes-kanban-run-error" }, r.error)
            : null,
          (r.metadata && Object.keys(r.metadata).length > 0)
            ? (function () {
                var json = JSON.stringify(r.metadata, null, 2);
                var collapsed = json.length > 300;
                return h("details", {
                    className: "hermes-kanban-run-meta-block",
                    open: !collapsed,
                  },
                  h("summary", { className: "hermes-kanban-run-meta-label" }, "Metadata"),
                  h("code", { className: "hermes-kanban-run-meta" }, json),
                );
              })()
            : null,
        );
      }),
    );
  }

  // Worker log: loads lazily (one GET on mount), refresh button, tail cap.
  function WorkerLogSection(props) {
    const { t } = useI18n();
    const [state, setState] = useState({ loading: false, data: null, err: null });
    const load = useCallback(function () {
      setState({ loading: true, data: null, err: null });
      SDK.fetchJSON(withBoard(`${API}/tasks/${encodeURIComponent(props.taskId)}/log?tail=100000`, props.boardSlug))
        .then(function (d) { setState({ loading: false, data: d, err: null }); })
        .catch(function (e) { setState({ loading: false, data: null, err: String(e.message || e) }); });
    }, [props.taskId, props.boardSlug]);

    // Auto-load when the section mounts; the user opened the drawer so the
    // cost is one small HTTP round-trip.
    useEffect(function () { load(); }, [load]);

    const data = state.data;
    let body;
    if (state.loading) {
      body = h("div", { className: "text-xs text-muted-foreground" },
        tx(t, "loadingLog", "Loading log…"));
    } else if (state.err) {
      body = h("div", { className: "text-xs text-destructive" }, state.err);
    } else if (!data || !data.exists) {
      body = h("div", { className: "text-xs text-muted-foreground italic" },
        tx(t, "noWorkerLog",
          "— no worker log yet (task hasn't spawned or log was rotated away) —"));
    } else {
      body = h("pre", { className: "hermes-kanban-pre hermes-kanban-log" },
        data.content || "(empty)");
    }

    return h("div", { className: "hermes-kanban-section" },
      h("div", { className: "hermes-kanban-section-head-row" },
        h("span", { className: "hermes-kanban-section-head" },
          tx(t, "workerLog", "Worker log") + (data && data.size_bytes ? ` (${data.size_bytes} B)` : "")),
        h("button", {
          type: "button",
          onClick: load,
          className: "hermes-kanban-edit-link",
          title: "Refresh log",
        }, "refresh"),
      ),
      body,
      data && data.truncated
        ? h("div", { className: "text-xs text-muted-foreground" },
            tx(t, "logTruncated", "(showing last 100 KB — full log at "),
            data.path,
            tx(t, "logAt", ")"))
        : null,
    );
  }

  function MetaRow(props) {
    return h("div", { className: "hermes-kanban-meta-row" },
      h("span", { className: "hermes-kanban-meta-label" }, props.label),
      h("span", { className: "hermes-kanban-meta-value" }, props.value),
    );
  }

  function TitleEditor(props) {
    const { t } = useI18n();
    const [v, setV] = useState(props.initial);
    const save = function () {
      const trimmed = v.trim();
      if (!trimmed) return;
      props.onSave(trimmed);
    };
    return h("div", { className: "hermes-kanban-edit-row" },
      h(Input, {
        value: v, autoFocus: true,
        onChange: function (e) { setV(e.target.value); },
        onKeyDown: function (e) {
          if (e.key === "Enter") { e.preventDefault(); save(); }
          if (e.key === "Escape") props.onCancel();
        },
        className: "h-8 text-sm flex-1",
      }),
      h(Button, { onClick: save,
        size: "sm",
      }, tx(t, "save", "Save")),
      h(Button, { onClick: props.onCancel,
        size: "sm",
      }, tx(t, "cancel", "Cancel")),
    );
  }

  function AssigneeEditor(props) {
    const { t } = useI18n();
    const [editing, setEditing] = useState(false);
    const [v, setV] = useState(props.task.assignee || "");
    useEffect(function () { setV(props.task.assignee || ""); }, [props.task.assignee]);
    if (!editing) {
      return h("div", { className: "hermes-kanban-meta-row" },
        h("span", { className: "hermes-kanban-meta-label" }, tx(t, "assignee", "Assignee")),
        h("span", {
          className: "hermes-kanban-meta-value hermes-kanban-editable",
          onClick: function () { setEditing(true); },
          title: tx(t, "clickToEditAssignee", "Click to edit assignee"),
        }, props.task.assignee || tx(t, "unassigned", "unassigned")),
      );
    }
    const save = function () {
      props.onPatch({ assignee: v.trim() || "" }).then(function () { setEditing(false); });
    };
    return h("div", { className: "hermes-kanban-meta-row" },
      h("span", { className: "hermes-kanban-meta-label" }, tx(t, "assignee", "Assignee")),
      h(Input, {
        value: v, autoFocus: true,
        onChange: function (e) { setV(e.target.value); },
        onKeyDown: function (e) {
          if (e.key === "Enter") { e.preventDefault(); save(); }
          if (e.key === "Escape") setEditing(false);
        },
        placeholder: tx(t, "emptyAssignee", "(empty = unassign)"),
        className: "h-7 text-xs flex-1",
        style: { textTransform: "none" },
        autoCapitalize: "none",
        autoCorrect: "off",
        spellCheck: false,
      }),
    );
  }

  function PriorityEditor(props) {
    const { t } = useI18n();
    const [editing, setEditing] = useState(false);
    const [v, setV] = useState(String(props.task.priority || 0));
    useEffect(function () { setV(String(props.task.priority || 0)); }, [props.task.priority]);
    if (!editing) {
      return h("div", { className: "hermes-kanban-meta-row" },
        h("span", { className: "hermes-kanban-meta-label" }, tx(t, "priority", "Priority")),
        h("span", {
          className: "hermes-kanban-meta-value hermes-kanban-editable",
          onClick: function () { setEditing(true); },
          title: tx(t, "clickToEdit", "Click to edit"),
        }, String(props.task.priority)),
      );
    }
    const save = function () {
      props.onPatch({ priority: Number(v) || 0 }).then(function () { setEditing(false); });
    };
    return h("div", { className: "hermes-kanban-meta-row" },
      h("span", { className: "hermes-kanban-meta-label" }, tx(t, "priority", "Priority")),
      h(Input, {
        type: "number", value: v, autoFocus: true,
        onChange: function (e) { setV(e.target.value); },
        onKeyDown: function (e) {
          if (e.key === "Enter") { e.preventDefault(); save(); }
          if (e.key === "Escape") setEditing(false);
        },
        className: "h-7 text-xs w-20",
      }),
    );
  }

  function BodyEditor(props) {
    const { t } = useI18n();
    const [editing, setEditing] = useState(false);
    const [v, setV] = useState(props.task.body || "");
    useEffect(function () { setV(props.task.body || ""); }, [props.task.body]);
    const save = function () {
      props.onPatch({ body: v }).then(function () { setEditing(false); });
    };
    return h("div", { className: "hermes-kanban-section" },
      h("div", { className: "hermes-kanban-section-head-row" },
        h("span", { className: "hermes-kanban-section-head" }, tx(t, "description", "Description")),
        editing
          ? h("div", { className: "flex gap-1" },
              h(Button, { onClick: save,
                size: "sm",
              }, tx(t, "save", "Save")),
              h(Button, { onClick: function () { setEditing(false); setV(props.task.body || ""); },
                size: "sm",
              }, tx(t, "cancel", "Cancel")),
            )
          : h("button", {
              type: "button",
              onClick: function () { setEditing(true); },
              className: "hermes-kanban-edit-link",
              title: "Edit description",
            }, tx(t, "edit", "edit")),
      ),
      editing
        ? h("textarea", {
            className: "hermes-kanban-textarea",
            value: v,
            rows: 8,
            onChange: function (e) { setV(e.target.value); },
          })
        : props.task.body
          ? h(MarkdownBlock, { source: props.task.body, enabled: props.renderMarkdown })
          : h("div", { className: "text-xs text-muted-foreground italic" },
              tx(t, "noDescription", "— no description —")),
    );
  }

  function DependencyEditor(props) {
    const { t } = useI18n();
    const { task, links, allTasks } = props;
    const [newParent, setNewParent] = useState("");
    const [newChild, setNewChild] = useState("");
    // Filter out self + existing links when offering the "add" dropdown.
    const candidatesFor = function (excludeSet) {
      return (allTasks || []).filter(function (tk) {
        return tk.id !== task.id && !excludeSet.has(tk.id);
      });
    };
    const parentExclude = new Set([task.id, ...(links.parents || [])]);
    const childExclude  = new Set([task.id, ...(links.children || [])]);

    return h("div", { className: "hermes-kanban-section" },
      h("div", { className: "hermes-kanban-section-head" }, tx(t, "dependencies", "Dependencies")),
      h("div", { className: "hermes-kanban-deps-row" },
        h("span", { className: "hermes-kanban-deps-label" }, tx(t, "parents", "Parents:")),
        h("div", { className: "hermes-kanban-deps-chips" },
          (links.parents || []).length === 0
            ? h("span", { className: "hermes-kanban-deps-empty" }, tx(t, "none", "none"))
            : (links.parents || []).map(function (id) {
                return h("span", { key: id, className: "hermes-kanban-dep-chip" },
                  id,
                  h("button", {
                    type: "button",
                    className: "hermes-kanban-dep-chip-x",
                    onClick: function () { props.onRemoveParent(id); },
                    title: tx(t, "removeDependency", "Remove dependency"),
                  }, "×"),
                );
              }),
        ),
      ),
      h("div", { className: "hermes-kanban-deps-row" },
        h(Select, Object.assign({
          value: newParent,
          className: "h-7 text-xs flex-1",
        }, selectChangeHandler(setNewParent)),
          h(SelectOption, { value: "" }, tx(t, "addParent", "— add parent —")),
          candidatesFor(parentExclude).map(function (tk) {
            return h(SelectOption, { key: tk.id, value: tk.id },
              `${tk.id} — ${(tk.title || "").slice(0, 50)}`);
          }),
        ),
        h(Button, {
          onClick: function () {
            if (!newParent) return;
            props.onAddParent(newParent).then(function () { setNewParent(""); });
          },
          disabled: !newParent,
          size: "sm",
        }, "+ parent"),
      ),
      h("div", { className: "hermes-kanban-deps-row" },
        h("span", { className: "hermes-kanban-deps-label" }, tx(t, "children", "Children:")),
        h("div", { className: "hermes-kanban-deps-chips" },
          (links.children || []).length === 0
            ? h("span", { className: "hermes-kanban-deps-empty" }, tx(t, "none", "none"))
            : (links.children || []).map(function (id) {
                return h("span", { key: id, className: "hermes-kanban-dep-chip" },
                  id,
                  h("button", {
                    type: "button",
                    className: "hermes-kanban-dep-chip-x",
                    onClick: function () { props.onRemoveChild(id); },
                    title: tx(t, "removeDependency", "Remove dependency"),
                  }, "×"),
                );
              }),
        ),
      ),
      h("div", { className: "hermes-kanban-deps-row" },
        h(Select, Object.assign({
          value: newChild,
          className: "h-7 text-xs flex-1",
        }, selectChangeHandler(setNewChild)),
          h(SelectOption, { value: "" }, tx(t, "addChild", "— add child —")),
          candidatesFor(childExclude).map(function (tk) {
            return h(SelectOption, { key: tk.id, value: tk.id },
              `${tk.id} — ${(tk.title || "").slice(0, 50)}`);
          }),
        ),
        h(Button, {
          onClick: function () {
            if (!newChild) return;
            props.onAddChild(newChild).then(function () { setNewChild(""); });
          },
          disabled: !newChild,
          size: "sm",
        }, "+ child"),
      ),
    );
  }

  function StatusActions(props) {
    const { t } = useI18n();
    const task = props.task;
    const [specifyBusy, setSpecifyBusy] = useState(false);
    const [specifyMsg, setSpecifyMsg] = useState(null);
    const [decomposeBusy, setDecomposeBusy] = useState(false);
    const [decomposeMsg, setDecomposeMsg] = useState(null);
    const b = function (label, patch, enabled, confirmMsg) {
      return h(Button, {
        onClick: function () { if (enabled !== false) props.onPatch(patch, { confirm: confirmMsg }); },
        disabled: enabled === false,
        size: "sm",
      }, label);
    };

    // "Specify" appears only when the task is in the Triage column — the
    // one column where an auxiliary LLM pass is meaningful. Elsewhere
    // the backend would return ok:false with "not in triage" anyway,
    // so hiding the button keeps the action row uncluttered.
    const specifyButton = (task.status === "triage" && props.onSpecify)
      ? h(Button, {
          onClick: function () {
            if (specifyBusy) return;
            setSpecifyBusy(true);
            setSpecifyMsg(null);
            props.onSpecify().then(function (res) {
              if (res && res.ok) {
                const suffix = res.new_title
                  ? ` — retitled: ${res.new_title}`
                  : "";
                setSpecifyMsg({ ok: true, text: `Specified${suffix}` });
              } else {
                setSpecifyMsg({
                  ok: false,
                  text: "Specify failed: " + ((res && res.reason) || "unknown error"),
                });
              }
            }).catch(function (err) {
              setSpecifyMsg({
                ok: false,
                text: "Specify failed: " + (err.message || String(err)),
              });
            }).then(function () {
              setSpecifyBusy(false);
            });
          },
          disabled: specifyBusy,
          size: "sm",
        }, specifyBusy ? "Specifying…" : "✨ Specify")
      : null;

    // "Decompose" is the built-in decomposer fan-out. Like Specify, only
    // makes sense on triage-column tasks — elsewhere the backend short-
    // circuits with ok:false. When the decomposer returns fanout:false
    // we render the same single-task message as Specify; when it fans
    // out we report the child count for quick at-a-glance verification.
    const decomposeButton = (task.status === "triage" && props.onDecompose)
      ? h(Button, {
          onClick: function () {
            if (decomposeBusy) return;
            setDecomposeBusy(true);
            setDecomposeMsg(null);
            props.onDecompose().then(function (res) {
              if (res && res.ok) {
                if (res.fanout && res.child_ids && res.child_ids.length) {
                  setDecomposeMsg({
                    ok: true,
                    text: `Decomposed into ${res.child_ids.length} children: ${res.child_ids.join(", ")}`,
                  });
                } else {
                  const suffix = res.new_title
                    ? ` — retitled: ${res.new_title}`
                    : "";
                  setDecomposeMsg({
                    ok: true,
                    text: `Single task (no fanout)${suffix}`,
                  });
                }
              } else {
                setDecomposeMsg({
                  ok: false,
                  text: "Decompose failed: " + ((res && res.reason) || "unknown error"),
                });
              }
            }).catch(function (err) {
              setDecomposeMsg({
                ok: false,
                text: "Decompose failed: " + (err.message || String(err)),
              });
            }).then(function () {
              setDecomposeBusy(false);
            });
          },
          disabled: decomposeBusy,
          size: "sm",
        }, decomposeBusy ? "Decomposing…" : "⚗ Decompose")
      : null;

    return h("div", null,
      h("div", { className: "hermes-kanban-actions" },
        specifyButton,
        decomposeButton,
        b("→ triage",  { status: "triage" },   task.status !== "triage"),
        b("→ ready",   { status: "ready" },    task.status !== "ready"),
        // No direct → running button: /tasks/:id PATCH rejects status=running
        // with 400 (issue #19535). Tasks enter running only through the
        // dispatcher's claim_task path, which atomically creates the run row,
        // claim lock, and worker process metadata.
        b(tx(t, "block", "Block"),     { status: "blocked" },
          task.status === "running" || task.status === "ready",
          getDestructiveConfirm(t, "blocked")),
        b(tx(t, "unblock", "Unblock"),   { status: "ready" },    task.status === "blocked"),
        b(tx(t, "complete", "Complete"),  { status: "done" },
          task.status === "running" || task.status === "ready" || task.status === "blocked",
          getDestructiveConfirm(t, "done")),
        b(tx(t, "archive", "Archive"),   { status: "archived" }, task.status !== "archived",
          getDestructiveConfirm(t, "archived")),
      ),
      specifyMsg ? h("div", {
        className: specifyMsg.ok
          ? "hermes-kanban-msg-ok"
          : "hermes-kanban-msg-err",
      }, specifyMsg.text) : null,
      decomposeMsg ? h("div", {
        className: decomposeMsg.ok
          ? "hermes-kanban-msg-ok"
          : "hermes-kanban-msg-err",
      }, decomposeMsg.text) : null,
    );
  }


  // One toggle per gateway platform the user has a home channel set on
  // (telegram, discord, slack, etc.). Toggling on creates a kanban_notify_subs
  // row routed to that platform's home; toggling off removes it. Nothing
  // renders when no platforms have a home configured — this section stays
  // invisible for users who haven't set one up.
  function HomeSubsSection(props) {
    const { t } = useI18n();
    const channels = props.homeChannels || [];
    if (channels.length === 0) return null;
    const busy = props.homeBusy || {};
    return h("div", { className: "hermes-kanban-section" },
      h("div", { className: "hermes-kanban-section-head" },
        tx(t, "notifyHomeChannels", "Notify home channels")),
      h("div", { className: "hermes-kanban-home-subs" },
        channels.map(function (hc) {
          const isBusy = !!busy[hc.platform];
          const label = hc.subscribed ? "✓ " + hc.platform : hc.platform;
          const target = `${hc.name} (${hc.chat_id}${hc.thread_id ? " / " + hc.thread_id : ""})`;
          const title = hc.subscribed
            ? `${tx(t, "sendingUpdates", "Sending updates to")} ${target}. Click to stop.`
            : `${tx(t, "sendNotifications", "Send completed / blocked / gave_up notifications to")} ${target}.`;
          return h(Button, {
            key: hc.platform,
            size: "sm",
            title: title,
            disabled: isBusy || !props.onToggle,
            onClick: function () {
              if (props.onToggle) props.onToggle(hc.platform, hc.subscribed);
            },
            className: hc.subscribed
              ? "hermes-kanban-home-sub hermes-kanban-home-sub--on"
              : "hermes-kanban-home-sub",
          }, label);
        })
      )
    );
  }

  // -------------------------------------------------------------------------
  // Register
  // -------------------------------------------------------------------------

  if (window.__HERMES_PLUGINS__ && typeof window.__HERMES_PLUGINS__.register === "function") {
    window.__HERMES_PLUGINS__.register("kanban", KanbanPage);
  }
})();
