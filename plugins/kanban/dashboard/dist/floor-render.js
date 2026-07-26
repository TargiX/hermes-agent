/*
 * The floor, drawn.
 *
 * This module owns pixels only. Every fact it shows comes from `FloorScene`,
 * which owns positions and time; nothing here reads the board. The split
 * matters because it is the reason motion can be honest: the renderer cannot
 * invent an agent walking somewhere the board never sent them.
 *
 * Pixi is loaded dynamically and the whole layer is optional — if the import
 * fails, the caller keeps its DOM floor and the board stays usable.
 */

import {
  FLOOR,
  FloorScene,
  AGENCY_LOOK,
  BELT_X,
  BELT_RIGHT_INSET,
  BELT_BOTTOM_INSET,
  BELT_HEIGHT,
  beltRun,
  dockedCardWidth,
} from "./floor-scene.js";

const PIXI_URL = new URL("./vendor/pixi.min.mjs", import.meta.url).href;

const KIND_TINT = {
  idea: 0x9b7de0,
  critique: 0xe0a458,
  gate: 0x4fd1c5,
  build: 0x5b9be0,
  review: 0x5fbf8f,
  publish: 0x3fa89c,
  evidence: 0xc98bd8,
  capability: 0xe08a4f,
  strategy: 0x7c8ce0,
  control: 0x8d97a3,
  other: 0x5c6672,
};

// Why the work exists, as opposed to what stage it is in. Two values only, and
// silence for everything else: an unlabelled card gets no badge rather than a
// guessed one, because a badge is only useful if it can be trusted on sight.
const INTENT_LOOK = {
  bet: { label: "ИДЕЯ", tint: 0x9b7de0 },
  hardening: { label: "УКРЕПЛЕНИЕ", tint: 0x8d97a3 },
};

function drawIntentTag(PIXI, intent) {
  const look = INTENT_LOOK[String(intent || "")];
  if (!look) return null;
  const text = new PIXI.Text({
    text: look.label,
    style: {
      fontFamily: "ui-monospace, monospace",
      fontSize: 8,
      fontWeight: "600",
      letterSpacing: 0.5,
      fill: look.tint,
    },
  });
  const view = new PIXI.Container();
  const pad = 5;
  const plate = new PIXI.Graphics();
  plate.roundRect(0, 0, Math.round(text.width) + pad * 2, 13, 3)
    .fill({ color: look.tint, alpha: 0.14 });
  view.addChild(plate);
  text.x = pad;
  text.y = Math.round((13 - text.height) / 2);
  view.addChild(text);
  view.__tagWidth = Math.round(text.width) + pad * 2;
  return view;
}

// One spacing scale for the whole scene. Positions are accumulated from it
// rather than typed in one at a time, which is why the card caption used to
// land on top of its own title.
const S = { xs: 4, sm: 6, md: 10, lg: 14, xl: 20 };

function hsl(hue, saturation, lightness) {
  // Pixi wants a packed int; agents are identified by hue so this keeps the
  // same name mapping to the same colour on every machine.
  const s = saturation / 100;
  const l = lightness / 100;
  const k = function (n) { return (n + hue / 30) % 12; };
  const a = s * Math.min(l, 1 - l);
  const f = function (n) {
    return l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  };
  const to = function (v) { return Math.round(v * 255); };
  return (to(f(0)) << 16) + (to(f(8)) << 8) + to(f(4));
}

