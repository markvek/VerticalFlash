export function matchesCohort(video: { createTime: number; duration: number }, age: string, length: string, observedAt: number): boolean {
  const days = Math.max(0, (observedAt / 1000 - video.createTime) / 86400);
  const ageMatches = age === "all" || (age === "week" ? days <= 7 : age === "month" ? days > 7 && days <= 30 : days > 30);
  const lengthMatches = length === "all" || (length === "short" ? video.duration <= 15 : length === "medium" ? video.duration > 15 && video.duration <= 30 : video.duration > 30);
  return ageMatches && lengthMatches;
}
