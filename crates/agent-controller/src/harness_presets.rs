//! Tier 2 metadata shared with the frontend; runtime quirks remain in buzz-acp.
use serde::Deserialize;
use std::path::Path;
use std::sync::OnceLock;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HarnessPreset {
    pub id: String,
    pub label: String,
    pub command: String,
    pub args: Vec<String>,
    pub setup_url: String,
    pub setup_hint: String,
}

pub fn harness_presets() -> &'static [HarnessPreset] {
    static PRESETS: OnceLock<Vec<HarnessPreset>> = OnceLock::new();
    PRESETS.get_or_init(|| {
        serde_json::from_str(include_str!("harness-presets.json"))
            .expect("bundled harness presets must be valid")
    })
}

/// Saved paths retain their identity independently of current discovery.
pub fn harness_preset(command: &str) -> Option<&'static HarnessPreset> {
    let name = Path::new(command).file_name()?.to_str()?;
    let stem = [".exe", ".cmd", ".bat"]
        .iter()
        .find_map(|suffix| name.strip_suffix(suffix))
        .unwrap_or(name);
    harness_presets()
        .iter()
        .find(|preset| preset.command == stem)
}
