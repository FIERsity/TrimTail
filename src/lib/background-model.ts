let segmenterPromise: Promise<any> | null = null;

export const MODEL_ID = "Xenova/modnet";
export const MODEL_LABEL = "本地模型（MODNet 人像）";
export const MODEL_LICENSE = "Apache-2.0";
export const MODEL_SIZE = "约 23 MB（量化模型）";
export const MODEL_RUNTIME_SIZE = "首次运行还需约 23 MB 浏览器运行组件";

export async function removeBackgroundWithModel(
  input: HTMLCanvasElement,
  onProgress?: (progress: number) => void
): Promise<HTMLCanvasElement> {
  if (!segmenterPromise) {
    segmenterPromise = import("@huggingface/transformers").then(async ({ pipeline, env }) => {
      env.allowRemoteModels = true;
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      return pipeline("background-removal", MODEL_ID, {
        device: typeof navigator !== "undefined" && "gpu" in navigator ? "webgpu" : "wasm",
        dtype: "q4",
        progress_callback: (event: { progress?: number }) => onProgress?.(Math.round(event.progress ?? 0)),
      } as any);
    });
    // 失败时重置缓存的 promise，允许用户点击重试，而不是只能刷新页面
    segmenterPromise.catch(() => {
      segmenterPromise = null;
    });
  }
  const segmenter = await segmenterPromise;
  const result = await segmenter(input);
  return result.toCanvas();
}

export async function clearModelCache(): Promise<number> {
  segmenterPromise = null;
  if (typeof caches === "undefined") return 0;
  const cache = await caches.open("transformers-cache");
  const keys = await cache.keys();
  let removed = 0;
  for (const request of keys) {
    if (await cache.delete(request)) removed++;
  }
  return removed;
}
