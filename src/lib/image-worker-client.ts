import type { BgColor } from "./pixels";
import {
  removeEdgeBackgroundData,
  removeBackgroundByColorsData,
} from "./pixels";
import { canvasToBlob } from "./canvas";

/**
 * Worker 封装：优先在后台线程跑重活；Worker 不可用（极少数环境）时自动降级回主线程，
 * 对外接口保持一致。
 */

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  onProgress?: (value: number) => void;
}

let worker: Worker | null = null;
let workerFailed = false;
let nextId = 1;
const pending = new Map<number, PendingEntry>();

function ensureWorker(): Worker | null {
  if (workerFailed) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("../workers/image-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as
        | { id: number; kind: "bg"; width: number; height: number; buffer: ArrayBuffer }
        | { id: number; kind: "progress"; value: number }
        | { id: number; kind: "compress"; blob: Blob }
        | { id: number; kind: "error"; message: string };
      const entry = pending.get(msg.id);
      if (!entry) return;
      if (msg.kind === "progress") {
        entry.onProgress?.(msg.value);
        return;
      }
      pending.delete(msg.id);
      if (msg.kind === "error") entry.reject(new Error(msg.message));
      else entry.resolve(msg);
    };
    worker.onerror = () => {
      workerFailed = true;
      worker?.terminate();
      worker = null;
      for (const entry of pending.values()) entry.reject(new Error("worker-crashed"));
      pending.clear();
    };
  } catch {
    workerFailed = true;
    worker = null;
  }
  return worker;
}

function canvasImageData(source: HTMLCanvasElement): ImageData {
  const ctx = source.getContext("2d", { willReadFrequently: true })!;
  return ctx.getImageData(0, 0, source.width, source.height);
}

function imageDataToCanvas(data: ImageData): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = data.width;
  cv.height = data.height;
  cv.getContext("2d")!.putImageData(data, 0, 0);
  return cv;
}

/** Worker 不可用时主线程同步跑同一份算法 */
function runBackgroundMainThread(
  source: HTMLCanvasElement,
  strategy: "edge" | "color",
  fuzz: number,
  colors: BgColor[]
): HTMLCanvasElement {
  const img = canvasImageData(source);
  if (strategy === "edge") {
    removeEdgeBackgroundData(img.data, img.width, img.height, fuzz);
  } else {
    removeBackgroundByColorsData(img.data, img.width, img.height, colors, fuzz);
  }
  return imageDataToCanvas(img);
}

export async function removeBackgroundOffThread(
  source: HTMLCanvasElement,
  strategy: "edge" | "color",
  fuzz: number,
  colors: BgColor[]
): Promise<HTMLCanvasElement> {
  const w = ensureWorker();
  if (!w) return runBackgroundMainThread(source, strategy, fuzz, colors);
  const img = canvasImageData(source);
  const buffer = img.data.buffer.slice(0);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => {
        const msg = value as { width: number; height: number; buffer: ArrayBuffer };
        resolve(
          imageDataToCanvas(new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height))
        );
      },
      reject,
    });
    w.postMessage(
      { id, kind: "bg", strategy, fuzz, colors, width: img.width, height: img.height, buffer },
      [buffer]
    );
  });
}

async function compressMainThread(
  input: HTMLCanvasElement,
  mime: string,
  targetBytes: number,
  onProgress?: (value: number) => void
): Promise<Blob> {
  const scales = [1, 0.85, 0.7, 0.55, 0.4, 0.25];
  for (const [scaleIndex, scale] of scales.entries()) {
    onProgress?.(Math.round((scaleIndex / scales.length) * 90));
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(input.width * scale));
    out.height = Math.max(1, Math.round(input.height * scale));
    const ctx = out.getContext("2d", { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(input, 0, 0, out.width, out.height);
    if (mime === "image/png") {
      const blob = await canvasToBlob(out, mime);
      if (blob.size <= targetBytes) {
        onProgress?.(100);
        return blob;
      }
      continue;
    }
    let lo = 0.04;
    let hi = 1;
    for (let i = 0; i < 12; i++) {
      const q = (lo + hi) / 2;
      const blob = await canvasToBlob(out, mime, q);
      if (blob.size <= targetBytes) {
        onProgress?.(100);
        return blob;
      }
      hi = q;
    }
  }
  const fallback = document.createElement("canvas");
  fallback.width = Math.max(1, Math.round(input.width * 0.2));
  fallback.height = Math.max(1, Math.round(input.height * 0.2));
  fallback.getContext("2d")!.drawImage(input, 0, 0, fallback.width, fallback.height);
  onProgress?.(100);
  return canvasToBlob(fallback, mime, mime === "image/png" ? undefined : 0.82);
}

export async function compressCanvasToTarget(
  input: HTMLCanvasElement,
  mime: string,
  targetBytes: number,
  onProgress?: (value: number) => void
): Promise<Blob> {
  const w = ensureWorker();
  if (!w) return compressMainThread(input, mime, targetBytes, onProgress);
  const img = canvasImageData(input);
  const buffer = img.data.buffer.slice(0);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve((value as { blob: Blob }).blob),
      reject,
      onProgress,
    });
    w.postMessage(
      { id, kind: "compress", mime, targetBytes, width: img.width, height: img.height, buffer },
      [buffer]
    );
  });
}
