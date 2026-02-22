import { NextResponse } from "next/server";
import { safeCompare } from "../../../../lib/auth";

export async function POST(request: Request) {
  try {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > 1_000_000) {
      return NextResponse.json({ error: "Request body too large" }, { status: 413 });
    }
    const { apiKey } = (await request.json()) as { apiKey: string };
    const expected = process.env.SKYNET_DASHBOARD_API_KEY;

    if (!expected) {
      return NextResponse.json(
        { error: "Auth not configured. Set SKYNET_DASHBOARD_API_KEY." },
        { status: 500 }
      );
    }

    if (!apiKey || !safeCompare(apiKey, expected)) {
      return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set("skynet-api-key", apiKey, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30, // 30 days
    });
    return response;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