export async function createFloorRenderer(host, options) {
  const PIXI = await import(PIXI_URL);
  const scene = new FloorScene();
  const app = new PIXI.Application();
  await app.init({
    background: 0x0b0f14,
    backgroundAlpha: 0,
    antialias: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
    width: FLOOR.width,
    height: FLOOR.height,
  });
  host.appendChild(app.canvas);
  app.canvas.style.width = "100%";
  app.canvas.style.height = "auto";
  app.canvas.style.display = "block";

  const layers = {
    floor: new PIXI.Container(),
    furniture: new PIXI.Container(),
    cards: new PIXI.Container(),
    agents: new PIXI.Container(),
    // Pointer targets last, so a card drawn on top of a stack header cannot
    // eat the hover that is meant to open it.
    overlay: new PIXI.Container(),
  };
  for (const layer of Object.values(layers)) app.stage.addChild(layer);

  drawFloor(PIXI, layers.floor);
  // Built once: every belt tiles the same stripe.
  const beltTexture = beltStripes(PIXI, app.renderer);

  const benchViews = new Map();
  const baseViews = new Map();
  const agentViews = new Map();
  const cardViews = new Map();
  let onOpen = (options && options.onOpen) || null;

  const columnLayer = new PIXI.Container();
  // Above the furniture, below the cards: an open stack covers the benches
  // rather than displacing them.
  layers.cards.addChild(columnLayer);
  const hitLayer = new PIXI.Container();
  layers.overlay.addChild(hitLayer);

  function columnAt(x, y) {
    for (const column of scene.places.columns || []) {
      if (x < column.x || x > column.x + column.width) continue;
      const depth = column.open
        ? column.total * (FLOOR.cardHeight + FLOOR.cardGapY)
        : FLOOR.cardHeight;
      const top = column.y - S.md;
      if (y >= top && y <= column.y + 30 + depth) return column;
    }
    return null;
  }

  app.stage.eventMode = "static";
  app.stage.hitArea = { contains: function () { return true; } };
  app.stage.on("pointermove", function (event) {
    const column = columnAt(event.global.x, event.global.y);
    const key = column ? column.key : null;
    if (key === scene.expandedColumn) return;
    if (key) {
      if (scene.hoverColumn(key)) redrawShelf();
    } else if (scene.expandedColumn && !scene.pinnedColumn) {
      if (scene.closeHover(scene.expandedColumn)) redrawShelf();
    }
  });
  app.stage.on("pointertap", function (event) {
    const column = columnAt(event.global.x, event.global.y);
    if (!column) return;
    scene.pinColumn(column.key);
    redrawShelf();
  });
  // The pointer can leave the canvas without a final move event.
  app.canvas.addEventListener("pointerleave", function () {
    if (scene.pinnedColumn || !scene.expandedColumn) return;
    if (scene.closeHover(scene.expandedColumn)) redrawShelf();
  });


  function syncColumns() {
    columnLayer.removeChildren().forEach(function (child) {
      child.destroy({ children: true });
    });
    hitLayer.removeChildren().forEach(function (child) {
      child.destroy({ children: true });
    });
    for (const column of scene.places.columns || []) {
      const tint = KIND_TINT[column.kind] || KIND_TINT.other;
      const head = new PIXI.Container();
      head.x = column.x;
      head.y = column.y;

      const plate = new PIXI.Graphics();
      plate.roundRect(0, -S.sm, column.width, 24, 4)
        .fill({ color: column.open ? 0x18232e : 0x111a23, alpha: column.open ? 1 : 0.75 });
      head.addChild(plate);

      const caret = new PIXI.Text({
        text: column.open ? "▾" : "▸",
        style: { fontFamily: "ui-monospace, monospace", fontSize: 10, fill: tint },
      });
      caret.x = S.sm; caret.y = 0;
      head.addChild(caret);

      const name = new PIXI.Text({
        text: `${column.label.toUpperCase()} · ${column.total}`,
        style: {
          fontFamily: "ui-monospace, monospace",
          fontSize: 10,
          fill: tint,
          letterSpacing: 0.8,
        },
      });
      name.x = S.lg + S.xs; name.y = 0;
      head.addChild(name);

      if (column.open && column.total > 1) {
        // The stack floats over the floor, so it needs its own ground or the
        // bench underneath shows through the gaps between cards.
        const drop = new PIXI.Graphics();
        drop.roundRect(
          -S.sm, 18,
          column.width + S.sm * 2,
          column.total * (FLOOR.cardHeight + FLOOR.cardGapY) + S.md,
          6,
        ).fill({ color: 0x080c11, alpha: 0.93 })
         .stroke({ width: 1, color: 0x1e2833 });
        head.addChildAt(drop, 0);
      }
      if (!column.open && column.hidden > 0) {
        const deck = new PIXI.Graphics();
        for (let i = Math.min(column.hidden, 3); i >= 1; i--) {
          deck.roundRect(i * 3, 26 + i * 3, column.width - i * 6, FLOOR.cardHeight, 5)
            .fill({ color: 0x101821 })
            .stroke({ width: 1, color: 0x1e2833 });
        }
        head.addChild(deck);
        const more = new PIXI.Text({
          text: `+${column.hidden}`,
          style: { fontFamily: "ui-monospace, monospace", fontSize: 10, fill: 0x8a98a8 },
        });
        more.anchor.set(1, 0);
        more.x = column.width - S.sm; more.y = 0;
        head.addChild(more);
      }
      columnLayer.addChild(head);

    }
  }

  function redrawShelf() {
    syncColumns();
    syncFurniture();
    syncActors();
  }

  function syncFurniture() {
    for (const [key, view] of baseViews) {
      if (!scene.places.bases.has(key)) { view.destroy({ children: true }); baseViews.delete(key); }
    }
    for (const base of scene.bases) {
      const place = scene.places.bases.get(base.key);
      if (!place) continue;
      let view = baseViews.get(base.key);
      if (!view) {
        view = drawBase(PIXI, base, place);
        layers.furniture.addChild(view);
        baseViews.set(base.key, view);
      }
      view.x = place.x;
      view.y = place.y;
    }

    const liveBenchIds = new Set(scene.benches.map(function (b) { return b.id; }));
    for (const [id, view] of benchViews) {
      if (!liveBenchIds.has(id)) { view.destroy({ children: true }); benchViews.delete(id); }
    }
    for (const bench of scene.benches) {
      const place = scene.places.benches.get(bench.id);
      if (!place) continue;
      let view = benchViews.get(bench.id);
      if (!view) {
        view = drawBench(PIXI, bench, place, beltTexture);
        view.eventMode = "static";
        view.cursor = "pointer";
        view.on("pointertap", function () {
          if (onOpen && bench.task) onOpen(bench.task);
        });
        layers.furniture.addChild(view);
        benchViews.set(bench.id, view);
      }
      view.x = place.x;
      view.y = place.y;
      view.__bench = bench;
      view.__place = place;
      // The bubble tracks this agent's live position, so the bench needs a
      // handle on the same object the walk animation moves.
      view.__agentRef = bench.agentName
        ? scene.agents.get(bench.agentName) || null
        : null;
    }
  }

  function syncActors() {
    for (const [name, view] of agentViews) {
      if (!scene.agents.has(name)) { view.destroy({ children: true }); agentViews.delete(name); }
    }
    for (const agent of scene.agents.values()) {
      let view = agentViews.get(agent.name);
      if (!view) {
        view = drawAgent(PIXI, agent);
        layers.agents.addChild(view);
        agentViews.set(agent.name, view);
      }
      view.__agent = agent;
    }
    for (const [id, view] of cardViews) {
      if (!scene.cards.has(id)) { view.destroy({ children: true }); cardViews.delete(id); }
    }
    for (const card of scene.cards.values()) {
      let view = cardViews.get(card.id);
      const signature = `${card.docked ? "dock" : "shelf"}|${card.kind}|${card.intent || ""}|${card.title || ""}|${card.wait || ""}`;
      if (view && view.__signature !== signature) {
        layers.cards.removeChild(view);
        view.destroy({ children: true });
        view = null;
        cardViews.delete(card.id);
      }
      if (!view) {
        view = drawCard(PIXI, card);
        view.__signature = signature;
        layers.cards.addChild(view);
        cardViews.set(card.id, view);
      }
      view.__card = card;
    }
  }

  app.ticker.add(function (ticker) {
    scene.advance(ticker.deltaMS / 1000);
    for (const view of agentViews.values()) {
      const agent = view.__agent;
      if (!agent) continue;
      view.x = agent.x;
      // A small bob while walking. It is the only motion here not read from
      // the board, and it says "moving" rather than asserting any fact.
      view.y = agent.y + (agent.walking ? Math.sin(agent.bob) * 2.2 : 0);
    }
    for (const view of cardViews.values()) {
      const card = view.__card;
      if (!card) continue;
      view.x = card.x;
      view.y = card.y;
      // The carried tab exists to make the hand-off visible: a card leaves the
      // shelf and travels to a bench. Once it lands, the bench header names
      // the same work and the bubble sits in that space, so holding the tab
      // there only crowds them. It fades out on arrival and the journey stays.
      if (card.docked && card.target) {
        const reach = Math.hypot(card.x - card.target.x, card.y - card.target.y);
        view.alpha = Math.max(0, Math.min(1, reach / 40));
      }
    }
    for (const view of benchViews.values()) {
      const bench = view.__bench;
      if (!bench || !view.__belt) continue;
      // The belt only runs while the heartbeat is fresh. A belt moving under
      // a silent worker would be this screen inventing progress.
      if (bench.beating) {
        view.__beltOffset = (view.__beltOffset + ticker.deltaMS * 0.028) % 24;
        view.__belt.tilePosition.x = view.__beltOffset;
        view.__belt.alpha = 1;
      } else {
        view.__belt.alpha = 0.4;
      }
      // The belt fills to the phase actually reached. Scrolling stripes alone
      // said "something is moving" without saying how far along; a filled run
      // says it at a glance, and the pulsing head says which step is live.
      if (view.__beltFill) {
        view.__beltPulse = (view.__beltPulse || 0) + ticker.deltaMS / 1000;
        drawBeltFill(view, bench, ticker.deltaMS / 1000);
      }
      // The thought follows the thinker. Anchored to the bench it stayed put
      // while the agent walked away from it, which read as someone else's.
      const agent = view.__agentRef;
      if (view.__bubble && agent) {
        view.__bubble.x = Math.round(agent.x - view.x - view.__bubbleWidth / 2);
      }
    }
  });

  // A handle on the live scene. Layout bugs here are geometry bugs, and
  // guessing at them from a screenshot is how three of them shipped.
  if (typeof window !== "undefined") window.__hermesFloor = { scene, app, FLOOR };

  return {
    canvas: app.canvas,
    update(snapshot) {
      scene.sync(snapshot);
      syncColumns();
      // The floor grows with the roster. A fixed canvas silently cropped the
      // last base, so a whole agency could be missing without a hint.
      const needed = Math.max(
        scene.places.floorHeight || 0,
        FLOOR.benchTop + Math.max(1, scene.benches.length)
          * (FLOOR.benchHeight + FLOOR.benchGap) + 60,
      );
      if (Math.abs(needed - app.renderer.height) > 4) {
        app.renderer.resize(FLOOR.width, needed);
        layers.floor.removeChildren().forEach(function (child) { child.destroy(true); });
        drawFloor(PIXI, layers.floor, needed);
      }
      syncFurniture();
      syncActors();
    },
    setOnOpen(handler) { onOpen = handler; },
    destroy() {
      app.destroy(true, { children: true });
    },
  };
}

