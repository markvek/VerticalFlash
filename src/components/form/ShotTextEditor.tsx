"use client";

import { useState } from "react";

export interface ShotTextEntry {
  text: string;
  include: boolean;
}

export interface ShotTextEditorProps {
  /** 1-based shot number, for the label */
  shotNumber: number;
  /** on_screen_text detected by the Gemini analysis for this shot */
  detectedText: string;
  /** Stored override for this shot (null = fall back to detectedText) */
  entry: ShotTextEntry | null;
  saving: boolean;
  onSave: (text: string, include: boolean) => void;
  /** Delete the stored override, returning to the detected text */
  onReset: () => void;
}

// Editable on-screen text for one shot: what the render's text burn stage
// puts over the chosen library clip. Burns as PNG overlays (rounded TikTok
// pill, color emoji); ASS subtitles are the fallback engine.
export function ShotTextEditor({
  shotNumber,
  detectedText,
  entry,
  saving,
  onSave,
  onReset,
}: ShotTextEditorProps) {
  const detected = detectedText.trim();
  const resolved = entry ?? { text: detected, include: detected.length > 0 };
  const [draft, setDraft] = useState(resolved.text);
  const edited = entry != null && entry.text.trim() !== detected;

  const commit = (include: boolean) => {
    const text = draft.trim();
    // Nothing to store when it still matches what would be resolved anyway
    if (entry == null && text === detected && include === resolved.include)
      return;
    if (entry != null && text === entry.text && include === entry.include)
      return;
    onSave(text, include);
  };

  const willBurn = resolved.include && draft.trim().length > 0;

  return (
    <div className="rounded-md border border-border p-2 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[10px] font-bold text-foreground uppercase tracking-wide">
          On-screen text for shot #{shotNumber}
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase ${
              willBurn
                ? "bg-primary/15 text-primary"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {willBurn ? "will burn" : "not burned"}
          </span>
          <label className="flex items-center gap-1 text-[10px] text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={resolved.include}
              disabled={saving}
              onChange={(e) => commit(e.target.checked)}
              className="accent-current"
            />
            include in render
          </label>
        </div>
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit(resolved.include)}
        disabled={saving}
        rows={2}
        maxLength={500}
        aria-label={`On-screen text for shot ${shotNumber}`}
        placeholder="No text detected for this shot — type to add some"
        className="w-full text-xs rounded-md border border-border bg-transparent p-1.5 outline-none focus:border-primary resize-y disabled:opacity-60"
      />
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[9px] text-muted-foreground">
          Burned as PNG overlays · TikTok pill styling · emoji supported ✨
        </p>
        {edited && (
          <button
            onClick={() => {
              setDraft(detected);
              onReset();
            }}
            disabled={saving}
            className="text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-60"
          >
            ↺ reset to detected text
          </button>
        )}
      </div>
    </div>
  );
}
