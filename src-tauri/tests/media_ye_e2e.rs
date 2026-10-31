//! 严格走冶入口，不以 FFmpeg 回退成功替代冶验收。
use duan_lib::media_ye::{extract_frame_ye, probe_ye};
use duan_lib::ye_engine::{YeSpec, ye_convert};
use std::process::Command;
use std::sync::atomic::AtomicBool;

#[test]
fn high_aac_pns_probe_thumbnail_and_existing_output_protection() {
    if !Command::new("ffmpeg")
        .arg("-version")
        .output()
        .is_ok_and(|o| o.status.success())
    {
        eprintln!("SKIP oracle_missing");
        return;
    }
    let dir = std::env::temp_dir().join(format!("duan-pure-media-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let input = dir.join("source.bin");
    let made = Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=176x144:rate=25:duration=1",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=997:sample_rate=44100:duration=1",
            "-c:v",
            "libx264",
            "-profile:v",
            "high",
            "-bf",
            "3",
            "-c:a",
            "aac",
            "-aac_pns",
            "1",
            "-f",
            "mp4",
        ])
        .arg(&input)
        .output()
        .unwrap();
    assert!(
        made.status.success(),
        "{}",
        String::from_utf8_lossy(&made.stderr)
    );
    let info = probe_ye(&input).unwrap();
    assert_eq!((info.width, info.height), (176, 144));
    assert_eq!(info.video_codec, "h264");
    assert_eq!(info.audio_codec, "aac");
    assert_eq!(info.sample_rate, 44100);
    let png = extract_frame_ye(input.to_string_lossy().into_owned(), 300000).unwrap();
    assert_eq!(&std::fs::read(&png).unwrap()[..8], b"\x89PNG\r\n\x1a\n");
    std::fs::remove_file(png).unwrap();
    let output = dir.join("important.mp4");
    std::fs::write(&output, b"keep me").unwrap();
    let settings = YeSpec {
        size: None,
        crf: 23,
        video_bitrate_bps: None,
        strip_video: false,
        audio: ye::convert::AudioEncodeSettings::Drop,
    };
    assert!(
        ye_convert(
            &input,
            &output,
            &settings,
            &AtomicBool::new(false),
            &|_, _| {}
        )
        .is_err()
    );
    assert_eq!(std::fs::read(&output).unwrap(), b"keep me");
    let bad = dir.join("bad.mp4");
    std::fs::write(&bad, b"not mp4").unwrap();
    assert!(probe_ye(&bad).is_err());
    for p in [input, output, bad] {
        std::fs::remove_file(p).unwrap();
    }
    std::fs::remove_dir(dir).unwrap();
}
