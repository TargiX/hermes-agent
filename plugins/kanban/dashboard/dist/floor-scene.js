/*
 * The agency floor as a scene that persists between frames.
 *
 * The board view before this drew a fresh picture from the database on every
 * tick. There was nowhere for motion to live: an agent had no position, a task
 * had no place, and a stage change had no duration, so the best an animation
 * could have done was cross-fade two static pictures.
 *
 * Here the board is the *target*, not the drawing. Each poll sets where things
 * should be; the scene walks them there over real seconds. That is the whole
 * difference between a diagram of a factory and a factory you can watch.
 *
 * Truth constraints, which outrank any visual:
 *   - an agent only walks to a bench it actually holds a running task for;
 *   - a card only leaves the shelf when the board says it was claimed;
 *   - the belt only runs while the worker's heartbeat is fresh, because a
 *     moving belt is this screen claiming output it cannot otherwise see;
 *   - nothing is invented to fill a gap. Missing data leaves an empty floor.
 */

export const FLOOR = {
  width: 1600,
  height: 900,
  // Bases sit along the left edge; benches occupy the working half.
  baseColumnWidth: 330,
  shelfTop: 60,
  shelfHeight: 168,
  // A card has to hold a readable title, so the shelf is sized around the
  // text rather than the text squeezed into a token square.
  cardWidth: 208,
  cardHeight: 3 + 10 + 11 + 6 + 30 + 6 + 11 + 10, // = 87
  cardGapX: 14,
  cardGapY: 12,
  benchTop: 268,
  benchHeight: 214,
  benchGap: 18,
};

const WALK_SPEED = 190; // scene units per second, a deliberate stroll
const CARRY_LIFT = 14;

export const AGENCY_LOOK = {
  development: { hue: 210, shape: "box", label: "Разработка" },
  marketing: { hue: 288, shape: "pill", label: "Маркетинг" },
  unassigned: { hue: 168, shape: "cut", label: "Продукт" },
};

export function agentHue(name) {
  let hash = 0;
  const text = String(name || "");
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) % 360;
  }
  return hash;
}

function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

function distance(ax, ay, bx, by) {
  return Math.hypot(bx - ax, by - ay);
}

/**
 * Group waiting cards into stage columns, in pipeline order.
 *
 * The order is supplied by the caller because it is a product statement, not
 * a drawing one: it says which stage feeds which. Anything the caller did not
 * name lands at the end rather than being dropped, so a new task class shows
 * up as an unsorted column instead of vanishing from the floor.
 */
function groupShelf(cards, stageOrder) {
  const byKind = new Map();
  for (const card of cards) {
    const key = card.kind || "other";
    if (!byKind.has(key)) {
      byKind.set(key, { key: key, label: card.kindLabel || key, cards: [] });
    }
    byKind.get(key).cards.push(card);
  }
  const ordered = [];
  for (const key of stageOrder) {
    if (byKind.has(key)) { ordered.push(byKind.get(key)); byKind.delete(key); }
  }
  for (const column of byKind.values()) ordered.push(column);
  return ordered;
}

/**
 * The shelf, read left to right along the pipeline.
 *
 * Grouped into stage columns rather than a flat grid: a grid said nothing
 * about order and ran off the right edge as the queue grew. A column is
 * bounded, and one that fills up stacks downward instead of shoving its
 * neighbours off the floor.
 */
function planShelf(model, places, benchX) {
  const columnWidth = FLOOR.cardWidth + FLOOR.cardGapX;
  const shelfWidth = FLOOR.width - benchX - 40;
  const maxColumns = Math.max(1, Math.floor(shelfWidth / columnWidth));
  const columns = model.shelfColumns.slice(0, maxColumns);
  places.columns = [];
  columns.forEach(function (column, columnIndex) {
    const x = benchX + columnIndex * columnWidth;
    const open = model.expandedColumn === column.key;
    const visible = open ? column.cards : column.cards.slice(0, 1);
    places.columns.push({
      key: column.key,
      label: column.label,
      kind: column.key,
      x: x,
      y: FLOOR.shelfTop + 26,
      width: FLOOR.cardWidth,
      total: column.cards.length,
      hidden: column.cards.length - visible.length,
      open: open,
    });
    visible.forEach(function (card, cardIndex) {
      places.shelf.push({
        id: card.id,
        x: x,
        // Collapsed, a deck shows only its top card. Expanded, the cards
        // fan down the column and the floor grows to hold them.
        y: FLOOR.shelfTop + 52 + cardIndex * (FLOOR.cardHeight + FLOOR.cardGapY),
        column: column.key,
      });
    });
  });
  // The floor below the shelf is reserved against the *collapsed* depth, so
  // opening a stack never shoves the benches down. An open stack is an
  // overlay: the cards layer already draws above the furniture, so it lands
  // on top of the floor instead of rearranging it.
  places.shelfBottom = FLOOR.shelfTop + 52 + FLOOR.cardHeight + FLOOR.cardGapY;
  places.shelfOverlayBottom = FLOOR.shelfTop + 52
    + places.columns.reduce(function (most, column) {
        return Math.max(most, column.open ? column.total : 1);
      }, 1) * (FLOOR.cardHeight + FLOOR.cardGapY);
}

