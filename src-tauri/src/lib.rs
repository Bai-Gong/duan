// 百工·锻：官方插件 + 转码自研命令（ffprobe 探测 / ffmpeg 定位、抽帧、转码执行与取消）。
// 命令实现见 probe.rs、ffmpeg.rs；转码参数由前端 buildTranscodeArgs 生成，
// 这里只负责执行、按 jobId 发 transcode-progress 进度事件与取消。
// ye_engine.rs 是进程内引擎（M3 接线轨）：与 ffmpeg 子进程路径同事件契约，
// 前端引擎开关二选一（对拍期 ffmpeg 留作 oracle 与回退）。pub 供
// tests/ye_engine_e2e.rs 直接调 ye_convert 做对拍（ffmpeg/probe 两模块
// 无此需求，保持私有）。
mod ffmpeg;
pub mod media_ye;
pub mod preset_ye;
mod probe;
pub mod runtime;
pub mod ye_engine;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_log::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            runtime::media_runtime_info,
            probe::probe_media,
            media_ye::probe_media_ye,
            media_ye::extract_frame_ye,
            preset_ye::check_preset_ye,
            preset_ye::run_preset_ye,
            ffmpeg::ffmpeg_info,
            ffmpeg::extract_frame,
            ffmpeg::run_transcode,
            ffmpeg::cancel_transcode,
            ye_engine::run_transcode_ye,
            ye_engine::cancel_transcode_ye,
        ])
        .run(tauri::generate_context!())
        .expect("error while running duan");
}
