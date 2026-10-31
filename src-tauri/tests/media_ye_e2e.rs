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

#[test]
fn preset_keeps_all_compatible_audio_tracks() {
    use duan_lib::preset_ye::{PresetArg, prepare, transcode_preset};
    let root = std::env::temp_dir().join(format!("duan-multiaudio-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let input = root.join("multi.mp4");
    let output = root.join("converted.mp4");
    let made = Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=32x32:rate=12:duration=0.25",
            "-f",
            "lavfi",
            "-i",
            "sine=sample_rate=48000:duration=0.25",
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-map",
            "1:a",
            "-map",
            "1:a",
            "-map",
            "1:a",
            "-map",
            "1:a",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
        ])
        .arg(&input)
        .output()
        .unwrap();
    assert!(
        made.status.success(),
        "{}",
        String::from_utf8_lossy(&made.stderr)
    );
    let preset:PresetArg=serde_json::from_value(serde_json::json!({"container":"mp4","video":{"codec":"libx264","rate":{"mode":"crf","crf":23},"maxHeight":"source","fps":12},"audio":{"codec":"aac","bitrateKbps":128,"sampleRate":48000}})).unwrap();
    assert!(prepare(&input, &preset).is_ok());
    let stats = transcode_preset(
        &input,
        &output,
        &preset,
        &AtomicBool::new(false),
        &|_, _| {},
    )
    .unwrap();
    assert_eq!(stats.streams, 6);
    let header = ye::media::inspect(Box::new(std::fs::File::open(&output).unwrap())).unwrap();
    assert_eq!(
        header
            .streams
            .iter()
            .filter(|s| s.media_type == ye::codec::MediaType::Audio)
            .count(),
        5
    );
    std::fs::remove_file(input).unwrap();
    std::fs::remove_file(output).unwrap();
    std::fs::remove_dir(root).unwrap();
}
