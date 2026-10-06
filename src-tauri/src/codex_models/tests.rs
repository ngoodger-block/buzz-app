use super::*;
use std::{collections::BTreeMap, os::unix::fs::PermissionsExt, path::Path};

fn tool(path: &Path, body: &str) {
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}

fn context(adapter_body: &str) -> (tempfile::TempDir, CodexContext) {
    let root = tempfile::tempdir().unwrap();
    let adapter = root.path().join("codex-acp");
    let cli = root.path().join("codex");
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    tool(&adapter, adapter_body);
    tool(&cli, "#!/bin/sh\nexit 0\n");
    let context = CodexContext::new(&adapter, &cli, &workspace, &BTreeMap::new()).unwrap();
    (root, context)
}

const INIT: &str = r#"printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"@agentclientprotocol/codex-acp","version":"1.10.0"}}}'"#;

#[test]
fn production_discovery_projects_catalog_and_selected_model_effort() {
    let (_root, context) = context(&format!(
        r#"#!/bin/sh
read -r initialize
{INIT}
read -r new
printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"session","configOptions":[{{"id":"model","category":"model","type":"select","currentValue":"alpha","options":[{{"value":"alpha","name":"Alpha"}},{{"value":"beta","name":"Beta"}}]}},{{"id":"reasoning_effort","category":"thought_level","type":"select","currentValue":"medium","options":[{{"value":"low","name":"Low"}},{{"value":"medium","name":"Medium"}}]}}]}}}}'
read -r change
case "$change" in *'"method":"session/set_config_option"'*'"value":"beta"'*) ;; *) exit 4 ;; esac
printf '%s\n' '{{"jsonrpc":"2.0","id":3,"result":{{"configOptions":[{{"id":"model","category":"model","type":"select","currentValue":"beta","options":[{{"value":"alpha","name":"Alpha"}},{{"value":"beta","name":"Beta"}}]}},{{"id":"reasoning_effort","category":"thought_level","type":"select","currentValue":"high","options":[{{"value":"medium","name":"Medium"}},{{"value":"high","name":"High"}}]}}]}}}}'
read -r close
case "$close" in *'"method":"session/close"'*) ;; *) exit 5 ;; esac
printf '%s\n' '{{"jsonrpc":"2.0","id":4,"result":{{}}}}'
read -r done
"#
    ));
    let result = discover(&context, "1.10.0", Some("beta"), &|| true).unwrap();
    assert_eq!(
        result.models.unwrap(),
        vec![
            Entry {
                id: "alpha".into(),
                name: "Alpha".into()
            },
            Entry {
                id: "beta".into(),
                name: "Beta".into()
            },
        ]
    );
    assert_eq!(result.resolved_model.as_deref(), Some("alpha"));
    assert_eq!(result.resolved_effort.as_deref(), Some("medium"));
    let effort = result.effort.unwrap();
    assert_eq!(effort.model, "beta");
    assert_eq!(effort.current.as_deref(), Some("high"));
    assert_eq!(effort.options[0].id, "medium");
}

#[test]
fn absent_catalog_is_unknown_and_present_empty_catalog_is_known() {
    for (config, expected) in [
        ("", None),
        (
            r#","configOptions":[{"id":"model","category":"model","type":"select","currentValue":"","options":[]}]"#,
            Some(Vec::new()),
        ),
    ] {
        let (_root, context) = context(&format!(
            r#"#!/bin/sh
read -r initialize
{INIT}
read -r new
printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"session"{config}}}}}'
read -r close
printf '%s\n' '{{"jsonrpc":"2.0","id":3,"result":{{}}}}'
read -r done
"#
        ));
        assert_eq!(
            discover(&context, "1.10.0", None, &|| true).unwrap().models,
            expected
        );
    }
}

#[test]
fn malformed_grouped_duplicate_and_oversized_metadata_are_rejected() {
    let without_effort = parse_options(Some(&json!([{
        "id":"model", "category":"model", "type":"select", "currentValue":"alpha",
        "options":[{"value":"alpha", "name":"Alpha"}]
    }])))
    .unwrap();
    assert!(without_effort.effort.is_none());

    let grouped = json!({
        "id":"model", "category":"model", "type":"select", "currentValue":"alpha",
        "options":[{"value":"alpha", "name":"Alpha", "group":"private"}]
    });
    assert_eq!(
        parse_options(Some(&json!([grouped]))).unwrap_err(),
        Failure::Incompatible
    );
    let duplicate = json!({
        "id":"model", "category":"model", "type":"select", "currentValue":"alpha",
        "options":[{"value":"alpha", "name":"A"}, {"value":"alpha", "name":"B"}]
    });
    assert_eq!(
        parse_options(Some(&json!([duplicate]))).unwrap_err(),
        Failure::Incompatible
    );
    let options: Vec<_> = (0..=MAX_MODELS)
        .map(|index| json!({"value":format!("m{index}"), "name":"Model"}))
        .collect();
    assert_eq!(
        parse_options(Some(&json!([{
            "id":"model", "category":"model", "type":"select",
            "currentValue":"m0", "options":options
        }])))
        .unwrap_err(),
        Failure::OutputLimit
    );
}

#[test]
fn rejected_or_unconfirmed_model_selection_is_not_exposed() {
    let (_root, context) = context(&format!(
        r#"#!/bin/sh
read -r initialize
{INIT}
read -r new
printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"session","configOptions":[{{"id":"model","category":"model","type":"select","currentValue":"alpha","options":[{{"value":"alpha","name":"Alpha"}},{{"value":"beta","name":"Beta"}}]}}]}}}}'
read -r change
printf '%s\n' '{{"jsonrpc":"2.0","id":3,"result":{{"configOptions":[{{"id":"model","category":"model","type":"select","currentValue":"alpha","options":[{{"value":"alpha","name":"Alpha"}},{{"value":"beta","name":"Beta"}}]}}]}}}}'
sleep 60
"#
    ));
    assert_eq!(
        discover(&context, "1.10.0", Some("beta"), &|| true),
        Err(Failure::Incompatible)
    );
}

fn alive(pid: &str) -> bool {
    std::process::Command::new("ps")
        .args(["-p", pid, "-o", "pid="])
        .output()
        .is_ok_and(|output| output.status.success() && !output.stdout.is_empty())
}

#[test]
fn production_discovery_retires_adapter_and_descendant() {
    let marker_root = tempfile::tempdir().unwrap();
    let marker = marker_root.path().join("processes");
    let (_root, context) = context(&format!(
        r#"#!/bin/sh
read -r initialize
{INIT}
read -r new
printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"session"}}}}'
read -r close
sleep 60 & helper=$!
printf '%s %s\n' "$$" "$helper" > '{}'
printf '%s\n' '{{"jsonrpc":"2.0","id":3,"result":{{}}}}'
wait
"#,
        marker.display()
    ));
    assert!(discover(&context, "1.10.0", None, &|| true).is_ok());
    let contents = std::fs::read_to_string(marker).unwrap();
    let pids: Vec<_> = contents.split_whitespace().collect();
    assert_eq!(pids.len(), 2);
    assert!(pids.iter().all(|pid| !alive(pid)));
}
