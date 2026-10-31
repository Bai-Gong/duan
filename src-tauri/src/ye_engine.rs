//! ye 进程内转码引擎（M3 接线轨 + M3 补齐）：门面 [`ye::convert::convert`]
//! 的命令封装。
//!
//! 与 ffmpeg.rs 的子进程路径构成「引擎二选一」（对拍期 ffmpeg 留作 oracle 与
//! 回退，见上级 AGENTS.md 接入方式）：同一条 transcode-progress 事件契约
//! （`{jobId, timeUs, totalUs}`，前端 runner 按 jobId 路由），取消从
//! 「kill 子进程」换成「AtomicBool 置位」（ye 泵每输出包检查点检出即返回
//! `Cancelled`）。
//!
//! 命令层只做参数校验/事件桥/取消表；转码主体在 [`ye_convert`]（纯库调用，
//! 不碰 Tauri 类型）——`tests/ye_engine_e2e.rs` 的对拍测试直接调它。
//!
//! 能力面（ye M3 补齐后）：输入 MP4 系的 H.264（视频轨）+ AAC（音频轨），
//! 视频重编码 H.264 Baseline（CRF 质量模式，或目标码率的 A-VBR 封顶——
//! 真码控），音频 AAC-LC 重编码（目标码率）或直通，支持剥视频（纯音频
//! 输出）/剥音轨，输出 MP4。改帧率/非 H.264 视频源/非 AAC 音频源/改采样率
//! 由前端翻译层（buildYeTranscodeParams）提前拒绝，这里只兜参数形状。

use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use tauri::Emitter;

use crate::ffmpeg::TranscodeProgress;

/// 取消标记表：jobId → 运行中转码的取消旗标（与 ffmpeg.rs 的 KILL 表同构，
/// 只是「句柄」从子进程换成布尔）。run_transcode_ye 登记本地 Arc、收尾摘除。
static CANCEL_FLAGS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 码率上限（kbps）：命令入参的形状校验用（4 Gbps——远超现实转码需求，
/// 挡住溢出/单位填错的病态值）。
const MAX_KBPS: u32 = 4_000_000;

/// ye 转码参数（M3 补齐）：视频质量/码率 + 音频三态 + 剥轨。
///
/// 由命令层 [`parse_ye_options`] 校验组装，[`ye_convert`] 消费。
#[derive(Debug, Clone)]
pub struct YeSpec {
    /// 目标尺寸（`None` = 保持原尺寸；剥视频时不得给出）。
    pub size: Option<(u32, u32)>,
    /// 基准 CRF（1..=51）：纯质量模式即目标质量；码率模式作 A-VBR 基准。
    pub crf: u8,
    /// 视频目标码率（bit/s；`None` = 纯质量模式）。
    pub video_bitrate_bps: Option<u64>,
    /// 剥视频（纯音频输出，对标 `-vn`）。
    pub strip_video: bool,
    /// 音频三态：直通 / AAC-LC 重编码（目标码率）/ 剥轨（对标 `-an`）。
    pub audio: ye::convert::AudioEncodeSettings,
}

/// 命令入参校验：尺寸（两轴同给或同缺）、CRF 值域、码率值域与剥轨互斥。
fn parse_ye_options(
    width: Option<u32>,
    height: Option<u32>,
    crf: Option<u8>,
    video_bitrate_kbps: Option<u32>,
    audio_bitrate_kbps: Option<u32>,
    strip_video: bool,
    strip_audio: bool,
) -> Result<YeSpec, String> {
    let size = match (width, height) {
        (Some(w), Some(h)) => {
            if w == 0 || h == 0 || w % 2 != 0 || h % 2 != 0 {
                return Err(format!(
                    "目标尺寸须为正偶数，收到 {w}x{h}（H.264 4:2:0 要求）"
                ));
            }
            Some((w, h))
        }
        (None, None) => None,
        _ => return Err("目标尺寸宽高须同时给出（或同时缺省保持原尺寸）".to_string()),
    };
    let crf = crf.ok_or("缺少 CRF 质量参数（1..=51）")?;
    if !(1..=51).contains(&crf) {
        return Err(format!("CRF 须在 1..=51，收到 {crf}"));
    }
    let check_kbps = |kbps: Option<u32>, name: &str| -> Result<(), String> {
        if let Some(kbps) = kbps
            && (kbps == 0 || kbps > MAX_KBPS)
        {
            return Err(format!("{name} 须在 1..={MAX_KBPS} kbps，收到 {kbps}"));
        }
        Ok(())
    };
    check_kbps(video_bitrate_kbps, "视频码率")?;
    check_kbps(audio_bitrate_kbps, "音频码率")?;
    if strip_video && size.is_some() {
        return Err("剥视频（纯音频输出）时不得给目标尺寸".to_string());
    }
    if strip_audio && audio_bitrate_kbps.is_some() {
        return Err("剥音轨与音频重编码码率互斥（二选一）".to_string());
    }
    if strip_video && strip_audio {
        return Err("剥视频+剥音轨＝空输出（拒绝）".to_string());
    }
    let audio = if strip_audio {
        ye::convert::AudioEncodeSettings::Drop
    } else {
        match audio_bitrate_kbps {
            Some(kbps) => ye::convert::AudioEncodeSettings::Aac {
                bitrate_bps: kbps * 1_000,
            },
            None => ye::convert::AudioEncodeSettings::Copy,
        }
    };
    Ok(YeSpec {
        size,
        crf,
        video_bitrate_bps: video_bitrate_kbps_to_bps(video_bitrate_kbps),
        strip_video,
        audio,
    })
}

