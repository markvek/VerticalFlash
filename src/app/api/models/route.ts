import { NextResponse } from "next/server";
import {
  checkedModelOptions,
  providerConfiguration,
} from "@/lib/models/providers";
export async function GET() {
  const models = await checkedModelOptions();
  return NextResponse.json({
    models,
    providers: providerConfiguration(),
    preparationAvailable: !!process.env.GEMINI_API_KEY,
  });
}
