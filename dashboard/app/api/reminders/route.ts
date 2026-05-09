import { NextResponse } from "next/server";
import { getReminders } from "@/lib/sheets";

export const dynamic = "force-dynamic";

export async function GET() {
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
