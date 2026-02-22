import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const { apiKey } = (await request.json()) as { apiKey: string };
    const expected = process.env.SKYNET_DASHBOARD_API_KEY;

    if (!expected) {
      return NextResponse.json(
        { error: "Auth not configured. Set SKYNET_DASHBOARD_API_KEY." },
        { status: 500 }
      );
    }

    if (!apiKey || apiKey !== expected) {
      return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set("skynet-api-key", apiKey, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30, // 30 days
    });
    return response;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
