"use client";

import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import type { Beat, Segment } from "@/lib/segments-schema";
import { FootageThumbnail } from "@/components/ui/FootageThumbnail";

export function StoryboardBeatCard({ beat, segment, index, disabled, onSeek, onNote, onTrim, onRemove, onMove, canRemove, canMoveUp, canMoveDown }: {
  beat: Beat; segment?: Segment; index: number; disabled: boolean;
  onSeek: () => void; onNote: (note: string) => void;
  onTrim?: () => void; onRemove?: () => void; onMove?: (direction: -1 | 1) => void; canRemove?: boolean; canMoveUp?: boolean; canMoveDown?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(beat.fix_note ?? "");
  useEffect(() => setNote(beat.fix_note ?? ""), [beat.fix_note]);
  const offset = beat.source?.offset ?? 0;
  const time = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
  const role = segment?.role ?? beat.section;
  const roleColor = role === "hook" ? "bg-amber-500/15 text-amber-300" : role === "cta" || role === "end" ? "bg-pink-500/15 text-pink-300" : "bg-blue-500/15 text-blue-300";
  const saveNote = () => { if (note !== (beat.fix_note ?? "")) onNote(note); setEditing(false); };
  return <article className="flex h-full min-h-[348px] flex-col gap-2 rounded-lg border border-border p-3">
    <button onClick={onSeek} className="mx-auto" aria-label={`Preview storyboard segment ${index + 1}`}>
      <FootageThumbnail src={beat.thumbnail ?? segment?.thumbnail} alt={`Segment ${index + 1}`} />
    </button>
    <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
      <span className="font-mono text-muted-foreground">{time(Math.max(0, beat.start - offset))}-{time(Math.max(0, beat.end - offset))} · {(beat.end - beat.start).toFixed(1)}s</span>
      <span className={`rounded px-1.5 py-0.5 font-semibold uppercase ${roleColor}`}>{role}</span>
      {!!segment && segment.hook_score >= 6 && <span className="text-amber-300">AI hook {segment.hook_score}/10</span>}
    </div>
    <p className="text-[11px] text-muted-foreground">{segment?.topic || (beat.section === "hook" ? "Opening" : beat.section === "end" ? "Ending" : "Main story")}</p>
    {beat.source && <p className="truncate text-[10px] text-muted-foreground" title={beat.source.filename}>{beat.source.filename}</p>}
    {editing ? <textarea autoFocus aria-label={`Fix note for segment ${index + 1}`} rows={3} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} onBlur={saveNote} onKeyDown={(event) => { if (event.key === "Escape") { setNote(beat.fix_note ?? ""); setEditing(false); } }} className="w-full rounded border border-border bg-background p-2 text-xs" /> : <button disabled={disabled} onClick={() => setEditing(true)} className="flex items-start gap-1 self-start rounded border border-border px-1.5 py-1 text-left text-[10px] text-muted-foreground"><Pencil className="mt-0.5 size-2.5 shrink-0" /><span className="break-words">{beat.fix_note || "Add fix note"}</span></button>}
    <button onClick={onSeek} className="text-left text-xs leading-relaxed text-foreground/90">{beat.text || "No spoken audio"}</button>
    <div className="mt-auto flex flex-wrap gap-2 text-xs">
      {onTrim && <button disabled={disabled} onClick={onTrim} className="underline disabled:opacity-40">Trim</button>}
      {onRemove && <button disabled={disabled || !canRemove} onClick={onRemove} className="underline disabled:opacity-40" title={!canRemove ? "Keep at least one segment" : "Remove this segment"}>Remove</button>}
      {onMove && <><button aria-label={`Move segment ${index + 1} earlier`} disabled={disabled || !canMoveUp} onClick={() => onMove(-1)} className="underline disabled:opacity-40">Earlier</button><button aria-label={`Move segment ${index + 1} later`} disabled={disabled || !canMoveDown} onClick={() => onMove(1)} className="underline disabled:opacity-40">Later</button></>}
    </div>
    {beat.broll_hint && <p className="text-[11px] text-green-300">{beat.broll_hint.description}</p>}
  </article>;
}
