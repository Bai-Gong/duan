//! 冶专用探测与缩略图入口：不查找、不执行外部工具。
use crate::probe::ProbeResult;
use std::io::BufReader;
use std::path::Path;

pub fn probe_ye(path: &Path) -> Result<ProbeResult, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let header = ye::media::inspect(Box::new(BufReader::new(file))).map_err(|e| e.to_string())?;
    let video = header
        .streams
        .iter()
        .find(|s| s.media_type == ye::codec::MediaType::Video);
    let audio = header
        .streams
        .iter()
        .find(|s| s.media_type == ye::codec::MediaType::Audio);
    let vp = video.and_then(|s| s.codec.video.as_ref());
    let ap = audio.and_then(|s| s.codec.audio.as_ref());
    let duration = header.duration.or_else(|| {
        header
            .streams
            .iter()
            .filter_map(|s| s.duration)
            .max_by(|a, b| a.compare(*b))
    });
    let duration_us = duration
        .map(|t| {
            t.rescale(ye::time::Rational::new(1, 1_000_000))
                .map(|t| t.ticks())
        })
        .transpose()
        .map_err(|e| e.to_string())?
        .unwrap_or(0);
    let fps = vp
        .and_then(|v| v.frame_rate)
        .map(|r| r.to_f64())
        .unwrap_or_else(|| {
            video
                .and_then(|s| s.nb_frames)
                .filter(|_| duration_us > 0)
                .map(|n| n as f64 * 1_000_000.0 / duration_us as f64)
                .unwrap_or(0.0)
        });
    if video.is_none() && audio.is_none() {
        return Err("容器没有音视频流".into());
    }
    Ok(ProbeResult {
        duration_us,
        width: vp.map(|v| v.width).unwrap_or(0),
        height: vp.map(|v| v.height).unwrap_or(0),
        fps,
        has_audio: audio.is_some(),
        kind: if video.is_some() { "video" } else { "audio" }.into(),
        video_codec: video
            .map(|s| format!("{:?}", s.codec.codec).to_lowercase())
            .unwrap_or_default(),
        audio_codec: audio
            .map(|s| format!("{:?}", s.codec.codec).to_lowercase())
            .unwrap_or_default(),
        container: header.format_name,
        sample_rate: ap.map(|p| p.sample_rate).unwrap_or(0),
        channels: ap
            .and_then(|p| p.channel_layout)
            .map(|l| l.channels())
            .unwrap_or(0),
    })
}

#[tauri::command(async)]
pub fn probe_media_ye(path: String) -> Result<ProbeResult, String> {
    probe_ye(Path::new(&path))
}

#[tauri::command(async)]
pub fn extract_frame_ye(path: String, time_us: i64) -> Result<String, String> {
    let input = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let png = ye::frame_grab::grab_frame_png(Box::new(BufReader::new(input)), time_us)
        .map_err(|e| e.to_string())?;
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let filename = std::env::temp_dir().join(format!(
        "duan-frame-{}-{}.png",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&filename)
        .map_err(|e| e.to_string())?;
    use std::io::Write;
    if let Err(e) = file.write_all(&png) {
        drop(file);
        let _ = std::fs::remove_file(&filename);
        return Err(e.to_string());
    }
    Ok(filename.to_string_lossy().into_owned())
}