function drawFloor(PIXI, layer, height) {
  const tall = height || FLOOR.height;
  const grid = new PIXI.Graphics();
  for (let x = 0; x <= FLOOR.width; x += 40) {
    grid.moveTo(x, 0).lineTo(x, tall);
  }
  for (let y = 0; y <= tall; y += 40) {
    grid.moveTo(0, y).lineTo(FLOOR.width, y);
  }
  grid.stroke({ width: 1, color: 0x1c2731, alpha: 0.55 });
  layer.addChild(grid);

  const shelfLabel = new PIXI.Text({
    text: "TASK SHELF  ·  EARLIEST STAGE LEFT, SHIPPING RIGHT",
    style: {
      fontFamily: "ui-monospace, monospace",
      fontSize: 11,
      fill: 0x6f7c8a,
      letterSpacing: 1.1,
    },
  });
  shelfLabel.x = FLOOR.baseColumnWidth + 120;
  shelfLabel.y = FLOOR.shelfTop;
  layer.addChild(shelfLabel);

  const divider = new PIXI.Graphics();
  divider
    .moveTo(FLOOR.baseColumnWidth + 40, 40)
    .lineTo(FLOOR.baseColumnWidth + 40, tall - 40)
    .stroke({ width: 1, color: 0x243140, alpha: 0.9 });
  layer.addChild(divider);
}

