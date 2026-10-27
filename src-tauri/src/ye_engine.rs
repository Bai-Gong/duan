//! ye 进程内转码引擎（M3 接线轨）：门面 [`ye::convert::convert`] 的命令封装。
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
//! 能力面（ye M3 首轮）：输入 H.264（MP4），视频重编码 H.264 Baseline
//! （CRF 质量），音频包直通，输出 MP4。目标码率/改帧率/非 H.264 源由前端
//! 翻译层（buildYeTranscodeParams）提前拒绝，这里只兜参数形状。

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, BufWriter};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use tauri::Emitter;

use crate::ffmpeg::TranscodeProgress;

/// 取消标记表：jobId → 运行中转码的取消旗标（与 ffmpeg.rs 的 KILL 表同构，
/// 只是「句柄」从子进程换成布尔）。run_transcode_ye 登记本地 Arc、收尾摘除。
static CANCEL_FLAGS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 命令入参校验：目标尺寸（两轴同给或同缺）与 CRF 值域（1..=51）。
fn parse_ye_options(
    width: Option<u32>,
    height: Option<u32>,
    crf: Option<u8>,
) -> Result<(Option<(u32, u32)>, u8), String> {
    let size = match (width, height) {
        (Some(w), Some(h)) => {
            if w == 0 || h == 0 || w % 2 != 0 || h % 2 != 0 {
                return Err(format!("目标尺寸须为正偶数，收到 {w}x{h}（H.264 4:2:0 要求）"));
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
    Ok((size, crf))
}

/// 转码主体（纯库调用）：注册表组装 → 门面泵 → 统计；失败即删半成品
/// （ye 泵不持有路径概念，输出文件清理归调用方——ye-cli 同款约定）。
///
/// 进度回调 `(processed_us, total_us)` 由泵逐输出包上报；total_us 取自
/// 流时长，缺时长时为 0，由调用方决定兜底。
pub fn ye_convert(
    input: &Path,
    output: &Path,
    size: Option<(u32, u32)>,
    crf: u8,
    cancel: &AtomicBool,
    progress: &dyn Fn(i64, i64),
) -> Result<ye::convert::ConvertStats, String> {
    let ctx = || format!("{} → {}", input.display(), output.display());
    let result = run_ye_convert(input, output, size, crf, cancel, progress);
    if result.is_err() {
        // 半成品清理：泵已随错误丢弃输出句柄，这里删残留文件（不存在时忽略）。
        let _ = std::fs::remove_file(output);
    }
    result.map_err(|e| format!("{}: {e}", ctx()))
}

fn run_ye_convert(
    input: &Path,
    output: &Path,
    size: Option<(u32, u32)>,
    crf: u8,
    cancel: &AtomicBool,
    progress: &dyn Fn(i64, i64),
) -> Result<ye::convert::ConvertStats, String> {
    let in_file = File::open(input).map_err(|e| format!("{}: {e}", input.display()))?;
    let out_file = File::create(output).map_err(|e| format!("{}: {e}", output.display()))?;

    // 注册表显式构造（与 ye-cli 同款）：MP4 容器 + H.264 解码/编码真工厂。
    // 音频包直通不重编码，无需 AAC 注册。
    let mut containers = ye::container::ContainerRegistry::new();
    ye::container::mp4::register_mp4(&mut containers);
    let mut codecs = ye::codec::CodecRegistry::new();
    ye::codec_h264::register_h264(&mut codecs);
    ye::codec_h264::register_h264_encoder(&mut codecs);

    let settings = ye::convert::VideoEncodeSettings {
        chain: ye::convert::VideoChain { format: None, size },
        gop: 250,
        quality: ye::codec::QualityMode::Crf(crf),
    };
    ye::convert::convert(
        &containers,
        &codecs,
        Box::new(BufReader::new(in_file)),
        "mp4",
        Box::new(BufWriter::new(out_file)),
        &settings,
        ye::convert::filter_ops(),
        progress,
        cancel,
    )
    .map_err(|e| e.to_string())
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
    total_us: i64,
) -> Result<(), String> {
    let (size, crf) = parse_ye_options(width, height, crf)?;
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
        size,
        crf,
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

    #[test]
    fn 尺寸与_crf_合法组合() {
        assert_eq!(parse_ye_options(None, None, Some(23)), Ok((None, 23)));
        assert_eq!(
            parse_ye_options(Some(320), Some(240), Some(51)),
            Ok((Some((320, 240)), 51))
        );
        assert_eq!(parse_ye_options(Some(320), Some(240), Some(1)), Ok((Some((320, 240)), 1)));
    }

    #[test]
    fn 尺寸与_crf_非法组合全拒() {
        // 宽高只给一轴
        assert!(parse_ye_options(Some(320), None, Some(23)).is_err());
        // 奇数（H.264 4:2:0 不收）
        assert!(parse_ye_options(Some(321), Some(240), Some(23)).is_err());
        assert!(parse_ye_options(Some(320), Some(241), Some(23)).is_err());
        // 零
        assert!(parse_ye_options(Some(0), Some(240), Some(23)).is_err());
        // CRF 越界 / 缺失
        assert!(parse_ye_options(None, None, Some(0)).is_err());
        assert!(parse_ye_options(None, None, Some(52)).is_err());
        assert!(parse_ye_options(None, None, None).is_err());
    }
}
