export async function readAsBitmap(file: File): Promise<ImageBitmap> {
  return createImageBitmap(file);
}

/** 在缩略画布上快速判断图片是否包含透明像素，避免为大图分配完整 ImageData。 */
export function hasTransparency(bitmap: ImageBitmap): boolean {
  const max = 128;
  const scale = Math.min(1, max / bitmap.width, max / bitmap.height);
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(bitmap.width * scale));
  cv.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;
  ctx.drawImage(bitmap, 0, 0, cv.width, cv.height);
  const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function extFor(mime: string): string {
  switch (mime) {
    case "image/webp":
      return "webp";
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    default:
      return "bin";
  }
}

export function baseName(name: string): string {
  const m = /^(.*?)(?:\.[^.]+)?$/.exec(name);
  return (m ? m[1] : name) || "image";
}

export function acceptMime(file: File): boolean {
  const type = file.type.toLowerCase();
  if (/^image\/(png|jpe?g|webp|gif|bmp|avif|tiff)$/.test(type)) return true;
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  return ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "tif", "tiff"].includes(ext);
}
