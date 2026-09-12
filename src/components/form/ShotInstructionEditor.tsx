"use client";
import { useEffect, useRef, useState } from "react";
interface Props { index: number; note: string; description: string; busy: boolean; draft?: string; onDraftChange?: (index: number, text: string) => void; onSave: (index: number, text: string) => Promise<boolean>; onApply?: () => void }
export function ShotInstructionEditor({ index, note, description, busy, onSave, onApply, draft: storedDraft, onDraftChange }: Props) {
  const [draft, setDraft] = useState(storedDraft ?? note);
  const [status, setStatus] = useState("");
  const dirty = useRef(storedDraft !== undefined && storedDraft !== note);
  useEffect(() => { if (!dirty.current) setDraft(note); }, [note]);
  const value = storedDraft ?? draft;
  const save = async () => {
    if (!dirty.current && value === note) return true;
    setStatus("Saving…");
    const ok = await onSave(index, value);
    if (ok) dirty.current = false;
    setStatus(ok ? "Saved" : "Could not save. Retry below.");
    return ok;
  };
  return <div className="flex h-full min-w-0 flex-col gap-1" onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
    <textarea aria-label={`Clip instructions for shot ${index + 1}`} title={description} value={value} maxLength={2000} disabled={busy}
      placeholder="Tell the AI editor what to change, e.g. loop this clip"
      className="min-h-10 w-full flex-1 resize-none rounded border border-border bg-background/40 p-1.5 text-[11px] outline-none focus:border-primary disabled:opacity-50"
      onChange={e => { dirty.current = true; setDraft(e.target.value); onDraftChange?.(index, e.target.value); setStatus("Unsaved"); }} onBlur={() => void save()} />
    <div className="flex flex-wrap items-center gap-2 text-[10px]">
      <span role="status" className="text-muted-foreground">{status}</span>
      <button disabled={busy} className="underline disabled:opacity-50" onPointerDown={e => e.preventDefault()} onClick={() => void save()}>Save</button>
      {onApply && <button disabled={busy} className="underline disabled:opacity-50" onPointerDown={e => e.preventDefault()} onClick={async () => { if (await save()) onApply(); }}>Apply &amp; render</button>}
    </div>
  </div>;
}
