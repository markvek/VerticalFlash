"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { PLAYHEAD_STEP, pointerTime } from "@/lib/playhead";

interface Props {
  time: number;
  duration: number;
  pxPerSec: number;
  timelineRef: RefObject<HTMLDivElement | null>;
  onSeek: (time: number) => void;
  onScrubStart: () => void;
  onScrubEnd: () => void;
}

export function TimelinePlayhead(props: Props) {
  const live = useRef(props); live.current = props;
  const handle = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ pointerId: number; clientX: number; offset: number; lastX: number; lastScroll: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const frame = useRef(0);

  const seekPointer = () => {
    const drag = gesture.current, p = live.current, strip = p.timelineRef.current;
    if (!drag || !strip) return;
    if (drag.clientX === drag.lastX && strip.scrollLeft === drag.lastScroll) return;
    drag.lastX = drag.clientX; drag.lastScroll = strip.scrollLeft;
    p.onSeek(pointerTime(drag.clientX, strip.getBoundingClientRect().left, strip.scrollLeft, p.pxPerSec, drag.offset, p.duration));
  };
  const finish = () => {
    const drag = gesture.current;
    if (!drag) return;
    seekPointer();
    gesture.current = null;
    cancelAnimationFrame(frame.current);
    if (handle.current?.hasPointerCapture(drag.pointerId)) handle.current.releasePointerCapture(drag.pointerId);
    setDragging(false);
    live.current.onScrubEnd();
  };
  useEffect(() => () => {
    cancelAnimationFrame(frame.current);
    if (gesture.current) live.current.onScrubEnd();
  }, []);

  return <div ref={handle} role="slider" tabIndex={0} aria-label="Timeline playhead"
    aria-valuemin={0} aria-valuemax={props.duration} aria-valuenow={Number(props.time.toFixed(3))}
    aria-valuetext={`${props.time.toFixed(2)} seconds`} aria-orientation="horizontal"
    data-dragging={dragging || undefined}
    className={`group absolute inset-y-0 z-30 w-4 touch-none select-none outline-none ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
    style={{ left: Math.max(0, Math.min(props.duration * props.pxPerSec - 16, props.time * props.pxPerSec - 8)) }}
    onClick={e => e.stopPropagation()}
    onPointerDown={e => {
      if (e.button !== 0 || gesture.current) return;
      const strip = props.timelineRef.current;
      if (!strip) return;
      e.preventDefault(); e.stopPropagation();
      e.currentTarget.focus({ preventScroll: true });
      // Stop a previous smooth shot-centering scroll before taking control.
      strip.scrollTo({ left: strip.scrollLeft, behavior: "instant" });
      gesture.current = { pointerId: e.pointerId, clientX: e.clientX,
        offset: e.clientX - strip.getBoundingClientRect().left + strip.scrollLeft - props.time * props.pxPerSec,
        lastX: e.clientX, lastScroll: strip.scrollLeft };
      e.currentTarget.setPointerCapture(e.pointerId);
      props.onScrubStart(); setDragging(true);
      let previous = performance.now();
      const tick = (now: number) => {
        const drag = gesture.current, viewport = live.current.timelineRef.current;
        if (!drag || !viewport) return;
        const bounds = viewport.getBoundingClientRect();
        const edge = 28;
        const speed = drag.clientX < bounds.left + edge ? -Math.min(1, (bounds.left + edge - drag.clientX) / edge)
          : drag.clientX > bounds.right - edge ? Math.min(1, (drag.clientX - bounds.right + edge) / edge) : 0;
        viewport.scrollLeft += speed * 500 * Math.min(32, now - previous) / 1000;
        previous = now;
        seekPointer();
        frame.current = requestAnimationFrame(tick);
      };
      frame.current = requestAnimationFrame(tick);
    }}
    onPointerMove={e => { if (gesture.current?.pointerId === e.pointerId) gesture.current.clientX = e.clientX; }}
    onPointerUp={e => { if (gesture.current?.pointerId === e.pointerId) { gesture.current.clientX = e.clientX; finish(); } }}
    onPointerCancel={finish} onLostPointerCapture={finish}
    onKeyDown={e => {
      if (e.key === "Escape") { e.stopPropagation(); finish(); return; }
      if (gesture.current) return;
      const step = e.shiftKey ? 1 : PLAYHEAD_STEP;
      const time = e.key === "Home" ? 0 : e.key === "End" ? props.duration
        : ["ArrowRight", "ArrowUp"].includes(e.key) ? props.time + step
        : ["ArrowLeft", "ArrowDown"].includes(e.key) ? props.time - step : null;
      if (time === null) return;
      e.preventDefault(); e.stopPropagation();
      props.onScrubStart(); props.onSeek(Math.max(0, Math.min(props.duration, time))); props.onScrubEnd();
    }}>
    <span data-playhead-line className={`pointer-events-none absolute inset-y-0 w-0.5 bg-red-500 transition-shadow group-hover:shadow-[0_0_8px_3px_rgba(239,68,68,0.6)] group-focus-visible:shadow-[0_0_8px_3px_rgba(239,68,68,0.6)] ${dragging ? "shadow-[0_0_10px_4px_rgba(239,68,68,0.75)]" : ""}`}
      style={{ left: props.time * props.pxPerSec - Math.max(0, Math.min(props.duration * props.pxPerSec - 16, props.time * props.pxPerSec - 8)) }} />
  </div>;
}
