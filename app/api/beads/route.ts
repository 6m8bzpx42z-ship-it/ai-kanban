import { NextRequest, NextResponse } from "next/server";
import { orderColumn } from "@/lib/board-order";
import { spawnSync } from "child_process";
import { errorResponse, HttpError, readJsonBody } from "@/lib/http";

/**
 * The board's window onto beads (`bd`).
 *
 * Beads stays the single source of truth — this route shells out and reads,
 * it never keeps a second copy. A board that mirrors its data is a board that
 * drifts, and the whole reason for moving off a markdown checklist was that
 * markdown checklists rot.
 *
 * Beads stores three states: open, in_progress, closed. The board shows five —
 * ready, in progress, blocked, done, parked — and ready/blocked are DERIVED from
 * the dependency graph rather than stored. `bd ready` is the authority on which
 * open issues are actually startable, so "blocked" is simply open-and-not-ready.
 * Nobody maintains those flags by hand; that's the point.
 */

// Where `bd` lives on a Mac. Next's server bundle launches from a login-less
// environment whose PATH often lacks the Homebrew dirs, so we put them back
// rather than trusting whatever PATH we inherited.
const BD_SEARCH_PATH = ["/opt/homebrew/bin", "/usr/local/bin", process.env.PATH ?? ""]
  .filter(Boolean)
  .join(":");

interface BeadIssue {
  id: string;
  title: string;
  status: string;
  priority: number;
  issue_type: string;
  labels?: string[];
  description?: string;
  dependency_count?: number;
  updated_at?: string;
  created_at?: string;
  closed_at?: string;
  // Carried through so the drawer can say what a closed card actually shipped —
  // it's the difference between a status wall and something you can act on.
  close_reason?: string;
  dependencies?: { id?: string; depends_on_id?: string; type?: string }[];
}

/**
 * Fields beads stores about PEOPLE that this board never renders.
 *
 * `owner` is the beads database owner's email address; `assignee` and
 * `created_by` hold a person's name. Nothing in the UI reads any of them, but
 * without this they travel in the JSON regardless — so anyone who opens DevTools,
 * or records their screen with the network tab open, publishes an email address
 * that no pixel on the page ever needed. Dropped at the edge rather than
 * trusting every future consumer of this response not to render them.
 *
 * The nested `dependencies[]` rows get the same treatment, and that is not
 * belt-and-braces. Every dependency edge carries its own `created_by`, so a
 * top-level-only strip leaves one copy of the name per edge behind — and
 * inspecting the parsed card's keys reports it clean, because the leftovers are
 * a level down. Grep the raw response, not the parsed object, when checking.
 *
 * If you want assignee back on the cards, delete it from this list on purpose —
 * that way it is a decision instead of a leak.
 */
const PERSONAL_FIELDS = ["owner", "assignee", "created_by"] as const;

function stripPersonalFields(issues: BeadIssue[]): BeadIssue[] {
  for (const issue of issues) {
    for (const field of PERSONAL_FIELDS) {
      delete (issue as unknown as Record<string, unknown>)[field];
    }
    for (const dep of issue.dependencies || []) {
      for (const field of PERSONAL_FIELDS) {
        delete (dep as unknown as Record<string, unknown>)[field];
      }
    }
  }
  return issues;
}

/**
 * The binary name here MUST stay a literal, and the search happens via PATH
 * instead of a candidate loop.
 *
 * This used to loop over ["/opt/homebrew/bin/bd", "/usr/local/bin/bd", "bd"]
 * and call spawnSync(bin, ...) with the loop variable. A non-literal first
 * argument is unresolvable to Turbopack's file tracer, so it gave up and traced
 * the entire repository into this route's NFT list — 1085 files, including
 * next.config.ts, which is what triggered the "whole project was traced
 * unintentionally" build warning. With the literal, the same route traces 96.
 * Verified by counting .next/server/app/api/beads/route.js.nft.json both ways.
 *
 * Precedence is unchanged: Homebrew ARM, then Intel, then whatever PATH we
 * inherited. The old loop swallowed a missing binary and retried; spawnSync now
 * reports ENOENT once, which we translate to the same not-found message.
 */
