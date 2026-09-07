import { after, NextRequest, NextResponse } from "next/server";
import { readMasterJob, retryMasterJob, runMasterJob } from "@/lib/master-jobs";
import { MasterJobStatusZ } from "@/lib/master-job-schema";

export const maxDuration = 600;
type Context = { params: Promise<{ videoId: string }> };

export async function GET(_request: NextRequest, { params }: Context) {
  const { videoId } = await params;
  if (!/^master-[\w-]+$/.test(videoId)) return NextResponse.json({ error: "Invalid master ID" }, { status: 400 });
  const job = await readMasterJob(videoId);
  return job
    ? NextResponse.json(MasterJobStatusZ.parse(job), { headers: { "Cache-Control": "no-store" } })
    : NextResponse.json({ error: "No processing job found" }, { status: 404 });
}

export async function POST(_request: NextRequest, { params }: Context) {
  const { videoId } = await params;
  if (!/^master-[\w-]+$/.test(videoId)) return NextResponse.json({ error: "Invalid master ID" }, { status: 400 });
  const job = await retryMasterJob(videoId);
  if (!job) return NextResponse.json({ error: "This job cannot be retried right now" }, { status: 409 });
  after(() => runMasterJob(videoId));
  return NextResponse.json(MasterJobStatusZ.parse(job), { status: 202 });
}
