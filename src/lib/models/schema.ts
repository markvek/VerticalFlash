import { z } from "zod";
export const ModelChoiceZ = z.object({
  provider: z.enum(["gemini", "openai", "claude", "grok"]),
  model: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[\w.:-]+$/),
});
export type ModelChoice = z.infer<typeof ModelChoiceZ>;
export type ModelOption = ModelChoice & {
  id: string;
  label: string;
  available: boolean;
  reason: string | null;
};
export const modelId = (choice: ModelChoice) =>
  `${choice.provider}:${choice.model}`;
export interface ModelImage {
  data: string;
  label: string;
}
export interface StructuredRequest {
  prompt: string;
  schema: object;
  images?: ModelImage[];
}
export interface StructuredResult {
  text: string;
  model: string;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
}
export type StructuredGenerator = (
  request: StructuredRequest,
) => Promise<StructuredResult>;

export const BENCHMARK_MODEL_PROVIDERS = [
  { id: "gemini", label: "Gemini" },
  { id: "openai", label: "OpenAI" },
  { id: "claude", label: "Claude" },
  { id: "grok", label: "xAI / Grok" },
] as const;

export function defaultBenchmarkModelIds(
  options: ModelOption[],
  compareProviders = true,
): string[] {
  if (!compareProviders)
    return options
      .filter((option) => option.available)
      .slice(0, 4)
      .map((option) => option.id);
  return BENCHMARK_MODEL_PROVIDERS.flatMap((provider) => {
    const option = options.find(
      (option) => option.provider === provider.id && option.available,
    );
    return option ? [option.id] : [];
  });
}
