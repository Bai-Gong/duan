/**
 * 队列项代表帧：Rust 侧 extract_frame 抽帧到临时 png，再转 asset URL 给 <img>。
 * 按 (path, timeUs) 缓存——同一源文件同一时刻反复渲染不重复抽帧；
 * 缓存存 Promise 而非结果，并发请求共享同一次抽帧；失败不缓存（下次重试）。
 * 模板 jian/core/media/thumbnail.ts:19-32，签名按锻契约改为 (path, timeUs) 直传
 * （锻无工程素材池，调用方 EncodingPanel/PreviewMonitor 持有队列项的源路径）。
 * 分层纪律「Rust 命令只被 core 调」：invoke 不出 core 层。
 */
import { invoke } from "@tauri-apps/api/core";
import { assetUrl } from "./assetUrl";

const cache = new Map<string, Promise<string>>();

/** 取某源文件指定时刻（微秒，缺省首帧）的代表帧 URL。抽帧失败时抛错（调用方按占位图处理）。 */
export function getFrameUrl(path: string, timeUs = 0): Promise<string> {
  const key = `${path}@${timeUs}`;
  const hit = cache.get(key);
  if (hit) return hit;
  // extract_frame 返回临时 png 的绝对路径，转成 <img> 可用的 asset URL
  const job = invoke<string>("extract_frame_ye", { path, timeUs }).then(assetUrl);
  cache.set(key, job);
  job.catch(() => cache.delete(key)); // 失败不占缓存位
  return job;
}

/** 严格冶代表帧，供纯冶接线与验收使用。 */
export async function getFrameUrlYe(path: string,timeUs=0): Promise<string> { return assetUrl(await invoke<string>("extract_frame_ye",{path,timeUs})); }