/**
 * Where each thing belongs, given the current board.
 *
 * Layout is derived, not authored: benches are allocated in the order the
 * board reports live work, so a bench keeps its slot for as long as its task
 * runs and an agent does not slide sideways because an unrelated card ended.
 */
// The conveyor's geometry, shared with the renderer so the figure and the
// phase marks cannot drift apart. The renderer draws the belt from BELT_X to
// the bench's right inset; a station sits at an even division of that run.
export const BELT_X = 120;
export const BELT_RIGHT_INSET = 40;
export const BELT_BOTTOM_INSET = 58;
export const BELT_HEIGHT = 18;
// Stretching the belt across the whole bench put 225px of nothing between two
// words. The run is capped so the five stations read as one short line of
// steps; the bench keeps its width for the title.
export const BELT_MAX_WIDTH = 620;

export function beltRun(benchWidth) {
  return Math.min(BELT_MAX_WIDTH, benchWidth - BELT_X - BELT_RIGHT_INSET);
}

export function phaseStationX(benchWidth, phaseIndex, phases) {
  const beltWidth = beltRun(benchWidth);
  const count = Array.isArray(phases) ? phases.length : 0;
  const last = Math.max(0, count - 1);
  // A finished card returns `phases.length` — past the last mark, not on it.
  // Clamping keeps the figure on the belt instead of walking off its end.
  const step = Math.min(Math.max(Number(phaseIndex) || 0, 0), last);
  return BELT_X + (beltWidth / (last || 1)) * step;
}

export function phaseStationY() {
  // Feet on the belt: the mark's centre line, so he stands on the dot rather
  // than beside it.
  return FLOOR.benchHeight - BELT_BOTTOM_INSET + BELT_HEIGHT / 2;
}

// Width of the tab the agent carries. Lives here because layout centres it
// under the figure and the renderer must draw it to exactly this width.
export function dockedCardWidth(kindLabel) {
  const glyphs = String(kindLabel || "").length;
  // The monospace face at 9px with 0.6 letter-spacing runs ~6px per glyph.
  return Math.max(46, Math.round(glyphs * 6.0) + 20);
}

export function planLayout(model) {
  const benchX = FLOOR.baseColumnWidth + 120;
  const places = { benches: new Map(), shelf: [], bases: new Map() };
  // Shelf first: the benches sit under whatever depth it ends up needing.
  planShelf(model, places, benchX);

  let index = 0;
  const benchTop = Math.max(FLOOR.benchTop, places.shelfBottom || 0);
  for (const bench of model.benches) {
    const y = benchTop + index * (FLOOR.benchHeight + FLOOR.benchGap);
    const width = FLOOR.width - benchX - 90;
    places.benches.set(bench.id, {
      x: benchX,
      y,
      width: width,
      height: FLOOR.benchHeight,
      // The worker stands on the phase he is executing, not at the head of the
      // belt. Standing still while the marks lit up behind him was the whole
      // reason the floor read as frozen: the picture said "waiting" while the
      // work said "three steps in".
      standX: benchX + phaseStationX(width, bench.phaseIndex, bench.phases),
      standY: y + phaseStationY(),
    });
    index += 1;
  }

  // Houses are spaced by how many people live in them. A fixed step put a
  // fourteen-strong base straight through the roof of the next one.
  const SEAT_COLUMNS = 3;
  const SEAT_ROW_HEIGHT = 58;
  const HOUSE_TO_FIRST_SEAT = 152;
  let baseY = 132;
  for (const base of model.bases) {
    const residents = Math.max(1, Number(base.residents) || 1);
    const rows = Math.ceil(residents / SEAT_COLUMNS);
    places.bases.set(base.key, {
      x: 150,
      y: baseY,
      hue: (AGENCY_LOOK[base.key] || {}).hue ?? 200,
      rows: rows,
    });
    baseY += HOUSE_TO_FIRST_SEAT + rows * SEAT_ROW_HEIGHT + 46;
  }
  places.floorHeight = Math.max(
    FLOOR.height,
    baseY + 40,
    benchTop + Math.max(1, model.benches.length)
      * (FLOOR.benchHeight + FLOOR.benchGap) + 60,
  );


  return places;
}

