import { promises as fs } from "fs";
import { dirname } from "path";
import {
  AGENT_CAPABILITIES,
  AGENT_OPTIONS,
  AgentCapabilityZ,
  AgentSettingsZ,
  DEFAULT_AGENT_SETTINGS,
  type AgentCapability,
  type AgentSettings,
} from "./agent-settings-schema";
import { AGENT_SETTINGS_PATH } from "./paths";

export {
  AGENT_CAPABILITIES,
  AGENT_CAPABILITY_DEFINITIONS,
  AGENT_OPTIONS,
  DEFAULT_AGENT_SETTINGS,
  type AgentCapability,
  type AgentSettings,
} from "./agent-settings-schema";

export function agentsForCapability(capability: AgentCapability) {
  return AGENT_OPTIONS.filter((agent) => agent.supports.includes(capability));
}

export function isSupportedAgentChoice(
  capability: AgentCapability,
  agentId: string
): boolean {
  return agentsForCapability(capability).some((agent) => agent.id === agentId);
}

export function validateAgentSettings(input: unknown): AgentSettings {
  const parsed = AgentSettingsZ.parse({
    ...DEFAULT_AGENT_SETTINGS,
    ...(input && typeof input === "object" ? input : {}),
  });

  for (const capability of AGENT_CAPABILITIES) {
    if (!isSupportedAgentChoice(capability, parsed[capability])) {
      throw new Error(
        `${capability} does not support agent "${parsed[capability]}"`
      );
    }
  }

  return parsed;
}

export async function readAgentSettings(): Promise<AgentSettings> {
  try {
    const raw = await fs.readFile(AGENT_SETTINGS_PATH, "utf8");
    return validateAgentSettings(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_AGENT_SETTINGS;
    }
    throw error;
  }
}

export async function writeAgentSettings(
  input: unknown
): Promise<AgentSettings> {
  const settings = validateAgentSettings(input);
  await fs.mkdir(dirname(AGENT_SETTINGS_PATH), { recursive: true });
  await fs.writeFile(
    `${AGENT_SETTINGS_PATH}.tmp`,
    JSON.stringify(settings, null, 2)
  );
  await fs.rename(`${AGENT_SETTINGS_PATH}.tmp`, AGENT_SETTINGS_PATH);
  return settings;
}

export async function updateAgentSettings(
  patch: Record<string, unknown>
): Promise<AgentSettings> {
  const current = await readAgentSettings();
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    AgentCapabilityZ.parse(key);
    next[key] = value;
  }
  return writeAgentSettings(next);
}

export async function resetAgentSettings(): Promise<AgentSettings> {
  return writeAgentSettings(DEFAULT_AGENT_SETTINGS);
}