function bd(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync("bd", args, {
    encoding: "utf-8",
    cwd: process.cwd(),
    timeout: 30000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PATH: BD_SEARCH_PATH },
  });
  if (res.error) {
    return { ok: false, stdout: "", stderr: `bd not found on PATH (${res.error.message})` };
  }
  return { ok: res.status === 0, stdout: res.stdout || "", stderr: res.stderr || "" };
}

/**
 * An empty board and a broken board are not the same thing, and this used to
 * render them identically: a JSON parse failure returned [], which draws as
 * "nothing to do" — the most reassuring possible screen for the most alarming
 * possible state. If `bd` changes its output shape or dies mid-write, you should
 * see that, not a clean board.
 *
 * A genuinely empty result still returns [] silently, because that one IS
 * "nothing to do".
 */
function parseIssues(raw: string): BeadIssue[] {
  if (!raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `bd returned something that isn't JSON (${(err as Error).message}). ` +
        `First 200 chars: ${raw.slice(0, 200)}`
    );
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { issues?: unknown; data?: unknown })?.issues ||
      (parsed as { data?: unknown })?.data ||
      [];
  if (!Array.isArray(list)) {
    throw new Error(
      `bd returned JSON but not a list of issues — got ${typeof list}. ` +
        `First 200 chars: ${raw.slice(0, 200)}`
    );
  }
  return list as BeadIssue[];
}

export type Column = "ready" | "in_progress" | "blocked" | "done" | "deferred";

export function classify(issue: BeadIssue, readyIds: Set<string>): Column {
  if (issue.status === "closed") return "done";
  if (issue.status === "in_progress") return "in_progress";
  // Deferred is PARKED BY CHOICE, not waiting on anything. `bd ready` withholds
  // it exactly like a blocked card, so without this line every parked card lands
  // in Blocked — and the Blocked count reports several times more stuck work
  // than actually exists: seven parked plus two genuinely blocked reads as a
  // column of nine.
  if (issue.status === "deferred") return "deferred";
  return readyIds.has(issue.id) ? "ready" : "blocked";
}