/**
 * A scene that remembers.
 *
 * `sync` accepts a board snapshot and only ever changes *intent*: who should
 * be where, which card belongs to whom. `advance` moves the world toward that
 * intent by a real elapsed time. Nothing in `advance` reads the board, and
 * nothing in `sync` sets a position directly — that separation is what keeps
 * motion honest when polls arrive late or out of order.
 */
export class FloorScene {
  constructor() {
    this.agents = new Map();
    this.cards = new Map();
    this.benches = [];
    this.bases = [];
    this.shelf = [];
    this.shelfColumns = [];
    // Which stack is open. Kept on the scene rather than the renderer so a
    // poll cannot quietly close a folder the reader just opened.
    this.expandedColumn = null;
    // A click pins a stack open; hovering elsewhere then leaves it alone.
    this.pinnedColumn = null;
    this.places = { benches: new Map(), shelf: [], bases: new Map() };
    this.elapsed = 0;
  }

  sync(snapshot) {
    this.benches = snapshot.benches || [];
    this.bases = snapshot.bases || [];
    this.shelf = snapshot.shelf || [];
    this.shelfColumns = groupShelf(this.shelf, snapshot.stageOrder || []);
    if (this.expandedColumn
      && !this.shelfColumns.some(function (column) {
        return column.key === this.expandedColumn;
      }, this)) {
      // The open stack emptied out; close it rather than leaving a folder
      // open onto nothing.
      this.expandedColumn = null;
    }
    this.places = planLayout(this);

    const seenAgents = new Set();
    for (const agent of snapshot.agents || []) {
      seenAgents.add(agent.name);
      const existing = this.agents.get(agent.name);
      const home = this.places.bases.get(agent.baseKey)
        || { x: 118, y: 150 };
      const bench = agent.benchId
        ? this.places.benches.get(agent.benchId)
        : null;
      const target = bench
        ? { x: bench.standX, y: bench.standY }
        : { x: home.x + agent.seat.dx, y: home.y + agent.seat.dy };

      if (existing) {
        existing.hue = agent.hue;
        existing.shape = agent.shape;
        existing.benchId = agent.benchId;
        existing.working = agent.working;
        existing.beating = agent.beating;
        existing.label = agent.label;
        existing.note = agent.note;
        existing.meter = agent.meter;
        // Only the destination changes on a poll. Position is the scene's.
        existing.target = target;
        existing.home = { x: home.x + agent.seat.dx, y: home.y + agent.seat.dy };
      } else {
        // A newly seen agent starts at its seat rather than sliding in from
        // the origin, which would read as an arrival that never happened.
        const start = { x: home.x + agent.seat.dx, y: home.y + agent.seat.dy };
        this.agents.set(agent.name, {
          name: agent.name,
          hue: agent.hue,
          shape: agent.shape,
          label: agent.label,
          benchId: agent.benchId,
          working: agent.working,
          beating: agent.beating,
          note: agent.note,
          meter: agent.meter,
          x: start.x,
          y: start.y,
          home: start,
          target: target,
          bob: Math.random() * Math.PI * 2,
        });
      }
    }
    for (const name of Array.from(this.agents.keys())) {
      if (!seenAgents.has(name)) this.agents.delete(name);
    }

    this.placeShelfCards();
    for (const bench of this.benches) {
      if (!bench.cardId) continue;
      const place = this.places.benches.get(bench.id);
      if (!place) continue;
      const existing = this.cards.get(bench.cardId);
      // Centred over the agent, not off his right shoulder, where it read as a
      // second task standing beside him. Above the nameplate rather than below
      // his feet: he now stands on the belt, and the space under him belongs to
      // the station labels.
      const tabWidth = dockedCardWidth(bench.kindLabel || bench.kind);
      const target = {
        x: Math.round(place.standX - tabWidth / 2),
        y: place.standY - 64,
      };
      if (existing) {
        existing.target = target;
        existing.carriedBy = bench.agentName || null;
        existing.kind = bench.kind;
        existing.kindLabel = bench.kindLabel;
        existing.docked = true;
      } else {
        // A card that appears already at a bench was claimed between polls;
        // start it at the shelf edge so the hand-off still reads as motion.
        this.cards.set(bench.cardId, {
          id: bench.cardId,
          x: place.x + 20,
          y: FLOOR.shelfTop + 40,
          target: target,
          carriedBy: bench.agentName || null,
          kind: bench.kind,
          kindLabel: bench.kindLabel,
          docked: true,
        });
      }
    }
  }

