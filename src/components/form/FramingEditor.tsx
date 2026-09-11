"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { TextCue } from "@/lib/text-cues";
import { createPortal } from "react-dom";
import { Crop, Crosshair, LocateFixed, Move, Pause, Play, Redo2, RotateCcw, Undo2 } from "lucide-react";
import { clamp, DEFAULT_FRAMING, DEFAULT_LAYER, frameRect, MAX_FRAME_ZOOM, MIN_FRAME_ZOOM, withFrameCenter, type Framing, type PreviewSource } from "@/lib/framing-schema";
import type { useFraming } from "./useFraming";
import { PositionInput } from "./PositionInput";

export interface PreviewBroll { id: string; url: string; start: number; end: number; clipStart: number; label: string }
interface Props {
  textCues?: TextCue[];
  externalLayerSelector?: boolean;
  controlsTarget: HTMLElement | null;
  state: ReturnType<typeof useFraming>;
  clock: RefObject<HTMLVideoElement | null>;
  shot: { index: number; start_time: number; end_time: number };
  source: PreviewSource[];
  broll: PreviewBroll[];
  target: string | null;
  onTarget: (id: string | null) => void;
  getTime: () => number;
  onSeek: (time: number) => void;
}
const WIDTH = 1080, HEIGHT = 1920;
const button = "inline-flex size-8 shrink-0 items-center justify-center rounded border border-border hover:bg-muted disabled:opacity-40";

