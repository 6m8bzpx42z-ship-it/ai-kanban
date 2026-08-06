"use client";

import { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from "react";

/**
 * Your backlog, as a board.
 *
 * Beads is the source of truth and this only reads it, so there is no second
 * copy to drift. Five columns, but only three of them are stored: beads knows
 * open / in_progress / closed, and Ready vs Blocked is DERIVED from the
 * dependency graph on every load. Close a blocker and whatever it was holding
 * moves itself — nobody maintains a "blocked" flag, because nobody can be
 * trusted to.
 *
 * Parked is the fifth column, backed by beads' `deferred` status. It means
 * parked by choice, which is a different thing from blocked, and it stays
 * collapsed by default.
 *
 * Design notes worth keeping if you rework this:
 *  - Cards carry a description preview, not just a title. A column of bare
 *    titles all reads the same at a glance.
 *  - The issue ID is always visible, never hover-only. It's what you type at
 *    the CLI, so a card you can't address without hovering can't be acted on.
 *  - Movement is animated (see the FLIP effect below). A card that teleports
 *    reads as a page refresh rather than as cause and effect.
 */

interface Issue {
  id: string;
  title: string;
  status: string;
  priority: number;
  issue_type: string;
  labels?: string[];
  description?: string;
  assignee?: string;
  owner?: string;
  close_reason?: string;
  blockers?: { id: string; title: string }[];
  unblocks?: { id: string; title: string }[];
  ageDays?: number;
}

type Column = "ready" | "in_progress" | "blocked" | "done" | "deferred";

interface Board {
  columns: Record<Column, Issue[]>;
  counts: Record<Column | "total", number>;
  error?: string;
}

const COLUMNS: { key: Column; label: string; hint: string; hue: string }[] = [
  { key: "ready", label: "Ready", hint: "nothing in the way", hue: "var(--hud-green)" },
  { key: "in_progress", label: "In Progress", hint: "claimed", hue: "#fbbf24" },
  { key: "blocked", label: "Blocked", hint: "waiting on another card", hue: "#f87171" },
  { key: "done", label: "Done", hint: "shipped + verified", hue: "var(--muted)" },
  // Parked by choice, not stuck. Collapsed by default like Done — it isn't
  // work you can start, and it isn't work waiting on anything.
  { key: "deferred", label: "Parked", hint: "deliberately on hold", hue: "#a78bfa" },
];

const TYPE_ICON: Record<string, string> = {
  bug: "🐛", feature: "✨", task: "🔧", chore: "🧹", epic: "🏔", decision: "⚖️",
};

const PRIORITY_HUE = ["#f87171", "#fb923c", "#7fb4ff", "#56729c", "#56729c"];
const priHue = (p: number) => PRIORITY_HUE[Math.min(4, Math.max(0, p ?? 3))];

/**
 * `title` is a prop with a generic default so the downloadable starter kit
 * doesn't hand viewers a board labelled with the name of someone else's private
 * project. Pass your own to override it.
 */
export default function BeadsBoard({ title = "Project Board" }: { title?: string } = {}) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Issue | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [showParked, setShowParked] = useState(false);
  const [query, setQuery] = useState("");
  const [maxPri, setMaxPri] = useState(4);
  const [stream, setStream] = useState<string>("all");
  const [reloadKey, setReloadKey] = useState(0);
  const [dragging, setDragging] = useState<Issue | null>(null);
  const [dropTarget, setDropTarget] = useState<Column | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  // When the last successful poll landed — drives the "updated Ns ago" readout.
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Cards that just changed column, so they can flash once on arrival.
  const [arrived, setArrived] = useState<Set<string>>(new Set());
  // Live DOM nodes, for measuring positions before and after a re-render.
  const cardRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // Where each card sat last render, and which column it was in.
  const prevRects = useRef<Record<string, DOMRect>>({});
  const prevCols = useRef<Record<string, Column>>({});
  // Non-null while the drawer is asking what was actually done before closing.
  const [closingNote, setClosingNote] = useState<string | null>(null);

  // Pure fetch, no setState — so the effect below owns all state transitions
  // and can drop a response that arrives after the component moved on.
  async function fetchBoard(): Promise<{ board?: Board; error?: string }> {
    try {
      const res = await fetch(`/api/beads?done=true`);
      const json = await res.json();
      if (json.error) return { error: json.error };
      return { board: json };
    } catch {
      return { error: "Couldn't reach the beads API" };
    }
  }

  const load = useCallback(() => setReloadKey((k) => k + 1), []);

  /**
   * Open another card from a dependency row. The whole reason to use a
   * dependency-aware tracker is that the graph is walkable, and until now the
   * drawer printed the neighbours as dead text — you could see that a card was
   * waiting on something and had no way to go look at it.
   *
   * Falls back to a refusal rather than silently doing nothing: a closed
   * blocker isn't in the board payload, and a click that appears to do nothing
   * reads as a broken button.
   */
  /**
   * Every path that changes which card the drawer shows goes through here, so
   * the pending close note can't outlive the card it was written about. Four
   * separate setOpen call sites is exactly how a half-typed note ends up
   * attached to a different card.
   */
  const showCard = useCallback((issue: Issue | null) => {
    setOpen(issue);
    setClosingNote(null);
  }, []);

  const jumpTo = useCallback(
    (id: string) => {
      const all = board ? Object.values(board.columns).flat() : [];
      const found = all.find((i) => i.id === id);
      if (found) showCard(found);
      else setRefused(`${id} isn't on the board right now — it may be closed and hidden.`);
    },
    [board, showCard]
  );


  useEffect(() => {
    // Fire-and-forget rather than calling load() bare: the lint rule flags a
    // synchronous call in an effect body, and void makes the intent explicit —
    // this is a subscription to an external system (the bd CLI), not state sync.
    let cancelled = false;
    void (async () => {
      const result = await fetchBoard();
      if (cancelled) return;
      if (result.error) setError(result.error);
      else if (result.board) { setError(null); setBoard(result.board); setLastSync(Date.now()); }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  /**
   * Poll while the tab is visible.
   *
   * Not a nicety: if you run coding agents against this board, cards close
   * underneath you constantly and a board that only loads on mount is wrong
   * within about a minute. It shows finished work as available, which is the
   * one thing a board must never do.
   *
   * Paused when the tab is hidden — each poll shells out to `bd`, and there's no
   * reason to spawn processes for a board nobody is looking at.
   */
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") setReloadKey((k) => k + 1);
    };
    // 2.5s, not 15s. A `bd close` in the terminal has to show up on screen
    // while the viewer is still looking at the terminal — Codex measured the
    // old interval as up to a 15-second dead pause, which kills the demo.
    // Each poll shells out to `bd`, which is cheap, and it pauses when hidden.
    const timer = setInterval(tick, 2500);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);


  // "Streams" are just labels, minus the one every card carries.
  const streams = useMemo(() => {
    if (!board) return [];
    const seen = new Map<string, number>();
    for (const col of Object.values(board.columns)) {
      for (const i of col) {
        for (const l of i.labels || []) {
          if (l !== "engine") seen.set(l, (seen.get(l) || 0) + 1);
        }
      }
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]);
  }, [board]);

  const filtered = useMemo(() => {
    if (!board) return null;
    const q = query.trim().toLowerCase();
    const keep = (i: Issue) =>
      (i.priority ?? 3) <= maxPri &&
      (stream === "all" || (i.labels || []).includes(stream)) &&
      (!q ||
        i.title.toLowerCase().includes(q) ||
        (i.description || "").toLowerCase().includes(q) ||
        i.id.includes(q));
    const out = {} as Record<Column, Issue[]>;
    for (const c of COLUMNS) out[c.key] = board.columns[c.key].filter(keep);
    return out;
  }, [board, query, maxPri, stream]);

  /**
   * Make the movement visible.
   *
   * The board was already CORRECT when a card became unblocked — it just wasn't
   * legible. The data changed and React reflowed the columns instantly, so the
   * card teleported. On camera that reads as a page refresh, not as cause and
   * effect, which throws away the one thing this board does that a checklist
   * can't: close a blocker and watch the next thing free itself.
   *
   * This is FLIP. Measure where every card was (First), let React put it where
   * it now goes (Last), Invert that with a transform so it appears not to have
   * moved, then Play by removing the transform on the next frame. No animation
   * library, and nothing to keep in sync with the layout.
   *
   * useLayoutEffect rather than useEffect on purpose: the invert transform has
   * to be applied before the browser paints, or you see one frame of the card
   * already in its new home, which is the exact artefact this removes.
   */
  useLayoutEffect(() => {
    if (!filtered) return;
    const nextRects: Record<string, DOMRect> = {};
    const nextCols: Record<string, Column> = {};
    const justArrived = new Set<string>();

    for (const key of Object.keys(filtered) as Column[]) {
      for (const issue of filtered[key]) {
        nextCols[issue.id] = key;
        const el = cardRefs.current[issue.id];
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        nextRects[issue.id] = rect;

        const before = prevRects.current[issue.id];
        if (before) {
          const dx = before.left - rect.left;
          const dy = before.top - rect.top;
          // Sub-pixel jitter isn't movement; animating it makes a still board shimmer.
          if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
            el.style.transition = "none";
            el.style.transform = `translate(${dx}px, ${dy}px)`;
            requestAnimationFrame(() => {
              el.style.transition = "transform 420ms cubic-bezier(0.2, 0.8, 0.2, 1)";
              el.style.transform = "";
            });
          }
        }
        const wasIn = prevCols.current[issue.id];
        if (wasIn && wasIn !== key) justArrived.add(issue.id);
      }
    }

    prevRects.current = nextRects;
    prevCols.current = nextCols;
    if (justArrived.size > 0) setArrived(justArrived);
  }, [filtered]);

  // Let the arrival flash finish, then clear it so it can fire again next time.
  useEffect(() => {
    if (arrived.size === 0) return;
    const t = setTimeout(() => setArrived(new Set()), 1600);
    return () => clearTimeout(t);
  }, [arrived]);

  // Ticks the "updated Ns ago" readout without re-fetching anything.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const sinceSync = useMemo(() => {
    if (!lastSync) return "";
    const secs = Math.max(0, Math.round((now - lastSync) / 1000));
    if (secs < 3) return "just now";
    if (secs < 60) return `${secs}s ago`;
    return `${Math.floor(secs / 60)}m ago`;
  }, [now, lastSync]);


  /**
   * Which drops are legal, and why the illegal ones are refused rather than
   * silently ignored. Blocked is the important case: it is DERIVED from the
   * dependency graph, so dragging a card into it — or dragging a blocked card
   * into Ready — would be asking the UI to state something beads knows is
   * false. The board is a window; it doesn't get to invent status.
   */
  function dropAction(issue: Issue, from: Column, to: Column): { action?: "claim" | "close" | "reopen"; refuse?: string } {
    if (from === to) return {};
    if (to === "blocked") return { refuse: "Blocked isn't a status — it's whether something else is still open." };
    if (to === "deferred") return { refuse: "Park a card with `bd update <id> --status deferred`." };
    if (from === "deferred" && to === "ready") return { action: "reopen" };
    if (from === "blocked" && to !== "done") {
      const b = issue.blockers?.[0];
      return { refuse: b ? `Still waiting on ${b.title}. Close that first.` : "This is blocked by an open dependency." };
    }
    if (to === "in_progress") return { action: "claim" };
    if (to === "done") return { action: "close" };
    if (to === "ready") return { action: "reopen" };
    return {};
  }

  function columnOf(issue: Issue): Column {
    if (issue.status === "closed") return "done";
    if (issue.status === "deferred") return "deferred";
    if (issue.status === "in_progress") return "in_progress";
    return (board?.columns.blocked || []).some((i) => i.id === issue.id) ? "blocked" : "ready";
  }

  async function handleDrop(to: Column) {
    const issue = dragging;
    setDragging(null);
    setDropTarget(null);
    if (!issue) return;
    const { action, refuse } = dropAction(issue, columnOf(issue), to);
    if (refuse) {
      setRefused(refuse);
      setTimeout(() => setRefused(null), 4000);
      return;
    }
    if (action) await act(issue.id, action);
  }

  async function act(id: string, action: "claim" | "close" | "reopen", note?: string) {
    setBusy(id);
    try {
      const res = await fetch("/api/beads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action, note }),
      });
      const json = await res.json();
      if (json.error) setError(json.error);
      else { showCard(null); load(); }
    } catch {
      setError(`Couldn't ${action} ${id}`);
    }
    setBusy(null);
  }

  const visible = COLUMNS.filter(
    (c) => (c.key !== "done" || showDone) && (c.key !== "deferred" || showParked)
  );
  const doneCount = board?.counts.done ?? 0;
  // Parked work is excluded: it isn't outstanding, and counting it made the
  // shipped percentage look worse than the actual state of the project.
  const openCount =
    (board?.counts.ready ?? 0) + (board?.counts.in_progress ?? 0) + (board?.counts.blocked ?? 0);
  const pct = openCount + doneCount > 0 ? Math.round((doneCount / (openCount + doneCount)) * 100) : 0;

  return (
    <div className="max-w-[1700px]">
      {/* Header — shipped-vs-left is the number worth seeing first */}
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2 mb-4">
        <div>
          <h1 className="text-2xl font-bold gradient-text leading-tight">{title}</h1>
          <p className="hud-label mt-1">
            beads · drag to move ·{" "}
            {/* A live board has to SAY it's live. Without this, a card that
                moves on its own reads as a glitch rather than as the board
                reacting to something you did in another window. */}
            <span style={{ color: "var(--hud-green)" }}>
              ● {lastSync ? `updated ${sinceSync}` : "connecting…"}
            </span>
          </p>
        </div>
        <div className="flex items-end gap-5 ml-auto">
          {COLUMNS.map((c) => (
            <button
              key={c.key}
              onClick={() => {
                if (c.key === "done") setShowDone((v) => !v);
                if (c.key === "deferred") setShowParked((v) => !v);
              }}
              className={
                c.key === "done" || c.key === "deferred"
                  ? "text-center cursor-pointer"
                  : "text-center cursor-default"
              }
            >
              <div className="text-xl font-bold tabular-nums" style={{ color: c.hue }}>
                {board?.counts[c.key] ?? "–"}
              </div>
              <div className="text-[9px] uppercase tracking-wider text-muted">
                {c.label}
                {c.key === "done" && (showDone ? " ▾" : " ▸")}
                {c.key === "deferred" && (showParked ? " ▾" : " ▸")}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Priority tiles. The column counts say how much work there is; these say
          how much of it is ON FIRE, which is the question you actually open the
          board with. */}
      {board && (
        <div className="flex flex-wrap gap-2 mb-4">
          {[0, 1, 2, 3].map((p) => {
            const n = Object.entries(board.columns)
              .filter(([k]) => k !== "done")
              .flatMap(([, v]) => v)
              .filter((i) => (i.priority ?? 3) === p).length;
            return (
              <div
                key={p}
                className="min-w-[74px] px-3 py-2 rounded-lg bg-[var(--surface)] border border-[var(--border)] text-center"
                style={{ borderTop: `3px solid ${PRIORITY_HUE[p]}` }}
              >
                <div className="text-xl font-bold tabular-nums leading-none" style={{ color: PRIORITY_HUE[p] }}>
                  {n}
                </div>
                <div className="text-[9px] uppercase tracking-wider text-muted mt-1.5">P{p} open</div>
              </div>
            );
          })}
          <div className="min-w-[74px] px-3 py-2 rounded-lg bg-[var(--surface)] border border-[var(--border)] text-center"
               style={{ borderTop: "3px solid var(--muted)" }}>
            <div className="text-xl font-bold tabular-nums leading-none text-muted">
              {board.columns.done.length}
            </div>
            <div className="text-[9px] uppercase tracking-wider text-muted mt-1.5">closed</div>
          </div>
          {filtered && (
            <div className="ml-auto self-end text-[10px] text-muted">
              {Object.values(filtered).flat().length} of {board.counts.total ?? Object.values(board.columns).flat().length} shown
            </div>
          )}
        </div>
      )}

      <div className="h-1 rounded-full bg-[var(--surface)] overflow-hidden mb-5">
        <div
          className="h-full transition-all duration-700"
          style={{ width: `${pct}%`, background: "linear-gradient(90deg,var(--hud-green),var(--hud-cyan))" }}
        />
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 mb-5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search titles, descriptions, ids…"
          className="flex-1 min-w-[220px] bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs text-foreground placeholder:text-muted focus:outline-none focus:border-[var(--accent)]"
        />
        <div className="flex items-center gap-1">
          {[0, 1, 2, 3].map((p) => (
            <button
              key={p}
              onClick={() => setMaxPri(p === maxPri ? 4 : p)}
              className="text-[10px] font-mono px-2 py-1.5 rounded border transition-colors"
              style={{
                borderColor: maxPri === p ? priHue(p) : "var(--border)",
                color: maxPri === p ? priHue(p) : "var(--muted)",
                background: maxPri === p ? `${priHue(p)}14` : "transparent",
              }}
              title={`only P${p} and above`}
            >
              ≤P{p}
            </button>
          ))}
        </div>
        <select
          value={stream}
          onChange={(e) => setStream(e.target.value)}
          className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-2 py-2 text-xs text-foreground focus:outline-none focus:border-[var(--accent)]"
        >
          <option value="all">all streams</option>
          {streams.map(([s, n]) => (
            <option key={s} value={s}>
              {s} ({n})
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 mb-4 text-sm text-red-400">
          {error}
        </div>
      )}
      {refused && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-[#f87171]/15 border border-[#f87171]/40 rounded-lg px-4 py-2.5 text-sm text-[#f87171] backdrop-blur-sm">
          ⛔ {refused}
        </div>
      )}
      {!board && !error && <p className="text-sm text-muted">Reading the board…</p>}

      {filtered && (
        <div
          className="grid gap-3 items-start"
          style={{ gridTemplateColumns: `repeat(${visible.length}, minmax(0,1fr))` }}
        >
          {visible.map((col) => (
            <section
              key={col.key}
              className="min-w-0 rounded-lg transition-colors"
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                setDropTarget(col.key);
              }}
              onDragLeave={() => setDropTarget((t) => (t === col.key ? null : t))}
              onDrop={(e) => { e.preventDefault(); handleDrop(col.key); }}
              style={
                dropTarget === col.key && dragging
                  ? dropAction(dragging, columnOf(dragging), col.key).refuse
                    ? { outline: "2px dashed #f87171", outlineOffset: 4 }
                    : { outline: `2px dashed ${col.hue}`, outlineOffset: 4 }
                  : undefined
              }
            >
              <header
                className="flex items-baseline gap-2 mb-2 pb-2"
                style={{ borderBottom: `1px solid ${col.hue}33` }}
              >
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: col.hue }} />
                <h2 className="text-xs font-semibold tracking-wide" style={{ color: col.hue }}>
                  {col.label.toUpperCase()}
                </h2>
                <span className="text-[10px] text-muted ml-auto tabular-nums">
                  {filtered[col.key].length}
                </span>
              </header>
              {/* What the column MEANS, not just what it's called. "Blocked"
                  is ambiguous until it says "waiting on another card" — and
                  Ready vs Parked is the distinction people get wrong. */}
              <p className="text-[9px] text-muted/70 -mt-1 mb-2 px-0.5">{col.hint}</p>

              <div className="space-y-2">
                {filtered[col.key].length === 0 && (
                  <p className="text-[11px] text-muted/50 px-1 py-6 text-center border border-dashed border-[var(--border)] rounded-lg">
                    {col.hint}
                  </p>
                )}
                {filtered[col.key].map((issue) => (
                  <button
                    key={issue.id}
                    ref={(el) => { cardRefs.current[issue.id] = el; }}
                    draggable
                    onDragStart={() => setDragging(issue)}
                    onDragEnd={() => { setDragging(null); setDropTarget(null); }}
                    onClick={() => showCard(issue)}
                    data-arrived={arrived.has(issue.id) ? "1" : undefined}
                    className="board-card w-full text-left hud-card rounded-lg p-2.5 group cursor-grab active:cursor-grabbing"
                    style={{
                      borderLeft: `4px solid ${priHue(issue.priority)}`,
                      opacity: dragging?.id === issue.id ? 0.4 : 1,
                    }}
                  >
                    {/* Meta row. The ID is always visible now rather than
                        hover-only: it's what you type at the CLI, and a card you
                        can't address without hovering is a card you can't act on. */}
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <span className="text-[9px] font-mono text-muted/70">{issue.id}</span>
                      <span
                        className="text-[9px] font-mono px-1 rounded font-bold"
                        style={{ background: `${priHue(issue.priority)}1f`, color: priHue(issue.priority) }}
                      >
                        P{issue.priority ?? 3}
                      </span>
                      {issue.issue_type && (
                        <span className="text-[9px] text-muted bg-[var(--surface)] border border-[var(--border)] rounded px-1 leading-4">
                          {TYPE_ICON[issue.issue_type] || "•"} {issue.issue_type}
                        </span>
                      )}
                      {typeof issue.ageDays === "number" && issue.ageDays >= 7 && (
                        <span
                          className="text-[9px] font-mono ml-auto"
                          style={{ color: issue.ageDays >= 30 ? "#fb923c" : "var(--muted)" }}
                          title={`open ${issue.ageDays} days`}
                        >
                          {issue.ageDays}d
                        </span>
                      )}
                    </div>

                    <p
                      className={
                        col.key === "done"
                          ? "text-[12px] leading-snug text-muted line-through"
                          : "text-[12px] leading-snug text-foreground font-medium"
                      }
                    >
                      {issue.title}
                    </p>

                    {/* The detail line — the single biggest thing the board was
                        missing. A wall of bare titles all reads the same; two
                        lines of the actual description is what makes one card
                        look different from the next at a glance.

                        On a Done card it shows the CLOSE REASON instead, because
                        once something has shipped "why did we do this" is a less
                        interesting question than "what actually changed". */}
                    {(() => {
                      const detail =
                        col.key === "done"
                          ? issue.close_reason || "closed with no reason recorded"
                          : issue.description;
                      if (!detail) return null;
                      const text = detail.replace(/\s+/g, " ").trim();
                      return (
                        <p className="text-[10.5px] leading-relaxed text-muted mt-1.5 line-clamp-2">
                          {text.length > 180 ? text.slice(0, 180).replace(/\s+\S*$/, "") + "…" : text}
                        </p>
                      );
                    })()}

                    {issue.unblocks && issue.unblocks.length > 0 && col.key !== "done" && (
                      <p className="text-[9px] text-[var(--hud-green)] mt-2 leading-snug font-semibold">
                        🔓 frees {issue.unblocks.length} other
                        {issue.unblocks.length > 1 ? "s" : ""}
                      </p>
                    )}
                    {col.key === "blocked" && issue.blockers && issue.blockers.length > 0 && (
                      <p className="text-[9px] mt-2 leading-snug inline-block px-1.5 py-0.5 rounded border"
                         style={{ color: "#f87171", background: "rgba(248,113,113,0.08)", borderColor: "rgba(248,113,113,0.22)" }}>
                        ⏸ waiting on {issue.blockers[0].title}
                        {issue.blockers.length > 1 ? ` +${issue.blockers.length - 1}` : ""}
                      </p>
                    )}
                    {issue.labels && issue.labels.filter((l) => l !== "engine").length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {issue.labels
                          .filter((l) => l !== "engine")
                          .slice(0, 3)
                          .map((l) => (
                            <span
                              key={l}
                              className="text-[9px] text-muted bg-[var(--surface)] border border-[var(--border)] rounded px-1 leading-4"
                            >
                              {l}
                            </span>
                          ))}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {/* Drawer — the description carries the diagnosis, so it gets real room */}
      {open && (
        <>
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40" onClick={() => showCard(null)} />
          <aside className="fixed right-0 top-0 bottom-0 w-full max-w-xl bg-[var(--background)] border-l border-[var(--border)] z-50 overflow-y-auto p-6">
            <div className="flex items-center gap-2 mb-3">
              <span
                className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                style={{ background: `${priHue(open.priority)}1f`, color: priHue(open.priority) }}
              >
                P{open.priority ?? 3}
              </span>
              <span>{TYPE_ICON[open.issue_type] || "•"}</span>
              <span className="text-[10px] text-muted font-mono">{open.id}</span>
              <button
                onClick={() => showCard(null)}
                className="ml-auto text-muted hover:text-foreground text-lg leading-none"
              >
                ✕
              </button>
            </div>

            <h2 className="text-lg font-semibold text-foreground mb-4 leading-snug">{open.title}</h2>

            {open.labels && open.labels.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-4">
                {open.labels.map((l) => (
                  <span
                    key={l}
                    className="text-[10px] text-muted bg-[var(--surface)] border border-[var(--border)] rounded px-1.5 py-0.5"
                  >
                    {l}
                  </span>
                ))}
              </div>
            )}

            {open.blockers && open.blockers.length > 0 && (
              <div className="border border-[#f87171]/30 bg-[#f87171]/5 rounded-lg p-3 mb-4">
                <p className="text-[10px] uppercase tracking-wider text-[#f87171] mb-1.5">Blocked by</p>
                {open.blockers.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => jumpTo(b.id)}
                    className="block w-full text-left text-[11px] text-foreground leading-snug hover:text-[#f87171] transition-colors"
                  >
                    <span className="font-mono text-muted">{b.id}</span> — {b.title}
                  </button>
                ))}
              </div>
            )}

            {open.unblocks && open.unblocks.length > 0 && (
              <div className="border border-[var(--hud-green)]/30 bg-[var(--hud-green)]/5 rounded-lg p-3 mb-4">
                <p className="text-[10px] uppercase tracking-wider text-[var(--hud-green)] mb-1.5">
                  Closing this frees
                </p>
                {open.unblocks.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => jumpTo(u.id)}
                    className="block w-full text-left text-[11px] text-foreground leading-snug hover:text-[var(--hud-green)] transition-colors"
                  >
                    <span className="font-mono text-muted">{u.id}</span> — {u.title}
                  </button>
                ))}
              </div>
            )}

            {open.close_reason && (
              <div className="border border-green-500/30 bg-green-500/5 rounded-lg p-3 mb-4">
                <p className="text-[10px] uppercase tracking-wider text-green-400 mb-1">Shipped</p>
                <p className="text-[11px] text-foreground leading-relaxed">{open.close_reason}</p>
              </div>
            )}

            {open.description && (
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-4 mb-5">
                <p className="text-[12px] text-muted whitespace-pre-wrap leading-relaxed">
                  {open.description}
                </p>
              </div>
            )}

            {/* The close note is the board's memory. Every card in Done that
                says "closed from the board" is a card whose reasoning is gone —
                and Done is the column worth re-reading, because it's the record
                of what was actually proven. So ask, once, at the moment the
                answer is known. Skippable: an empty note still closes, because a
                required field would just get filled with "done". */}
            {closingNote !== null && open.status !== "closed" && (
              <div className="border border-green-500/30 bg-green-500/5 rounded-lg p-3 mb-4">
                <p className="text-[10px] uppercase tracking-wider text-green-400 mb-2">
                  What did you actually do? — this is what Done will show
                </p>
                <textarea
                  autoFocus
                  value={closingNote}
                  onChange={(e) => setClosingNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      act(open.id, "close", closingNote);
                    }
                    if (e.key === "Escape") setClosingNote(null);
                  }}
                  rows={3}
                  placeholder="What changed, and how you know it works."
                  className="w-full bg-[var(--surface)] border border-[var(--border)] rounded-md p-2 text-[12px] text-foreground resize-none"
                />
                <div className="flex gap-2 mt-2">
                  <button
                    onClick={() => act(open.id, "close", closingNote)}
                    disabled={busy === open.id}
                    className="px-3 py-1.5 rounded-md text-[12px] bg-green-600/90 hover:bg-green-500 text-white disabled:opacity-50"
                  >
                    {busy === open.id ? "…" : "Close it"}
                  </button>
                  <button
                    onClick={() => setClosingNote(null)}
                    className="px-3 py-1.5 rounded-md text-[12px] text-muted hover:text-foreground"
                  >
                    Cancel
                  </button>
                  <span className="text-[10px] text-muted self-center">⌘↵ to close</span>
                </div>
              </div>
            )}

            <div className="flex gap-2">
              {/* Dragging a blocked card already refuses; the drawer used to offer
                  "Start it" on anything open, so the same card could be claimed
                  from two feet away with its blockers still open. The board is
                  only useful if Ready means ready — a claimed-but-blocked card
                  reads as work in flight when nobody can actually do it. */}
              {open.status !== "in_progress" && open.status !== "closed" && (
                open.blockers && open.blockers.length > 0 ? (
                  <span className="px-4 py-2.5 rounded-lg text-sm bg-[var(--surface)] border border-[var(--border)] text-muted">
                    Can&apos;t start — waiting on {open.blockers[0].title}
                    {open.blockers.length > 1 ? ` +${open.blockers.length - 1}` : ""}
                  </span>
                ) : (
                  <button
                    onClick={() => act(open.id, "claim")}
                    disabled={busy === open.id}
                    className="btn-gradient px-4 py-2.5 rounded-lg text-sm disabled:opacity-50"
                  >
                    {busy === open.id ? "…" : "Start it"}
                  </button>
                )
              )}
              {open.status !== "closed" && closingNote === null && (
                <button
                  onClick={() => setClosingNote("")}
                  disabled={busy === open.id}
                  className="px-4 py-2.5 rounded-lg text-sm bg-green-600/90 hover:bg-green-500 text-white disabled:opacity-50"
                >
                  Mark done
                </button>
              )}
              {open.status === "closed" && (
                <button
                  onClick={() => act(open.id, "reopen")}
                  disabled={busy === open.id}
                  className="px-4 py-2.5 rounded-lg text-sm bg-[var(--surface)] border border-[var(--border)] text-foreground disabled:opacity-50"
                >
                  Reopen
                </button>
              )}
            </div>

            <p className="text-[10px] text-muted font-mono mt-5 select-all bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1.5">
              bd show {open.id}
            </p>

            <p className="text-[10px] text-muted/60 mt-3 leading-relaxed">
              These buttons run the real <code>bd</code> command, so this board and your terminal can
              never disagree. Ready and Blocked aren&apos;t stored anywhere — they come from the
              dependency graph.
            </p>
          </aside>
        </>
      )}
    </div>
  );
}