function label(PIXI, text, size, color, weight) {
  return new PIXI.Text({
    text: text,
    style: {
      fontFamily: "Inter, system-ui, sans-serif",
      fontSize: size,
      fontWeight: weight || "500",
      fill: color,
      letterSpacing: 0.2,
    },
  });
}

function drawBase(PIXI, base, place) {
  const view = new PIXI.Container();
  const look = AGENCY_LOOK[base.key] || { hue: 200 };
  const tint = hsl(look.hue, 42, 58);
  const roof = new PIXI.Graphics();
  roof.moveTo(-64, 0).lineTo(0, -42).lineTo(64, 0).closePath().fill({ color: tint, alpha: 0.35 });
  view.addChild(roof);
  const body = new PIXI.Graphics();
  body.roundRect(-58, 0, 116, 58, 6).fill({ color: 0x121a22 }).stroke({ width: 1, color: tint, alpha: 0.7 });
  view.addChild(body);
  const name = label(PIXI, base.label || base.key, 15, 0xdae3ed, "600");
  name.anchor.set(0.5, 0);
  name.y = 66;
  view.addChild(name);
  const count = label(PIXI, base.caption || "", 12, 0x8a98a8);
  count.anchor.set(0.5, 0);
  count.y = 86;
  view.addChild(count);
  return view;
}

