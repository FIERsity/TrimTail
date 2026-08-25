import { drawToCanvas } from "./canvas";

export function scaleTo(bitmap: ImageBitmap, w: number, h: number) {
  return drawToCanvas(bitmap, w, h);
}

export function cropTo(
  bitmap: ImageBitmap,
  x: number,
  y: number,
  w: number,
  h: number
) {
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(w));
  cv.height = Math.max(1, Math.round(h));
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, x, y, w, h, 0, 0, cv.width, cv.height);
  return cv;
}

export function rotateImage(bitmap: ImageBitmap, deg: 90 | 180 | 270) {
  const cv = document.createElement("canvas");
  if (deg === 90 || deg === 270) {
    cv.width = bitmap.height;
    cv.height = bitmap.width;
  } else {
    cv.width = bitmap.width;
    cv.height = bitmap.height;
  }
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  ctx.translate(cv.width / 2, cv.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  return cv;
}

/** 居中裁剪到给定宽高比 (w/h)，如 1 表示 1:1，16/9 表示 16:9 */
export function cropAspect(bitmap: ImageBitmap, ratio: number) {
  const bw = bitmap.width;
  const bh = bitmap.height;
  let w = bw;
  let h = bw / ratio;
  if (h > bh) {
    h = bh;
    w = bh * ratio;
  }
  const x = (bw - w) / 2;
  const y = (bh - h) / 2;
  return cropTo(bitmap, x, y, w, h);
}
