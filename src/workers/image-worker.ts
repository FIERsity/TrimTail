/// <reference lib="webworker" />
/**
 * 后台 Worker：把 BFS 去底、按颜色去底、二分压缩这类 O(W×H) 重活
 * 挪出主线程，避免大图时冻结 UI。
 *
 * 注意：所有算法必须与 src/lib/pixels.ts、src/lib/compress.ts 保持一致。
 */
import {
  removeEdgeBackgroundData,
  removeBackgroundByColorsData,
  type BgColor,
} from "../lib/pixels";

type Request =
  | {
      id: number;
      kind: "bg";
      strategy: "edge" | "color";
      fuzz: number;
      colors: BgColor[];
      width: number;
      height: number;
      buffer: ArrayBuffer;
    }
  | {
      id: number;
      kind: "compress";
      mime: string;
      targetBytes: number;
      width: number;
      height: number;
      buffer: ArrayBuffer;
    };

type Response =
  | { id: number; kind: "bg"; width: number; height: number; buffer: ArrayBuffer }
  | { id: number; kind: "progress"; value: number }
  | { id: number; kind: "compress"; blob: Blob }
  | { id: number; kind: "error"; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (event: MessageEvent<Request>) => {
  const req = event.data;
  try {
    if (req.kind === "bg") {
      const data = new Uint8ClampedArray(req.buffer);
      if (req.strategy === "edge") {
        removeEdgeBackgroundData(data, req.width, req.height, req.fuzz);
      } else {
        removeBackgroundByColorsData(data, req.width, req.height, req.colors, req.fuzz);
      }
      const out = data.buffer;
      ctx.postMessage(
        { id: req.id, kind: "bg", width: req.width, height: req.height, buffer: out } satisfies Response,
        [out]
      );
      return;
    }

    if (req.kind === "compress") {
      const bitmap = await createImageBitmap(
        new ImageData(new Uint8ClampedArray(req.buffer), req.width, req.height)
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const c2d = canvas.getContext("2d", { willReadFrequently: true })!;
      c2d.drawImage(bitmap, 0, 0);
      bitmap.close();

      const progress = (value: number) =>
        ctx.postMessage({ id: req.id, kind: "progress", value } satisfies Response);

      const blob = await compressOffscreen(canvas, req.mime, req.targetBytes, progress);
      ctx.postMessage({ id: req.id, kind: "compress", blob } satisfies Response);
      return;
    }
  } catch (cause) {
    ctx.postMessage({
      id: req.id,
      kind: "error",
      message: cause instanceof Error ? cause.message : String(cause),
    } satisfies Response);
  }
};

async function compressOffscreen(
  input: OffscreenCanvas,
  mime: string,
  targetBytes: number,
  onProgress: (value: number) => void
): Promise<Blob> {
  const scales = [1, 0.85, 0.7, 0.55, 0.4, 0.25];
  for (const [scaleIndex, scale] of scales.entries()) {
    onProgress(Math.round((scaleIndex / scales.length) * 90));
    const out = new OffscreenCanvas(
      Math.max(1, Math.round(input.width * scale)),
      Math.max(1, Math.round(input.height * scale))
    );
    const c = out.getContext("2d", { willReadFrequently: true })!;
    c.imageSmoothingQuality = "high";
    c.drawImage(input, 0, 0, out.width, out.height);
    if (mime === "image/png") {
      const blob = await out.convertToBlob({ type: mime });
      if (blob.size <= targetBytes) {
        onProgress(100);
        return blob;
      }
      continue;
    }
    let lo = 0.04;
    let hi = 1;
    for (let i = 0; i < 12; i++) {
      const q = (lo + hi) / 2;
      const blob = await out.convertToBlob({ type: mime, quality: q });
      if (blob.size <= targetBytes) {
        onProgress(100);
        return blob;
      }
      hi = q;
    }
  }
  const fallback = new OffscreenCanvas(
    Math.max(1, Math.round(input.width * 0.2)),
    Math.max(1, Math.round(input.height * 0.2))
  );
  fallback.getContext("2d")!.drawImage(input, 0, 0, fallback.width, fallback.height);
  onProgress(100);
  return fallback.convertToBlob({
    type: mime,
    quality: mime === "image/png" ? undefined : 0.82,
  });
}
