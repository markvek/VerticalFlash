import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  AGENT_CAPABILITY_DEFINITIONS,
  AGENT_OPTIONS,
  DEFAULT_AGENT_SETTINGS,
  readAgentSettings,
  resetAgentSettings,
  updateAgentSettings,
} from "@/lib/agent-settings";

export const runtime = "nodejs";

const PatchBodyZ = z.object({
  settings: z.record(z.unknown()).optional(),
  reset: z.boolean().optional(),
});

function payload(settings: Awaited<ReturnType<typeof readAgentSettings>>) {
  return {
    settings,
    defaults: DEFAULT_AGENT_SETTINGS,
    capabilities: AGENT_CAPABILITY_DEFINITIONS,
    agents: AGENT_OPTIONS,
  };
}

export async function GET() {
  try {
    return NextResponse.json(payload(await readAgentSettings()));
  } catch (error) {
    console.error("Agent settings load failed:", error);
    return NextResponse.json(
      { error: "Could not load agent settings" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  let body: z.infer<typeof PatchBodyZ>;
  try {
    body = PatchBodyZ.parse(await request.json());
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof z.ZodError
            ? error.issues
                .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
                .join("; ")
            : "Invalid request",
      },
      { status: 400 }
    );
  }

  try {
    const settings = body.reset
      ? await resetAgentSettings()
      : await updateAgentSettings(body.settings ?? {});
    return NextResponse.json(payload(settings));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not save agent settings" },
      { status: 400 }
    );
  }
}
