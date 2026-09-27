/**
 * asset 协议图片加载失败的自愈机制。
 *
 * 背景：Tauri 运行时的 asset scope 授权不持久化。重启后，画布引用的
 * 外部原图（不在应用 images_dir 内）需要由 App 层的重新授权 effect
 * （ensureAssetPathsAllowed）重新 allow。但节点 <img> 的首次加载可能与该
 * 授权完成产生时序竞态：img 在授权生效前请求 asset URL 得到 403，
 * 且 <img> 加载失败后不会自行重试，导致"重启后变破图"。
 *
 * 方案：在 document 上以捕获阶段监听 img 的 error 事件（一次性覆盖所有
 * 渲染 asset 图片的组件）。对 asset.localhost 的失败图片：
 * 1. 先补一次 ensureAssetPathsAllowed（幂等，失败不阻塞）；
 * 2. 加 cache-buster 查询参数重试一次（asset protocol 只读 path，
 *    查询参数不影响取文件，同时确保 WebView 不复用失败的缓存）。
 * 同一 URL 只重试一次，避免无限循环。
 */

import { ensureAssetPathsAllowed } from "@/services/fileStorageService";

const RETRY_PARAM = "nc-asset-retry";
// 已尝试自愈的 <img> 元素（每个元素只重试一次，防循环）
// 同一 URL 可能被多个 img 元素同时引用，必须按元素去重而不是按 URL
const attempted = new WeakSet<Element>();

/** 从 asset URL 中解出本地文件路径；非 asset 协议 URL 返回 null */
function parseAssetPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (!parsed.hostname.endsWith(".localhost") || parsed.hostname !== "asset.localhost") {
      return null;
    }
    const path = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    // 解码后应像本地绝对路径（C:\... 或 /...），避免误伤
    if (!/^([a-zA-Z]:[\\/]|\/|\\\\)/.test(path)) return null;
    return path;
  } catch {
    return null;
  }
}

export function installAssetImgSelfHeal(): void {
  if (typeof document === "undefined") return;
  document.addEventListener(
    "error",
    (event) => {
      const target = event.target as HTMLImageElement | null;
      if (!target || target.tagName !== "IMG") return;
      const src = target.currentSrc || target.src;
      if (!src || src.includes(`${RETRY_PARAM}=`)) return;

      const path = parseAssetPath(src);
      if (!path) return;
      if (attempted.has(target)) return;
      attempted.add(target);

      void (async () => {
        try {
          await ensureAssetPathsAllowed([path]);
        } catch {
          // 授权失败也照常重试一次：失败图片保持破图即可，不额外处理
        }
        const sep = src.includes("?") ? "&" : "?";
        target.src = `${src}${sep}${RETRY_PARAM}=${Date.now()}`;
      })();
    },
    true
  );
}
