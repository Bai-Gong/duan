//! Preset translation and actual-stream capability checks live in the backend.
use crate::ye_engine::{CANCEL_FLAGS, YeSpec, ye_convert_with_options};
use serde::Deserialize;
use std::{
    fs::File,
    io::BufReader,
    path::Path,
    sync::{Arc, atomic::AtomicBool},
};
use tauri::Emitter;
use ye::{
    codec::MediaType,
    convert::{AudioEncodeSettings, AudioOutput, ConvertOptions},
    time::Rational,
};

#[derive(Debug, Clone, Deserialize)]
pub struct PresetArg {
    pub container: String,
    pub video: Option<VideoArg>,
    pub audio: Option<AudioArg>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoArg {
    pub codec: String,
    pub rate: RateArg,
    pub max_height: serde_json::Value,
    pub fps: Option<f64>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum RateArg {
    Crf {
        crf: u8,
    },
    Bitrate {
        #[serde(rename = "bitrateKbps")]
        bitrate_kbps: u32,
    },
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioArg {
    pub codec: String,
    pub bitrate_kbps: u32,
    pub sample_rate: u32,
}

pub fn preset_issues(preset: &PresetArg) -> Vec<String> {
    let mut issues = Vec::new();
    if preset.container != "mp4" {
        issues.push(format!(
            "暂不支持输出 {}，请选择 MP4 预设",
            preset.container
        ));
    }
    if preset.video.is_none() && preset.audio.is_none() {
        issues.push("预设没有输出轨道".into());
    }
    if let Some(video) = &preset.video {
        if video.codec != "libx264" {
            issues.push(format!("暂不支持视频编码器 {}", video.codec));
        }
        match video.rate {
            RateArg::Crf { crf } if !(1..=51).contains(&crf) => issues.push("CRF 须在1..51".into()),
            RateArg::Bitrate { bitrate_kbps } if bitrate_kbps == 0 || bitrate_kbps > 4_000_000 => {
                issues.push("视频码率无效".into())
            }
            _ => {}
        }
        if video
            .fps
            .is_some_and(|fps| !fps.is_finite() || fps <= 0.0 || fps > 240.0)
        {
            issues.push("目标帧率须大于0且不超过240".into());
        }
        if video.max_height.as_str() != Some("source")
            && !video
                .max_height
                .as_u64()
                .is_some_and(|h| h > 0 && h <= 8192 && h % 2 == 0)
        {
            issues.push("最大高度须为 source 或正偶数".into());
        }
    }
    if let Some(audio) = &preset.audio {
        if audio.codec != "aac" {
            issues.push(format!("暂不支持音频编码器 {}", audio.codec));
        }
        if ![44100, 48000].contains(&audio.sample_rate) {
            issues.push("采样率须为44.1/48kHz".into());
        }
        if audio.bitrate_kbps == 0 || audio.bitrate_kbps > 4_000_000 {
            issues.push("音频码率无效".into());
        }
    }
    issues
}

pub fn prepare(input: &Path, preset: &PresetArg) -> Result<(YeSpec, ConvertOptions), Vec<String>> {
    let mut issues = preset_issues(preset);
    let header = File::open(input)
        .map_err(|e| e.to_string())
        .and_then(|f| ye::media::inspect(Box::new(BufReader::new(f))).map_err(|e| e.to_string()));
    let header = match header {
        Ok(h) => h,
        Err(e) => {
            issues.push(e);
            return Err(issues);
        }
    };
    let mut codecs = ye::codec::CodecRegistry::new();
    ye::codec_h264::register_h264(&mut codecs);
    ye::codec_aac::register_aac(&mut codecs);
    let video = header
        .streams
        .iter()
        .find(|s| s.media_type == MediaType::Video);
    let audio = header
        .streams
        .iter()
        .find(|s| s.media_type == MediaType::Audio);
    let wants_video = preset.video.is_some();
    let wants_audio = preset.audio.is_some() && audio.is_some();
    if !wants_video && audio.is_none() {
        issues.push("纯音频预设要求源素材带音轨".into());
    }
    let mut size = None;
    let mut crf = 23;
    let mut bitrate = None;
    let mut fps = None;
    if let Some(v) = &preset.video {
        match v.rate {
            RateArg::Crf { crf: value } => crf = value,
            RateArg::Bitrate { bitrate_kbps } => bitrate = Some(u64::from(bitrate_kbps) * 1000),
        }
        if let Some(stream) = video {
            if let Some(params) = &stream.codec.video {
                if let Some(h) = v
                    .max_height
                    .as_u64()
                    .filter(|h| *h < u64::from(params.height))
                {
                    let w = (u64::from(params.width) * h + u64::from(params.height) / 2)
                        / u64::from(params.height);
                    let w = w + w % 2;
                    size = Some((w as u32, h as u32));
                }
                fps = params.frame_rate;
            }
            if fps.is_none()
                && let (Some(n), Some(d)) = (stream.nb_frames, stream.duration)
            {
                // Integer duration clock; gcd keeps long inputs inside Rational's i32 domain.
                let mut num = u128::from(n) * stream.time_base.den() as u128;
                let mut den = d.ticks().max(0) as u128 * stream.time_base.num() as u128;
                let (mut a, mut b) = (num, den);
                while b != 0 {
                    (a, b) = (b, a % b);
                }
                if let (Some(reduced_num), Some(reduced_den)) =
                    (num.checked_div(a), den.checked_div(a))
                {
                    num = reduced_num;
                    den = reduced_den;
                }
                if num <= i32::MAX as u128 && den > 0 && den <= i32::MAX as u128 {
                    fps = Some(Rational::new(num as i32, den as i32));
                }
            }
            if let Some(target) = v.fps.filter(|f| f.is_finite() && *f > 0.0 && *f <= 240.0) {
                fps = Rational::from_f64(target, 1_000_000).ok();
            }
            if fps.is_none() {
                issues.push("无法确定源帧率，请指定目标帧率".into());
            }
        }
    }
    let mut audio_output = None;
    let audio_mode = if let Some(a) = preset.audio.as_ref().filter(|_| wants_audio) {
        if let Some(params) = audio.and_then(|s| s.codec.audio.as_ref()) {
            let channels = params.channel_layout.map_or(0, |l| l.channels());
            for stream in header
                .streams
                .iter()
                .filter(|s| s.media_type == MediaType::Audio)
            {
                if let Some(params) = &stream.codec.audio {
                    if ![44100, 48000].contains(&params.sample_rate) {
                        issues.push(format!("音轨 {} 须为44.1/48kHz", stream.index));
                    }
                    if params.channel_layout.map_or(0, |l| l.channels()) != channels {
                        issues.push("多音轨声道布局不同，当前预设暂不能保持各轨布局".into());
                    }
                }
            }
            if !(1..=2).contains(&channels) {
                issues.push("源音频须为单/双声道".into());
            }
            audio_output = Some(AudioOutput {
                sample_rate: a.sample_rate,
                channels: channels as u8,
            });
        }
        AudioEncodeSettings::Aac {
            bitrate_bps: a.bitrate_kbps.saturating_mul(1000),
        }
    } else {
        AudioEncodeSettings::Drop
    };
    if !issues.is_empty() {
        return Err(issues);
    }
    let spec = YeSpec {
        size,
        crf,
        video_bitrate_bps: bitrate,
        strip_video: !wants_video,
        audio: audio_mode,
    };
    let options = ConvertOptions {
        frame_rate: fps,
        audio_output,
    };
    ye::codec_h264::register_h264_encoder(&mut codecs);
    ye::codec_aac::register_aac_encoder(&mut codecs);
    issues.extend(
        ye::convert::check_convert(
            &header,
            &codecs,
            spec.video_settings().as_ref(),
            &spec.audio,
            &options,
        )
        .into_iter()
        .map(|e| e.to_string()),
    );
    if !issues.is_empty() {
        return Err(issues);
    }
    Ok((spec, options))
}

#[tauri::command(async)]
pub fn check_preset_ye(preset: PresetArg, input_path: Option<String>) -> Vec<String> {
    input_path.map_or_else(
        || preset_issues(&preset),
        |path| prepare(Path::new(&path), &preset).err().unwrap_or_default(),
    )
}
pub fn transcode_preset(
    input: &Path,
    output: &Path,
    preset: &PresetArg,
    cancel: &AtomicBool,
    progress: &dyn Fn(i64, i64),
) -> Result<ye::convert::ConvertStats, String> {
    let (spec, options) = prepare(input, preset).map_err(|e| e.join("\n"))?;
    if let Some(parent) = output.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    ye_convert_with_options(input, output, &spec, &options, cancel, progress)
}
#[tauri::command(async)]
pub fn run_preset_ye(
    app: tauri::AppHandle,
    job_id: String,
    input_path: String,
    out_path: String,
    preset: PresetArg,
) -> Result<(), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut flags = CANCEL_FLAGS.lock().map_err(|_| "取消表锁失败")?;
        if flags.contains_key(&job_id) {
            return Err("任务已在执行".into());
        }
        flags.insert(job_id.clone(), cancel.clone());
    }
    let result = transcode_preset(
        Path::new(&input_path),
        Path::new(&out_path),
        &preset,
        &cancel,
        &|time_us, total_us| {
            let _ = app.emit(
                "transcode-progress",
                crate::ffmpeg::TranscodeProgress {
                    job_id: job_id.clone(),
                    time_us,
                    total_us,
                },
            );
        },
    );
    let mut flags = CANCEL_FLAGS.lock().map_err(|_| "取消表锁失败")?;
    if flags.get(&job_id).is_some_and(|c| Arc::ptr_eq(c, &cancel)) {
        flags.remove(&job_id);
    }
    result.map(|_| ())
}
