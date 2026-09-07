let requestId = 0;
let activeMedia: HTMLMediaElement | null = null;
const listeners = new Set<() => void>();

function pauseOthers(except: HTMLMediaElement | null) {
  if (activeMedia && activeMedia !== except) activeMedia.pause();
  document.querySelectorAll<HTMLMediaElement>("video, audio").forEach((media) => {
    if (media !== except) media.pause();
  });
}

function selectPlayback(media: HTMLMediaElement | null) {
  requestId += 1;
  pauseOthers(media);
  activeMedia = media;
  listeners.forEach((listener) => listener());
  return requestId;
}

// Reserve playback at the user action, before loading media or scheduling beats.
export function beginMediaPlayback() {
  return selectPlayback(null);
}

export function isCurrentMediaPlayback(request: number) {
  return request === requestId;
}

export function subscribeMediaPlayback(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export async function playMedia(media: HTMLMediaElement, request = beginMediaPlayback()) {
  if (!isCurrentMediaPlayback(request) || !media.isConnected) return;
  pauseOthers(media);
  activeMedia = media;
  await media.play();
  if (!isCurrentMediaPlayback(request) && activeMedia !== media) media.pause();
}

export function installMediaPlaybackGuard() {
  const onPlay = (event: Event) => {
    const media = event.target;
    if (!(media instanceof HTMLMediaElement) || media.paused) return;
    if (media !== activeMedia) selectPlayback(media);
    else pauseOthers(media);
  };
  const onPause = (event: Event) => {
    const media = event.target;
    if (media instanceof HTMLMediaElement && media === activeMedia && media.paused && !media.ended) selectPlayback(null);
  };
  // Media events do not bubble; capture also covers players mounted in dialogs.
  document.addEventListener("play", onPlay, true);
  document.addEventListener("playing", onPlay, true);
  document.addEventListener("pause", onPause, true);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (!(node instanceof Element) || node.isConnected) continue;
        if (node instanceof HTMLMediaElement) node.pause();
        node.querySelectorAll<HTMLMediaElement>("video, audio").forEach((media) => media.pause());
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return () => {
    document.removeEventListener("play", onPlay, true);
    document.removeEventListener("playing", onPlay, true);
    document.removeEventListener("pause", onPause, true);
    observer.disconnect();
    beginMediaPlayback();
  };
}
