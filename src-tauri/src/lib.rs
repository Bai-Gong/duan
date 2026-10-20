// 百工·锻：官方插件 + 转码自研命令（ffprobe 探测 / ffmpeg 定位、抽帧、转码执行与取消）。
// 命令实现见 probe.rs、ffmpeg.rs；转码参数由前端 buildTranscodeArgs 生成，
// 这里只负责执行、按 jobId 发 transcode-progress 进度事件与取消。
mod ffmpeg;
mod probe;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_log::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            probe::probe_media,
            ffmpeg::ffmpeg_info,
            ffmpeg::extract_frame,
            ffmpeg::run_transcode,
            ffmpeg::cancel_transcode,
        ])
        .run(tauri::generate_context!())
        .expect("error while running duan");
}
