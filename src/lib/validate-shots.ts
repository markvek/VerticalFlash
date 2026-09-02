// Shared shot-timestamp validation, used by the video analysis route (shots
// detected from a real video) and generateShotPlan (shots planned from a
// creative brief). Pure module with no imports so it stays cheap to reuse.

interface TimedShot {
  start_time: number;
  end_time: number;
}

// Timestamps must be sane: ascending, within duration. Small overlaps
// (≤0.2s) between adjacent shots are clamped; anything worse is rejected.
export function validateShots<T extends TimedShot>(
  shots: T[],
  duration: number
): T[] {
  const tolerance = 0.5;
  const sorted = [...shots].sort((a, b) => a.start_time - b.start_time);

  const result = sorted.map((shot, i) => {
    let { start_time, end_time } = shot;
    if (start_time < 0 && start_time > -tolerance) start_time = 0;
    if (end_time > duration && end_time < duration + tolerance) {
      end_time = duration;
    }
    if (
      start_time < 0 ||
      end_time > duration ||
      end_time <= start_time
    ) {
      throw new Error(
        `Shot ${i + 1} has invalid timestamps ${shot.start_time}s → ${shot.end_time}s (video is ${duration.toFixed(1)}s)`
      );
    }
    return { ...shot, start_time, end_time };
  });

  for (let i = 1; i < result.length; i++) {
    const overlap = result[i - 1].end_time - result[i].start_time;
    if (overlap > 0.2) {
      throw new Error(
        `Shots ${i} and ${i + 1} overlap by ${overlap.toFixed(1)}s — timestamps are not usable`
      );
    }
    if (overlap > 0) {
      result[i - 1] = { ...result[i - 1], end_time: result[i].start_time };
    }
  }

  // Guard against unit confusion (e.g. Gemini emitting 0.035 for 0:03.5):
  // the shots must actually cover most of the video
  const covered = result.reduce((sum, s) => sum + (s.end_time - s.start_time), 0);
  if (covered < duration * 0.6) {
    throw new Error(
      `Shots cover only ${covered.toFixed(1)}s of a ${duration.toFixed(1)}s video — timestamps look wrong (wrong unit?)`
    );
  }

  return result;
}
