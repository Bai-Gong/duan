import { invoke } from "@tauri-apps/api/core";
import type { Preset } from "./types";
/** Metadata only. Saved presets are never rewritten by a capability check. */
export async function checkPresetYe(preset: Preset): Promise<string[]> {
  try { return await invoke<string[]>("check_preset_ye", { preset, inputPath: null }); }
  catch (error) { return [`无法检查预设：${String(error)}`]; }
}
