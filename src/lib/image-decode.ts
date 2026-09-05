export function detectHeic(file: File): boolean {
  const type = (file.type || "").toLowerCase();
  if (type === "image/heic" || type === "image/heif") return true;
  return /\.(heic|heif)$/i.test(file.name || "");
}

/** 探测当前浏览器的图片解码能力；探测结果随会话缓存 */
const decodeSupport = new Map<string, Promise<boolean>>();

export function canDecode(mime: string): Promise<boolean> {
  const cached = decodeSupport.get(mime);
  if (cached) return cached;
  const probe = (async () => {
    try {
      const imageDecode = (window as unknown as { ImageDecode?: { isTypeSupported?: (t: string) => Promise<boolean> } }).ImageDecode;
      return (await imageDecode?.isTypeSupported?.(mime)) === true;
    } catch {
      return false;
    }
  })();
  decodeSupport.set(mime, probe);
  return probe;
}

/** 探测 toDataURL 编码能力（决定导出格式是否可用） */
const encodeSupport = new Map<string, boolean>();

export function canEncode(mime: string): boolean {
  const cached = encodeSupport.get(mime);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    const cv = document.createElement("canvas");
    cv.width = 1;
    cv.height = 1;
    ok = cv.toDataURL(mime).startsWith("data:" + mime);
  } catch {
    ok = false;
  }
  encodeSupport.set(mime, ok);
  return ok;
}
