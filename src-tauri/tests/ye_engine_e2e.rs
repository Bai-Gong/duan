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

use duan_lib::ye_engine::ye_convert;

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
    let stats = ye_convert(&src, &ye_out, Some((320, 240)), 23, &cancel, &|_, _| {})
        .expect("ye 转码失败");
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
