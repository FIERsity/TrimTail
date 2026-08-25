export type BgColor = [number, number, number];

/** 从四个角各取一块区域求平均色，当作背景采样 */
export function sampleBgColor(bitmap: ImageBitmap): BgColor {
  const cv = document.createElement("canvas");
  cv.width = bitmap.width;
  cv.height = bitmap.height;
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const w = cv.width;
  const k = Math.max(1, Math.min(8, bitmap.width, bitmap.height)); // 小图也能采样
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (const [sx, sy] of [
    [0, 0],
    [w - k, 0],
    [0, cv.height - k],
    [w - k, cv.height - k],
  ]) {
    for (let y = sy; y < sy + k; y++) {
      for (let x = sx; x < sx + k; x++) {
        const o = (y * w + x) * 4;
        if (img[o + 3] === 0) continue;
        rs.push(img[o]);
        gs.push(img[o + 1]);
        bs.push(img[o + 2]);
      }
    }
  }
  if (!rs.length) return [255, 255, 255];
  const median = (values: number[]) => {
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  };
  return [median(rs), median(gs), median(bs)];
}

/** 四角连通 BFS：与种子色差异小于 fuzz 的像素置为透明 */
export function removeBackground(
  bitmap: ImageBitmap,
  fuzz: number,
  bg?: BgColor
): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = bitmap.width;
  cv.height = bitmap.height;
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, cv.width, cv.height);
  const d = img.data;
  const w = cv.width;
  const h = cv.height;
  const seed = bg ?? sampleBgColor(bitmap);
  const f2 = fuzz * fuzz;
  const visited = new Uint8Array(w * h);
  const stack: number[] = [];
  const trySeed = (x: number, y: number) => {
    const idx = y * w + x;
    if (visited[idx]) return;
    visBFS(idx);
  };
  const visBFS = (startIdx: number) => {
    stack.length = 0;
    stack.push(startIdx);
    visited[startIdx] = 1;
    while (stack.length) {
      const idx = stack.pop()!;
      const o = idx * 4;
      const dr = d[o] - seed[0];
      const dg = d[o + 1] - seed[1];
      const db = d[o + 2] - seed[2];
      if (dr * dr + dg * dg + db * db <= f2) {
        d[o + 3] = 0;
        const x = idx % w;
        const y = (idx / w) | 0;
        if (x > 0 && !visited[idx - 1]) {
          visited[idx - 1] = 1;
          stack.push(idx - 1);
        }
        if (x < w - 1 && !visited[idx + 1]) {
          visited[idx + 1] = 1;
          stack.push(idx + 1);
        }
        if (y > 0 && !visited[idx - w]) {
          visited[idx - w] = 1;
          stack.push(idx - w);
        }
        if (y < h - 1 && !visited[idx + w]) {
          visited[idx + w] = 1;
          stack.push(idx + w);
        }
      }
    }
  };
  // 四角种子（只沿外缘扩散,避免吃到主体内部同类色）
  const corners: [number, number][] = [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
  ];
  for (const [x, y] of corners) trySeed(x, y);
  featherEdges(d, w, h, seed, fuzz);
  ctx.putImageData(img, 0, 0);
  return cv;
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

export function hexToRgb(hex: string): BgColor {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [255, 255, 255];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** canvas 版去底(四角 BFS 同款)—— 供编辑器实时预览与导出使用 */
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
  const d = img.data;
  const w = out.width;
  const h = out.height;
  const seed = bg ?? sampleBgFromData(d, w, h);
  const f2 = fuzz * fuzz;
  const visited = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (idx: number) => {
    if (!visited[idx]) {
      visited[idx] = 1;
      stack.push(idx);
    }
  };
  for (const [x, y] of [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
  ] as [number, number][])
    push(y * w + x);
  while (stack.length) {
    const idx = stack.pop()!;
    const o = idx * 4;
    const dr = d[o] - seed[0];
    const dg = d[o + 1] - seed[1];
    const db = d[o + 2] - seed[2];
    if (dr * dr + dg * dg + db * db <= f2) {
      d[o + 3] = 0;
      const x = idx % w;
      const y = (idx / w) | 0;
      if (x > 0) push(idx - 1);
      if (x < w - 1) push(idx + 1);
      if (y > 0) push(idx - w);
      if (y < h - 1) push(idx + w);
    }
  }
  featherEdges(d, w, h, seed, fuzz);
  ctx.putImageData(img, 0, 0);
  return out;
}

/** 全图按颜色去除：不要求颜色区域与画布边缘连通，适合主体内部的背景孔洞。 */
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
  const d = img.data;
  const f2 = fuzz * fuzz;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const matches = colors.some(([r, g, b]) => {
      const dr = d[i] - r;
      const dg = d[i + 1] - g;
      const db = d[i + 2] - b;
      return dr * dr + dg * dg + db * db <= f2;
    });
    if (matches) d[i + 3] = 0;
  }
  featherEdges(d, out.width, out.height, colors[0] ?? [255, 255, 255], fuzz);
  ctx.putImageData(img, 0, 0);
  return out;
}


/** 给去底边缘留一圈半透明过渡，减少硬切造成的锯齿和白边。 */
function featherEdges(
  d: Uint8ClampedArray,
  w: number,
  h: number,
  seed: BgColor,
  fuzz: number
) {
  const feather = Math.max(4, Math.min(18, fuzz * 0.25));
  const limit = fuzz + feather;
  const source = d.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const o = idx * 4;
      if (source[o + 3] === 0) continue;
      const touchesTransparent =
        (x > 0 && source[o - 4 + 3] === 0) ||
        (x < w - 1 && source[o + 4 + 3] === 0) ||
        (y > 0 && source[o - w * 4 + 3] === 0) ||
        (y < h - 1 && source[o + w * 4 + 3] === 0);
      if (!touchesTransparent) continue;
      const distance = Math.hypot(source[o] - seed[0], source[o + 1] - seed[1], source[o + 2] - seed[2]);
      if (distance > limit) continue;
      const alpha = Math.round(Math.max(0, Math.min(1, (distance - fuzz) / feather)) * 255);
      d[o + 3] = Math.min(d[o + 3], alpha);
    }
  }
}

function sampleBgFromData(
  d: Uint8ClampedArray,
  w: number,
  h: number
): BgColor {
  const k = Math.max(1, Math.min(8, w, h));
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (const [sx, sy] of [
    [0, 0],
    [w - k, 0],
    [0, h - k],
    [w - k, h - k],
  ] as [number, number][]) {
    for (let y = sy; y < sy + k; y++) {
      for (let x = sx; x < sx + k; x++) {
        const o = (y * w + x) * 4;
        if (d[o + 3] === 0) continue;
        rs.push(d[o]);
        gs.push(d[o + 1]);
        bs.push(d[o + 2]);
      }
    }
  }
  if (!rs.length) return [255, 255, 255];
  const median = (values: number[]) => {
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  };
  return [median(rs), median(gs), median(bs)];
}