function drawBench(PIXI, bench, place, beltTexture) {
  const view = new PIXI.Container();
  const tint = KIND_TINT[bench.kind] || KIND_TINT.other;

  const slab = new PIXI.Graphics();
  slab.roundRect(0, 0, place.width, place.height, 12)
    .fill({ color: 0x111922, alpha: 0.92 })
    .stroke({ width: 1, color: bench.stuck ? 0xe0645f : 0x243140 });
  slab.moveTo(0, 12).lineTo(0, place.height - 12).stroke({ width: 3, color: tint });
  view.addChild(slab);

  const kind = label(PIXI, (bench.kindLabel || "").toUpperCase(), 11, tint, "600");
  kind.x = S.xl; kind.y = S.lg;
  view.addChild(kind);
  // Beside the stage, not instead of it: a build is a build either way, and
  // the reader still needs to know whether it is a bet or upkeep.
  const benchIntent = drawIntentTag(PIXI, bench.intent);
  if (benchIntent) {
    benchIntent.x = S.xl + Math.round(kind.width) + S.md;
    benchIntent.y = S.lg - 2;
    view.addChild(benchIntent);
  }

  const title = label(PIXI, bench.title || "Untitled", 16, 0xdae3ed, "600");
  // One line, clipped. A wrapping title made the band below it a moving
  // target, which is how the bubble ended up on top of the words.
  title.x = S.xl;
  title.y = BENCH_TITLE_Y;
  const titleRoom = place.width - S.xl * 2;
  if (title.width > titleRoom) {
    const words = String(bench.title || "").split(/\s+/);
    let kept = "";
    for (const word of words) {
      const attempt = kept ? `${kept} ${word}` : word;
      title.text = `${attempt}…`;
      if (title.width > titleRoom) break;
      kept = attempt;
    }
    title.text = kept ? `${kept}…` : "…";
  }
  view.addChild(title);

  if (bench.live) {
    const bubble = drawBubble(PIXI, bench.live);
    if (bubble) {
      // Over the head, where a thought belongs. The bench reserves a band for
      // it between the title and the belt; the ticker slides it along that
      // band so it stays over the agent as he walks the phases.
      bubble.x = 34;
      bubble.y = LIVE_BAND_TOP;
      view.addChild(bubble);
      view.__bubble = bubble;
      view.__bubbleWidth = bubble.__bubbleWidth || 260;
    }
  }

  // The conveyor: a real belt with phase marks, not a progress bar. The agent
  // stands at its head, and the work travels away from them.
  const beltY = place.height - BELT_BOTTOM_INSET;
  const beltX = BELT_X;
  const beltWidth = beltRun(place.width);
  const belt = new PIXI.TilingSprite({
    texture: beltTexture,
    width: beltWidth,
    height: BELT_HEIGHT,
  });
  belt.x = beltX; belt.y = beltY;
  view.addChild(belt);
  view.__belt = belt;
  view.__beltOffset = 0;

  const beltFill = new PIXI.Graphics();
  view.addChild(beltFill);
  view.__beltFill = beltFill;
  view.__beltGeometry = {
    x: beltX, y: beltY, width: beltWidth, height: BELT_HEIGHT, tint: tint,
  };
  view.__beltPulse = 0;

  const frame = new PIXI.Graphics();
  frame.roundRect(beltX, beltY, beltWidth, BELT_HEIGHT, 3)
    .stroke({ width: 1, color: 0x243140 });
  view.addChild(frame);

  (bench.phases || []).forEach(function (phase, index, all) {
    const x = beltX + (beltWidth / (all.length - 1 || 1)) * index;
    const mark = new PIXI.Graphics();
    const reached = index <= (bench.phaseIndex ?? 0);
    mark.circle(x, beltY + BELT_HEIGHT / 2, 5)
      .fill({ color: reached ? tint : 0x0b0f14 })
      .stroke({ width: 2, color: reached ? tint : 0x2a3440 });
    view.addChild(mark);
    const text = label(PIXI, phase, 11, reached ? 0xdae3ed : 0x6b7785);
    text.anchor.set(0.5, 0);
    text.x = x; text.y = beltY + 22;
    view.addChild(text);
  });

  return view;
}

