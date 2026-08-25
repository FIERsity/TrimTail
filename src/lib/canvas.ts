export function drawToCanvas(
  src: CanvasImageSource,
  width: number,
  height: number
): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(width));
  cv.height = Math.max(1, Math.round(height));
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, cv.width, cv.height);
  return cv;
}

export function canvasToBlob(
  cv: HTMLCanvasElement,
  type: string,
  quality?: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    cv.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("导出失败"))),
      type,
      quality
    );
  });
}
