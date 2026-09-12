import { NextRequest, NextResponse } from "next/server";
import { activitySummary, readActivity } from "@/lib/workflow-activity";
export async function GET(request: NextRequest) {
  try {
    const records = await readActivity(request.nextUrl.searchParams.get("videoId") || undefined);
    return NextResponse.json({ records: records.slice(0, 100), summary: activitySummary(records) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Activity could not be loaded" }, { status: 500 });
  }
}