// One stripe, rendered once and repeated. A TilingSprite needs a real
// texture, so this goes through the renderer rather than handing back a
// Graphics that would silently draw nothing.
function beltStripes(PIXI, renderer) {
  const g = new PIXI.Graphics();
  g.rect(0, 0, 24, 18).fill({ color: 0x16202a });
  g.moveTo(0, 18).lineTo(12, 0).stroke({ width: 2, color: 0x22303d });
  g.moveTo(12, 18).lineTo(24, 0).stroke({ width: 2, color: 0x22303d });
  const texture = renderer.generateTexture({ target: g, resolution: 2 });
  texture.source.addressMode = "repeat";
  g.destroy();
  return texture;
}

// How far along the belt the work actually is, drawn as a filled run rather
// than left to scrolling stripes.
//
// Segments behind the current phase are solid: those steps are done. The
// segment the worker is standing on fills part-way and breathes, because the
// board knows he is on that step but not how far through it — claiming a
// precise fraction would be this screen inventing progress it cannot measure.
function drawBeltFill(view, bench, deltaSeconds) {
  const fill = view.__beltFill;
  const geometry = view.__beltGeometry;
  if (!fill || !geometry) return;
  const { x, y, width, height, tint } = geometry;
  const phases = bench.phases || [];
  const last = Math.max(0, phases.length - 1);
  const step = Math.min(Math.max(Number(bench.phaseIndex) || 0, 0), last);
  const segment = width / (last || 1);
  const settled = segment * step;
  // The live segment breathes between a third and two thirds of its run.
  const pulse = bench.beating
    ? 0.5 + Math.sin((view.__beltPulse || 0) * 2.2) * 0.16
    : 0.5;
  const live = step < last ? segment * pulse : 0;

  fill.clear();
  if (settled > 0) {
    fill.roundRect(x, y, settled, height, 3).fill({ color: tint, alpha: 0.55 });
  }
  if (live > 0) {
    fill.rect(x + settled, y, live, height)
      .fill({ color: tint, alpha: bench.beating ? 0.3 : 0.16 });
  }
}

