# 百工·锻 (Duan)

媒体编码/转码工具，对标 Adobe Media Encoder。

技术栈：Tauri + React。

## 当前联动基线

默认运行时使用冶，正式安装包不携带 FFmpeg/ffprobe，也不查找外部工具。支持经验证的 MP4/M4A、H.264 progressive 8-bit 4:2:0 与 AAC-LC 单/双声道。视频输出支持有理数帧率，音频支持44.1/48kHz重采样；预设由 Rust 对实际容器和码流再次检查，不按扩展名放行。不支持的旧预设保留并标记暂不可执行，旧引擎偏好迁移时留档，不改写预设参数。

日常门禁：`npm ci`、`npm run build`、`npm test`、`cargo test --manifest-path src-tauri/Cargo.toml --locked`。测试需要外部 FFmpeg 生成参考素材；它只属于开发/CI环境。`pure_runtime` 集成测试生成素材后启动清空 PATH 的子进程，验收纯冶探测、缩略图与十项成功/拒绝/失败/取消及输出保护场景。

Windows 打包：`npm run package:windows`。显式开发兼容构建：`npm run dev:compat`；默认 feature 为空。冶固定至 Cargo.toml 的已推送 rev，Cargo.lock 与之一起提交。坊由父仓库固定指针，CI钉同一提交。

本轮代码验收不等于干净 Windows 安装验收；未完成的安装环境和人工预览检查见父仓库联动施工记录。不自动推送 qa/main。

产品分析见 [docs/产品分析.md](docs/产品分析.md)。

属于「百工」项目集群，约定参见上级目录 [AGENTS.md](../AGENTS.md)。
