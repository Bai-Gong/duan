// 百工·锻：官方插件注册。转码自研命令（ffprobe 探测 / ffmpeg 定位与执行、进度事件）
// 随队列引擎落地时再加入 invoke_handler，底座参照剪仓库的 ffmpeg.rs / probe.rs。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_log::Builder::new().build())
        .run(tauri::generate_context!())
        .expect("error while running duan");
}
