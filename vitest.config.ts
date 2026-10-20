import { defineConfig } from "vitest/config";

// 核心层是纯逻辑（无 DOM），node 环境跑；不引 jsdom。
// 注意：本配置独立于 vite.config.ts（那边是 Tauri/dev server 配置，测试不需要 fang alias）。
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // M0 零测试文件期（首个 *.test.ts 随 M1/M2 核心层落地）：vitest run 零文件默认退出码 1，
    // 会打红 CI web-gate 的 npm test。该选项只影响零文件场景，有测试文件后行为不变。
    passWithNoTests: true,
  },
});
