/**
 * Coverage for the card ordering, including the way it fails silently.
 *
 * Read this before changing `board-order.ts`, because the dangerous bug here is
 * not a wrong comparator. A correct comparator that runs BEFORE the graph walk
 * that fills in `unblocks` is worse: every card compares as length 0, the
 * ordering does nothing at all, and the "frees 3 others" badge beside it still
 * renders perfectly. Correct code, zero effect, no error.
 *
 * That is why the last check reads the route source instead of calling a
 * function. A unit test of a comparator cannot tell that the comparator ran too
 * early, so the order of operations has to be asserted directly.
 *
 * Run it:  node --test lib/board-order.test.ts
 * No test framework, no install. Node strips the types itself.
 */

import { readFileSync } from "node:fs";
import { compareCards, orderColumn } from "./board-order.ts";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const card = (
  title: string,
  priority: number,
  frees: number
): { title: string; priority: number; unblocks: { id: string; title: string }[] } => ({
  title,
  priority,
  unblocks: Array.from({ length: frees }, (_, i) => ({ id: `x${i}`, title: `t${i}` })),
});

console.log("board ordering");

// The regression itself: same priority, different leverage.
{
  const cards = [card("frees nothing", 1, 0), card("frees three", 1, 3)];
  const order = orderColumn(cards).map((c) => c.title);
  check(
    "a card that frees work outranks one that frees none",
    order[0] === "frees three",
    `got ${order.join(" then ")}`
  );
}

// Priority must stay the OUTER key — leverage is a tiebreaker, not an override.
// A P3 that frees five cards is still less urgent than the P1 that is on fire.
{
  const cards = [card("P3 frees five", 3, 5), card("P1 frees none", 1, 0)];
  const order = orderColumn(cards).map((c) => c.title);
  check(
    "priority still beats leverage",
    order[0] === "P1 frees none",
    `got ${order.join(" then ")}`
  );
}

// `unblocks` missing entirely — which is what every card looks like if the sort
// runs before the graph walk. It must sort as zero leverage, not throw on
// `.length` of undefined.
{
  const a = { title: "no field", priority: 2 };
  const b = { title: "has leverage", priority: 2, unblocks: [{ id: "z", title: "z" }] };
  check(
    "a missing unblocks field sorts as zero, not as a crash",
    compareCards(a, b) > 0
  );
}

// Stability: equal priority AND equal leverage falls back to title, so the board
// does not reshuffle itself between polls just because rows came back in a
// different order.
{
  const cards = [card("beta", 2, 1), card("alpha", 2, 1)];
  const order = orderColumn(cards).map((c) => c.title);
  check("ties break by title so the order is stable", order[0] === "alpha");
}

// Unprioritised cards sink rather than floating to the top as priority 0.
{
  const cards = [{ title: "no priority" }, card("P3", 3, 0)];
  const order = orderColumn(cards).map((c) => c.title);
  check("a card with no priority sorts last, not first", order[0] === "P3");
}

// The wiring guard — the only check here that can catch the silent failure.
// Assert the ORDER OF OPERATIONS in the route: the sort must come after the
// assignment it depends on.
//
// This reads the route by path, so it only runs when the route sits where the
// README says to put it (lib/ and app/ as siblings under your source root). If
// you moved things, it says so and skips rather than failing a test you did not
// break — but fix the path if you can, because this is the check that matters.
{
  const routeUrl = new URL("../app/api/beads/route.ts", import.meta.url);
  let route: string | null = null;
  try {
    route = readFileSync(routeUrl, "utf8");
  } catch {
    console.log(
      `  – skipped: route not found at ${routeUrl.pathname} — point this at your copy of app/api/beads/route.ts`
    );
  }
  if (route !== null) {
    const assigns = route.indexOf("enriched.unblocks =");
    const sorts = route.indexOf("orderColumn(columns[key]");
    check(
      "the route sorts AFTER unblocks is assigned, not before",
      assigns !== -1 && sorts !== -1 && assigns < sorts,
      `assign at ${assigns}, sort at ${sorts}`
    );
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
