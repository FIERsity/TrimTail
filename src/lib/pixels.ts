export type BgColor = [number, number, number];

/** 从四角各取一块区域求中位色，当作背景采样（纯数据版，供 canvas 与 Worker 共用） */
export function sampleBgFromData(d: Uint8ClampedArray, w: number, h: number): BgColor {
  const k = Math.max(1, Math.min(8, w, h));
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (const [sx, sy] of [
    [0, 0],
    [w - k, 0],
    [0, h - k],
    [w - k, h - k],
  ]) {
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

/** 给去底边缘留一圈半透明过渡，减少硬切造成的锯齿和白边 */
export function featherEdgesData(
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
      const distance = Math.hypot(
        source[o] - seed[0],
        source[o + 1] - seed[1],
        source[o + 2] - seed[2]
      );
      if (distance > limit) continue;
      const alpha = Math.round(Math.max(0, Math.min(1, (distance - fuzz) / feather)) * 255);
      d[o + 3] = Math.min(d[o + 3], alpha);
    }
  }
}

/** 四角连通 BFS：与种子色差异小于 fuzz 且与边缘连通的像素置为透明（原地修改 d） */
export function removeEdgeBackgroundData(
  d: Uint8ClampedArray,
  w: number,
  h: number,
  fuzz: number,
  bg?: BgColor
) {
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
  ])
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
  featherEdgesData(d, w, h, seed, fuzz);
}

/** 全图按颜色去除：不要求颜色区域与画布边缘连通，适合主体内部的背景孔洞（原地修改 d） */
export function removeBackgroundByColorsData(
  d: Uint8ClampedArray,
  w: number,
  h: number,
  colors: BgColor[],
  fuzz: number
) {
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
  featherEdgesData(d, w, h, colors[0] ?? [255, 255, 255], fuzz);
}

export function hexToRgb(hex: string): BgColor {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [255, 255, 255];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
