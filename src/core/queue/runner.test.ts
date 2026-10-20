/**
 * runner 行为测试：mock invoke 与 listen（不触达 Rust），锁住——
 * - 串行单 worker：前一项落终态后才启动下一项；
 * - 取消与失败的可靠区分：取消后 reject 置 canceled 且忽略 stderr；
 * - 取消后仍收到进度事件不写入（入口防御 + 节流补写防御）；
 * - 进度节流（≥100ms 合并）、空队停转、skip/cancel 门禁、stopQueue 语义。
 *
 * mock 说明：../preset/buildTranscodeArgs 是虚拟 mock（同时隔离其真实实现，
 * runner 测试只关心「调用了它、拿到了 args」）；zustand 用真实安装依赖，
 * 早期无依赖阶段的迷你 create 顶替 mock 已在集成阶段（M0 落依赖）删除。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaInfo } from "../media/probe";
import { BUILTIN_PRESETS } from "../preset/builtin";
import { cancelJob, resetRunnerState, startQueue, stopQueue } from "./runner";
import { useQueueStore } from "./store";
import type { QueueItem } from "./types";

const mocks = vi.hoisted(() => {
  /** listen 注册的 transcode-progress 回调；unlisten 后保留（模拟取消后才到达的迟到事件）。 */
  const progressHandlerRef: { current: ((e: { payload: unknown }) => void) | null } = {
    current: null,
  };
  const invokeMock = vi.fn();
  const listenMock = vi.fn(async (_event: string, handler: (e: { payload: unknown }) => void) => {
    progressHandlerRef.current = handler;
    return () => {};
  });
  // 返回类型显式放宽为判别联合：mockImplementationOnce 要能返回 {ok:false} 分支
  // （vi.fn 会把首次实现的字面量 ok:true 收窄成常量类型，真实 TranscodeArgsResult 是联合）。
  const buildArgsMock = vi.fn(
    (): { ok: true; args: string[] } | { ok: false; error: string } => ({
      ok: true as const,
      args: ["-y", "-progress", "pipe:1", "-nostats", "D:/out/fake.mp4"],
    }),
  );
  return { progressHandlerRef, invokeMock, listenMock, buildArgsMock };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listenMock }));
vi.mock("../preset/buildTranscodeArgs", () => ({ buildTranscodeArgs: mocks.buildArgsMock }));

/** 内置预设即真实数据（builtin.ts 已就位），resolvePreset 一查一个准。 */
const preset = BUILTIN_PRESETS[0];

/**
 * 桩与 core/media/probe.ts 的 MediaInfo 逐字段对齐（完整版不含 path——
 * path 在 QueueItem 上单列，runner 调 buildTranscodeArgs 时合并）。
 */
