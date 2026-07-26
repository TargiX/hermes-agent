import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const bundlePath = fileURLToPath(new URL("./dist/index.js", import.meta.url));

function loadFloorProjection() {
  const source = fs.readFileSync(bundlePath, "utf8");
  const exportMarker =
    "  // -------------------------------------------------------------------------\n" +
    "  // Register\n";
  assert.ok(source.includes(exportMarker), "kanban bundle export marker changed");
  const instrumented = source.replace(
    exportMarker,
    "  window.__KANBAN_FLOOR_TEST__ = { buildYardScene, buildFloorSnapshot };\n\n" +
      exportMarker,
  );
  const noop = () => {};
  const context = {
    URL,
    console,
    setInterval: noop,
    clearInterval: noop,
    setTimeout: noop,
    clearTimeout: noop,
    window: {
      __HERMES_PLUGIN_SDK__: {
        React: {
          Component: class {},
          createElement: noop,
          Fragment: Symbol("Fragment"),
        },
        components: {},
        hooks: {
          useState: noop,
          useEffect: noop,
          useCallback: noop,
          useMemo: noop,
          useRef: noop,
        },
        utils: {
          cn: (...values) => values.filter(Boolean).join(" "),
          timeAgo: () => "",
        },
      },
      __HERMES_PLUGINS__: { register: noop },
    },
  };
  vm.runInNewContext(instrumented, context, { filename: bundlePath });
  return context.window.__KANBAN_FLOOR_TEST__;
}

test("review-required work remains visible between worker runs", () => {
  const { buildYardScene, buildFloorSnapshot } = loadFloorProjection();
  const task = {
    id: "t_impl",
    title: "Fix current-head review findings on PR #985",
    body: "task_class: implementation",
    assignee: "terra-frontend",
    status: "blocked",
    block_kind: "review_required",
    priority: 4,
    created_at: 100,
    board_slug: "agency",
  };
  const scene = buildYardScene(
    {
      columns: [{ name: "review", tasks: [task] }],
      controllers: [],
      graph: { links: [], relations: [] },
      factory_flow: {
        objects: [
          {
            id: "agency:t_impl",
            board_slug: "agency",
            board_name: "Ilya Engineering Agency",
            task,
            lifecycle: {
              stage: "review",
              status: "blocked",
              label: "Awaiting review task",
              visibility: "waiting",
              task,
            },
          },
        ],
      },
    },
    [{ name: "terra-frontend" }],
  );

  const snapshot = buildFloorSnapshot(scene);

  assert.deepEqual(
    JSON.parse(JSON.stringify(
      snapshot.shelf.map(({ id, wait }) => ({ id, wait })),
    )),
    [
      {
        id: "t_impl",
        wait: "@terra-frontend · Awaiting review task",
      },
    ],
  );
  assert.equal(snapshot.shelf[0].kind, "review");
});
