import { NextRequest, NextResponse } from "next/server";
import { beginActivity, finishActivity } from "./workflow-activity";
type Context = { params: Promise<{ videoId: string }> };

// Persist status while the existing handler runs. Retries remain explicit so
// returning to a page never repeats a paid operation or an upload.
export function trackedRoute(stage: string, handler: (request: NextRequest, context: Context) => Promise<NextResponse>) {
  return async (request: NextRequest, context: Context) => {
    const { videoId } = await context.params;
    if (!/^[\w-]+$/.test(videoId)) return handler(request, context);
    const record = await beginActivity(videoId, stage);
    if (!record) return NextResponse.json({ error: `${stage} is already running. Its status is saved in project activity.` }, { status: 409 });
    try {
      const response = await handler(request, context);
      const body = await response.clone().json().catch(() => ({}));
      await finishActivity(record, response.ok ? null : String(body.error || `HTTP ${response.status}`), Array.isArray(body.issues) ? body.issues.length : 0);
      return response;
    } catch (error) {
      await finishActivity(record, error instanceof Error ? error.message : "Action failed");
      throw error;
    }
  };
}
