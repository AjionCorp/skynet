const MAX_BODY_SIZE = 1_000_000; // 1 MB

/**
 * Parse a JSON request body with size validation.
 * Reads the actual body text (not Content-Length header) to prevent spoofing.
 * Returns { data, error } — caller should check error before using data.
 */
export async function parseBody<T>(
  request: Request
): Promise<{ data: T | null; error: string | null; status?: number }> {
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_SIZE) {
      return { data: null, error: "Request body too large", status: 413 };
    }
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { data: null, error: "Request body must be a JSON object", status: 400 };
    }
    return { data: parsed as T, error: null };
  } catch {
    return { data: null, error: "Invalid JSON body", status: 400 };
  }
}
