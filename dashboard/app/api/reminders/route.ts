import { NextRequest, NextResponse } from "next/server";
import { getReminders } from "@/lib/sheets";

export async function GET(request: NextRequest) {
  const apiSecret = process.env.API_SECRET;
  if (apiSecret) {
    const authHeader = request.headers.get("authorization");
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;
    if (token !== apiSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const reminders = await getReminders();
    return NextResponse.json(
      { reminders },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
        },
      }
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error occurred";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
