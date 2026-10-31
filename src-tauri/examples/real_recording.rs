//! Opt-in acceptance of user-supplied recordings. Never modifies the source.
use duan_lib::{
    media_ye,
    preset_ye::{PresetArg, prepare, transcode_preset},
};
use std::{path::PathBuf, sync::atomic::AtomicBool};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 3 {
        return Err("original, derived clip, output required".into());
    }
    let original = PathBuf::from(&args[0]);
    let clip = PathBuf::from(&args[1]);
    let output = PathBuf::from(&args[2]);
    let info = media_ye::probe_ye(&original)?;
    println!(
        "original probe: {}x{} @{} audio={}",
        info.width, info.height, info.fps, info.has_audio
    );
    let preset: PresetArg = serde_json::from_value(
        serde_json::json!({"container":"mp4","video":{"codec":"libx264","rate":{"mode":"crf","crf":23},"maxHeight":90,"fps":12},"audio":{"codec":"aac","bitrateKbps":128,"sampleRate":48000}}),
    )?;
    prepare(&original, &preset).map_err(|e| e.join("\n"))?;
    println!("original preflight passed (all audio tracks preserved)");
    let stats = transcode_preset(&clip, &output, &preset, &AtomicBool::new(false), &|_, _| {})?;
    println!("derived clip output: {stats:?}");
    Ok(())
}
