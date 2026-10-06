//! Headless Codex model catalog and selected-model effort discovery. No prompts.
#[cfg(unix)]
use crate::codex_acp::{self, Failure, Limits};
#[cfg(unix)]
use buzz_agent_controller::codex::CodexContext;
#[cfg(unix)]
use serde_json::{json, Value};
#[cfg(unix)]
use std::collections::BTreeSet;

#[cfg(unix)]
const MAX_MODELS: usize = 1_000;
#[cfg(unix)]
const MAX_EFFORTS: usize = 20;
#[cfg(unix)]
const MAX_CONFIG_OPTIONS: usize = 100;
#[cfg(unix)]
const MAX_ID: usize = 512;
#[cfg(unix)]
const MAX_NAME: usize = 1_024;

#[cfg(unix)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Entry {
    pub(crate) id: String,
    pub(crate) name: String,
}

#[cfg(unix)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Effort {
    pub(crate) model: String,
    pub(crate) current: Option<String>,
    pub(crate) options: Vec<Entry>,
}

#[cfg(unix)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Discovery {
    /// `None` means the adapter did not publish model metadata. `Some([])` is
    /// an authoritative, successfully discovered empty catalog.
    pub(crate) models: Option<Vec<Entry>>,
    /// The model resolved when the session opened, before an optional selection.
    pub(crate) resolved_model: Option<String>,
    /// The effort resolved when the session opened; not a per-model default.
    pub(crate) resolved_effort: Option<String>,
    /// Reported metadata for the selected/current model. Missing means unknown.
    pub(crate) effort: Option<Effort>,
}

#[cfg(unix)]
pub(crate) fn discover(
    context: &CodexContext,
    adapter_version: &str,
    selected_model: Option<&str>,
    current: &impl Fn() -> bool,
) -> Result<Discovery, Failure> {
    if selected_model.is_some_and(|value| !valid(value, MAX_ID)) {
        return Err(Failure::Incompatible);
    }
    codex_acp::run(context, Limits::discovery(), current, |client| {
        client.initialize(adapter_version, current)?;
        let opened = client.request(
            "session/new",
            json!({"cwd": context.workspace, "mcpServers": []}),
            current,
        )?;
        let session_id = opened
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| valid(value, MAX_ID))
            .ok_or(Failure::Incompatible)?
            .to_owned();
        let initial = parse_options(opened.get("configOptions"))?;
        let resolved_model = initial.current_model.clone();
        let resolved_effort = initial
            .effort
            .as_ref()
            .and_then(|effort| effort.current.clone());
        let final_options = match selected_model.filter(|value| !value.is_empty()) {
            Some(selected) if initial.current_model.as_deref() != Some(selected) => {
                if !initial
                    .models
                    .as_ref()
                    .is_some_and(|models| models.iter().any(|model| model.id == selected))
                {
                    return Err(Failure::Incompatible);
                }
                let changed = client.request(
                    "session/set_config_option",
                    json!({
                        "sessionId": session_id,
                        "configId": "model",
                        "value": selected,
                    }),
                    current,
                )?;
                let changed = parse_options(changed.get("configOptions"))?;
                if changed.current_model.as_deref() != Some(selected) {
                    return Err(Failure::Incompatible);
                }
                changed
            }
            _ => initial,
        };
        client.request("session/close", json!({"sessionId": session_id}), current)?;
        let Options {
            models,
            current_model,
            effort,
        } = final_options;
        let effort = current_model.map(|model| {
            effort.map(|mut effort| {
                effort.model = model;
                effort
            })
        });
        Ok(Discovery {
            models,
            resolved_model,
            resolved_effort,
            effort: effort.flatten(),
        })
    })
}

#[cfg(unix)]
#[derive(Debug)]
struct Options {
    models: Option<Vec<Entry>>,
    current_model: Option<String>,
    effort: Option<Effort>,
}

#[cfg(unix)]
fn parse_options(value: Option<&Value>) -> Result<Options, Failure> {
    let Some(value) = value else {
        return Ok(Options {
            models: None,
            current_model: None,
            effort: None,
        });
    };
    let options = value.as_array().ok_or(Failure::Incompatible)?;
    if options.len() > MAX_CONFIG_OPTIONS {
        return Err(Failure::OutputLimit);
    }
    let mut model = None;
    let mut effort = None;
    for option in options {
        let id = option.get("id").and_then(Value::as_str);
        let category = option.get("category").and_then(Value::as_str);
        if id == Some("model") || category == Some("model") {
            if id != Some("model") || category != Some("model") || model.is_some() {
                return Err(Failure::Incompatible);
            }
            model = Some(parse_select(option, MAX_MODELS)?);
        }
        if id == Some("reasoning_effort") || category == Some("thought_level") {
            if id != Some("reasoning_effort")
                || category != Some("thought_level")
                || effort.is_some()
            {
                return Err(Failure::Incompatible);
            }
            effort = Some(parse_select(option, MAX_EFFORTS)?);
        }
    }
    let (models, current_model) = match model {
        Some(model) => {
            let current = current(&model)?;
            (Some(model.options), current)
        }
        None => (None, None),
    };
    if models.is_none() && effort.is_some() {
        return Err(Failure::Incompatible);
    }
    let effort = effort
        .map(|selection| {
            Ok(Effort {
                model: String::new(),
                current: current(&selection)?,
                options: selection.options,
            })
        })
        .transpose()?;
    Ok(Options {
        models,
        current_model,
        effort,
    })
}

#[cfg(unix)]
struct Selection {
    current: String,
    options: Vec<Entry>,
}

#[cfg(unix)]
fn parse_select(value: &Value, limit: usize) -> Result<Selection, Failure> {
    if value.get("type").and_then(Value::as_str) != Some("select") {
        return Err(Failure::Incompatible);
    }
    let current = value
        .get("currentValue")
        .and_then(Value::as_str)
        .filter(|value| value.is_empty() || valid(value, MAX_ID))
        .ok_or(Failure::Incompatible)?
        .to_owned();
    let values = value
        .get("options")
        .and_then(Value::as_array)
        .ok_or(Failure::Incompatible)?;
    if values.len() > limit {
        return Err(Failure::OutputLimit);
    }
    let mut ids = BTreeSet::new();
    let mut options = Vec::with_capacity(values.len());
    for option in values {
        if option.get("group").is_some() {
            return Err(Failure::Incompatible);
        }
        let id = option
            .get("value")
            .and_then(Value::as_str)
            .filter(|value| valid(value, MAX_ID))
            .ok_or(Failure::Incompatible)?;
        let name = option
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| valid(value, MAX_NAME))
            .ok_or(Failure::Incompatible)?;
        if !ids.insert(id) {
            return Err(Failure::Incompatible);
        }
        options.push(Entry {
            id: id.to_owned(),
            name: name.to_owned(),
        });
    }
    Ok(Selection { current, options })
}

#[cfg(unix)]
fn current(selection: &Selection) -> Result<Option<String>, Failure> {
    if selection.current.is_empty() && selection.options.is_empty() {
        return Ok(None);
    }
    selection
        .options
        .iter()
        .any(|option| option.id == selection.current)
        .then(|| Some(selection.current.clone()))
        .ok_or(Failure::Incompatible)
}

#[cfg(unix)]
fn valid(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

#[cfg(all(test, unix))]
mod tests;