/// 视频码率 kbps → bit/s（u64 域，挡 u32 溢出）。
fn video_bitrate_kbps_to_bps(kbps: Option<u32>) -> Option<u64> {
    kbps.map(u64::from).map(|v| v * 1_000)
}

/// 转码主体（纯库调用）：注册表组装 → 门面泵 → 统计；失败即删半成品
/// （ye 泵不持有路径概念，输出文件清理归调用方——ye-cli 同款约定）。
///
/// 进度回调 `(processed_us, total_us)` 由泵逐输出包上报；total_us 取自
/// 流时长，缺时长时为 0，由调用方决定兜底。
pub fn ye_convert(
    input: &Path,
    output: &Path,
    spec: &YeSpec,
    cancel: &AtomicBool,
    progress: &dyn Fn(i64, i64),
) -> Result<ye::convert::ConvertStats, String> {
    let ctx = || format!("{} → {}", input.display(), output.display());
    let result = run_ye_convert(input, output, spec, cancel, progress);

    result.map_err(|e| format!("{}: {e}", ctx()))
}

fn run_ye_convert(
    input: &Path,
    output: &Path,
    spec: &YeSpec,
    cancel: &AtomicBool,
    progress: &dyn Fn(i64, i64),
) -> Result<ye::convert::ConvertStats, String> {
    let in_file = File::open(input).map_err(|e| format!("{}: {e}", input.display()))?;
    let transaction = ye::output::OutputTransaction::new(output)
        .map_err(|e| format!("{}: {e}", output.display()))?;
    let out_file = transaction.writer().map_err(|e| e.to_string())?;

    // 注册表显式构造（与 ye-cli 同款）：MP4 容器 + H.264/AAC 解码编码
    // 真工厂（音频直通路径用不到 AAC，重编码路径需要）。
    let mut containers = ye::container::ContainerRegistry::new();
    ye::container::mp4::register_mp4(&mut containers);
    let mut codecs = ye::codec::CodecRegistry::new();
    ye::codec_h264::register_h264(&mut codecs);
    ye::codec_h264::register_h264_encoder(&mut codecs);
    ye::codec_aac::register_aac(&mut codecs);
    ye::codec_aac::register_aac_encoder(&mut codecs);

    let settings = ye::convert::VideoEncodeSettings {
        chain: ye::convert::VideoChain {
            format: None,
            size: spec.size,
        },
        gop: 250,
        quality: ye::codec::QualityMode::Crf(spec.crf),
        bit_rate: spec.video_bitrate_bps,
    };
    let video = if spec.strip_video {
        None
    } else {
        Some(&settings)
    };
    let stats = ye::convert::convert(
        &containers,
        &codecs,
        Box::new(BufReader::new(in_file)),
        "mp4",
        Box::new(out_file),
        video,
        &spec.audio,
        ye::convert::filter_ops(),
        progress,
        cancel,
    )
    .map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(stats)
}

/// 跑转码（ye 引擎）：与 ffmpeg.rs 的 run_transcode 同一事件契约与取消语义。
///
/// 取消（cancel_transcode_ye 置位）后泵返回 `Cancelled` 错误，本函数照常走
/// Err 分支——「用户取消」与「真失败」的区分同样由前端 runner 打标记判断，
/// Rust 不猜（与 ffmpeg 路径口径一致）。
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn run_transcode_ye(
    app: tauri::AppHandle,
    job_id: String,
    input_path: String,
    out_path: String,
    width: Option<u32>,
    height: Option<u32>,
    crf: Option<u8>,
    video_bitrate_kbps: Option<u32>,
    audio_bitrate_kbps: Option<u32>,
    strip_video: bool,
    strip_audio: bool,
    total_us: i64,
) -> Result<(), String> {
    let spec = parse_ye_options(
        width,
        height,
        crf,
        video_bitrate_kbps,
        audio_bitrate_kbps,
        strip_video,
        strip_audio,
    )?;
    if let Some(parent) = Path::new(&out_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建输出目录失败（{}）: {e}", parent.display()))?;
    }

    let cancel = Arc::new(AtomicBool::new(false));
    CANCEL_FLAGS
        .lock()
        .map_err(|_| "取消标记表锁已中毒".to_string())?
        .insert(job_id.clone(), Arc::clone(&cancel));

    let emit_job = job_id.clone();
    let fallback_total = total_us;
    let result = ye_convert(
        Path::new(&input_path),
        Path::new(&out_path),
        &spec,
        &cancel,
        &move |processed, total| {
            // 泵的 total 缺时长时为 0，退回前端按源素材给的兜底值。
            let total = if total > 0 { total } else { fallback_total };
            let _ = app.emit(
                "transcode-progress",
                TranscodeProgress {
                    job_id: emit_job.clone(),
                    time_us: processed,
                    total_us: total,
                },
            );
        },
    );

    // 摘除取消标记：只摘自己登记的那份（同 jobId 被后继覆盖的极端情形不误删）。
    if CANCEL_FLAGS
        .lock()
        .map_err(|_| "取消标记表锁已中毒".to_string())?
        .get(&job_id)
        .is_some_and(|r| Arc::ptr_eq(r, &cancel))
    {
        CANCEL_FLAGS
            .lock()
            .map_err(|_| "取消标记表锁已中毒".to_string())?
            .remove(&job_id);
    }
    result.map(|_| ())
}