function makeMediaInfo(durationUs: number): MediaInfo {
  return {
    durationUs,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
    kind: "video",
    videoCodec: "h264",
    audioCodec: "aac",
    container: "mov,mp4,m4a,3gp,3g2,mj2",
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** run_transcode 结果挂钩（FIFO：按 armRun 顺序供循环逐项取用），测试手动 resolve/reject 模拟 ffmpeg 结束。 */
const runQueue: Deferred<null>[] = [];
mocks.invokeMock.mockImplementation((cmd: string) => {
  if (cmd === "run_transcode") {
    const d = runQueue.shift();
    if (!d) return Promise.reject(new Error("测试未挂钩 run_transcode"));
    return d.promise;
  }
  if (cmd === "cancel_transcode") return Promise.resolve(null);
  return Promise.resolve(null);
});

function armRun(): Deferred<null> {
  const d = deferred<null>();
  runQueue.push(d);
  return d;
}

function emitProgress(payload: { jobId: string; timeUs: number; totalUs: number }): void {
  mocks.progressHandlerRef.current?.({ payload });
}

function addItems(n: number): string[] {
  return useQueueStore.getState().add(
    Array.from({ length: n }, (_, k) => ({
      path: `C:/media/素材${k}.mp4`,
      mediaInfo: makeMediaInfo(10_000_000),
      presetId: preset.id,
      presetLabel: preset.name,
      outDir: "D:/out",
      ext: preset.container,
    })),
  );
}

function item(id: string): QueueItem {
  const found = useQueueStore.getState().items.find((i) => i.id === id);
  if (!found) throw new Error(`队列项不存在：${id}`);
  return found;
}

beforeEach(() => {
  resetRunnerState();
  useQueueStore.setState({ items: [], running: false });
  mocks.invokeMock.mockClear();
  mocks.listenMock.mockClear();
  mocks.buildArgsMock.mockClear();
  mocks.progressHandlerRef.current = null;
  runQueue.length = 0;
});

describe("startQueue 串行循环", () => {
  it("逐项串行：前一项落 done 后才启动下一项，循环结束回落 running=false", async () => {
    const ids = addItems(2);
    const d1 = armRun();
    const d2 = armRun();
    const done = startQueue({ resolvePreset: () => preset });

    await vi.waitFor(() => expect(item(ids[0]).status).toBe("running"));
    expect(item(ids[1]).status).toBe("waiting");
    d1.resolve(null);
    await vi.waitFor(() => expect(item(ids[0]).status).toBe("done"));
    await vi.waitFor(() => expect(item(ids[1]).status).toBe("running"));
    d2.resolve(null);
    await done;

    expect(item(ids[1]).status).toBe("done");
    expect(useQueueStore.getState().running).toBe(false);
    const runCalls = mocks.invokeMock.mock.calls.filter(([cmd]) => cmd === "run_transcode");
    expect(runCalls.map(([, args]) => (args as { jobId: string }).jobId)).toEqual(ids);
    expect(mocks.buildArgsMock).toHaveBeenCalledTimes(2);
  });

  it("空队停转：无项时不 invoke，running 立即回落", async () => {
    await startQueue({ resolvePreset: () => preset });
    expect(mocks.invokeMock).not.toHaveBeenCalled();
    expect(useQueueStore.getState().running).toBe(false);
  });

  it("run_transcode 传参对齐契约：jobId/args/outPath/totalUs", async () => {
    const [id] = addItems(1);
    const d = armRun();
    const done = startQueue({ resolvePreset: () => preset });
    await vi.waitFor(() => expect(item(id).status).toBe("running"));
    d.resolve(null);
    await done;

    expect(mocks.invokeMock).toHaveBeenCalledWith("run_transcode", {
      jobId: id,
      args: ["-y", "-progress", "pipe:1", "-nostats", "D:/out/fake.mp4"],
      outPath: item(id).outPath,
      totalUs: 10_000_000,
    });
  });

  it("run_transcode 失败落 failed，error=reject 消息（stderr 尾部）", async () => {
    const [id] = addItems(1);
    const d = armRun();
    const done = startQueue({ resolvePreset: () => preset });
    await vi.waitFor(() => expect(item(id).status).toBe("running"));
    d.reject(new Error("ffmpeg 导出失败（退出码 Some(1)）: …stderr 尾部…"));
    await done;

    expect(item(id).status).toBe("failed");
    expect(item(id).error).toContain("stderr 尾部");
  });

  it("预设查不到落 failed，循环不中断", async () => {
    addItems(1);
    const done = startQueue({ resolvePreset: () => undefined });
    await done;
    const failed = useQueueStore.getState().items[0];
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("预设不存在");
  });

  it("翻译被拒（图片素材/非法预设形状）落 failed，不 invoke run_transcode", async () => {
    addItems(1);
    mocks.buildArgsMock.mockImplementationOnce(() => ({
      ok: false as const,
      error: "图片素材不在 MVP 转码范围：C:/media/素材0.mp4",
    }));
    const done = startQueue({ resolvePreset: () => preset });
    await done;
    const failed = useQueueStore.getState().items[0];
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("图片素材");
    expect(mocks.invokeMock).not.toHaveBeenCalled();
  });
});

describe("取消链路", () => {
  it("取消后 reject 置 canceled 且忽略 stderr（不落 error）", async () => {
    const [id] = addItems(1);
    const d = armRun();
    const done = startQueue({ resolvePreset: () => preset });
    await vi.waitFor(() => expect(item(id).status).toBe("running"));

    cancelJob(id);
    expect(mocks.invokeMock).toHaveBeenCalledWith("cancel_transcode", { jobId: id });
    // kill 后非零退出的 reject：与真失败同一条 Err 通道，靠标记区分
    d.reject(new Error("ffmpeg 导出失败（退出码 Some(1)）: …stderr…"));
    await done;

    expect(item(id).status).toBe("canceled");
    expect(item(id).error).toBeUndefined();
  });

  it("取消后仍收到进度事件不写入（入口与节流补写双重防御）", async () => {
    const [id] = addItems(1);
    const d = armRun();
    const done = startQueue({ resolvePreset: () => preset });
    await vi.waitFor(() => expect(item(id).status).toBe("running"));

    // 首事件在节流窗口外，立即落库
    emitProgress({ jobId: id, timeUs: 1_000_000, totalUs: 10_000_000 });
    expect(item(id).progressUs).toBe(1_000_000);
    // 第二事件进缓冲，约 100ms 后补写——在此之前取消已落定
    emitProgress({ jobId: id, timeUs: 2_000_000, totalUs: 10_000_000 });
    cancelJob(id);
    d.reject(new Error("killed"));
    await done;
    expect(item(id).status).toBe("canceled");
    // unlisten 后的迟到事件（防御口径：不写回任何状态）
    emitProgress({ jobId: id, timeUs: 3_000_000, totalUs: 10_000_000 });

    await new Promise((r) => setTimeout(r, 160)); // 越过节流窗口，确认补写路径也拒收
    expect(item(id).progressUs).toBe(1_000_000);
  });

  it("waiting 项取消直接落 canceled，不走 cancel_transcode", async () => {
    const [id] = addItems(1);
    cancelJob(id);
    expect(item(id).status).toBe("canceled");
    expect(mocks.invokeMock).not.toHaveBeenCalled();
  });

  it("stopQueue：当前项取消、剩余 waiting 保留、循环退出", async () => {
    const ids = addItems(2);
    const d1 = armRun();
    const done = startQueue({ resolvePreset: () => preset });
    await vi.waitFor(() => expect(item(ids[0]).status).toBe("running"));

    stopQueue();
    d1.reject(new Error("killed"));
    await done;

    expect(item(ids[0]).status).toBe("canceled");
    expect(item(ids[1]).status).toBe("waiting");
    expect(useQueueStore.getState().running).toBe(false);
    // 停止后不再取下一项：全程只跑过第一项
    expect(mocks.invokeMock.mock.calls.filter(([cmd]) => cmd === "run_transcode")).toHaveLength(1);
  });
});

describe("进度路由与节流", () => {
  it("按 jobId 路由：非当前项/未知 jobId 的事件拒收", async () => {
    const ids = addItems(2);
    const d = armRun();
    const done = startQueue({ resolvePreset: () => preset });
    await vi.waitFor(() => expect(item(ids[0]).status).toBe("running"));

    emitProgress({ jobId: ids[1], timeUs: 5_000_000, totalUs: 10_000_000 }); // waiting 项
    emitProgress({ jobId: "unknown-job", timeUs: 5_000_000, totalUs: 10_000_000 }); // 未知项
    expect(item(ids[1]).progressUs).toBe(0);

    d.resolve(null);
    await done;
  });

  it("节流：100ms 内多次事件合并为最后一次", async () => {
    const [id] = addItems(1);
    const d = armRun();
    const done = startQueue({ resolvePreset: () => preset });
    await vi.waitFor(() => expect(item(id).status).toBe("running"));

    emitProgress({ jobId: id, timeUs: 1_000_000, totalUs: 10_000_000 });
    emitProgress({ jobId: id, timeUs: 2_000_000, totalUs: 10_000_000 }); // 窗口内→缓冲
    expect(item(id).progressUs).toBe(1_000_000); // 未越窗不落库
    await vi.waitFor(() => expect(item(id).progressUs).toBe(2_000_000)); // 补写

    d.resolve(null);
    await done;
    expect(item(id).status).toBe("done");
  });
});

describe("skip 门禁", () => {
  it("skip 仅对 waiting：队首跳过后直接跑下一项；running 项 skip 是 no-op", async () => {
    const ids = addItems(2);
    useQueueStore.getState().skip(ids[0]); // 队首跳过
    const d = armRun();
    const done = startQueue({ resolvePreset: () => preset });

    await vi.waitFor(() => expect(item(ids[1]).status).toBe("running"));
    expect(item(ids[0]).status).toBe("skipped");

    useQueueStore.getState().skip(ids[1]); // running → no-op
    expect(item(ids[1]).status).toBe("running");

    d.resolve(null);
    await done;
    expect(mocks.buildArgsMock).toHaveBeenCalledTimes(1); // 跳过项不生成 args
  });
});
