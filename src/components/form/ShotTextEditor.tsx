"use client";

import type { ShotOverlay, TextStyle, TextWord } from "@/lib/text-overlays-schema";

interface Props {
  shotNumber: number;
  duration: number;
  entry: ShotOverlay;
  defaults: TextStyle;
  words: TextWord[];
  saving: boolean;
  dirty: boolean;
  aligning: boolean;
  error: string | null;
  onChange: (entry: ShotOverlay) => void;
  onSave: (entry: ShotOverlay) => void;
  onAlign: () => void;
}
const field = "w-full min-w-0 rounded border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary disabled:opacity-50";
export function ShotTextEditor({ shotNumber, duration, entry, defaults, words, saving, dirty, aligning, error, onChange, onSave, onAlign }: Props) {
  const style = { ...defaults, ...entry.style };
  const change = (patch: Partial<ShotOverlay>, save = true) => {
    const next = { ...entry, ...patch }; onChange(next); if (save) onSave(next);
  };
  const setStyle = (patch: Partial<TextStyle>, save = true) => change({ style: { ...entry.style, ...patch } }, save);
  return <fieldset disabled={saving || aligning} className="flex min-w-0 flex-col gap-3" aria-label={`Text controls for shot ${shotNumber}`}>
    <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={entry.include} onChange={e => change({ include: e.target.checked })} />Show text on video</label>
    <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={entry.matchSpeech ?? false}
      disabled={!words.length && !entry.matchSpeech}
      onChange={e => change({ matchSpeech: e.target.checked, ...(e.target.checked ? { words, include: true } : {}) })} />Match spoken words</label>
    {!words.length && <div className="text-xs text-muted-foreground">Align speech to synchronize captions with this shot.
      <button type="button" className="ml-2 underline text-foreground" onClick={onAlign}>{aligning ? "Aligning speech…" : "Transcribe & align speech"}</button>
    </div>}
    {!entry.matchSpeech ? <label className="flex flex-col gap-1 text-xs">Custom on-screen text
      <textarea aria-label={`On-screen text for shot ${shotNumber}`} className={field} rows={3} maxLength={500} value={entry.text}
        onChange={e => change({ text: e.target.value }, false)} onBlur={() => onSave(entry)} placeholder="Type text to show over this shot" />
    </label> : <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">Shown in timed phrases. Correct individual words below without changing their timing.</p>
      <div className="flex max-h-40 flex-wrap gap-1 overflow-auto" aria-label="Correct spoken words">
        {words.map((w, i) => <input key={`${w.start}:${i}`} aria-label={`Spoken word ${i + 1}`} title={`${w.start.toFixed(2)}–${w.end.toFixed(2)}s in source`}
          className={`${field} !w-24`} value={w.text} maxLength={100}
          onChange={e => change({ words: words.map((word, j) => i === j ? { ...word, text: e.target.value } : word) }, false)}
          onBlur={() => onSave(entry)} />)}
      </div>
      <p className="text-[11px] text-muted-foreground">Your custom text is kept when you turn speech matching off.</p>
    </div>}
    <div className="grid grid-cols-2 gap-3">
      <label className="text-xs">Style<select aria-label="Text style" className={field} value={style.preset} onChange={e => setStyle({ preset: e.target.value as TextStyle["preset"] })}>
        <option value="tiktok_box">TikTok box</option><option value="outline">Bold outline</option><option value="caption_bar">Caption bar</option>
      </select></label>
      <label className="text-xs">Position<select aria-label="Text position" className={field} value={style.position} onChange={e => setStyle({ position: e.target.value as TextStyle["position"] })}>
        <option value="top">Upper third</option><option value="center">Center</option><option value="bottom">Lower third</option>
      </select></label>
      <label className="text-xs">Size (px)<input aria-label="Text size" className={field} type="number" min={24} max={120} value={style.fontSize ?? (style.preset === "outline" ? 68 : style.preset === "caption_bar" ? 52 : 64)}
        onChange={e => { if (e.target.value) setStyle({ fontSize: Number(e.target.value) }, false); }} onBlur={() => onSave(entry)} /></label>
      <label className="text-xs">Color<input aria-label="Text color" className={`${field} h-8`} type="color" value={style.color ?? "#ffffff"} onChange={e => setStyle({ color: e.target.value })} /></label>
      <label className="text-xs">Start in shot (s)<input aria-label="Text start" className={field} type="number" step="0.1" min={0} max={duration} value={entry.startOffset ?? 0}
        onChange={e => change({ startOffset: Number(e.target.value) }, false)} onBlur={() => onSave(entry)} /></label>
      <label className="text-xs">End in shot (s)<input aria-label="Text end" className={field} type="number" step="0.1" min={0} max={duration} value={entry.endOffset ?? duration}
        onChange={e => change({ endOffset: Number(e.target.value) }, false)} onBlur={() => onSave(entry)} /></label>
    </div>
    {error ? <p role="alert" className="text-xs text-red-400">{error} <button type="button" className="underline" onClick={() => onSave(entry)}>Retry save</button></p>
      : <p role="status" className="text-xs text-muted-foreground">{aligning ? "Aligning speech…" : saving ? "Saving text…" : dirty ? "Unsaved text changes" : "Saved"}</p>}
  </fieldset>;
}
