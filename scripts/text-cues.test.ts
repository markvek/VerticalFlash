import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TEXT_STYLE, ShotOverlayZ, TextOverlaysZ } from "../src/lib/text-overlays-schema";
import { resolveTextCues } from "../src/lib/text-cues";
import { buildAssSubtitles } from "../src/lib/ass-subtitles";
import { rasterizeTextBlock } from "../src/lib/png-overlays";
const shot = { index: 0, start_time: 4, end_time: 8, source_start: 10, on_screen_text: "Title" };
const words = ["These", "are", "the", "exact", "spoken", "words."].map((text, i) => ({ text, start: 10 + i * .5, end: 10.4 + i * .5 }));
test("old overlays retain text and inclusion without opting into speech mode", () => {
  const old = TextOverlaysZ.parse({ videoId: "123", updatedAt: "", style: DEFAULT_TEXT_STYLE, shots: { "0": { text: "Title", include: true } } });
  assert.deepEqual(resolveTextCues(shot, old.shots["0"]), [{ start: 4, end: 8, text: "Title", style: DEFAULT_TEXT_STYLE }]);
});
test("speech cues preserve wording, map source timing, and retain the custom draft", () => {
  const entry = { text: "Custom title", include: true, matchSpeech: true, words };
  const cues = resolveTextCues(shot, entry);
  assert.equal(cues.map(c => c.text).join(" "), words.map(w => w.text).join(" "));
  assert.equal(cues[0].start, 4);
  assert.equal(cues.length, 2);
  assert.equal(resolveTextCues(shot, { ...entry, matchSpeech: false })[0].text, "Custom title");
  assert.deepEqual(resolveTextCues(shot, { ...entry, include: false }), []);
});
test("trim, custom timing, corrections, silence and missing alignment", () => {
  const entry = { text: "Title", include: true, matchSpeech: true, words };
  const trimmed = { ...shot, source_start: 11, end_time: 6 };
  assert.equal(resolveTextCues(trimmed, entry)[0].text, "the exact spoken words.");
  const limited = resolveTextCues(shot, { ...entry, startOffset: 1, endOffset: 2 });
  assert(limited.every(c => c.start >= 5 && c.end <= 6));
  assert.equal(resolveTextCues(shot, { ...entry, words: words.map((w,i) => i === 0 ? { ...w, text: "Those" } : w) })[0].text, "Those are the exact spoken");
  assert.deepEqual(resolveTextCues(shot, { ...entry, words: [] }), []);
  assert.deepEqual(resolveTextCues(shot, { ...entry, startOffset: 3, endOffset: 1 }), []);
  const pauses = resolveTextCues(shot, { ...entry, words: [words[0], words[5]] });
  assert.equal(pauses.length, 2);
  assert(pauses[0].end < pauses[1].start);
});
test("both raster and ASS export honor per-cue color, size and position", async () => {
  const style = { ...DEFAULT_TEXT_STYLE, color: "#ff0000", fontSize: 96, position: "bottom" as const };
  const cues = resolveTextCues(shot, { text: "Style test", include: true, style });
  const ass = buildAssSubtitles(cues, DEFAULT_TEXT_STYLE);
  assert.match(ass, /Style: Cue0,Arial Black,96,&H000000ff/i);
  assert.match(ass, /,2,90,90,460,1/);
  const png = await rasterizeTextBlock("Style test", style);
  assert.equal(png.subarray(1,4).toString(), "PNG");
  assert.notDeepEqual(png, await rasterizeTextBlock("Style test", DEFAULT_TEXT_STYLE));
  assert.equal(ShotOverlayZ.safeParse({ text: "", include: true, words: [{ text: "broken", start: 2, end: 1 }] }).success, false);
});