/// 取消一个 ye 引擎转码任务：置位该 jobId 的取消旗标。
/// 返回是否真的置位——false 表示该 jobId 当前没有进行中的 ye 转码
/// （已结束/从未启动/走的是 ffmpeg 引擎）。
#[tauri::command]
pub fn cancel_transcode_ye(job_id: String) -> Result<bool, String> {
    let flags = CANCEL_FLAGS
        .lock()
        .map_err(|_| "取消标记表锁已中毒".to_string())?;
    match flags.get(&job_id) {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            Ok(true)
        }
        None => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::parse_ye_options;
    use ye::convert::AudioEncodeSettings;

    #[test]
    fn 尺寸与_crf_合法组合() {
        let spec = parse_ye_options(None, None, Some(23), None, None, false, false).unwrap();
        assert_eq!(spec.size, None);
        assert_eq!(spec.crf, 23);
        assert_eq!(spec.video_bitrate_bps, None);
        assert_eq!(spec.audio, AudioEncodeSettings::Copy);
        assert!(!spec.strip_video);

        let spec =
            parse_ye_options(Some(320), Some(240), Some(51), None, None, false, false).unwrap();
        assert_eq!(spec.size, Some((320, 240)));
        assert_eq!(spec.crf, 51);

        let spec =
            parse_ye_options(Some(320), Some(240), Some(1), None, None, false, false).unwrap();
        assert_eq!(spec.crf, 1);
    }

    #[test]
    fn m3_补齐参数面_码率与剥轨() {
        // 视频码率 + 音频重编码
        let spec =
            parse_ye_options(None, None, Some(23), Some(8000), Some(256), false, false).unwrap();
        assert_eq!(spec.video_bitrate_bps, Some(8_000_000));
        assert_eq!(
            spec.audio,
            AudioEncodeSettings::Aac {
                bitrate_bps: 256_000
            }
        );

        // 纯音频：剥视频 + 音频重编码
        let spec = parse_ye_options(None, None, Some(23), None, Some(128), true, false).unwrap();
        assert!(spec.strip_video);
        assert_eq!(
            spec.audio,
            AudioEncodeSettings::Aac {
                bitrate_bps: 128_000
            }
        );

        // 剥音轨
        let spec = parse_ye_options(None, None, Some(23), None, None, false, true).unwrap();
        assert_eq!(spec.audio, AudioEncodeSettings::Drop);
    }

    #[test]
    fn 非法组合全拒() {
        // 宽高只给一轴
        assert!(parse_ye_options(Some(320), None, Some(23), None, None, false, false).is_err());
        // 奇数（H.264 4:2:0 不收）
        assert!(
            parse_ye_options(Some(321), Some(240), Some(23), None, None, false, false).is_err()
        );
        assert!(
            parse_ye_options(Some(320), Some(241), Some(23), None, None, false, false).is_err()
        );
        // 零
        assert!(parse_ye_options(Some(0), Some(240), Some(23), None, None, false, false).is_err());
        // CRF 越界 / 缺失
        assert!(parse_ye_options(None, None, Some(0), None, None, false, false).is_err());
        assert!(parse_ye_options(None, None, Some(52), None, None, false, false).is_err());
        assert!(parse_ye_options(None, None, None, None, None, false, false).is_err());
        // 码率越界
        assert!(parse_ye_options(None, None, Some(23), Some(0), None, false, false).is_err());
        assert!(
            parse_ye_options(None, None, Some(23), Some(4_000_001), None, false, false).is_err()
        );
        assert!(parse_ye_options(None, None, Some(23), None, Some(0), false, false).is_err());
        // 剥视频 + 尺寸
        assert!(parse_ye_options(Some(320), Some(240), Some(23), None, None, true, false).is_err());
        // 剥音轨 + 音频码率
        assert!(parse_ye_options(None, None, Some(23), None, Some(128), false, true).is_err());
        // 剥光
        assert!(parse_ye_options(None, None, Some(23), None, None, true, true).is_err());
    }
}