export function FramingEditor(props: Props) {
  const { state, clock, shot, source, broll, target, onTarget, onSeek, controlsTarget } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const live = useRef(props); live.current = props;
  const [position, setPosition] = useState(shot.start_time);
  const [playing, setPlaying] = useState(false);
  const [endpoint, setEndpoint] = useState<"start" | "end">("start");
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [buffering, setBuffering] = useState(false);
  const [dimensions, setDimensions] = useState({ width: WIDTH, height: HEIGHT, key: "" });
  const [guides, setGuides] = useState(false);
  const drag = useRef<{ x: number; y: number; frame: Framing; key: "start" | "end"; bounds: DOMRect } | null>(null);
  const activeText = props.textCues?.find(cue => position >= cue.start && position < cue.end);
  const selected = broll.find(s => s.id === target);
  const layer = target ? state.document?.broll[target] ?? DEFAULT_LAYER : null;
  const frame = layer?.framing ?? state.document?.shots[String(shot.index)] ?? DEFAULT_FRAMING;
  const start = selected?.start ?? shot.start_time;
  const end = selected?.end ?? shot.end_time;
  const key = frame.motion === "static" ? "start" : endpoint;
  const dimensionsReady = dimensions.key === `${shot.index}:${target ?? "main"}`;
  const selectedRect = frameRect(dimensions.width, dimensions.height, WIDTH, HEIGHT, frame, key === "end" ? 1 : 0);
  const centerX = selectedRect.x + selectedRect.width / 2;
  const centerY = selectedRect.y + selectedRect.height / 2;
  const guideRect = frameRect(dimensions.width, dimensions.height, WIDTH, HEIGHT, frame, (position - start) / Math.max(0.001, end - start));
  const changeFrame = (next: Framing, continuous = false) => state.update(d => target
    ? { ...d, broll: { ...d.broll, [target]: { ...(d.broll[target] ?? DEFAULT_LAYER), framing: next } } }
    : { ...d, shots: { ...d.shots, [String(shot.index)]: next } }, continuous);

  useEffect(() => { setEndpoint("start"); }, [target, shot.index]);
  useEffect(() => { setMediaError(null); }, [target, shot.index]);
  useEffect(() => {
    let raf = 0, lastUi = 0;
    const buffer = document.createElement("canvas"); buffer.width = WIDTH; buffer.height = HEIGHT;
    const syncVideo = (key: string, url: string, desired: number, running: boolean) => {
      let v = videos.current.get(key);
      if (!v) {
        v = document.createElement("video"); v.muted = true; v.playsInline = true; v.preload = "auto";
        v.src = url; videos.current.set(key, v);
        v.onerror = () => {
          if (!v!.dataset.proxy) {
            v!.dataset.proxy = "true";
            v!.src = `/api/framing-preview?source=${encodeURIComponent(url)}`;
          } else setMediaError("A preview clip could not be loaded.");
        };
      }
      // Some browsers expose an audio-only HEVC decode as ready, with no error.
      if (v.readyState >= 2 && !v.videoWidth && !v.dataset.proxy) {
        v.dataset.proxy = "true"; v.src = `/api/framing-preview?source=${encodeURIComponent(url)}`;
      }
      if (v.readyState >= 1) {
        const t = Math.max(0, Math.min(desired, Math.max(0, v.duration - 1 / 30)));
        if (!v.seeking && Math.abs(v.currentTime - t) > (running ? 0.12 : 0.018)) v.currentTime = t;
        if (running && v.paused && desired < v.duration - 1 / 30) void v.play().catch(() => {});
        if (!running && !v.paused) v.pause();
      }
      return v;
    };
    const draw = (now: number) => {
      const p = live.current;
      const time = p.getTime();
      const running = !!p.clock.current && !p.clock.current.paused;
      const ctx = buffer.getContext("2d");
      let waiting = false;
      const used = new Set<string>();
      if (ctx) {
        ctx.globalAlpha = 1; ctx.fillStyle = "#000000"; ctx.fillRect(0, 0, WIDTH, HEIGHT);
        const render = (key: string, url: string, local: number, framing: Framing, progress: number, opacity: number, active: boolean) => {
          used.add(key);
          const v = syncVideo(key, url, local, running);
          if (v.readyState < 2 || !v.videoWidth || v.seeking) { waiting = true; return; }
          const r = frameRect(v.videoWidth, v.videoHeight, WIDTH, HEIGHT, framing, progress);
          ctx.globalAlpha = opacity;
          ctx.drawImage(v, r.x, r.y, r.width, r.height);
          ctx.globalAlpha = 1;
          if (active && now - lastUi > 100) setDimensions({ width: v.videoWidth, height: v.videoHeight, key: `${p.shot.index}:${p.target ?? "main"}` });
        };
        const local = time - p.shot.start_time;
        const spans = p.source;
        const span = spans.find(s => local >= s.offset && local < s.offset + s.end - s.start) ?? spans[spans.length - 1];
        if (span) {
          let elapsed = Math.max(0, local - span.offset);
          const playback = span.playback;
          if (playback?.fill === "loop") elapsed %= Math.max(0.001, playback.available);
          if (playback?.fill === "slow_mo") elapsed *= playback.available / (span.end - span.start);
          if (!(playback?.fill === "black" && elapsed >= playback.available)) {
            render(`main:${span.url}`, span.url, span.start + elapsed, p.state.document?.shots[String(p.shot.index)] ?? DEFAULT_FRAMING,
              local / Math.max(0.001, p.shot.end_time - p.shot.start_time), 1, !p.target);
          }
        }
        const active = p.broll.filter(s => time >= s.start && time < s.end);
        const top = active[active.length - 1];
        if (top) {
          const background = p.state.document?.broll[top.id] ?? DEFAULT_LAYER;
          ctx.fillStyle = background.background;
          ctx.globalAlpha = 1 - (background.mainVisible ? background.mainOpacity : 0);
          ctx.fillRect(0, 0, WIDTH, HEIGHT); ctx.globalAlpha = 1;
        }
        for (const segment of active) {
          const settings = p.state.document?.broll[segment.id] ?? DEFAULT_LAYER;
          render(`broll:${segment.id}:${segment.url}`, segment.url, segment.clipStart + time - segment.start, settings.framing,
            (time - segment.start) / (segment.end - segment.start), settings.opacity, p.target === segment.id);
        }
      }
      if (!waiting) canvas.current?.getContext("2d")?.drawImage(buffer, 0, 0);
      for (const [key, v] of videos.current) if (!used.has(key)) {
        v.pause();
        if (videos.current.size > 8) { v.removeAttribute("src"); v.load(); videos.current.delete(key); }
      }
      if (now - lastUi > 100) { setPosition(time); setPlaying(running); setBuffering(waiting); lastUi = now; }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    const media = videos.current;
    return () => { cancelAnimationFrame(raf); for (const v of media.values()) { v.pause(); v.removeAttribute("src"); v.load(); } media.clear(); };
  }, []);

  const selectEndpoint = (value: "start" | "end") => {
    clock.current?.pause(); setEndpoint(value);
    onSeek(value === "start" ? start : Math.max(start, end - 0.001));
  };
  const controlEnd = () => { state.commit(); };
  const changeCenter = (x: number, y: number, continuous = false) => {
    changeFrame(withFrameCenter(frame, key, dimensions.width, dimensions.height, WIDTH, HEIGHT, x, y), continuous);
  };
  const changeZoom = (zoom: number) => {
    const next = { ...frame, [key]: { ...frame[key], zoom } };
    changeFrame(withFrameCenter(next, key, dimensions.width, dimensions.height, WIDTH, HEIGHT, centerX, centerY), true);
  };
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label="Framing and layers">
      <div className="relative aspect-[9/16] w-full overflow-hidden bg-black">
        <canvas ref={canvas} width={WIDTH} height={HEIGHT} aria-label="Video framing preview" tabIndex={0}
          className="h-full w-full touch-none outline-none focus:ring-2 focus:ring-inset focus:ring-primary"
          style={{ cursor: drag.current ? "grabbing" : "grab" }}
          onFocus={() => setGuides(true)} onBlur={() => setGuides(false)}
          onPointerEnter={() => setGuides(true)} onPointerLeave={() => { if (!drag.current) setGuides(false); }}
          onPointerDown={e => {
            if (!state.document || !dimensionsReady) return;
            e.currentTarget.setPointerCapture(e.pointerId); clock.current?.pause(); state.begin();
            e.currentTarget.focus(); setGuides(true);
            selectEndpoint(endpoint);
            drag.current = { x: e.clientX, y: e.clientY, frame, key, bounds: e.currentTarget.getBoundingClientRect() };
          }}
          onPointerMove={e => {
            const d = drag.current; if (!d) return;
            const point = d.frame[d.key];
            const dx = (e.clientX - d.x) * WIDTH / d.bounds.width;
            const dy = (e.clientY - d.y) * HEIGHT / d.bounds.height;
            changeFrame({ ...d.frame, [d.key]: { ...point,
              offsetX: clamp((point.offsetX ?? 0) + dx / WIDTH, -100, 100),
              offsetY: clamp((point.offsetY ?? 0) + dy / HEIGHT, -100, 100) } }, true);
          }}
          onPointerUp={() => { drag.current = null; state.commit(); }}
          onPointerCancel={() => { drag.current = null; state.commit(); }}
          onKeyDown={e => {
            if (!dimensionsReady || !state.document) return;
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
            e.preventDefault(); selectEndpoint(endpoint);
            const step = e.shiftKey ? 10 : 1;
            changeCenter(centerX + (e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0),
              centerY + (e.key === "ArrowDown" ? step : e.key === "ArrowUp" ? -step : 0));
          }} />
        {guides && dimensionsReady && !playing && <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute border border-cyan-400" style={{ left: `${guideRect.x / WIDTH * 100}%`, top: `${guideRect.y / HEIGHT * 100}%`, width: `${guideRect.width / WIDTH * 100}%`, height: `${guideRect.height / HEIGHT * 100}%` }} />
          <Crosshair size={24} className="absolute -translate-x-1/2 -translate-y-1/2 text-cyan-400 drop-shadow" style={{ left: `${(guideRect.x + guideRect.width / 2) / WIDTH * 100}%`, top: `${(guideRect.y + guideRect.height / 2) / HEIGHT * 100}%` }} />
        </div>}
        {activeText && (
          // The same rasterizer supplies the preview and exported overlay.
          // eslint-disable-next-line @next/next/no-img-element
          <img alt={activeText.text} draggable={false} className="pointer-events-none absolute left-0 w-full"
            src={`/api/text-preview?${new URLSearchParams({ text: activeText.text, style: JSON.stringify(activeText.style) })}`}
            style={activeText.style.position === "top" ? { top: `${250 / HEIGHT * 100}%` } : activeText.style.position === "bottom" ? { bottom: `${460 / HEIGHT * 100}%` } : { top: "50%", transform: "translateY(-50%)" }} />
        )}
        {buffering && <span className="pointer-events-none absolute left-2 top-2 bg-black/70 px-2 py-1 text-xs text-white">Loading preview</span>}
      </div>
      <div className="flex items-center gap-1">
        <button className={button} title={playing ? "Pause" : "Play"} aria-label={playing ? "Pause preview" : "Play preview"}
          onClick={() => { const v = clock.current; if (!v) return; if (v.paused) { if (position >= end - 0.04) onSeek(start); void v.play().catch(() => setMediaError("Playback could not start.")); } else v.pause(); }}>
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <input aria-label="Preview position" className="min-w-0 flex-1" type="range" min={start} max={end - 0.001} step={0.01}
          value={clamp(position, start, end - 0.001)} onChange={e => { const time = Number(e.target.value); clock.current?.pause(); setPosition(time); onSeek(time); }} />
        <span className="w-16 shrink-0 whitespace-nowrap text-right font-mono text-[10px]">{Math.max(0, position - start).toFixed(1)} / {(end - start).toFixed(1)}s</span>
      </div>
      {controlsTarget && createPortal(<div className="flex min-w-0 flex-col gap-4">
      <fieldset aria-label="Framing controls" disabled={!state.document} className="flex min-w-0 flex-col gap-4">
        <div className="flex items-center gap-2">
          <Crop size={16} className="shrink-0" />
          <select aria-label="Framing layer" hidden={props.externalLayerSelector} className="min-w-0 flex-1 rounded border border-border bg-background p-1.5 text-xs"
            value={target ?? "main"} onChange={e => { const id = e.target.value === "main" ? null : e.target.value; onTarget(id); const seg = broll.find(s => s.id === id); if (seg) onSeek(seg.start); }}>
            <option value="main">Main video - shot {shot.index + 1}</option>
            {broll.map(s => <option key={s.id} value={s.id}>B-roll - {s.label}</option>)}
          </select>
          <button className={button} title="Undo framing" aria-label="Undo framing" disabled={!state.canUndo} onClick={state.undo}><Undo2 size={15} /></button>
          <button className={button} title="Redo framing" aria-label="Redo framing" disabled={!state.canRedo} onClick={state.redo}><Redo2 size={15} /></button>
          <button className={button} title="Reset framing" aria-label="Reset framing" onClick={() => changeFrame(structuredClone(DEFAULT_FRAMING))}><RotateCcw size={15} /></button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex" role="group" aria-label="Frame fit">
            {(["fill", "fit"] as const).map(value => <button key={value} aria-pressed={frame.fit === value}
              className={`border border-border px-3 py-1.5 text-xs ${frame.fit === value ? "bg-primary text-primary-foreground" : "bg-background"}`}
              onClick={() => changeFrame({ ...frame, fit: value })}>{value === "fill" ? "Fill" : "Fit"}</button>)}
          </div>
          <select aria-label="Frame motion" className="min-w-0 flex-1 rounded border border-border bg-background p-1.5 text-xs" value={frame.motion}
            onChange={e => { const motion = e.target.value as Framing["motion"]; changeFrame({ ...frame, motion, end: motion === "pan-zoom" ? { ...frame.start } : frame.end }); setEndpoint("start"); }}>
            <option value="static">Static</option><option value="pan-zoom">Pan &amp; Zoom</option>
          </select>
        </div>
        {frame.motion === "pan-zoom" && <div className="flex items-center gap-2" role="group" aria-label="Motion keyframe">
          <Move size={15} />
          {(["start", "end"] as const).map(value => <button key={value} aria-pressed={endpoint === value}
            className={`flex-1 rounded border border-border px-3 py-1.5 text-xs ${endpoint === value ? "bg-muted font-semibold" : ""}`}
            onClick={() => selectEndpoint(value)}>{value === "start" ? "Start" : "End"}</button>)}
        </div>}
        <fieldset aria-label="Layer position" disabled={!dimensionsReady} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px] items-end gap-2">
          <PositionInput key={`${shot.index}:${target}:${key}:x`} label="Center X" value={centerX}
            onBegin={() => { state.begin(); setGuides(true); selectEndpoint(endpoint); }}
            onChange={x => changeCenter(x, centerY, true)} onCommit={() => { controlEnd(); setGuides(false); }} />
          <PositionInput key={`${shot.index}:${target}:${key}:y`} label="Center Y" value={centerY}
            onBegin={() => { state.begin(); setGuides(true); selectEndpoint(endpoint); }}
            onChange={y => changeCenter(centerX, y, true)} onCommit={() => { controlEnd(); setGuides(false); }} />
          <button className={button} title="Center position" aria-label="Center position"
            onClick={() => { selectEndpoint(endpoint); changeCenter(WIDTH / 2, HEIGHT / 2); }}><LocateFixed size={16} /></button>
        </fieldset>
        <label className="flex items-center gap-2 text-xs">Zoom
          <input aria-label="Zoom" className="min-w-0 flex-1" type="range" min={MIN_FRAME_ZOOM} max={MAX_FRAME_ZOOM} step={0.01}
            value={frame[frame.motion === "static" ? "start" : endpoint].zoom}
            disabled={!dimensionsReady}
            onPointerDown={() => { state.begin(); selectEndpoint(endpoint); }} onPointerUp={controlEnd} onPointerCancel={controlEnd} onBlur={controlEnd} onKeyUp={controlEnd}
            onChange={e => changeZoom(Number(e.target.value))} />
          <span className="w-10 text-right font-mono">{frame[frame.motion === "static" ? "start" : endpoint].zoom.toFixed(2)}x</span>
        </label>
        {layer && target && <div className="flex flex-col gap-3 border-t border-border pt-3">
          <label className="flex items-center justify-between text-xs">Main video
            <input type="checkbox" checked={layer.mainVisible} onChange={e => state.update(d => ({ ...d, broll: { ...d.broll, [target]: { ...layer, mainVisible: e.target.checked } } }))} />
          </label>
          {([{ key: "mainOpacity", name: "Main video opacity" }, { key: "opacity", name: "B-roll opacity" }] as const).map(({ key, name }) =>
            <label key={key} className="grid grid-cols-[110px_minmax(0,1fr)_32px] items-center gap-2 text-xs">{name}
              <input aria-label={name} type="range" min={0} max={1} step={0.01} disabled={key === "mainOpacity" && !layer.mainVisible} value={layer[key]}
                onPointerDown={state.begin} onPointerUp={controlEnd} onPointerCancel={controlEnd} onBlur={controlEnd} onKeyUp={controlEnd}
                onChange={e => state.update(d => ({ ...d, broll: { ...d.broll, [target]: { ...layer, [key]: Number(e.target.value) } } }), true)} />
              <span className="text-right font-mono">{Math.round(layer[key] * 100)}%</span>
            </label>)}
          <label className="flex items-center justify-between text-xs">Background color
            <input aria-label="Background color" type="color" className="h-7 w-9 disabled:opacity-40" value={layer.background}
              disabled={layer.mainVisible && layer.mainOpacity === 1} title="Background behind the hidden or faded main video"
              onChange={e => state.update(d => ({ ...d, broll: { ...d.broll, [target]: { ...layer, background: e.target.value } } }))} />
          </label>
        </div>}
      </fieldset>
      <div role="status" className="text-xs text-muted-foreground">{state.status}</div>
      {(state.error || mediaError) && <div role="alert" className="break-words text-xs text-red-500">{state.error || mediaError}
        {state.document && state.error && <button className="ml-2 underline" onClick={() => void state.flush().catch(() => {})}>Retry save</button>}
      </div>}
      </div>, controlsTarget)}
      {source.some(s => s.warning) && <p className="text-xs text-amber-600">{source.find(s => s.warning)?.warning}</p>}
    </section>
  );
}
