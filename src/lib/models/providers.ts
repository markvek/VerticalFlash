import { getGeminiClient, GEMINI_MODEL } from "../gemini";
import {
  ModelChoiceZ,
  modelId,
  type ModelChoice,
  type ModelOption,
  type StructuredGenerator,
} from "./schema";

const providers = [
  {
    provider: "gemini",
    key: "GEMINI_API_KEY",
    models: "BENCHMARK_GEMINI_MODELS",
    fallback: GEMINI_MODEL,
  },
  {
    provider: "openai",
    key: "OPENAI_API_KEY",
    models: "BENCHMARK_OPENAI_MODELS",
    fallback: "gpt-5",
  },
  {
    provider: "claude",
    key: "ANTHROPIC_API_KEY",
    models: "BENCHMARK_CLAUDE_MODELS",
    fallback: "",
  },
  {
    provider: "grok",
    key: "XAI_API_KEY",
    models: "BENCHMARK_GROK_MODELS",
    fallback: "",
  },
] as const;

export function modelOptions(): ModelOption[] {
  return providers.flatMap((p) =>
    (process.env[p.models] || p.fallback)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((model) => {
        const choice = ModelChoiceZ.parse({ provider: p.provider, model });
        const available = !!process.env[p.key]?.trim();
        return {
          ...choice,
          id: modelId(choice),
          label: `${p.provider} · ${model}`,
          available,
          reason: available ? null : `Configure ${p.key}`,
        };
      }),
  );
}
export function providerConfiguration() {
  return providers.map((p) => ({
    provider: p.provider,
    keyConfigured: !!process.env[p.key]?.trim(),
    modelsConfigured: !!(process.env[p.models] || p.fallback),
    modelsVariable: p.models,
    keyVariable: p.key,
  }));
}
export function assertModelAvailable(choice: ModelChoice) {
  const option = modelOptions().find((o) => o.id === modelId(choice));
  if (!option?.available)
    throw new Error(
      option?.reason ||
        `Configure an allowed model for ${choice.provider}: ${choice.model}`,
    );
}

// All providers receive the same prompt/schema and timestamped JPEG evidence.
// JSON is validated by the caller; malformed output gets one shared repair attempt.
export function modelGenerator(choice: ModelChoice): StructuredGenerator {
  assertModelAvailable(choice);
  return async ({ prompt, schema, images = [] }) => {
    const instruction = `${prompt}\nReturn ONLY a JSON object matching this schema:\n${JSON.stringify(schema)}`;
    if (choice.provider === "gemini") {
      const response = await getGeminiClient().models.generateContent({
        model: choice.model,
        contents: [
          {
            role: "user",
            parts: [
              { text: instruction },
              ...images.flatMap((i) => [
                { text: i.label },
                { inlineData: { mimeType: "image/jpeg", data: i.data } },
              ]),
            ],
          },
        ],
        config: { responseMimeType: "application/json" },
      });
      return {
        text: response.text ?? "",
        model: response.modelVersion || choice.model,
        ...response.usageMetadata,
      };
    }
    const p = providers.find((p) => p.provider === choice.provider)!;
    let url: string;
    let body: object;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (choice.provider === "claude") {
      url = "https://api.anthropic.com/v1/messages";
      headers["x-api-key"] = process.env[p.key]!;
      headers["anthropic-version"] = "2023-06-01";
      body = {
        model: choice.model,
        max_tokens: 12000,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: instruction },
              ...images.flatMap((i) => [
                { type: "text", text: i.label },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/jpeg",
                    data: i.data,
                  },
                },
              ]),
            ],
          },
        ],
      };
    } else if (choice.provider === "openai") {
      url = "https://api.openai.com/v1/responses";
      headers.Authorization = `Bearer ${process.env[p.key]}`;
      body = {
        model: choice.model,
        store: false,
        max_output_tokens: 16000,
        text: { format: { type: "json_object" } },
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: instruction },
              ...images.flatMap((i) => [
                { type: "input_text", text: i.label },
                {
                  type: "input_image",
                  image_url: `data:image/jpeg;base64,${i.data}`,
                  detail: "auto",
                },
              ]),
            ],
          },
        ],
      };
    } else {
      url = "https://api.x.ai/v1/chat/completions";
      headers.Authorization = `Bearer ${process.env[p.key]}`;
      body = {
        model: choice.model,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: instruction },
              ...images.flatMap((i) => [
                { type: "text", text: i.label },
                {
                  type: "image_url",
                  image_url: { url: `data:image/jpeg;base64,${i.data}` },
                },
              ]),
            ],
          },
        ],
      };
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(240000),
    });
    if (!response.ok)
      throw new Error(
        `${choice.provider} ${choice.model}: HTTP ${response.status}. Check model access, credentials, and quota.`,
      );
    const data = await response.json();
    let text: string;
    if (choice.provider === "claude")
      text = (data.content ?? [])
        .filter((c: { type: string }) => c.type === "text")
        .map((c: { text: string }) => c.text)
        .join("");
    else if (choice.provider === "openai") {
      if (data.status === "incomplete" || data.error)
        throw new Error("OpenAI did not complete the response");
      text = (data.output ?? [])
        .flatMap(
          (o: { content?: Array<{ type: string; text?: string }> }) =>
            o.content ?? [],
        )
        .filter((c: { type: string }) => c.type === "output_text")
        .map((c: { text: string }) => c.text)
        .join("");
    } else text = data.choices?.[0]?.message?.content ?? "";
    if (!text)
      throw new Error(
        `${choice.provider} returned no text (possibly a refusal)`,
      );
    return {
      text,
      model: data.model || choice.model,
      promptTokenCount: data.usage?.input_tokens ?? data.usage?.prompt_tokens,
      candidatesTokenCount:
        data.usage?.output_tokens ?? data.usage?.completion_tokens,
    };
  };
}

