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
export async function parseBody<T>(
  request: Request
): Promise<{ data: T | null; error: string | null; status?: number }> {
  try {
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

    const chunks: Uint8Array[] = [];
    let totalSize = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.byteLength;
      if (totalSize > MAX_BODY_SIZE) {
        reader.cancel();
        return { data: null, error: "Request body too large", status: 413 };
      }
      chunks.push(value);
    }

    const text = new TextDecoder().decode(
      chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)
    );

    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { data: null, error: "Request body must be a JSON object", status: 400 };
    }
    return { data: parsed as T, error: null };
  } catch {
    return { data: null, error: "Invalid JSON body", status: 400 };
  }
}
