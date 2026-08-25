import { drawToCanvas, canvasToBlob } from "./canvas";

export interface CompressOptions {
  format: "webp" | "jpeg";
  quality: number; // 0-1
  targetBytes?: number; // 可选：压到目标大小以内
}

export interface CompressResult {
  blob: Blob;
  width: number;
  height: number;
  downsample: number;
}

const MAXQ = 0.96;
const MINQ = 0.04;

export async function compressCanvasToTarget(
  input: HTMLCanvasElement,
  mime: string,
  targetBytes: number,
  onProgress?: (value: number) => void
): Promise<Blob> {
  const qualityMime = mime === "image/png" ? undefined : 0.82;
  const scales = [1, 0.85, 0.7, 0.55, 0.4, 0.25];
  for (const [scaleIndex, scale] of scales.entries()) {
    onProgress?.(Math.round((scaleIndex / scales.length) * 90));
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(input.width * scale));
    out.height = Math.max(1, Math.round(input.height * scale));
    const ctx = out.getContext("2d", { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(input, 0, 0, out.width, out.height);
    let lo = mime === "image/png" ? 1 : 0.04;
    let hi = 1;
    for (let i = 0; i < (mime === "image/png" ? 1 : 12); i++) {
      const q = mime === "image/png" ? undefined : (lo + hi) / 2;
      const blob = await canvasToBlob(out, mime, q);
      if (blob.size <= targetBytes) {
        onProgress?.(100);
        return blob;
      }
      if (mime !== "image/png") hi = q!;
      else break;
    }
  }
  const fallback = document.createElement("canvas");
  fallback.width = Math.max(1, Math.round(input.width * 0.2));
  fallback.height = Math.max(1, Math.round(input.height * 0.2));
  fallback.getContext("2d")!.drawImage(input, 0, 0, fallback.width, fallback.height);
  onProgress?.(100);
  return canvasToBlob(fallback, mime, qualityMime);
}

async function encodeAt(
  bitmap: ImageBitmap,
  scale: number,
  q: number,
  format: "webp" | "jpeg"
): Promise<{ blob: Blob; w: number; h: number }> {
  const cv = drawToCanvas(bitmap, bitmap.width * scale, bitmap.height * scale);
  const blob = await canvasToBlob(cv, `image/${format}`, q);
  return { blob, w: cv.width, h: cv.height };
}

export async function compressImage(
  bitmap: ImageBitmap,
  opts: CompressOptions
): Promise<CompressResult> {
  const { format, quality, targetBytes } = opts;

  if (format === "jpeg") {
    // JPEG: 垫白再压
    const padded = document.createElement("canvas");
    padded.width = bitmap.width;
    padded.height = bitmap.height;
    const ctx = padded.getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, padded.width, padded.height);
    ctx.drawImage(bitmap, 0, 0);
    const blob = await canvasToBlob(padded, "image/jpeg", quality);
    return { blob, width: padded.width, height: padded.height, downsample: 1 };
  }

  if (!targetBytes || targetBytes <= 0) {
    const { blob, w, h } = await encodeAt(bitmap, 1, quality, format);
    return { blob, width: w, height: h, downsample: 1 };
  }

  // 二分质量 + 逐级降分辨率，直至达标
  for (const scale of [1, 0.85, 0.7, 0.55, 0.4]) {
    let lo = MINQ;
    let hi = MAXQ;
    let best: { blob: Blob; w: number; h: number } | null = null;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      const r = await encodeAt(bitmap, scale, mid, format);
      if (r.blob.size <= targetBytes) {
        best = r;
        lo = mid;
      } else {
        hi = mid;
      }
      if (hi - lo < 0.01) break;
    }
    if (best) return { blob: best.blob, width: best.w, height: best.h, downsample: scale };
  }

  const r = await encodeAt(bitmap, 0.4, MINQ, format);
  return { blob: r.blob, width: r.w, height: r.h, downsample: 0.4 };
}
