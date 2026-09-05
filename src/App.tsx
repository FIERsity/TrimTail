import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canvasToBlob } from "./lib/canvas";
import { compressCanvasToTarget } from "./lib/compress";
import { MODEL_LABEL, MODEL_LICENSE, MODEL_RUNTIME_SIZE, MODEL_SIZE, clearModelCache, removeBackgroundWithModel } from "./lib/background-model";
import { APP_VERSION } from "./version";
import { paintBackground, hexToRgb } from "./lib/background";
import { removeBackgroundOffThread } from "./lib/image-worker-client";
import { canEncode, detectHeic } from "./lib/image-decode";
import {
  readAsBitmap,
  download,
  fmtSize,
  extFor,
  baseName,
  acceptMime,
  hasTransparency,
} from "./lib/file";

type Mode = "adjust" | "bg" | "export";
type BgStrategy = "edge" | "color" | "model";

interface Source {
  bitmap: ImageBitmap;
  url: string;
  name: string;
  mime: string;
  bytes: number;
  w: number;
  h: number;
  hasTransparency: boolean;
}

interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface EditSnapshot {
  rot: number;
  flipH: boolean;
  flipV: boolean;
  ratio: string;
  crop: CropBox | null;
  bgMode: "original" | "remove" | "solid";
  bgStrategy: BgStrategy;
  fuzz: number;
  sampleColors: string[];
  bgColor: string;
}

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "move";

