#![cfg(not(feature = "compat-ffmpeg"))]
use duan_lib::{
    media_ye,
    preset_ye::{PresetArg, prepare, transcode_preset},
    runtime::media_runtime_info,
};
use serde_json::json;
use std::{fs, process::Command, sync::atomic::AtomicBool};

#[test]
fn pure_backend_handles_no_path() {
    if let Some(root) = std::env::var_os("DUAN_PURE_WORKER").map(std::path::PathBuf::from) {
        assert_eq!(std::env::var_os("PATH").unwrap(), "");
        assert!(!media_runtime_info().unwrap().compat_ffmpeg);
        let input = root.join("source.bin");
        let silent = root.join("silent.mp4");
        let info = media_ye::probe_ye(&input).unwrap();
        assert_eq!(info.width, 32);
        assert!(info.has_audio);
        let thumbnail = media_ye::extract_frame_ye(input.to_string_lossy().into(), 250000).unwrap();
        assert!(fs::read(&thumbnail).unwrap().starts_with(b"\x89PNG"));
        fs::remove_file(thumbnail).unwrap();
        let preset:PresetArg=serde_json::from_value(json!({"container":"mp4","video":{"codec":"libx264","rate":{"mode":"crf","crf":23},"maxHeight":"source","fps":24},"audio":{"codec":"aac","sampleRate":48000,"bitrateKbps":128}})).unwrap();
        let run = |name: &str, preset: &PresetArg, source: &std::path::Path, cancel: bool| {
            transcode_preset(
                source,
                &root.join(name),
                preset,
                &AtomicBool::new(cancel),
                &|_, _| {},
            )
        };
        assert_eq!(
            run("0.mp4", &preset, &input, false).unwrap().video_frames,
            24
        );
        let mut second = preset.clone();
        second.video.as_mut().unwrap().fps = Some(12.0);
        assert_eq!(
            run("1.mp4", &second, &input, false).unwrap().video_frames,
            12
        );
        let mut audio = preset.clone();
        audio.video = None;
        audio.audio.as_mut().unwrap().sample_rate = 44100;
        assert!(run("2.mp4", &audio, &input, false).is_ok());
        let mut unsupported = preset.clone();
        unsupported.container = "mp3".into();
        assert!(prepare(&input, &unsupported).is_err());
        assert!(run("3.mp4", &unsupported, &input, false).is_err());
        unsupported = preset.clone();
        unsupported.video.as_mut().unwrap().codec = "libx265".into();
        assert!(run("4.mp4", &unsupported, &input, false).is_err());
        let bad = root.join("bad.mp4");
        fs::write(&bad, b"not mp4").unwrap();
        assert!(run("5.mp4", &preset, &bad, false).is_err());
        let mut broken = fs::read(&input).unwrap();
        let mdat = broken.windows(4).position(|w| w == b"mdat").unwrap();
        let size = u32::from_be_bytes(broken[mdat - 4..mdat].try_into().unwrap()) as usize;
        for byte in &mut broken[mdat + 4..mdat - 4 + size] {
            *byte = 0;
        }
        let broken_path = root.join("broken.mp4");
        fs::write(&broken_path, broken).unwrap();
        assert!(prepare(&broken_path, &preset).is_ok());
        assert!(run("6.mp4", &preset, &broken_path, false).is_err());
        assert!(run("7.mp4", &preset, &input, true).is_err());
        fs::write(root.join("8.mp4"), b"existing valid output").unwrap();
        assert!(run("8.mp4", &preset, &input, false).is_err());
        assert_eq!(
            fs::read(root.join("8.mp4")).unwrap(),
            b"existing valid output"
        );
        assert!(run("9.mp4", &preset, &silent, false).is_ok());
        for name in ["3.mp4", "4.mp4", "5.mp4", "6.mp4", "7.mp4"] {
            assert!(!root.join(name).exists(), "partial {name}");
        }
        assert!(
            fs::read_dir(&root).unwrap().all(|e| !e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".part"))
        );
        return;
    }
    let root = std::env::temp_dir().join(format!(
        "duan-pure-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let made = Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=32x32:rate=30:duration=1",
            "-f",
            "lavfi",
            "-i",
            "sine=sample_rate=44100:duration=1",
            "-c:v",
            "libx264",
            "-profile:v",
            "high",
            "-bf",
            "2",
            "-c:a",
            "aac",
            "-f",
            "mp4",
            "-y",
        ])
        .arg(root.join("source.bin"))
        .status()
        .unwrap();
    assert!(made.success());
    let made = Command::new("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(root.join("source.bin"))
        .args(["-an", "-c:v", "copy", "-y"])
        .arg(root.join("silent.mp4"))
        .status()
        .unwrap();
    assert!(made.success());
    let worker = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "pure_backend_handles_no_path",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("DUAN_PURE_WORKER", &root)
        .env("PATH", "")
        .env("BJ_FFMPEG_DIR", root.join("missing-tools"))
        .output()
        .unwrap();
    assert!(
        worker.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&worker.stdout),
        String::from_utf8_lossy(&worker.stderr)
    );
    for entry in fs::read_dir(&root).unwrap() {
        fs::remove_file(entry.unwrap().path()).unwrap();
    }
    fs::remove_dir(root).unwrap();
}
