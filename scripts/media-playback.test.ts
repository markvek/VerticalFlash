import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { beginMediaPlayback, preservePlaybackOnPause, installMediaPlaybackGuard, isCurrentMediaPlayback, playMedia } from "../src/lib/media-playback";

class TestDocument extends EventTarget {
  body = {};
  media: TestMedia[] = [];
  querySelectorAll() { return this.media.filter((media) => media.isConnected); }
  emit(type: string, target: TestMedia) {
    const event = new Event(type);
    Object.defineProperty(event, "target", { value: target });
    this.dispatchEvent(event);
  }
}
class TestMedia {
  paused = true;
  ended = false;
  isConnected = true;
  playCalls = 0;
  constructor(private document: TestDocument) { document.media.push(this); }
  async play() {
    this.playCalls++;
    this.paused = false;
    this.document.emit("play", this);
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    queueMicrotask(() => this.document.emit("pause", this));
  }
}

let document: TestDocument;
let cleanup: () => void;
const element = (media: TestMedia) => media as unknown as HTMLMediaElement;
beforeEach(() => {
  document = new TestDocument();
  Object.assign(globalThis, {
    document,
    HTMLMediaElement: TestMedia,
    MutationObserver: class { observe() {} disconnect() {} },
  });
  cleanup = installMediaPlaybackGuard();
});
afterEach(() => cleanup());

test("starting another player pauses the previous video or audio, including native controls", async () => {
  const first = new TestMedia(document);
  const second = new TestMedia(document);
  await playMedia(element(first));
  await second.play();
  assert.equal(first.paused, true);
  assert.equal(second.paused, false);
  await first.play();
  assert.equal(first.paused, false);
  assert.equal(second.paused, true);
});

test("a delayed older selection cannot interrupt the latest playback request", async () => {
  const first = new TestMedia(document);
  const second = new TestMedia(document);
  const oldRequest = beginMediaPlayback();
  await playMedia(element(second));
  await playMedia(element(first), oldRequest);
  assert.equal(first.playCalls, 0);
  assert.equal(second.paused, false);
});

test("reserving a new selection pauses pending playback before its media loads", async () => {
  const first = new TestMedia(document);
  await playMedia(element(first));
  const request = beginMediaPlayback();
  assert.equal(first.paused, true);
  assert.equal(isCurrentMediaPlayback(request), true);
});

test("pausing invalidates scheduled playback but the end of a beat does not", async () => {
  const first = new TestMedia(document);
  const request = beginMediaPlayback();
  await playMedia(element(first), request);
  first.ended = true;
  first.pause();
  await Promise.resolve();
  assert.equal(isCurrentMediaPlayback(request), true);
  first.ended = false;
  await playMedia(element(first), request);
  first.pause();
  await Promise.resolve();
  assert.equal(isCurrentMediaPlayback(request), false);
  await playMedia(element(first), request);
  assert.equal(first.paused, true);
});

test("leaving the page cancels delayed starts and pauses detached players", async () => {
  const first = new TestMedia(document);
  const request = beginMediaPlayback();
  await playMedia(element(first), request);
  first.isConnected = false;
  beginMediaPlayback();
  assert.equal(first.paused, true);
  assert.equal(isCurrentMediaPlayback(request), false);
});

test("a playback-driven sequence pauses and resumes without letting another player reuse its request", async () => {
  const first = new TestMedia(document), second = new TestMedia(document);
  const request = beginMediaPlayback(); const release = preservePlaybackOnPause(request);
  await playMedia(element(first), request); first.pause(); await Promise.resolve();
  assert.equal(isCurrentMediaPlayback(request), true);
  await first.play(); assert.equal(isCurrentMediaPlayback(request), true);
  await second.play(); assert.equal(isCurrentMediaPlayback(request), false);
  release();
});
