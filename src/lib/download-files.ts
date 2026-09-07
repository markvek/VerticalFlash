import { promises as fs } from "fs";
import { join, sep } from "path";
import { PROJECT_MEDIA_DIRS } from "./paths";
import { extractVideoId, isValidVideoId } from "./video-id";

export interface ProjectMediaFile {
  path: string;
  filename: string;
  directory: string;
}

export function isProjectFilename(filename: string): boolean {
  return !filename.startsWith(".") && !/[\/\\\0]/.test(filename) &&
    !filename.includes("..") && /\.(mp4|mov)$/i.test(filename);
}

// Legacy Downloads URLs still resolve after projects get their own folders.
export async function resolveProjectFile(filename: string): Promise<ProjectMediaFile | null> {
  if (!isProjectFilename(filename)) return null;
  for (const directory of PROJECT_MEDIA_DIRS) {
    const path = join(directory, filename);
    try {
      const [root, real, stat] = await Promise.all([
        fs.realpath(directory), fs.realpath(path), fs.stat(path),
      ]);
      if (stat.isFile() && real.startsWith(`${root}${sep}`)) {
        return { path, filename, directory };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return null;
}

export async function listProjectFiles(): Promise<ProjectMediaFile[]> {
  const names = new Set<string>();
  for (const directory of PROJECT_MEDIA_DIRS) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if ((entry.isFile() || entry.isSymbolicLink()) && isProjectFilename(entry.name)) {
        names.add(entry.name);
      }
    }
  }
  const files = await Promise.all([...names].map(resolveProjectFile));
  return files.filter((file): file is ProjectMediaFile => file !== null);
}

export async function findDownloadFile(videoId: string): Promise<ProjectMediaFile | null> {
  if (!isValidVideoId(videoId)) return null;
  return (await listProjectFiles()).find((file) => extractVideoId(file.filename) === videoId) ?? null;
}

export async function requireProjectPath(filename: string): Promise<string> {
  const file = await resolveProjectFile(filename);
  if (!file) throw new Error(`Project media not found: ${filename}`);
  return file.path;
}
