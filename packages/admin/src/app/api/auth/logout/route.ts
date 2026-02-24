import { NextResponse } from "next/server";

export async function POST() {
  const response = NextResponse.json({ data: { ok: true }, error: null });
  response.cookies.set("skynet-api-key", "", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}
