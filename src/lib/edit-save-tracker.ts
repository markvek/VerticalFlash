// Track saves owned by nested editors so changing an active edit cannot race
// an onBlur request or silently abandon a failed save.
const pending = new Map<string, Set<Promise<unknown>>>();
const failures = new Map<string, Map<string, unknown>>();
export async function trackEditSave<T>(videoId: string, task: () => Promise<T>, key = "default"): Promise<T> {
  const work = task();
  const tasks = pending.get(videoId) ?? new Set<Promise<unknown>>();
  pending.set(videoId, tasks); tasks.add(work);
  try { const result = await work; failures.get(videoId)?.delete(key); if (!failures.get(videoId)?.size) failures.delete(videoId); return result; }
  catch (error) { const errors = failures.get(videoId) ?? new Map<string, unknown>(); errors.set(key, error); failures.set(videoId, errors); throw error; }
  finally { tasks.delete(work); if (!tasks.size) pending.delete(videoId); }
}
export async function flushEditSaves(videoId: string): Promise<void> {
  while (pending.get(videoId)?.size) await Promise.all([...pending.get(videoId)!]);
  if (failures.has(videoId)) throw failures.get(videoId)!.values().next().value;
}
