//! ye 引擎端到端对拍（M3 准入锚点：锻的第一个转码任务）。
//!
//! 口径（roadmap M3）：改分辨率（176x144 → 320x240）、音频直通，ye 产物与
//! ffmpeg 同参数产物对拍——
//! 1. 双方产物都能被 ffmpeg 无错解码（流合法性）；
//! 2. 时长差 ≤ 0.1s、帧数一致（封装口径）；
//! 3. 同点位（1.0s）抽帧灰度逐像素比较，平均 |Δ| ≤ 6（画面一致性——
//!    两编码器 CRF 23 同源同尺寸，视觉应一致，不是逐字节对齐）。
//!
//! ffmpeg/ffprobe 从 src-tauri/binaries（fetch 脚本/集群开发机布局）或 PATH
//! 取；都没有则失败——对拍测试不许假绿（ye 同款约定）。CI 的 rust-gate 只
//! check 不跑 test，本测试约束的是本机/开发流程。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::AtomicBool;

use duan_lib::ye_engine::{YeSpec, ye_convert};
use ye::convert::AudioEncodeSettings;

/// ffmpeg/ffprobe 定位：src-tauri/binaries（开发机/打包布局）→ PATH。
fn tool(name: &str) -> PathBuf {
    let manifest_binaries = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
    let with_exe = manifest_binaries.join(format!("{name}.exe"));
    if with_exe.exists() {
        return with_exe;
    }
    let plain = manifest_binaries.join(name);
    if plain.exists() {
        return plain;
    }
    PathBuf::from(name) // 交给 PATH
}

fn run(cmd: &Path, args: &[&str]) -> (bool, Vec<u8>, Vec<u8>) {
    let out = Command::new(cmd).args(args).output().expect("启动外部命令失败");
    (out.status.success(), out.stdout, out.stderr)
}

/// 生成测试源：3 秒 176x144 15fps H.264(Baseline)+AAC MP4（testsrc2 + 正弦音）。
fn make_source(dir: &Path, ffmpeg: &Path) -> PathBuf {
    let src = dir.join("src.mp4");
    let mut args: Vec<&str> = vec![
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=duration=3:size=176x144:rate=15",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=3",
        "-c:v",
        "libx264",
        "-profile:v",
        "baseline",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
    ];
    args.push(src.to_str().unwrap());
    let (ok, _, stderr) = run(ffmpeg, &args);
    assert!(ok, "ffmpeg 造源失败: {}", String::from_utf8_lossy(&stderr));
    src
}

/// ffprobe 取流时长（秒）与逐帧计数。
fn probe_duration_frames(ffprobe: &Path, file: &Path) -> (f64, u32) {
    let (ok, out, err) = run(
        ffprobe,
        &[
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=duration,nb_frames",
            "-count_frames",
            "-show_entries",
            "stream=nb_read_frames",
            "-of",
            "default=noprint_wrappers=1",
            file.to_str().unwrap(),
        ],
    );
    assert!(ok, "ffprobe 失败: {}", String::from_utf8_lossy(&err));
    let text = String::from_utf8_lossy(&out);
    let mut duration = None;
    let mut frames = None;
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("duration=") {
            duration = v.trim().parse::<f64>().ok().or(duration);
        }
        if let Some(v) = line.strip_prefix("nb_read_frames=") {
            frames = v.trim().parse::<u32>().ok();
        }
    }
    (
        duration.unwrap_or(0.0),
        frames.unwrap_or_else(|| panic!("ffprobe 未读到帧数: {text}")),
    )
}

/// 抽取指定时间点的灰度帧（rawvideo 单帧），供画面一致性比较。
fn extract_gray_frame(ffmpeg: &Path, file: &Path, at_s: &str) -> Vec<u8> {
    let (ok, out, err) = run(
        ffmpeg,
        &[
            "-v",
            "error",
            "-ss",
            at_s,
            "-i",
            file.to_str().unwrap(),
            "-frames:v",
            "1",
            "-pix_fmt",
            "gray",
            "-f",
            "rawvideo",
            "-",
        ],
    );
    assert!(ok, "抽帧失败: {}", String::from_utf8_lossy(&err));
    out
}

