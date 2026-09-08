export const AGENT_KIT_VERSION = "0.1.0";

export const AGENT_GUIDES = [
  { file: "SKILL.md", title: "Video workflow skill", description: "The entry point for your agent: how to use VerticalFlash and move between creative stages.", path: "verticalflash-video/SKILL.md" },
  { file: "creative-brief.md", title: "Creative direction", description: "Work out the audience, angle, tone, source footage, and how involved you want to be.", path: "verticalflash-video/references/creative-brief.md" },
  { file: "storyboarding.md", title: "Storyboarding", description: "Compare hooks, revise beats, and turn the chosen storyboard into an editing project.", path: "verticalflash-video/references/storyboarding.md" },
  { file: "editing-broll.md", title: "Editing & B-roll", description: "Trim footage, choose coverage, preserve speech, and review the rendered video.", path: "verticalflash-video/references/editing-broll.md" },
] as const;

export const AGENT_KIT_FILES = [
  "README.md",
  "mcp/package.json",
  "mcp/package-lock.json",
  "mcp/mcp-config.json",
  "mcp/server.mjs",
  "mcp/test/server.test.mjs",
  ...AGENT_GUIDES.map((guide) => guide.path),
] as const;

export const AGENT_INDIVIDUAL_FILES: Readonly<Record<string, string>> = {
  "setup.md": "README.md",
  "mcp-config.json": "mcp/mcp-config.json",
  ...Object.fromEntries(AGENT_GUIDES.map((guide) => [guide.file, guide.path])),
};

export function agentDownloadHref(file: string): string {
  return `/api/settings/agent-kit/${encodeURIComponent(file)}`;
}
