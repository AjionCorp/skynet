const MAX_BODY_SIZE = 1_000_000; // 1 MB

/**
 * Parse request body as JSON with size limit and error handling.
 * NOTE: The generic T is a TypeScript-only hint — no runtime validation is performed.
 * Callers MUST validate required fields after parsing. The T parameter exists
 * for IDE autocompletion, not runtime safety.
 *
 * This is intentional: adding a schema validator (Zod, etc.) would increase bundle
 * size for minimal benefit since all callers already validate their specific fields.
 *
 * Example: Callers must validate required fields:
 *   const { data } = await parseBody<{ name: string }>(req);
 *   if (!data || typeof data.name !== "string") return error;
 *
 * Checks Content-Length header first as an early-reject optimization,
 * then stream-reads with a hard size limit to prevent memory exhaustion.
 * Returns { data, error } — caller should check error before using data.
 */
/**
 * TS-P1-2: Measure the nesting depth of a JSON object/array to prevent
 * stack overflow from deeply nested payloads. Uses an iterative approach
 * with an explicit stack to avoid stack overflow in the depth checker itself.
 */
function jsonDepth(obj: unknown): number {
  if (typeof obj !== "object" || obj === null) return 0;
  let maxDepth = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value: obj, depth: 1 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (depth > maxDepth) maxDepth = depth;
    // Early exit: if we already exceeded the limit, no need to continue
    if (maxDepth > 20) return maxDepth;
    if (typeof value === "object" && value !== null) {
      for (const v of Object.values(value as Record<string, unknown>)) {
        if (typeof v === "object" && v !== null) {
          stack.push({ value: v, depth: depth + 1 });
        }
      }
    }
  }
  return maxDepth;
}

export async function parseBody<T>(
  request: Request
): Promise<{ data: T | null; error: string | null; status?: number }> {
  try {
    // Reject non-JSON content types early (before reading body)
    const contentType = request.headers.get("content-type") || "";
    if (!contentType || !contentType.includes("application/json")) {
      return { data: null, error: "Content-Type must be application/json", status: 415 };
    }

    // Early reject if Content-Length header exceeds limit (not a security check,
    // just an optimization — actual body size is enforced below)
    const cl = request.headers.get("content-length");
    if (cl && Number(cl) > MAX_BODY_SIZE) {
      return { data: null, error: "Request body too large", status: 413 };
    }

    // Stream-read with size limit to prevent memory exhaustion
    const reader = request.body?.getReader();
    if (!reader) {
      return { data: null, error: "No request body", status: 400 };
    }

    const chunks: Buffer[] = [];
    let totalSize = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.byteLength;
      if (totalSize > MAX_BODY_SIZE) {
        reader.cancel();
        return { data: null, error: "Request body too large", status: 413 };
      }
      chunks.push(Buffer.from(value));
    }

    const text = new TextDecoder().decode(
      chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)
    );

    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { data: null, error: "Request body must be a JSON object", status: 400 };
    }
    // TS-P1-2: Reject deeply nested JSON to prevent stack overflow from recursive processing.
    // Limit to 20 levels which is well beyond any legitimate API request structure.
    if (jsonDepth(parsed) > 20) {
      return { data: null, error: "JSON body too deeply nested", status: 400 };
    }
    return { data: parsed as T, error: null };
  } catch {
    return { data: null, error: "Invalid JSON body", status: 400 };
  }
}