  /**
   * Apply the current shelf layout to the cards.
   *
   * Split out of `sync` because opening a folder changes where cards belong
   * without any new board data. Leaving it inside meant a stack looked frozen
   * until the next poll arrived — the folder appeared to open by itself
   * fifteen seconds later.
   */
  placeShelfCards() {
    // Membership is decided by what the layout actually shows, not by what
    // is on the shelf. Keying it on the whole shelf meant a collapsed stack
    // kept every hidden card alive at its expanded position: the model
    // closed, the picture did not, and the folder looked stuck open.
    const visible = new Set(this.places.shelf.map(function (slot) {
      return slot.id;
    }));
    for (const bench of this.benches) {
      if (bench.cardId) visible.add(bench.cardId);
    }
    for (const id of Array.from(this.cards.keys())) {
      if (!visible.has(id)) this.cards.delete(id);
    }
    this.places.shelf.forEach(function (slot) {
      const existing = this.cards.get(slot.id);
      const source = this.shelf.find(function (card) { return card.id === slot.id; }) || {};
      if (existing) {
        existing.target = { x: slot.x, y: slot.y };
        existing.carriedBy = null;
        existing.docked = false;
        existing.title = source.title;
        existing.kindLabel = source.kindLabel;
        existing.wait = source.wait;
        existing.kind = source.kind;
      } else {
        this.cards.set(slot.id, {
          id: slot.id,
          x: slot.x,
          y: slot.y,
          target: { x: slot.x, y: slot.y },
          carriedBy: null,
          kind: (this.shelf.find(function (card) { return card.id === slot.id; }) || {}).kind,
          title: (this.shelf.find(function (card) { return card.id === slot.id; }) || {}).title,
          kindLabel: (this.shelf.find(function (card) { return card.id === slot.id; }) || {}).kindLabel,
          wait: (this.shelf.find(function (card) { return card.id === slot.id; }) || {}).wait,
        });
      }
    }, this);
  }

  toggleColumn(key) {
    this.expandedColumn = this.expandedColumn === key ? null : key;
    this.places = planLayout(this);
    this.placeShelfCards();
  }

  /** Click: pin a stack open, or release it. Pinning survives hovering away. */
  pinColumn(key) {
    const pinning = this.pinnedColumn !== key;
    this.pinnedColumn = pinning ? key : null;
    this.expandedColumn = pinning ? key : null;
    this.places = planLayout(this);
    this.placeShelfCards();
  }

  /** Pointer left the stack: close it, unless a click pinned it open. */
  closeHover(key) {
    if (this.pinnedColumn) return false;
    if (this.expandedColumn !== key) return false;
    this.expandedColumn = null;
    this.places = planLayout(this);
    this.placeShelfCards();
    return true;
  }

  /** Hover-open a stack without pinning it. Same immediate re-placement. */
  hoverColumn(key) {
    if (this.pinnedColumn) return false;
    if (this.expandedColumn === key) return false;
    this.expandedColumn = key;
    this.places = planLayout(this);
    this.placeShelfCards();
    return true;
  }

  advance(deltaSeconds) {
    const step = Math.min(Math.max(deltaSeconds, 0), 0.25);
    this.elapsed += step;
    for (const agent of this.agents.values()) {
      const gap = distance(agent.x, agent.y, agent.target.x, agent.target.y);
      if (gap > 0.5) {
        const travel = Math.min(gap, WALK_SPEED * step);
        const ratio = travel / gap;
        agent.x = lerp(agent.x, agent.target.x, ratio);
        agent.y = lerp(agent.y, agent.target.y, ratio);
        agent.walking = true;
      } else {
        agent.x = agent.target.x;
        agent.y = agent.target.y;
        agent.walking = false;
      }
      agent.bob += step * (agent.walking ? 9 : 1.6);
    }
    for (const card of this.cards.values()) {
      const carrier = card.carriedBy ? this.agents.get(card.carriedBy) : null;
      // A carried card rides the agent rather than racing it to the bench.
      const target = carrier && carrier.walking
        ? { x: carrier.x + 20, y: carrier.y - CARRY_LIFT }
        : card.target;
      const gap = distance(card.x, card.y, target.x, target.y);
      if (gap > 0.5) {
        const travel = Math.min(gap, WALK_SPEED * 1.15 * step);
        const ratio = travel / gap;
        card.x = lerp(card.x, target.x, ratio);
        card.y = lerp(card.y, target.y, ratio);
      } else {
        card.x = target.x;
        card.y = target.y;
      }
    }
  }

  /** True when everything has reached where the board says it belongs.
   *
   * Compares positions rather than the `walking` flag: the flag is only set
   * once `advance` has run, so trusting it reports a freshly synced scene as
   * already settled and any caller waiting on it never waits at all.
   */
  settled() {
    for (const agent of this.agents.values()) {
      if (distance(agent.x, agent.y, agent.target.x, agent.target.y) > 0.5) {
        return false;
      }
    }
    for (const card of this.cards.values()) {
      if (distance(card.x, card.y, card.target.x, card.target.y) > 0.5) {
        return false;
      }
    }
    return true;
  }
}