// The bubble over the head. It exists whenever the worker has said anything
// on this run, and it dims when the beat goes stale rather than disappearing:
// a worker that has gone quiet is information, not absence.
function drawBubble(PIXI, agent) {
  if (!agent.note && !agent.meter) return null;
  const view = new PIXI.Container();
  const width = 262;

  const state = new PIXI.Text({
    text: agent.beating ? "WORKING NOW" : "NO UPDATE YET",
    style: {
      fontFamily: "ui-monospace, monospace",
      fontSize: 9,
      fill: agent.beating ? 0x4fd1c5 : 0x8a98a8,
      letterSpacing: 0.9,
    },
  });
  const note = new PIXI.Text({
    text: agent.note || "",
    style: {
      fontFamily: "Inter, system-ui, sans-serif",
      fontSize: 12,
      fill: 0xdae3ed,
      wordWrap: true,
      wordWrapWidth: width - S.md * 2,
      lineHeight: 16,
    },
  });
  // Two lines of thought, then an ellipsis: the band is a fixed height, and
  // a growing bubble would climb back over the title.
  if (note.height > 32) {
    const words = String(agent.note || "").split(/\s+/);
    let kept = "";
    for (const word of words) {
      const attempt = kept ? `${kept} ${word}` : word;
      note.text = `${attempt}…`;
      if (note.height > 32) break;
      kept = attempt;
    }
    note.text = kept ? `${kept}…` : "…";
  }
  const meter = new PIXI.Text({
    text: agent.meter || "",
    style: { fontFamily: "ui-monospace, monospace", fontSize: 9, fill: 0x8a98a8 },
  });

  // Flowed on the scale, same as the cards, so nothing lands on anything.
  let cursor = S.md;
  state.x = S.md + 12; state.y = cursor;
  cursor += state.height + (agent.note ? S.sm : 0);
  note.x = S.md; note.y = cursor;
  if (agent.note) cursor += note.height + S.sm;
  meter.x = S.md; meter.y = cursor;
  if (agent.meter) cursor += meter.height;
  const height = cursor + S.md;

  const edge = agent.beating ? 0x2f7d78 : 0x243140;
  const shell = new PIXI.Graphics();
  shell.roundRect(0, 0, width, height, 8)
    .fill({ color: 0x101923, alpha: 0.97 })
    .stroke({ width: 1, color: edge });
  // A tail, so it reads as something being said rather than another card.
  // Centred, because the ticker centres the bubble over the agent: a tail at
  // the left edge pointed at empty floor once the bubble started following.
  const tailX = width / 2;
  shell.moveTo(tailX - 10, height).lineTo(tailX, height + 10).lineTo(tailX + 10, height)
    .fill({ color: 0x101923, alpha: 0.97 });
  shell.moveTo(tailX - 10, height).lineTo(tailX, height + 10).lineTo(tailX + 10, height)
    .stroke({ width: 1, color: edge });
  view.addChild(shell);
  view.__bubbleWidth = width;

  const dot = new PIXI.Graphics();
  dot.circle(S.md + 4, S.md + 5, 3.5)
    .fill({ color: agent.beating ? 0x4fd1c5 : 0x6b7785 });
  view.addChild(dot);
  view.addChild(state);
  if (agent.note) view.addChild(note);
  if (agent.meter) view.addChild(meter);

  // Anchored to the bench, not floating over it: the worker stands at the
  // bottom-left, so the bubble hangs to its right at bench-floor level and
  // clears both the title above and the belt below.
  view.alpha = agent.beating ? 1 : 0.75;
  view.__width = width;
  view.__height = height;
  return view;
}

// The bench, laid out top to bottom on the scale.
const BENCH_TITLE_Y = 26;
const LIVE_BAND_TOP = 54;
const LIVE_BAND_HEIGHT = 96;
const BELT_FROM_BOTTOM = 58;

function drawAgent(PIXI, agent) {
  const view = new PIXI.Container();
  const tint = hsl(agent.hue, 46, 62);
  const figure = new PIXI.Graphics();
  figure.circle(0, -20, 6.4).fill({ color: tint });
  if (agent.shape === "box") {
    figure.roundRect(-9, -12, 18, 20, 3).fill({ color: tint });
  } else if (agent.shape === "pill") {
    figure.roundRect(-7, -12, 14, 20, 7).fill({ color: tint });
  } else if (agent.shape === "cut") {
    figure.moveTo(-10, 8).lineTo(-6, -12).lineTo(6, -12).lineTo(10, 8).closePath().fill({ color: tint });
  } else {
    figure.roundRect(-8, -12, 16, 20, 8).fill({ color: tint });
  }
  view.addChild(figure);
  // The full handle above the head, the way a character is labelled in a
  // game. Initials under the feet told you nothing you could act on.
  const handle = agent.name.length > 13
    ? `@${agent.name.slice(0, 12)}…`
    : `@${agent.name}`;
  const plate = new PIXI.Text({
    text: handle,
    style: {
      fontFamily: "ui-monospace, monospace",
      fontSize: 10,
      fill: agent.working ? 0xdae3ed : 0x8a98a8,
    },
  });
  plate.anchor.set(0.5, 1);
  plate.y = -30;
  const backing = new PIXI.Graphics();
  backing.roundRect(-plate.width / 2 - 5, -30 - plate.height - 3, plate.width + 10, plate.height + 5, 3)
    .fill({ color: 0x0b0f14, alpha: 0.75 });
  view.addChild(backing);
  view.addChild(plate);
  return view;
}