export async function GET(req: NextRequest) {
  try {
    const includeDone = req.nextUrl.searchParams.get("done") !== "false";

    const listed = bd(["list", "--json", "--all"]);
    if (!listed.ok && !listed.stdout) {
      throw new HttpError(
        503,
        listed.stderr.includes("not found")
          ? "beads isn't installed — run `brew install beads`"
          : `bd failed: ${listed.stderr.slice(0, 200)}`
      );
    }
    const all = stripPersonalFields(parseIssues(listed.stdout));
    // --limit 0 is load-bearing: bd ready applies a default result limit, and a
    // truncated ready list silently reclassifies real ready work as BLOCKED.
    // Under about a hundred issues the default doesn't truncate; past that it
    // does, and the board just quietly starts lying about what you can start.
    // GUARD THE READY CALL. parseIssues returns [] on any failure, and classify
    // then sends every open issue to BLOCKED — a 200 OK reporting the entire
    // backlog as blocked, with no warning. Verified: with this call made to
    // fail, ready went 32 -> 0 and blocked 10 -> 42.
    const readyRes = bd(["ready", "--limit", "0", "--json"]);
    if (!readyRes.ok) {
      throw new HttpError(
        503,
        `bd ready failed, so Ready/Blocked cannot be determined: ${(readyRes.stderr || "unknown error").slice(0, 200)}`
      );
    }
    const readyIds = new Set(parseIssues(readyRes.stdout).map((i) => i.id));

    const columns: Record<Column, BeadIssue[]> = {
      ready: [], in_progress: [], blocked: [], done: [], deferred: [],
    };
    for (const issue of all) {
      const col = classify(issue, readyIds);
      if (col === "done" && !includeDone) continue;
      columns[col].push(issue);
    }
    const titleById = new Map(all.map((i) => [i.id, i.title]));
    const openById = new Map(all.map((i) => [i.id, i.status !== "closed"]));

    // Walk the graph BOTH ways. "What is this waiting on" tells you why a card
    // is stuck; "what is waiting on this" tells you where to start, and that
    // second direction is the one the board never showed. The data was already
    // here — it just only ever got read in one direction.
    const unblocksById = new Map<string, { id: string; title: string }[]>();
    for (const issue of all) {
      if (issue.status === "closed") continue;
      for (const d of issue.dependencies || []) {
        const blockerId = d.depends_on_id || d.id;
        if (!blockerId || openById.get(blockerId) !== true) continue;
        const list = unblocksById.get(blockerId) || [];
        list.push({ id: issue.id, title: issue.title });
        unblocksById.set(blockerId, list);
      }
    }

    const now = Date.now();
    for (const issue of all) {
      const blockers = (issue.dependencies || [])
        .map((d) => d.depends_on_id || d.id)
        .filter((bid): bid is string => !!bid && openById.get(bid) === true)
        .map((bid) => ({ id: bid, title: titleById.get(bid) || bid }));
      const enriched = issue as BeadIssue & { blockers?: unknown; unblocks?: unknown; ageDays?: number };
      enriched.blockers = blockers;
      enriched.unblocks = unblocksById.get(issue.id) || [];
      const created = issue.created_at ? Date.parse(issue.created_at) : NaN;
      enriched.ageDays = Number.isFinite(created)
        ? Math.floor((now - created) / 86400000)
        : 0;
    }

    // Sort AFTER the graph walk, not before.
    //
    // This comparator reads `unblocks`, which is assigned by the enrichment
    // above. It used to run first, so every card compared as length 0 and the
    // leverage ordering silently did nothing — the badge rendered correctly and
    // the sort it was supposed to drive was inert. Caught by a Codex review;
    // no test covered ordering, which is why it survived.
    for (const key of Object.keys(columns) as Column[]) {
      orderColumn(columns[key] as (BeadIssue & { unblocks?: { id: string; title: string }[] })[]);
    }

    return NextResponse.json({
      columns,
      counts: {
        ready: columns.ready.length,
        in_progress: columns.in_progress.length,
        blocked: columns.blocked.length,
        done: columns.done.length,
        deferred: columns.deferred.length,
        total: all.length,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Move a card. Only the transitions the board offers are allowed — this is a
 * view onto beads, not a second way to invent state.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await readJsonBody(req);
    const id = typeof body.id === "string" ? body.id : "";
    const action = typeof body.action === "string" ? body.action : "";
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new HttpError(400, "A valid issue id is required");

    let args: string[];
    if (action === "claim") {
      args = ["update", id, "--claim"];
    } else if (action === "close") {
      // -r, NOT a positional argument. `bd close <id> <note>` reads the note as
      // ANOTHER ISSUE ID and fails with "no issue found matching ..." — which is
      // exactly what the Mark-done button was doing before this was tested.
      const note =
        typeof body.note === "string" && body.note.trim()
          ? body.note.trim().slice(0, 300)
          : "closed from the board";
      args = ["close", id, "-r", note];
    } else if (action === "reopen") {
      args = ["update", id, "--status", "open"];
    } else {
      throw new HttpError(400, "action must be claim, close, or reopen");
    }

    const res = bd(args);
    if (!res.ok) throw new HttpError(500, `bd ${action} failed: ${(res.stderr || res.stdout).slice(0, 300)}`);
    return NextResponse.json({ ok: true, message: (res.stdout || "").trim().slice(0, 300) });
  } catch (error) {
    return errorResponse(error);
  }
}
