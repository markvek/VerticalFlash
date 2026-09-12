import { GEMINI_MODEL } from "@/lib/gemini";
import { projectModel } from "@/lib/models/native";
import { NextRequest, NextResponse } from "next/server";
import {
  checkedModelOptions,
  providerConfiguration,
} from "@/lib/models/providers";
export async function GET(request: NextRequest) {
  const models = await checkedModelOptions();
  return NextResponse.json({
    models,
    defaultModel: request.nextUrl.searchParams.get("videoId") ? await projectModel(request.nextUrl.searchParams.get("videoId")!) : GEMINI_MODEL,
    providers: providerConfiguration(),
    preparationAvailable: !!process.env.GEMINI_API_KEY,
  });
}
