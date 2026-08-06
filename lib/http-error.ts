/**
 * HttpError, on its own, with no framework import.
 *
 * It used to live in `http.ts` next to `readJsonBody` and `errorResponse`,
 * which genuinely need `next/server`. That coupling meant a low-level utility
 * like `ffmpeg.ts` — which wants nothing from Next and only throws this one
 * class — transitively pulled in the whole framework module. Under plain Node
 * that fails outright (`next` ships no exports map, so bare `next/server`
 * doesn't resolve), which kept ffmpeg.ts and everything downstream of it out of
 * the test runner entirely.
 *
 * Two fixes were proposed and both were worse: rewriting the import to
 * `next/server.js` diverges from what Next's own shipped docs document, and a
 * resolve hook in the test would make tests resolve the module graph
 * differently from production — exactly the divergence that lets a real import
 * bug pass a green suite.
 *
 * Moving the class is the actual fix, because the dependency was never real.
 * `http.ts` re-exports it, so all 38 existing importers are untouched.
 */
export class HttpError extends Error {
  status: number;
  /**
   * Structured payload merged into the JSON error body. Some refusals need to
   * tell the UI *how* to recover — the privacy gate returns which checklist
   * items are outstanding, and an ambiguous publish returns the candidate files
   * to choose between. A bare message can't carry that.
   */
  details?: Record<string, unknown>;
  constructor(status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
