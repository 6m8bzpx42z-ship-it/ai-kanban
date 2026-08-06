import { NextRequest, NextResponse } from "next/server";
import { HttpError } from "./http-error";

/**
 * Re-exported so all 38 existing `from "@/lib/http"` importers keep working.
 * It lives in http-error.ts because it has no framework dependency, and having
 * it here dragged next/server into every low-level lib that merely throws it.
 */
export { HttpError };


/**
 * Parse the request body as JSON, returning a 400-flavored HttpError on
 * malformed input instead of letting Next.js surface an unhandled 500.
 */
export async function readJsonBody(req: NextRequest): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/** Map any thrown error to a JSON error response (HttpError keeps its status). */
export function errorResponse(error: unknown): NextResponse {
  if (error instanceof HttpError) {
    return NextResponse.json(
      { error: error.message, ...(error.details || {}) },
      { status: error.status }
    );
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Unknown error" },
    { status: 500 }
  );
}
