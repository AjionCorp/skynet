import { NextResponse } from "next/server";
import { safeCompare, deriveSessionToken } from "../../../../lib/auth";

export async function POST(request: Request) {
  try {
    const text = await request.text();
    if (text.length > 10_000) {
      return NextResponse.json({ error: "Request body too large" }, { status: 413 });
    }
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || typeof body.apiKey !== "string") {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    const { apiKey } = body as { apiKey: string };
    const expected = process.env.SKYNET_DASHBOARD_API_KEY;

    if (!expected) {
      return NextResponse.json(
        { error: "Authentication error" },
        { status: 500 }
      );
    }

    if (!apiKey || !safeCompare(apiKey, expected)) {
      return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
    }

    const sessionToken = deriveSessionToken(expected);
    const response = NextResponse.json({ ok: true });
    response.cookies.set("skynet-api-key", sessionToken, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30, // 30 days
    });
    return response;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
