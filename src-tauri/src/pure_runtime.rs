//! Default runtime: no executable lookup or external process entry point.
use serde::Serialize;
const DISABLED: &str = "此构建使用冶；FFmpeg 兼容路径仅限显式 compat-ffmpeg 开发构建";
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegInfo {
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
    pub source: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscodeProgress {
    pub job_id: String,
    pub time_us: i64,
    pub total_us: i64,
}
#[tauri::command]
pub fn ffmpeg_info() -> Result<FfmpegInfo, String> {
    Err(DISABLED.into())
}
#[tauri::command(async)]
pub fn extract_frame(path: String, time_us: i64) -> Result<String, String> {
    let _ = (path, time_us);
    Err(DISABLED.into())
}
#[tauri::command(async)]
pub fn run_transcode(
    app: tauri::AppHandle,
    job_id: String,
    args: Vec<String>,
    out_path: String,
    total_us: i64,
) -> Result<(), String> {
    let _ = (app, job_id, args, out_path, total_us);
    Err(DISABLED.into())
}
#[tauri::command]
pub fn cancel_transcode(job_id: String) -> Result<bool, String> {
    let _ = job_id;
    Ok(false)
}
pub(crate) fn stderr_tail(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .lines()
        .rev()
        .take(12)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n")
}
