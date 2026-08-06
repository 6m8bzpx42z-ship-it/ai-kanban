/**
 * What order the cards sit in — and why that's a real decision.
 *
 * A board sorted by priority alone hides the most useful fact it knows. Two P1s
 * look identical, but if one of them is the blocker for three other cards and
 * the other blocks nothing, they are not the same card: finishing the first
 * releases four pieces of work, finishing the second releases one. That's
 * leverage, and it's invisible without walking the dependency graph.
 *
 * This lived inline in the beads route and was WRONG for its whole life — the
 * sort ran before the graph walk that fills in `unblocks`, so every card
 * compared as zero and the ordering silently did nothing. It rendered a correct
 * "frees 3 others" badge next to an order that ignored it. A Codex review caught
 * it; no test did, because nothing tested order.
 *
 * So it lives here now: pure, exported, and covered. The lesson generalises —
 * anything computed from a field assigned elsewhere in the same function is one
 * edit away from reading undefined, and it fails silently every time.
 */

export interface OrderableCard {
  title: string;
  priority?: number;
  unblocks?: { id: string; title: string }[];
}

/**
 * Priority first, then leverage, then title.
 *
 * Priority stays the outer key deliberately — leverage is a tiebreaker, not an
 * override. A P3 that frees five cards is still less urgent than a P1 that frees
 * none, because the P1 is what's on fire. Title last so the order is stable
 * rather than dependent on however the rows came back.
 */
export function compareCards(a: OrderableCard, b: OrderableCard): number {
  const byPriority = (a.priority ?? 9) - (b.priority ?? 9);
  if (byPriority !== 0) return byPriority;

  const au = (a.unblocks || []).length;
  const bu = (b.unblocks || []).length;
  if (au !== bu) return bu - au;

  return a.title.localeCompare(b.title);
}

/** Sort in place, returning the same array for convenience at call sites. */
export function orderColumn<T extends OrderableCard>(cards: T[]): T[] {
  return cards.sort(compareCards);
}
