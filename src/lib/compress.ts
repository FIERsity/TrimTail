/**
 * 压缩到目标大小：实现已迁移到 image-worker-client（优先 Web Worker，主线程降级）。
 * 本文件仅保留对外 re-export，保持既有 import 路径不变。
 */
export { compressCanvasToTarget } from "./image-worker-client";
