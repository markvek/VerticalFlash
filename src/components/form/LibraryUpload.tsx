"use client";
import { useRef, useState } from "react";
import type { LibraryClip } from "@/lib/library-schema";

type Item = {
  id: string;
  file: File;
  analyze: boolean;
  progress: number;
  status: "queued" | "uploading" | "processing" | "done" | "error";
  message?: string;
};
function send(
  file: File,
  analyze: boolean,
  progress: (percent: number) => void,
): Promise<{
  clips: LibraryClip[];
  errors: { name: string; error: string }[];
}> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/library/upload${analyze ? "?analyze=1" : ""}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) progress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onerror = () =>
      reject(
        new Error("Upload interrupted. Check the library before retrying."),
      );
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || "Upload failed"));
      } catch {
        reject(new Error(`Upload failed (HTTP ${xhr.status})`));
      }
    };
    const form = new FormData();
    form.append("files", file);
    xhr.send(form);
  });
}
export function LibraryUpload({
  onAdded,
  onBusy,
}: {
  onAdded: (clips: LibraryClip[]) => void | Promise<void>;
  onBusy?: (busy: boolean) => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [analyze, setAnalyze] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const queue = useRef<Item[]>([]);
  const running = useRef(false);
  const callbacks = useRef({ onAdded, onBusy });
  callbacks.current = { onAdded, onBusy };
  const patch = (id: string, change: Partial<Item>) =>
    setItems((current) =>
      current.map((i) => (i.id === id ? { ...i, ...change } : i)),
    );
  const drain = async () => {
    if (running.current) return;
    running.current = true;
    callbacks.current.onBusy?.(true);
    try {
      while (queue.current.length) {
        const item = queue.current.shift()!;
        patch(item.id, {
          status: "uploading",
          message: undefined,
          progress: 0,
        });
        try {
          const result = await send(item.file, item.analyze, (progress) =>
            patch(item.id, {
              progress,
              status: progress === 100 ? "processing" : "uploading",
            }),
          );
          if (!result.clips.length)
            throw new Error(result.errors[0]?.error || "Upload failed");
          patch(item.id, {
            status: "done",
            progress: 100,
            message: result.errors.map((e) => e.error).join("; ") || undefined,
          });
          try {
            await callbacks.current.onAdded(result.clips);
          } catch {
            patch(item.id, {
              message: "Saved. Refresh the library to see the clip.",
            });
          }
        } catch (e) {
          patch(item.id, {
            status: "error",
            message: e instanceof Error ? e.message : "Upload failed",
          });
        }
      }
    } finally {
      running.current = false;
      callbacks.current.onBusy?.(false);
    }
  };
  const add = (files: File[]) => {
    const next: Item[] = files.map((file) => {
      const message = !/\.(mp4|mov|avi|mkv)$/i.test(file.name)
        ? "Choose MP4, MOV, AVI, or MKV video."
        : file.size === 0
          ? "File is empty."
          : file.size > 500 * 1024 * 1024
            ? "File exceeds 500 MB."
            : undefined;
      return {
        id: crypto.randomUUID(),
        file,
        analyze,
        progress: 0,
        status: message ? "error" : "queued",
        message,
      };
    });
    setItems((current) => [...current, ...next]);
    queue.current.push(...next.filter((i) => i.status === "queued"));
    void drain();
  };
  return (
    <section className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node))
            setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          add(Array.from(e.dataTransfer.files));
        }}
        className={`rounded-xl border-2 border-dashed p-6 text-center ${dragging ? "border-primary bg-primary/10" : "border-border"}`}
      >
        <p className="font-medium text-sm">Drop videos into your library</p>
        <p className="mt-1 text-xs text-muted-foreground">
          MP4, MOV, AVI, MKV · up to 500 MB per file
        </p>
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="mt-3 rounded-md border px-3 py-2 text-sm"
        >
          Choose files
        </button>
        <input
          ref={input}
          className="hidden"
          type="file"
          multiple
          accept=".mp4,.mov,.avi,.mkv"
          onChange={(e) => {
            add(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </div>
      <label className="flex gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={analyze}
          onChange={(e) => setAnalyze(e.target.checked)}
        />
        Also analyze for B-roll reuse (uses Gemini)
      </label>
      <ul className="space-y-2" aria-live="polite">
        {items.map((i) => (
          <li key={i.id} className="rounded border px-3 py-2 text-xs">
            <div className="flex justify-between gap-3">
              <span className="truncate">{i.file.name}</span>
              <span>
                {i.status === "done"
                  ? "Added"
                  : i.status === "uploading"
                    ? `${i.progress}% uploaded`
                    : i.status}
              </span>
            </div>
            {["uploading", "processing"].includes(i.status) && (
              <progress
                className="mt-2 w-full"
                value={i.progress}
                max={100}
                aria-label={`Uploading ${i.file.name}`}
              />
            )}
            {i.message && (
              <p
                className={`mt-1 ${i.status === "error" ? "text-destructive" : "text-amber-600"}`}
              >
                {i.message}
              </p>
            )}
            {i.status === "error" &&
              /\.(mp4|mov|avi|mkv)$/i.test(i.file.name) &&
              i.file.size > 0 &&
              i.file.size <= 500 * 1024 * 1024 && (
                <button
                  className="mt-1 underline"
                  type="button"
                  onClick={() => {
                    patch(i.id, { status: "queued" });
                    queue.current.push(i);
                    void drain();
                  }}
                >
                  Retry
                </button>
              )}
          </li>
        ))}
      </ul>
    </section>
  );
}
