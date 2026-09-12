export interface RenderIssue {
  shot_index: number | null;
  message: string;
  fix: string;
}

export function renderIssues(warnings: string[]): RenderIssue[] {
  return [...new Set(warnings)].filter(message =>
    !/^Matches were generated against/.test(message) &&
    !/^Shot \d+: no (day|night) clip available/.test(message) &&
    !/^Text burn was requested, but every shot's text is empty or excluded/.test(message)
  ).map(message => ({
    shot_index: /^Shot (\d+)/.test(message) ? Number(message.match(/^Shot (\d+)/)![1]) - 1 : null,
    message,
    fix: /audio|song|music|silent/i.test(message)
      ? "Choose an available soundtrack or select No audio, then export again."
      : /text|speech|subtitle|libass/i.test(message)
        ? "Check the text and speech alignment, choose a working text engine or exclude the affected text, then export again."
        : /B-roll/i.test(message)
          ? "Replace or remove the affected B-roll and adjust its range to fit the clip, then export again."
          : /fix note|notes/i.test(message)
            ? "Revise the clip instructions to a supported trim, clip selection, loop, freeze, or slow-motion edit, then export again."
            : "Select readable footage that covers the affected shot and set its trim range, then export again.",
  }));
}