/** 居中最大化到某比例的框 */
function aspectCentered(W: number, H: number, r: number): CropBox {
  let w = W;
  let h = W / r;
  if (h > H) {
    h = H;
    w = H * r;
  }
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

export default function App() {
  const [src, setSrc] = useState<Source | null>(null);
  const [mode, setMode] = useState<Mode>("adjust");
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // 调整:旋转/翻转为"动作"状态
  const [rot, setRot] = useState(0); // 0/90/180/270 累加
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [ratio, setRatio] = useState("free");
  const [crop, setCrop] = useState<CropBox | null>(null); // null = 满幅
  const [dragging, setDragging] = useState<Handle | null>(null);

  // 背景
  const [bgMode, setBgMode] = useState<"original" | "remove" | "solid">("original");
  const [bgStrategy, setBgStrategy] = useState<BgStrategy>("edge");
  const [fuzz, setFuzz] = useState(40);
  const [sampleColors, setSampleColors] = useState<string[]>([]);
  const [samplingIndex, setSamplingIndex] = useState<number | null>(null);
  const [bgColor, setBgColor] = useState("#ffffff");
  const [modelMask, setModelMask] = useState<HTMLCanvasElement | null>(null);
  const [modelProgress, setModelProgress] = useState(0);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState("");
  const [modelCacheBusy, setModelCacheBusy] = useState(false);

  // 输出
  // 某些浏览器（如老 Safari）不支持 WebP 编码，导出前探测并降级默认格式、禁用该选项
  const [webpEncodable] = useState(() => canEncode("image/webp"));
  const [format, setFormat] = useState<"webp" | "jpeg" | "png">(webpEncodable ? "webp" : "jpeg");
  const [outMode, setOutMode] = useState<"quality" | "target">("quality");
  const [quality, setQuality] = useState(82);
  const [targetKb, setTargetKb] = useState(500);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [exportInfo, setExportInfo] = useState("");
  const [loading, setLoading] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const historyRef = useRef<EditSnapshot[]>([]);
  const historyIndexRef = useRef(-1);
  const restoringHistoryRef = useRef(false);
  const [, setHistoryVersion] = useState(0);

  const stageRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const srcRef = useRef<Source | null>(null);
  const [disp, setDisp] = useState({ w: 0, h: 0, scale: 1 });
  const dragState = useRef<{ startX: number; startY: number; crop: CropBox } | null>(null);
  const bgMaskCacheRef = useRef<{ source: HTMLCanvasElement; strategy: BgStrategy; fuzz: number; colors: string[]; mask: HTMLCanvasElement } | null>(null);

  const editSnapshot = useMemo<EditSnapshot>(() => ({
    rot,
    flipH,
    flipV,
    ratio,
    crop: crop ? { ...crop } : null,
    bgMode,
    bgStrategy,
    fuzz,
    sampleColors,
    bgColor,
  }), [rot, flipH, flipV, ratio, crop, bgMode, bgStrategy, fuzz, sampleColors, bgColor]);

  const sameSnapshot = (a: EditSnapshot | undefined, b: EditSnapshot) =>
    !!a && JSON.stringify(a) === JSON.stringify(b);

  useEffect(() => {
    historyRef.current = [];
    historyIndexRef.current = -1;
    setHistoryVersion((v) => v + 1);
  }, [src?.url]);

  useEffect(() => {
    if (!src || dragging) return;
    if (restoringHistoryRef.current) {
      restoringHistoryRef.current = false;
      return;
    }
    const current = editSnapshot;
    const index = historyIndexRef.current;
    if (sameSnapshot(historyRef.current[index], current)) return;
    historyRef.current = historyRef.current.slice(0, index + 1);
    historyRef.current.push(current);
    historyIndexRef.current = historyRef.current.length - 1;
    setHistoryVersion((v) => v + 1);
  }, [src, dragging, editSnapshot]);

  const restoreHistory = useCallback((index: number) => {
    const snapshot = historyRef.current[index];
    if (!snapshot) return;
    restoringHistoryRef.current = true;
    historyIndexRef.current = index;
    setRot(snapshot.rot);
    setFlipH(snapshot.flipH);
    setFlipV(snapshot.flipV);
    setRatio(snapshot.ratio);
    setCrop(snapshot.crop ? { ...snapshot.crop } : null);
    setBgMode(snapshot.bgMode);
    setBgStrategy(snapshot.bgStrategy);
    setFuzz(snapshot.fuzz);
    setSampleColors(snapshot.sampleColors);
    setBgColor(snapshot.bgColor);
    setHistoryVersion((v) => v + 1);
  }, []);

  const canUndo = historyIndexRef.current > 0;
  const canRedo = historyIndexRef.current >= 0 && historyIndexRef.current < historyRef.current.length - 1;

  const loadFile = useCallback(async (file: File) => {
    if (loading) return;
    setLoading(true);
    setError("");
    setExportInfo("");
    if (!acceptMime(file)) {
      // HEIC/HEIF 在大多数浏览器里无法解码，单独提示，别让用户误以为支持
      setError(
        detectHeic(file)
          ? "HEIC/HEIF 暂不支持：大多数浏览器无法直接解码，请先转成 JPG 或 PNG 再导入。"
          : "目前支持 PNG、JPG、WebP、GIF、BMP、AVIF、TIFF 图片。"
      );
      setLoading(false);
      return;
    }
    try {
      const bitmap = await readAsBitmap(file);
      if (bitmap.width * bitmap.height > 64_000_000) {
        bitmap.close();
        setError("图片尺寸过大，请先缩小到 6400 万像素以内再处理。");
        return;
      }
      const next: Source = {
        bitmap,
        url: URL.createObjectURL(file),
        name: file.name,
        mime: file.type,
        bytes: file.size,
        w: bitmap.width,
        h: bitmap.height,
        hasTransparency: hasTransparency(bitmap),
      };
      setSrc((previous) => {
        if (previous) {
          URL.revokeObjectURL(previous.url);
          previous.bitmap.close();
        }
        srcRef.current = next;
        return next;
      });
    } catch {
      setError("这张图片无法在当前浏览器中读取，请换 PNG、JPG 或 WebP 试试。");
    } finally {
      setLoading(false);
    }
    setRot(0);
    setFlipH(false);
    setFlipV(false);
    setCrop(null);
    setBgMode("original");
    setBgStrategy("edge");
    setSampleColors([]);
    setModelMask(null);
    setModelError("");
    setMode("adjust");
    setRatio("free");
  }, [loading]);

  const clear = useCallback(() => {
    setSrc((previous) => {
      if (previous) {
        URL.revokeObjectURL(previous.url);
        previous.bitmap.close();
      }
      srcRef.current = null;
      return null;
    });
    setCrop(null);
    setBgMode("original");
    setBgStrategy("edge");
    setSampleColors([]);
    setModelMask(null);
    setModelError("");
    setError("");
    setExportInfo("");
  }, []);

  useEffect(() => () => {
    const previous = srcRef.current;
    if (previous) {
      URL.revokeObjectURL(previous.url);
      previous.bitmap.close();
      srcRef.current = null;
    }
  }, []);

  /* ---------- 变换管线 ---------- */
  const rotated = useMemo(() => {
    if (!src) return null;
    const { bitmap } = src;
    const t = ((rot % 360) + 360) % 360;
    const swap = t === 90 || t === 270;
    const w = swap ? bitmap.height : bitmap.width;
    const h = swap ? bitmap.width : bitmap.height;
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1); // 先翻转
    ctx.rotate((t * Math.PI) / 180); // 再旋转(顺时针)
    ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    ctx.restore();
    return cv;
  }, [src, rot, flipH, flipV]);

  useEffect(() => {
    setModelMask(null);
    setModelError("");
  }, [rotated]);

  useEffect(() => {
    if (samplingIndex === null) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSamplingIndex(null);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [samplingIndex]);

  const activeCrop: CropBox = useMemo(() => {
    if (!rotated) return { x: 0, y: 0, w: 1, h: 1 };
    return crop ?? { x: 0, y: 0, w: rotated.width, h: rotated.height };
  }, [rotated, crop]);

  /* ---------- 动作式旋转/翻转 ---------- */
  const rotateBy = useCallback((delta: 90 | -90) => {
    setRot((r) => (((r + delta) % 360) + 360) % 360);
    setCrop(null);
  }, []);

  const toggleFlip = useCallback((dir: "h" | "v") => {
    if (dir === "h") setFlipH((v) => !v);
    else setFlipV((v) => !v);
    setCrop(null);
  }, []);

  const onRatio = useCallback((v: string) => {
    setRatio(v);
  }, []);

  // 旋转/翻转改变工作图后,保持所选比例(居中最大化)
  useEffect(() => {
    if (!rotated || ratio === "free") return;
    const r = parseFloat(ratio);
    setCrop(aspectCentered(rotated.width, rotated.height, r));
  }, [rotated, ratio]);

  /* ---------- 显示尺寸适配 ---------- */
  useEffect(() => {
    if (!rotated) return;
    const stage = stageRef.current;
    const inner = innerRef.current;
    if (!stage || !inner) return;
    const fit = () => {
      const maxW = stage.clientWidth - 24;
      const maxH = Math.min(600, Math.floor(window.innerHeight * 0.58));
      const scale = Math.min(maxW / rotated.width, maxH / rotated.height, 1.4);
      const w = Math.max(1, Math.round(rotated.width * scale));
      const h = Math.max(1, Math.round(rotated.height * scale));
      setDisp({ w, h, scale });
      if (canvasRef.current) {
        canvasRef.current.width = w;
        canvasRef.current.height = h;
      }
      redraw();
    };
    fit();
    const ro = new ResizeObserver(() => fit());
    ro.observe(stage);
    return () => ro.disconnect();
  }, [rotated]);

  /* ---------- 背景处理缓存 ---------- */
  const runModel = useCallback(async () => {
    if (!rotated || modelBusy) return;
    setModelBusy(true);
    setModelError("");
    setModelProgress(1);
    try {
      const mask = await removeBackgroundWithModel(rotated, setModelProgress);
      setModelMask(mask);
      setModelProgress(100);
    } catch (cause) {
      console.error(cause);
      setModelError("模型下载或处理失败，请检查网络后重试；图片仍可使用其他去背景策略。");
    } finally {
      setModelBusy(false);
    }
  }, [rotated, modelBusy]);

  const clearCachedModel = useCallback(async () => {
    setModelCacheBusy(true);
    setModelError("");
    try {
      await clearModelCache();
      setModelMask(null);
      setModelProgress(0);
    } catch (cause) {
      console.error(cause);
      setModelError("模型缓存清除失败，请稍后重试。");
    } finally {
      setModelCacheBusy(false);
    }
  }, []);

  // 背景蒙版改为 useEffect + Web Worker 计算：
  // 1) 重活不在渲染期执行，避免 useMemo 里做副作用和阻塞 UI
  // 2) 参数变化时丢弃过期结果，脏蒙版不会被展示/导出
  const [algoMask, setAlgoMask] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!rotated || bgStrategy === "model" || bgMode === "original") {
      setAlgoMask(null);
      return;
    }
    if (bgStrategy === "color" && (!sampleColors.length || sampleColors.some((color) => !color))) {
      setAlgoMask(null);
      return;
    }
    const cached = bgMaskCacheRef.current;
    const same =
      cached &&
      cached.source === rotated &&
      cached.strategy === bgStrategy &&
      cached.fuzz === fuzz &&
      JSON.stringify(cached.colors) === JSON.stringify(sampleColors);
    if (same) {
      setAlgoMask(cached.mask);
      return;
    }
    const colors = sampleColors.map(hexToRgb);
    removeBackgroundOffThread(rotated, bgStrategy === "color" ? "color" : "edge", fuzz, colors)
      .then((mask) => {
        if (cancelled) return;
        bgMaskCacheRef.current = { source: rotated, strategy: bgStrategy, fuzz, colors: [...sampleColors], mask };
        setAlgoMask(mask);
      })
      .catch((cause) => {
        if (cancelled) return;
        console.error(cause);
        setError("去背景计算失败，请调低容差或换一张图片重试。");
      });
    return () => {
      cancelled = true;
    };
  }, [rotated, bgMode, bgStrategy, fuzz, sampleColors]);

  const bgMask = bgStrategy === "model" ? modelMask : algoMask;

  const bgApplied = useMemo(() => {
    if (!rotated || bgMode === "original" || !bgMask) return rotated;
    return bgMode === "solid" ? paintBackground(bgMask, bgColor) : bgMask;
  }, [rotated, bgMode, bgMask, bgColor]);

  const previewApplied = useMemo(() => {
    if (format === "jpeg" && bgMode === "remove" && bgMask) return paintBackground(bgMask, "#ffffff");
    return bgApplied;
  }, [format, bgMode, bgMask, bgApplied]);

  /* ---------- 预览绘制 ---------- */
  const redraw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv || !rotated) return;
    const w = cv.width;
    const h = cv.height;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(previewApplied!, 0, 0, previewApplied!.width, previewApplied!.height, 0, 0, w, h);
  }, [rotated, previewApplied]);

  useEffect(() => {
    redraw();
  }, [redraw, disp.w, disp.h]);

  /* ---------- 裁剪框交互(相对 inner,坐标已对齐) ---------- */
  const boxStyle = useMemo(() => {
    const scale = disp.scale || 1;
    // 四值取整,避免亚像素边界导致光标在边带/框体间闪切
    return {
      left: Math.round(activeCrop.x * scale),
      top: Math.round(activeCrop.y * scale),
      width: Math.round(activeCrop.w * scale),
      height: Math.round(activeCrop.h * scale),
    };
  }, [activeCrop, disp]);

  const onBoxDown = (handle: Handle) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      crop: { ...activeCrop },
    };
    setDragging(handle);
  };

  const onStageClick = useCallback((e: React.MouseEvent) => {
    if (samplingIndex === null || !rotated || !innerRef.current) return;
    const rect = innerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(rotated.width - 1, Math.floor((e.clientX - rect.left) / (disp.scale || 1))));
    const y = Math.max(0, Math.min(rotated.height - 1, Math.floor((e.clientY - rect.top) / (disp.scale || 1))));
    const ctx = rotated.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    const pixel = ctx.getImageData(x, y, 1, 1).data;
    const color = `#${[pixel[0], pixel[1], pixel[2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    setSampleColors((items) => items.map((value, index) => index === samplingIndex ? color : value));
    setSamplingIndex(null);
  }, [samplingIndex, rotated, disp.scale]);

  const onBoxKeyDown = (e: React.KeyboardEvent) => {
    if (!rotated || ratio !== "free" || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
    setCrop((previous) => {
      const current = previous ?? { x: 0, y: 0, w: rotated.width, h: rotated.height };
      return {
        ...current,
        x: Math.max(0, Math.min(rotated.width - current.w, current.x + dx)),
        y: Math.max(0, Math.min(rotated.height - current.h, current.y + dy)),
      };
    });
  };

  // 纯几何计算：由拖动起点的快照和当前位移算出下一个裁剪框
  const computeNextCrop = useCallback(
    (c0: CropBox, handle: Handle, dx: number, dy: number): CropBox | null => {
      if (!rotated) return null;
      const W = rotated.width;
      const H = rotated.height;
      const r = ratio === "free" ? 0 : parseFloat(ratio);
      const hasW = handle.includes("w");
      const hasE = handle.includes("e");
      const hasN = handle.includes("n");
      const hasS = handle.includes("s");

      if (handle === "move") {
        return {
          x: Math.max(0, Math.min(c0.x + dx, W - c0.w)),
          y: Math.max(0, Math.min(c0.y + dy, H - c0.h)),
          w: c0.w,
          h: c0.h,
        };
      }

      // 自由比例:每条边独立更新,始终保持锚点与最小尺寸
      if (r === 0) {
        const min = 16;
        const left = hasW ? Math.max(0, Math.min(c0.x + dx, c0.x + c0.w - min)) : c0.x;
        const right = hasE ? Math.min(W, Math.max(c0.x + min, c0.x + c0.w + dx)) : c0.x + c0.w;
        const top = hasN ? Math.max(0, Math.min(c0.y + dy, c0.y + c0.h - min)) : c0.y;
        const bottom = hasS ? Math.min(H, Math.max(c0.y + min, c0.y + c0.h + dy)) : c0.y + c0.h;
        const x = hasW ? left : c0.x;
        const y = hasN ? top : c0.y;
        const w = Math.max(min, (hasE ? right : c0.x + c0.w) - x);
        const h = Math.max(min, (hasS ? bottom : c0.y + c0.h) - y);
        return { x, y, w, h };
      }

      // 固定比例:拖哪侧由哪侧主导,锚定对边
      const anchorX = hasW ? c0.x + c0.w : c0.x;
      const anchorY = hasN ? c0.y + c0.h : c0.y;
      const signedDx = hasW ? -dx : dx;
      const signedDy = hasN ? -dy : dy;
      const horizontal = hasE || hasW;
      const requestedW = c0.w + signedDx;
      const requestedH = c0.h + signedDy;
      const widthFromY = requestedH * r;
      let nw = horizontal ? requestedW : widthFromY;
      if (
        (horizontal && Math.abs(signedDx) < Math.abs(signedDy) * r) ||
        (!horizontal && Math.abs(signedDy) < Math.abs(signedDx) / r)
      ) {
        nw = widthFromY;
      }
      const maxW = hasW ? anchorX : W - anchorX;
      const maxH = hasN ? anchorY : H - anchorY;
      nw = Math.max(16, Math.min(nw, maxW, maxH * r));
      const nh = nw / r;
      return { x: hasW ? anchorX - nw : anchorX, y: hasN ? anchorY - nh : anchorY, w: nw, h: nh };
    },
    [rotated, ratio]
  );

  // pointermove 高频触发：只记录最新指针位置，每帧最多 setCrop 一次
  const dragFrameRef = useRef(0);
  const latestPointerRef = useRef<{ x: number; y: number } | null>(null);

  const flushCrop = useCallback(() => {
    dragFrameRef.current = 0;
    const pointer = latestPointerRef.current;
    const drag = dragState.current;
    if (!pointer || !drag || !dragging) return;
    const scale = disp.scale || 1;
    const next = computeNextCrop(
      drag.crop,
      dragging,
      (pointer.x - drag.startX) / scale,
      (pointer.y - drag.startY) / scale
    );
    if (next) setCrop(next);
  }, [dragging, disp.scale, computeNextCrop]);

  const onBoxMove = (e: React.PointerEvent) => {
    if (!dragging || !dragState.current || !rotated) return;
    latestPointerRef.current = { x: e.clientX, y: e.clientY };
    if (!dragFrameRef.current) {
      dragFrameRef.current = requestAnimationFrame(flushCrop);
    }
  };

  const endDrag = useCallback(() => {
    if (dragFrameRef.current) {
      cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = 0;
    }
    latestPointerRef.current = null;
    setDragging(null);
    dragState.current = null;
  }, []);

  const onBoxUp = () => {
    endDrag();
  };

  const onBoxCancel = () => {
    // 指针被系统取消（如来电、手势抢占）时也要复位拖动状态
    endDrag();
  };

  /* ---------- 光标:JS 距离判定,单一来源(stage 上继承) ---------- */
  const stageHover = useCallback(
    (e: React.PointerEvent) => {
      const stage = stageRef.current;
      if (!stage) return;
      // 触屏等粗糙指针没有稳定悬停，跳过光标距离判定
      if (e.pointerType && e.pointerType !== "mouse" && e.pointerType !== "pen") return;
      if (samplingIndex !== null) {
        stage.style.cursor = "crosshair";
        return;
      }
      const sr = stage.getBoundingClientRect();
      const mx = e.clientX - sr.left;
      const my = e.clientY - sr.top;
      const offX = (sr.width - disp.w) / 2;
      const offY = (sr.height - disp.h) / 2;
      const ix = mx - offX;
      const iy = my - offY;
      const scale = disp.scale || 1;
      const b = activeCrop;
      const bx = b.x * scale;
      const by = b.y * scale;
      const bw = b.w * scale;
      const bh = b.h * scale;
      const bx2 = bx + bw;
      const by2 = by + bh;
      const T = 12; // 边带判定距离
      const C = 16; // 角判定距离
      let cur = "";
      const dCorner = (cx: number, cy: number) => Math.hypot(ix - cx, iy - cy);
      if (dCorner(bx, by) <= C || dCorner(bx2, by2) <= C) cur = "nwse-resize";
      else if (dCorner(bx2, by) <= C || dCorner(bx, by2) <= C) cur = "nesw-resize";
      else if (ix >= bx - T && ix <= bx2 + T && iy >= by - T && iy <= by2 + T) {
        const dl = Math.abs(ix - bx);
        const dr = Math.abs(ix - bx2);
        const dt = Math.abs(iy - by);
        const db = Math.abs(iy - by2);
        const min = Math.min(dl, dr, dt, db);
        if (min <= T) cur = min === dl || min === dr ? "ew-resize" : "ns-resize";
        else cur = "move";
      }
      // 拖动期间固定为所用方向的光标
      if (dragging) {
        cur =
          dragging === "move"
            ? "move"
            : dragging.includes("e") || dragging.includes("w")
            ? "ew-resize"
            : "ns-resize";
      }
      stage.style.cursor = cur;
    },
    [disp, activeCrop, dragging, samplingIndex]
  );

  /* ---------- 导出 ---------- */
  const doExport = useCallback(async () => {
    if (!rotated) return;
    setExporting(true);
    setExportProgress(5);
    setError("");
    setExportInfo("");
    try {
      let cv = bgMode !== "original" ? bgApplied! : rotated;
      const b = activeCrop;
      if (b.w !== rotated.width || b.h !== rotated.height) {
        const out = document.createElement("canvas");
        out.width = Math.max(1, Math.round(b.w));
        out.height = Math.max(1, Math.round(b.h));
        const ctx = out.getContext("2d", { willReadFrequently: true })!;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(cv, b.x, b.y, b.w, b.h, 0, 0, out.width, out.height);
        cv = out;
      }
      const mime = `image/${format}`;
      if (format === "jpeg" && bgMode === "remove") {
        const padded = document.createElement("canvas");
        padded.width = cv.width;
        padded.height = cv.height;
        const pctx = padded.getContext("2d")!;
        pctx.fillStyle = "#ffffff";
        pctx.fillRect(0, 0, padded.width, padded.height);
        pctx.drawImage(cv, 0, 0);
        cv = padded;
      }
      let blob: Blob;
      if (outMode === "quality") {
        setExportProgress(70);
        blob = await canvasToBlob(cv, mime, format === "png" ? undefined : quality / 100);
      } else {
        blob = await compressCanvasToTarget(cv, mime, targetKb * 1024, setExportProgress);
      }
      download(blob, `${baseName(src!.name)}-edit.${extFor(mime)}`);
      const targetNote = outMode === "target" && blob.size > targetKb * 1024 ? " · 未能完全达到目标大小" : "";
      setExportInfo(`已下载 ${fmtSize(blob.size)} · ${cv.width}×${cv.height}${targetNote}`);
    } catch {
      setError("导出失败，请换一种格式或降低图片尺寸后重试。");
    } finally {
      setExporting(false);
      setExportProgress(0);
    }
  }, [rotated, activeCrop, bgMode, bgStrategy, fuzz, sampleColors, bgColor, format, outMode, quality, targetKb, src, bgApplied]);

  /* ---------- 渲染 ---------- */
  if (!src) {
    return (
      <>
        <Header />
        <main className="wrap">
          <TitleBlock />
          <section
            role="button"
            tabIndex={0}
            aria-label="选择图片或拖入图片"
            aria-busy={loading}
            className={"drop" + (dragOver ? " drop-over" : "")}
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                fileRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) loadFile(f);
            }}
          >
            <div className="drop-empty">
              <p className="drop-main">{loading ? "正在读取图片…" : "把图片拖进来,或点一下选择"}</p>
              <span className="muted">支持 PNG / JPG / WebP / GIF(首帧) / BMP / AVIF / TIFF</span>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".png,.jpg,.jpeg,.webp,.gif,.bmp,.avif,.tif,.tiff"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) loadFile(f);
                e.currentTarget.value = "";
              }}
            />
          </section>
          {error && <div className="notice notice-error">{error}</div>}
          <Footer />
        </main>
      </>
    );
  }

  return (
    <>
      <Header />
      <main className="wrap wrap-editor">
        <div className="editor-head">
          <div className="editor-file">
            <img className="editor-thumb" src={src.url} alt="" width={40} height={40} />
            <div>
              <strong>{src.name}</strong>
              <span className="muted">
                {src.w}×{src.h} · {fmtSize(src.bytes)}
              </span>
            </div>
            <span className="editor-file-actions">
              <button className="btn btn-ghost" onClick={() => fileRef.current?.click()}>
                换一张
              </button>
              <button className="btn btn-ghost" onClick={clear}>
                清空
              </button>
            </span>
            <input
              ref={fileRef}
              type="file"
              accept=".png,.jpg,.jpeg,.webp,.gif,.bmp,.avif,.tif,.tiff"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) loadFile(f);
                e.currentTarget.value = "";
              }}
            />
          </div>
          <nav className="modes">
            {(
              [
                ["adjust", "调整"],
                ["bg", "背景"],
                ["export", "输出"],
              ] as [Mode, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                className={"tab" + (mode === id ? " tab-active" : "")}
                onClick={() => setMode(id)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="history-actions" aria-label="编辑历史">
            <button className="btn btn-ghost icon-btn" disabled={!canUndo} onClick={() => restoreHistory(historyIndexRef.current - 1)}>
              <HistoryIcon direction="undo" /> 撤销
            </button>
            <button className="btn btn-ghost icon-btn" disabled={!canRedo} onClick={() => restoreHistory(historyIndexRef.current + 1)}>
              <HistoryIcon direction="redo" /> 恢复
            </button>
          </div>
        </div>

        <div className="editor-grid">
          <section className="stage-wrap">
            <div className={`stage${src.hasTransparency || bgMode === "remove" ? " stage-checker" : ""}`} ref={stageRef} onPointerMove={stageHover} onPointerLeave={() => { if (stageRef.current) stageRef.current.style.cursor = ""; }}>
              <div className={`stage-inner${samplingIndex !== null ? " sampling-active" : ""}`} ref={innerRef} onClick={onStageClick} style={{ width: disp.w, height: disp.h }}>
                <canvas ref={canvasRef} className="stage-canvas" />
                <div className="crop-mask crop-mask-top" style={{ height: boxStyle.top }} />
                <div className="crop-mask crop-mask-bottom" style={{ top: boxStyle.top + boxStyle.height, height: Math.max(0, disp.h - boxStyle.top - boxStyle.height) }} />
                <div className="crop-mask crop-mask-left" style={{ top: boxStyle.top, width: boxStyle.left, height: boxStyle.height }} />
                <div className="crop-mask crop-mask-right" style={{ left: boxStyle.left + boxStyle.width, top: boxStyle.top, width: Math.max(0, disp.w - boxStyle.left - boxStyle.width), height: boxStyle.height }} />
                <div
                  className="cropbox"
                  style={boxStyle as React.CSSProperties}
                  tabIndex={0}
                  aria-label="裁剪框，可用方向键移动"
                  onKeyDown={onBoxKeyDown}
                  onPointerDown={onBoxDown("move")}
                  onPointerMove={onBoxMove}
                  onPointerUp={onBoxUp}
                  onPointerCancel={onBoxCancel}
                >
                  {/* 边带:整条边可按住调整,悬停光标即切换 */}
                  <span className="crop-edge crop-edge-n" onPointerDown={onBoxDown("n")} onPointerMove={onBoxMove} onPointerUp={onBoxUp} onPointerCancel={onBoxCancel} />
                  <span className="crop-edge crop-edge-s" onPointerDown={onBoxDown("s")} onPointerMove={onBoxMove} onPointerUp={onBoxUp} onPointerCancel={onBoxCancel} />
                  <span className="crop-edge crop-edge-e" onPointerDown={onBoxDown("e")} onPointerMove={onBoxMove} onPointerUp={onBoxUp} onPointerCancel={onBoxCancel} />
                  <span className="crop-edge crop-edge-w" onPointerDown={onBoxDown("w")} onPointerMove={onBoxMove} onPointerUp={onBoxUp} onPointerCancel={onBoxCancel} />
                  {/* 四角手柄 */}
                  {(["nw", "ne", "se", "sw"] as Handle[]).map((hd) => (
                    <span
                      key={hd}
                      className={`crop-handle crop-handle-${hd}`}
                      onPointerDown={onBoxDown(hd)}
                      onPointerMove={onBoxMove}
                      onPointerUp={onBoxUp}
                      onPointerCancel={onBoxCancel}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className="stage-hint muted">
              点右侧按钮旋转或翻转 · 拖动手柄调整裁剪 · 选比例后框内保持
            </div>
          </section>

          <aside className="rail">
            {mode === "adjust" && (
              <div className="rail-block">
                <h3>旋转 · 翻转</h3>
                <div className="seg">
                  <button className="seg-btn" onClick={() => rotateBy(-90)}>
                    ↺ 逆时针旋转
                  </button>
                  <button className="seg-btn" onClick={() => rotateBy(90)}>
                    ↻ 顺时针旋转
                  </button>
                </div>
                <div className="seg">
                  <button className="seg-btn" onClick={() => toggleFlip("h")}>
                    水平翻转
                  </button>
                  <button className="seg-btn" onClick={() => toggleFlip("v")}>
                    垂直翻转
                  </button>
                </div>
                <h3>裁剪</h3>
                <label className="field">
                  <span className="field-label">比例(选择后框内固定)</span>
                  <select value={ratio} onChange={(e) => onRatio(e.target.value)}>
                    <option value="free">自由</option>
                    <option value="1">1:1</option>
                    <option value="1.7778">16:9 横</option>
                    <option value="0.5625">9:16 竖</option>
                    <option value="1.3333">4:3</option>
                    <option value="0.75">3:4</option>
                  </select>
                </label>
                <button className="btn btn-ghost" onClick={() => setCrop(null)}>
                  满幅(取消裁剪)
                </button>
              </div>
            )}
            {mode === "bg" && (
              <div className="rail-block">
                <label className="field">
                  <span className="field-label">背景方式</span>
                  <div className="seg">
                    {([['original', '原图'], ['remove', '去背景'], ['solid', '换纯色底']] as const).map(([value, label]) => (
                      <button key={value} className={"seg-btn" + (bgMode === value ? " seg-on" : "")} onClick={() => { setSamplingIndex(null); setBgMode(value); }}>{label}</button>
                    ))}
                  </div>
                </label>
                {bgMode !== "original" && (
                  <>
                    <label className="field">
                      <span className="field-label">去背景策略</span>
                      <select value={bgStrategy} onChange={(e) => { setSamplingIndex(null); setBgStrategy(e.target.value as BgStrategy); }}>
                        <option value="edge">自动去背景（外沿）</option>
                        <option value="color">按颜色去除（全图）</option>
                        <option value="model">本地模型（人像）</option>
                      </select>
                    </label>
                    {bgStrategy === "model" && (
                      <div className="model-card">
                        <strong>{MODEL_LABEL}</strong>
                        <span>{MODEL_SIZE}；{MODEL_RUNTIME_SIZE}。模型会下载到浏览器缓存，图片不会上传。许可证：{MODEL_LICENSE}。</span>
                        <button className="btn btn-ghost" disabled={modelBusy} onClick={runModel}>
                          {modelBusy ? `下载 / 处理 ${modelProgress}%` : modelMask ? "重新处理" : "下载并使用模型"}
                        </button>
                        <button className="btn btn-ghost" disabled={modelBusy || modelCacheBusy} onClick={clearCachedModel}>
                          {modelCacheBusy ? "清除中…" : "清除本地模型"}
                        </button>
                        {modelError && <span className="model-error">{modelError}</span>}
                      </div>
                    )}
                    {bgStrategy === "color" && (
                      <div className="sample-list">
                        <div className="field-label">取样颜色</div>
                        {sampleColors.length === 0 && <div className="sample-empty">尚未取色，请点击“添加颜色”后在图片上选择背景。</div>}
                        {sampleColors.map((color, index) => (
                          <div className="sample-row" key={`${color}-${index}`}>
                            <span className="sample-swatch" style={{ background: color || "#fff", opacity: color ? 1 : 0.35 }} />
                            <code>{color || "尚未取色"}</code>
                            <button className="btn btn-ghost" onClick={() => setSamplingIndex(index)}>{samplingIndex === index ? "请在图片上取色（Esc 取消）" : "取色"}</button>
                            {sampleColors.length > 1 && <button className="btn btn-ghost" onClick={() => setSampleColors((items) => items.filter((_, i) => i !== index))}>移除</button>}
                          </div>
                        ))}
                        {sampleColors.length < 4 && <button className="btn btn-ghost" onClick={() => { setSampleColors((items) => [...items, ""]); setSamplingIndex(sampleColors.length); }}>+ 添加颜色</button>}
                      </div>
                    )}
                    {bgStrategy !== "model" && <label className="field">
                      <span className="field-label">颜色容差 {fuzz}</span>
                      <input
                        type="range"
                        min={5}
                        max={120}
                        value={fuzz}
                        onChange={(e) => setFuzz(+e.target.value)}
                      />
                      <button className="btn btn-ghost" onClick={() => setFuzz(40)}>恢复默认容差</button>
                    </label>}
                    {bgMode === "solid" && (
                      <label className="field">
                        <span className="field-label">底色</span>
                        <input type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value)} />
                      </label>
                    )}
                  </>
                )}
                <p className="rail-note muted">
                  {bgMode === "original" ? "保留原始背景，不生成透明蒙版。" : bgStrategy === "edge" ? "适合纯色或接近纯色、且连接到图片边缘的背景。" : bgStrategy === "color" ? "全图移除相近颜色，主体内部的同色区域也会受到影响。" : "模型在浏览器本地运行，首次使用需要下载模型文件。"}
                </p>
              </div>
            )}
            {mode === "export" && (
              <div className="rail-block">
                <h3>输出</h3>
                <label className="field">
                  <span className="field-label">格式</span>
                  <div className="seg">
                    {(["webp", "jpeg", "png"] as const).map((f) => {
                      const unsupported = f === "webp" && !webpEncodable;
                      return (
                        <button
                          key={f}
                          className={"seg-btn" + (format === f ? " seg-on" : "")}
                          disabled={unsupported}
                          title={unsupported ? "当前浏览器不支持 WebP 编码" : undefined}
                          onClick={() => setFormat(f)}
                        >
                          {f.toUpperCase()}
                        </button>
                      );
                    })}
                  </div>
                </label>
                {!webpEncodable && <p className="rail-note muted">当前浏览器不支持导出 WebP，已切换为 JPEG。</p>}
                <label className="field">
                  <span className="field-label">模式</span>
                  <div className="seg">
                    <button
                      className={"seg-btn" + (outMode === "quality" ? " seg-on" : "")}
                      onClick={() => setOutMode("quality")}
                    >
                      按质量
                    </button>
                    <button
                      className={"seg-btn" + (outMode === "target" ? " seg-on" : "")}
                      onClick={() => setOutMode("target")}
                    >
                      压到目标大小
                    </button>
                  </div>
                </label>
                {outMode === "quality" ? (
                  <label className="field">
                    <span className="field-label">{format === "png" ? "PNG 无损" : `质量 ${quality}%`}</span>
                    <input
                      type="range"
                      min={30}
                      max={100}
                      value={quality}
                      disabled={format === "png"}
                      onChange={(e) => setQuality(+e.target.value)}
                    />
                  </label>
                ) : (
                  <label className="field">
                    <span className="field-label">目标</span>
                    <div className="target-options" role="group" aria-label="目标大小">
                      {([[100, "100 KB"], [500, "500 KB"], [1024, "1 MB"], [2048, "2 MB"], [5120, "5 MB"]] as const).map(([value, label]) => (
                        <button key={value} className={"target-option" + (targetKb === value ? " target-option-on" : "")} onClick={() => setTargetKb(value)}>{label}</button>
                      ))}
                    </div>
                  </label>
                )}
                {format === "png" && outMode === "target" && <p className="rail-note muted">PNG 会通过降低分辨率来接近目标大小。</p>}
                {format === "jpeg" && <p className="rail-note muted">JPEG 不支持透明背景，透明区域会铺白。</p>}
              </div>
            )}
          </aside>
        </div>
        <div className="download-bar">
          <div className="processing-summary">
            <strong>处理摘要</strong>
            <span>{buildSummary({ crop: activeCrop, rotated, bgMode, bgStrategy, format })}</span>
          </div>
          <button className="btn btn-primary download-btn" disabled={exporting} onClick={doExport}>
            {exporting ? `导出中 ${exportProgress}%…` : "下载图片 ↓"}
          </button>
        </div>
        {(error || exportInfo) && <div className={error ? "notice notice-error" : "notice"}>{error || exportInfo}</div>}
        <Footer />
      </main>
    </>
  );
}

/* ---------- 结构组件 ---------- */

function Header() {
  return (
    <header className="topbar">
      <a className="crumb" href="https://tools.red-pandas.com/" target="_blank" rel="noreferrer">
        <img src="./panda-trimmed.png" alt="" width={30} height={20} />
        小熊猫工具盒
      </a>
      <span className="crumb-sep">/</span>
      <strong className="crumb-here">
        <img className="crumb-tail" src="./logo.png" alt="" width={22} height={24} />
        尾巴图片工坊
      </strong>
      <span className="app-version">v{APP_VERSION}</span>
      <span className="topbar-note">纯本地处理,文件不上传</span>
    </header>
  );
}

function TitleBlock() {
  return (
    <div className="title-block">
      <h1>
        尾巴图片工坊 <span className="en">TrimTail</span>
      </h1>
      <p>目前功能:裁剪、压缩、转换格式、背景处理</p>
    </div>
  );
}

function Footer() {
  return <footer className="foot">🐾来自小熊猫工具盒</footer>;
}

function HistoryIcon({ direction }: { direction: "undo" | "redo" }) {
  return (
    <svg className="history-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d={direction === "undo" ? "M7.2 5.1H4.4l2.1-2.2M4.6 5.2a6.2 6.2 0 1 1-.1 6.8" : "M12.8 5.1h2.8l-2.1-2.2M15.4 5.2a6.2 6.2 0 1 0 .1 6.8"} />
    </svg>
  );
}

function buildSummary({ crop, rotated, bgMode, bgStrategy, format }: { crop: CropBox; rotated: HTMLCanvasElement | null; bgMode: "original" | "remove" | "solid"; bgStrategy: BgStrategy; format: string }) {
  if (!rotated) return "原图";
  const parts: string[] = [];
  if (Math.round(crop.w) !== rotated.width || Math.round(crop.h) !== rotated.height) {
    parts.push(`${Math.round(crop.w)}×${Math.round(crop.h)} 裁剪`);
  }
  if (bgMode === "original") parts.push("原图背景");
  const bgLabel = bgStrategy === "edge" ? "外沿去背景" : bgStrategy === "color" ? "按颜色去背景" : "模型去背景";
  if (bgMode === "remove") parts.push(bgLabel);
  if (bgMode === "solid") parts.push(`${bgLabel} · 纯色底`);
  parts.push(format.toUpperCase());
  return parts.join(" · ");
}
