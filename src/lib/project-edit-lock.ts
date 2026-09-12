// Shared across route bundles in this single-user server process.
const state = globalThis as typeof globalThis & { projectEditLocks?: Map<string, Promise<unknown>> };
export const projectEditLocks = state.projectEditLocks ??= new Map();
export async function withProjectEdit<T>(videoId: string, work: () => Promise<T>): Promise<T> {
  const task = (projectEditLocks.get(videoId) ?? Promise.resolve()).catch(() => {}).then(work);
  projectEditLocks.set(videoId, task);
  try { return await task; } finally { if (projectEditLocks.get(videoId) === task) projectEditLocks.delete(videoId); }
}
