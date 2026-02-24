import { describe, it, expect } from "vitest";
import { parseBody } from "./parse-body";

function makeRequest(body: string | null, headers?: Record<string, string>): Request {
  const init: RequestInit = { method: "POST", headers: headers ?? {} };
  if (body !== null) {
    init.body = body;
    if (!headers?.["content-type"]) {
      (init.headers as Record<string, string>)["content-type"] = "application/json";
    }
  }
  return new Request("http://localhost/test", init);
}

describe("parseBody", () => {
  it("parses valid JSON object", async () => {
    const req = makeRequest(JSON.stringify({ name: "test" }));
    const result = await parseBody<{ name: string }>(req);
    expect(result.data).toEqual({ name: "test" });
    expect(result.error).toBeNull();
  });

  it("rejects non-object JSON (array)", async () => {
    const req = makeRequest("[1,2,3]");
    const result = await parseBody(req);
    expect(result.error).toBe("Request body must be a JSON object");
    expect(result.status).toBe(400);
  });

  it("rejects non-object JSON (string)", async () => {
    const req = makeRequest('"hello"');
    const result = await parseBody(req);
    expect(result.error).toBe("Request body must be a JSON object");
    expect(result.status).toBe(400);
  });

  it("rejects non-object JSON (null literal)", async () => {
    const req = makeRequest("null");
    const result = await parseBody(req);
    expect(result.error).toBe("Request body must be a JSON object");
    expect(result.status).toBe(400);
  });

  it("rejects invalid JSON", async () => {
    const req = makeRequest("{not json}");
    const result = await parseBody(req);
    expect(result.error).toBe("Invalid JSON body");
    expect(result.status).toBe(400);
  });

  it("rejects empty body", async () => {
    const req = new Request("http://localhost/test", { method: "POST" });
    const result = await parseBody(req);
    expect(result.error).toBeTruthy();
  });

  it("rejects body exceeding Content-Length limit", async () => {
    const req = makeRequest("{}", { "content-length": "2000000", "content-type": "application/json" });
    const result = await parseBody(req);
    expect(result.error).toBe("Request body too large");
    expect(result.status).toBe(413);
  });

  it("parses nested objects", async () => {
    const body = { config: { key: "value" }, items: [1, 2] };
    const req = makeRequest(JSON.stringify(body));
    const result = await parseBody(req);
    expect(result.data).toEqual(body);
    expect(result.error).toBeNull();
  });

  it("handles empty object", async () => {
    const req = makeRequest("{}");
    const result = await parseBody(req);
    expect(result.data).toEqual({});
    expect(result.error).toBeNull();
  });

  it("rejects non-JSON Content-Type with 415", async () => {
    const req = makeRequest('{"name":"test"}', { "content-type": "text/plain" });
    const result = await parseBody(req);
    expect(result.error).toBe("Content-Type must be application/json");
    expect(result.status).toBe(415);
    expect(result.data).toBeNull();
  });

  it("rejects XML Content-Type with 415", async () => {
    const req = makeRequest("<xml/>", { "content-type": "application/xml" });
    const result = await parseBody(req);
    expect(result.error).toBe("Content-Type must be application/json");
    expect(result.status).toBe(415);
  });

  it("accepts application/json Content-Type", async () => {
    const req = makeRequest('{"ok":true}', { "content-type": "application/json" });
    const result = await parseBody(req);
    expect(result.data).toEqual({ ok: true });
    expect(result.error).toBeNull();
  });

  it("accepts application/json with charset parameter", async () => {
    const req = makeRequest('{"ok":true}', { "content-type": "application/json; charset=utf-8" });
    const result = await parseBody(req);
    expect(result.data).toEqual({ ok: true });
    expect(result.error).toBeNull();
  });

  it("rejects requests where runtime auto-sets text/plain Content-Type", async () => {
    // When no explicit content-type is set but body is provided, the runtime
    // defaults to "text/plain;charset=UTF-8", which should be rejected.
    const req = new Request("http://localhost/test", {
      method: "POST",
      body: '{"ok":true}',
    });
    const result = await parseBody(req);
    expect(result.error).toBe("Content-Type must be application/json");
    expect(result.status).toBe(415);
  });
});
