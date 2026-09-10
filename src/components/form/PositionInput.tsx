"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  label: string;
  value: number;
  onChange: (value: number) => void;
  onBegin: () => void;
  onCommit: () => void;
}
const display = (value: number) => String(Math.round(value * 100) / 100);

export function PositionInput({ label, value, onChange, onBegin, onCommit }: Props) {
  const [draft, setDraft] = useState(display(value));
  const focused = useRef(false);
  const initial = useRef(value);
  useEffect(() => { if (!focused.current) setDraft(display(value)); }, [value]);
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs">
      {label}
      <span className="flex min-w-0 items-center rounded border border-border bg-background focus-within:border-primary">
        <input type="number" aria-label={label} step={1} value={draft}
          className="w-full min-w-0 bg-transparent px-2 py-1.5 font-mono outline-none disabled:opacity-40"
          onFocus={() => { focused.current = true; initial.current = value; onBegin(); }}
          onChange={e => {
            setDraft(e.target.value);
            const number = e.target.valueAsNumber;
            if (Number.isFinite(number)) onChange(number);
          }}
          onBlur={() => { focused.current = false; setDraft(display(value)); onCommit(); }}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
            if (e.key === "Escape") {
              e.preventDefault(); onChange(initial.current); setDraft(display(initial.current)); e.currentTarget.blur();
            }
          }} />
        <span className="pr-2 text-muted-foreground">px</span>
      </span>
    </label>
  );
}