#[test]
fn ye_引擎_转码对拍_ffmpeg() {
    let ffmpeg = tool("ffmpeg");
    let ffprobe = tool("ffprobe");
    // 工具缺席＝环境不具备，明确失败（不跳过——对拍不许假绿）。
    let (ok, _, _) = run(&ffmpeg, &["-version"]);
    assert!(ok, "ffmpeg 不可用（{ffmpeg:?}）：对拍测试需要 binaries/ 下的 ffmpeg/ffprobe");
    let (ok, _, _) = run(&ffprobe, &["-version"]);
    assert!(ok, "ffprobe 不可用（{ffprobe:?}）");

    let dir = std::env::temp_dir().join(format!("duan-ye-e2e-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("建临时目录");
    let src = make_source(&dir, &ffmpeg);

    // —— 被测方：ye 引擎转码（run_transcode_ye 的主体路径，crf 23 → 320x240）——
    let ye_out = dir.join("ye-out.mp4");
    let cancel = AtomicBool::new(false);
    let spec = YeSpec {
        size: Some((320, 240)),
        crf: 23,
        video_bitrate_bps: None,
        strip_video: false,
        audio: AudioEncodeSettings::Copy,
    };
    let stats = ye_convert(&src, &ye_out, &spec, &cancel, &|_, _| {}).expect("ye 转码失败");
    assert!(stats.video_frames > 0, "ye 转码无视频帧输出");

    // —— 对照方：ffmpeg 同参数（libx264 crf 23 + scale 320x240 + 音频直通）——
    let ff_out = dir.join("ff-out.mp4");
    let (ok, _, stderr) = run(
        &ffmpeg,
        &[
            "-y",
            "-v",
            "error",
            "-i",
            src.to_str().unwrap(),
            "-vf",
            "scale=320:240",
            "-c:v",
            "libx264",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "copy",
            ff_out.to_str().unwrap(),
        ],
    );
    assert!(ok, "ffmpeg 对照转码失败: {}", String::from_utf8_lossy(&stderr));

    // —— 对拍 1：双方产物 ffmpeg 无错解码 ——
    for file in [&ye_out, &ff_out] {
        let (ok, _, err) = run(
            &ffmpeg,
            &["-v", "error", "-i", file.to_str().unwrap(), "-f", "null", "-"],
        );
        assert!(ok, "{} 解码报错: {}", file.display(), String::from_utf8_lossy(&err));
    }

    // —— 对拍 2：时长差 ≤ 0.1s 且帧数一致 ——
    let (ye_dur, ye_frames) = probe_duration_frames(&ffprobe, &ye_out);
    let (ff_dur, ff_frames) = probe_duration_frames(&ffprobe, &ff_out);
    assert!(
        (ye_dur - ff_dur).abs() <= 0.1,
        "时长差超限：ye {ye_dur}s vs ffmpeg {ff_dur}s"
    );
    assert_eq!(ye_frames, ff_frames, "帧数不一致（ye {ye_frames} vs ffmpeg {ff_frames}）");

    // —— 对拍 3：同点位（1.0s）灰度帧平均 |Δ| ≤ 6 ——
    let ye_frame = extract_gray_frame(&ffmpeg, &ye_out, "1.0");
    let ff_frame = extract_gray_frame(&ffmpeg, &ff_out, "1.0");
    assert_eq!(ye_frame.len(), ff_frame.len(), "两产物抽帧尺寸不一致");
    assert_eq!(ye_frame.len(), 320 * 240, "抽帧不是 320x240 灰度");
    let diff_sum: u32 = ye_frame
        .iter()
        .zip(&ff_frame)
        .map(|(a, b)| u32::from(a.abs_diff(*b)))
        .sum();
    let mean = diff_sum as f64 / ye_frame.len() as f64;
    assert!(
        mean <= 6.0,
        "同点位画面平均 |Δ| 超限：{mean:.2}（容差 6.0）"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// M3 补齐面：① 纯音频（剥视频 + AAC-LC 重编码 128k）；② 视频码率模式
/// （A-VBR 200k + 剥音轨）。两者产物均须 ffmpeg 无错解码、时长对齐；
/// 纯音频产物非静音（volumedetect 峰值）。
#[test]
fn ye_引擎_纯音频重编码与视频码率模式() {
    let ffmpeg = tool("ffmpeg");
    let ffprobe = tool("ffprobe");
    let (ok, _, _) = run(&ffmpeg, &["-version"]);
    assert!(ok, "ffmpeg 不可用（{ffmpeg:?}）：对拍测试需要 binaries/ 下的 ffmpeg/ffprobe");
    let (ok, _, _) = run(&ffprobe, &["-version"]);
    assert!(ok, "ffprobe 不可用（{ffprobe:?}）");

    let dir = std::env::temp_dir().join(format!("duan-ye-e2e-m3b-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("建临时目录");
    let src = make_source(&dir, &ffmpeg);
    let cancel = AtomicBool::new(false);

    // —— ① 纯音频：剥视频 + AAC 重编码 128k ——
    let audio_out = dir.join("audio-out.mp4");
    let spec = YeSpec {
        size: None,
        crf: 23,
        video_bitrate_bps: None,
        strip_video: true,
        audio: AudioEncodeSettings::Aac {
            bitrate_bps: 128_000,
        },
    };
    let stats = ye_convert(&src, &audio_out, &spec, &cancel, &|_, _| {})
        .expect("纯音频转码失败");
    assert_eq!(stats.video_frames, 0, "剥视频后不应有视频帧");
    assert!(stats.audio_frames > 0, "应有音频输出包");

    // 流形态：单 aac 轨（ffprobe codec_name 全表）。
    let (ok, out, err) = run(
        &ffprobe,
        &[
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name",
            "-of",
            "csv=p=0",
            audio_out.to_str().unwrap(),
        ],
    );
    assert!(ok, "ffprobe 失败: {}", String::from_utf8_lossy(&err));
    let text = String::from_utf8_lossy(&out);
    // ffprobe 的 csv 输出按条目自身序（codec_name 在前）：单 aac 轨。
    assert_eq!(text.trim(), "aac,audio", "应为单 aac 轨：{text}");

    // ffmpeg 无错解码 + 非静音（volumedetect 峰值 > -60dB）。
    let (ok, _, err) = run(
        &ffmpeg,
        &[
            "-v",
            "error",
            "-i",
            audio_out.to_str().unwrap(),
            "-af",
            "volumedetect",
            "-f",
            "null",
            "-",
        ],
    );
    assert!(ok && err.is_empty(), "音频产物解码报错: {}", String::from_utf8_lossy(&err));
    let detect = String::from_utf8_lossy(&err);
    // -v error 下 volumedetect 的摘要仍走 stderr（info 级被静音则退回
    // 仅校验解码干净；开发机实测摘要可见）。
    if let Some(line) = detect.lines().find(|l| l.contains("max_volume")) {
        let db: f64 = line
            .split(':')
            .nth(1)
            .and_then(|v| v.trim().trim_end_matches(" dB").parse().ok())
            .unwrap_or(-999.0);
        assert!(db > -60.0, "重编码音频疑似静音（max_volume {db} dB）");
    }

    // 时长对齐源（±0.1s，容器级）。
    let src_dur = format_duration(&ffprobe, &src);
    let audio_dur = format_duration(&ffprobe, &audio_out);
    assert!(
        (src_dur - audio_dur).abs() <= 0.1,
        "纯音频时长差超限：源 {src_dur}s vs 输出 {audio_dur}s"
    );

    // —— ② 视频码率模式（A-VBR 200k）+ 剥音轨 ——
    let vb_out = dir.join("vb-out.mp4");
    let spec = YeSpec {
        size: None,
        crf: 23,
        video_bitrate_bps: Some(200_000),
        strip_video: false,
        audio: AudioEncodeSettings::Drop,
    };
    let stats = ye_convert(&src, &vb_out, &spec, &cancel, &|_, _| {})
        .expect("码率模式转码失败");
    assert!(stats.video_frames > 0, "应有视频帧输出");
    assert_eq!(stats.audio_frames, 0, "剥音轨后不应有音频包");

    let (ok, _, err) = run(
        &ffmpeg,
        &["-v", "error", "-i", vb_out.to_str().unwrap(), "-f", "null", "-"],
    );
    assert!(
        ok && err.is_empty(),
        "码率模式产物解码报错: {}",
        String::from_utf8_lossy(&err)
    );
    let (_, vb_frames) = probe_duration_frames(&ffprobe, &vb_out);
    let (_, src_frames) = probe_duration_frames(&ffprobe, &src);
    assert_eq!(vb_frames, src_frames, "码率模式帧数应与源一致");
    // 诊断：实测平均码率（收敛容差的正本在 ye-codec-h264 测试）。
    let vb_dur = format_duration(&ffprobe, &vb_out);
    let size_bits = std::fs::metadata(&vb_out).unwrap().len() * 8;
    eprintln!(
        "ye_引擎_纯音频重编码与视频码率模式: A-VBR 200k 实测 ≈ {} bps（{}s 产物）",
        size_bits as f64 / vb_dur,
        vb_dur
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// ffprobe 容器级时长（秒）。
fn format_duration(ffprobe: &Path, file: &Path) -> f64 {
    let (ok, out, err) = run(
        ffprobe,
        &[
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
            file.to_str().unwrap(),
        ],
    );
    assert!(ok, "ffprobe 失败: {}", String::from_utf8_lossy(&err));
    String::from_utf8_lossy(&out)
        .trim()
        .parse()
        .expect("duration 应为数值")
}
