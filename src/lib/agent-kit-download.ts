import { readFile } from "fs/promises";
import { join } from "path";
import { zipSync } from "fflate";
import { AGENT_KIT_DIR } from "./paths";
import { AGENT_INDIVIDUAL_FILES, AGENT_KIT_FILES } from "./agent-kit-catalog";

export async function buildAgentDownload(file: string) {
  if (file === "verticalflash-agent-kit.zip") {
    // Package only maintained, public setup files. Never recursively archive
    // the workspace, runtime configuration, media, or installed dependencies.
    const entries = await Promise.all(AGENT_KIT_FILES.map(async (path) => [
      `verticalflash-agent-kit/${path}`, new Uint8Array(await readFile(join(AGENT_KIT_DIR, path))),
    ] as const));
    return { bytes: zipSync(Object.fromEntries(entries)), contentType: "application/zip" };
  }
  if (!Object.hasOwn(AGENT_INDIVIDUAL_FILES, file)) return null;
  return {
    bytes: new Uint8Array(await readFile(join(AGENT_KIT_DIR, AGENT_INDIVIDUAL_FILES[file]))),
    contentType: file.endsWith(".json") ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
  };
}