// The card in the agent's hands.
//
// It used to print the task id, which names the work to the database and to
// nobody else, and it sat off the agent's right shoulder where it read as a
// second task rather than the one he is carrying. It shows the kind instead —
// the same word and colour the shelf used — so the eye can follow one piece of
// work from shelf to bench without decoding an identifier.
function drawDockedCard(PIXI, card) {
  const view = new PIXI.Container();
  const tint = KIND_TINT[card.kind] || KIND_TINT.other;
  const text = new PIXI.Text({
    text: String(card.kindLabel || card.kind || "").toUpperCase(),
    style: {
      fontFamily: "ui-monospace, monospace",
      fontSize: 9,
      fontWeight: "600",
      letterSpacing: 0.6,
      fill: tint,
    },
  });
  const height = 18;
  // Layout centres the tab under the figure using this exact width, so the
  // renderer must not measure its own.
  const width = dockedCardWidth(card.kindLabel || card.kind);
  const tab = new PIXI.Graphics();
  tab.roundRect(0, 0, width, height, 4)
    .fill({ color: 0x18222c })
    .stroke({ width: 1, color: tint, alpha: 0.75 });
  view.addChild(tab);
  text.x = Math.round((width - text.width) / 2);
  text.y = Math.round((height - text.height) / 2);
  view.addChild(text);
  return view;
}


// A card is a card: it says what the work is.
//
// Laid out by accumulating a cursor down the spacing scale, so a block can
// never land on the one above it. The previous version typed each y by hand
// and the caption sat on the title the moment a title wrapped to two lines.
const CARD_TITLE_LINES = 2;
const CARD_TITLE_LINE_HEIGHT = 15;

function drawCard(PIXI, card) {
  // At a bench the card is a tab, not a card. The bench already names the
  // work in full; drawing the title twice is the duplication this floor was
  // rebuilt to remove — and the docked copy had no title to draw anyway,
  // so it read "no title" beside the very title it was repeating.
  if (card.docked) return drawDockedCard(PIXI, card);
  const view = new PIXI.Container();
  const tint = KIND_TINT[card.kind] || KIND_TINT.other;
  const width = FLOOR.cardWidth;
  const height = FLOOR.cardHeight;
  const inner = width - S.md * 2;

  const paper = new PIXI.Graphics();
  paper.roundRect(0, 0, width, height, 5)
    .fill({ color: 0x141c25 })
    .stroke({ width: 1, color: 0x243140 });
  paper.rect(0, 0, width, 3).fill({ color: tint });
  view.addChild(paper);

  let cursor = 3 + S.md;

  const kind = new PIXI.Text({
    text: (card.kindLabel || "").toUpperCase(),
    style: {
      fontFamily: "ui-monospace, monospace",
      fontSize: 9,
      fill: tint,
      letterSpacing: 0.7,
    },
  });
  kind.x = S.md;
  kind.y = cursor;
  view.addChild(kind);
  // Right-aligned on the same line as the stage, so the two facts read
  // together without the badge stealing a row from the title.
  const cardIntent = drawIntentTag(PIXI, card.intent);
  if (cardIntent) {
    cardIntent.x = width - S.md - (cardIntent.__tagWidth || 0);
    cardIntent.y = cursor - 2;
    view.addChild(cardIntent);
  }
  cursor += kind.height + S.sm;

  const title = new PIXI.Text({
    text: card.title || "Без названия",
    style: {
      fontFamily: "Inter, system-ui, sans-serif",
      fontSize: 12,
      fontWeight: "500",
      fill: 0xdae3ed,
      wordWrap: true,
      wordWrapWidth: inner,
      lineHeight: CARD_TITLE_LINE_HEIGHT,
      breakWords: true,
    },
  });
  const titleBox = CARD_TITLE_LINES * CARD_TITLE_LINE_HEIGHT;
  if (title.height > titleBox) {
    // Trim by whole words until two lines fit, then mark the cut. A card that
    // grew to fit its title would shove the entire shelf on every poll.
    const words = String(card.title || "").split(/\s+/);
    let kept = "";
    for (const word of words) {
      const attempt = kept ? `${kept} ${word}` : word;
      title.text = `${attempt}…`;
      if (title.height > titleBox) break;
      kept = attempt;
    }
    title.text = kept ? `${kept}…` : "…";
  }
  title.x = S.md;
  title.y = cursor;
  view.addChild(title);
  cursor += titleBox + S.sm;

  const wait = new PIXI.Text({
    text: card.wait || "",
    style: {
      fontFamily: "ui-monospace, monospace",
      fontSize: 9,
      fill: 0x6f7c8a,
      wordWrap: true,
      wordWrapWidth: inner,
      breakWords: true,
    },
  });
  wait.x = S.md;
  wait.y = cursor;
  view.addChild(wait);

  view.pivot.set(0, 0);
  return view;
}

