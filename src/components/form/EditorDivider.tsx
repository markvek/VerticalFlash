"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import styles from "./editor.module.css";

const STORAGE_KEY = "editing-workspace-split";

export function EditorDivider({ content, upper }: {
  content: RefObject<HTMLDivElement | null>;
  upper: RefObject<HTMLDivElement | null>;
}) {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; y: number; height: number } | null>(null);
  const ratio = useRef<number | null>(null);
  const [percent, setPercent] = useState(50);
  const [dragging, setDragging] = useState(false);

  const availableHeight = () => {
    if (!content.current || !handle.current) return 0;
    const gap = parseFloat(getComputedStyle(content.current).rowGap) || 0;
    return Math.max(0, content.current.clientHeight - handle.current.offsetHeight - gap * 2);
  };
  const resize = (height: number) => {
    const available = availableHeight();
    if (!available || !content.current) return;
    const minimum = Math.min(200, available * 0.3);
    const next = Math.max(minimum, Math.min(available - minimum, height));
    content.current.style.setProperty("--editor-upper-height", `${next}px`);
    ratio.current = next / available;
    setPercent(Math.round(ratio.current * 100));
  };
  const persist = () => {
    try {
      if (ratio.current === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, String(ratio.current));
    } catch { /* Resizing still works when browser storage is unavailable. */ }
  };
  const reset = () => {
    content.current?.style.removeProperty("--editor-upper-height");
    ratio.current = null;
    persist();
    const available = availableHeight();
    if (available && upper.current) setPercent(Math.round(upper.current.offsetHeight / available * 100));
  };
  const latest = useRef({ resize, availableHeight });
  latest.current = { resize, availableHeight };

  useEffect(() => {
    const container = content.current;
    if (!container) return;
    try {
      const saved = Number(localStorage.getItem(STORAGE_KEY));
      if (saved > 0 && saved < 1) ratio.current = saved;
    } catch { /* Use the existing layout by default. */ }
    const measure = () => {
      if (!handle.current?.offsetHeight) return; // Keep the stacked mobile layout.
      const available = latest.current.availableHeight();
      if (ratio.current !== null) latest.current.resize(available * ratio.current);
      else if (available && upper.current) setPercent(Math.round(upper.current.offsetHeight / available * 100));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    measure();
    return () => { observer.disconnect(); container.style.removeProperty("--editor-upper-height"); };
  }, [content, upper]);

  useEffect(() => {
    if (!dragging) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    return () => { document.body.style.cursor = cursor; document.body.style.userSelect = userSelect; };
  }, [dragging]);

  const finish = (cancel = false) => {
    const current = drag.current;
    if (!current) return;
    if (cancel) resize(current.height);
    drag.current = null;
    setDragging(false);
    if (handle.current?.hasPointerCapture(current.pointer)) handle.current.releasePointerCapture(current.pointer);
    persist();
  };

  return <div ref={handle} role="separator" tabIndex={0}
    aria-label="Resize editing panel and timeline" aria-orientation="horizontal"
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
    aria-valuetext={`Editing panel ${percent}%, timeline ${100 - percent}%`}
    className={styles.divider} data-dragging={dragging || undefined}
    title="Drag to resize · Arrow keys to adjust · Double-click or Enter to reset"
    onPointerDown={event => {
      if (event.button !== 0 || !upper.current) return;
      event.preventDefault(); event.currentTarget.focus();
      drag.current = { pointer: event.pointerId, y: event.clientY, height: upper.current.offsetHeight };
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }}
    onPointerMove={event => {
      const current = drag.current;
      if (current?.pointer === event.pointerId) resize(current.height + event.clientY - current.y);
    }}
    onPointerUp={() => finish()} onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish()}
    onDoubleClick={reset}
    onKeyDown={event => {
      if (event.key === "Escape" && drag.current) { event.preventDefault(); finish(true); return; }
      if (drag.current) return;
      if (event.key === "Enter") { event.preventDefault(); reset(); return; }
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const step = event.shiftKey ? 48 : 16;
      resize(event.key === "Home" ? 0 : event.key === "End" ? availableHeight() : (upper.current?.offsetHeight ?? 0) + (event.key === "ArrowUp" ? -step : step));
      persist();
    }} />;
}
