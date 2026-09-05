import type { BgColor } from "./pixels";
import {
  sampleBgFromData,
  featherEdgesData,
  removeEdgeBackgroundData,
  removeBackgroundByColorsData,
  hexToRgb,
} from "./pixels";

export type { BgColor };
export { hexToRgb };

/** canvas 版去底(四角 BFS)—— 供编辑器取色预览等少量主线程场景使用 */
export function removeBackgroundCanvas(
  cv: HTMLCanvasElement,
  fuzz: number,
  bg?: BgColor
): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = cv.width;
  out.height = cv.height;
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(cv, 0, 0);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  removeEdgeBackgroundData(img.data, out.width, out.height, fuzz, bg ?? sampleBgFromData(img.data, out.width, out.height));
  ctx.putImageData(img, 0, 0);
  return out;
}

/** 全图按颜色去除(canvas 版)，主线程小图/降级路径使用 */
export function removeBackgroundByColorsCanvas(
  cv: HTMLCanvasElement,
  colors: BgColor[],
  fuzz: number
): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = cv.width;
  out.height = cv.height;
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(cv, 0, 0);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  removeBackgroundByColorsData(img.data, out.width, out.height, colors, fuzz);
  ctx.putImageData(img, 0, 0);
  return out;
}

/** 把透明底图铺到纯色背景上（透明部分显示为 color） */
export function paintBackground(
  transparentCanvas: HTMLCanvasElement,
  color: string
): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = transparentCanvas.width;
  cv.height = transparentCanvas.height;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(transparentCanvas, 0, 0);
  return cv;
}