const availabilityState = globalThis as typeof globalThis & {
  modelAvailability?: {
    expires: number;
    signature: string;
    result: Promise<ModelOption[]>;
  };
};

async function providerAccessFailure(
  response: Response,
  keyVariable: string,
): Promise<string> {
  // Providers may echo credentials in their errors. Classify the response but
  // return only our own text; never expose their raw message, code, or body.
  const body: unknown = await response.json().catch(() => null);
  const error =
    body && typeof body === "object" && "error" in body ? body.error : null;
  const code =
    error && typeof error === "object" && "code" in error ? error.code : null;
  const message =
    typeof error === "string"
      ? error
      : error && typeof error === "object" && "message" in error &&
          typeof error.message === "string"
        ? error.message
        : "";
  const status = `HTTP ${response.status}`;
  if (
    code === "invalid_api_key" ||
    /(?:incorrect|invalid)[\s\S]{0,30}(?:api[ _-]?key|x-api-key)|(?:api[ _-]?key|x-api-key)[\s\S]{0,30}(?:incorrect|invalid)/i.test(message)
  )
    return `Provider rejected ${keyVariable} (${status}). Replace it with a valid API key in .env.local and restart the app.`;
  if (response.status === 401)
    return `Provider authentication failed (${status}). Check ${keyVariable} in .env.local and restart the app after updating it.`;
  if (response.status === 403)
    return `Provider denied access to its model list (${status}). Check this API key's permissions and account access.`;
  if (response.status === 429)
    return `Provider model-list check was limited (${status}). Check provider quota and rate limits, then retry.`;
  return `Provider access check failed (${status}). Check provider configuration and service availability.`;
}

export async function checkedModelOptions(): Promise<ModelOption[]> {
  // Only a digest is kept as the cache key; credential values never reach the UI.
  const { createHash } = await import("crypto");
  const signature = createHash("sha256")
    .update(
      JSON.stringify(
        providers.map((p) => [process.env[p.key], process.env[p.models]]),
      ),
    )
    .digest("hex");
  const cached = availabilityState.modelAvailability;
  if (cached && cached.expires > Date.now() && cached.signature === signature)
    return cached.result;
  const result = Promise.all(
    providers.map(async (p) => {
      const options = modelOptions().filter((o) => o.provider === p.provider);
      if (!options.length || !process.env[p.key]) return options;
      const headers: Record<string, string> =
        p.provider === "gemini"
          ? { "x-goog-api-key": process.env[p.key]! }
          : p.provider === "claude"
            ? {
                "x-api-key": process.env[p.key]!,
                "anthropic-version": "2023-06-01",
              }
            : { Authorization: `Bearer ${process.env[p.key]}` };
      const url =
        p.provider === "gemini"
          ? "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000"
          : p.provider === "claude"
            ? "https://api.anthropic.com/v1/models?limit=1000"
            : p.provider === "openai"
              ? "https://api.openai.com/v1/models"
              : "https://api.x.ai/v1/models";
      try {
        const response = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok)
          throw new Error(await providerAccessFailure(response, p.key));
        const data = await response.json();
        const ids = new Set<string>(
          (data.data ?? data.models ?? []).map(
            (m: { id?: string; name?: string }) =>
              (m.id ?? m.name ?? "").replace(/^models\//, ""),
          ),
        );
        return await Promise.all(options.map(async (o): Promise<ModelOption> => {
          if (ids.has(o.model)) return { ...o, available: true, reason: null };
          // Claude lists canonical IDs, but accepts aliases for generation.
          // Resolve missing names through its API instead of guessing a suffix.
          if (p.provider === "claude") {
            try {
              const resolved = await fetch(
                `https://api.anthropic.com/v1/models/${encodeURIComponent(o.model)}`,
                { headers, signal: AbortSignal.timeout(15000) },
              );
              if (!resolved.ok)
                return {
                  ...o,
                  available: false,
                  reason: resolved.status === 404
                    ? "Claude could not find this model or alias for your account. Check BENCHMARK_CLAUDE_MODELS."
                    : await providerAccessFailure(resolved, p.key),
                };
              const model = await resolved.json();
              if (typeof model?.id !== "string" || !model.id)
                throw new Error("Invalid model response");
              return { ...o, available: true, reason: null };
            } catch {
              return {
                ...o,
                available: false,
                reason: "Claude model lookup failed. Retry the access check.",
              };
            }
          }
          return {
            ...o,
            available: false,
            reason: "Model was not returned by this provider’s model list",
          };
        }));
      } catch (e) {
        return options.map((o) => ({
          ...o,
          available: false,
          reason:
            e instanceof Error ? e.message : "Provider access check failed",
        }));
      }
    }),
  ).then((groups) => groups.flat());
  availabilityState.modelAvailability = {
    signature,
    expires: Date.now() + 60000,
    result,
  };
  return result;
}
