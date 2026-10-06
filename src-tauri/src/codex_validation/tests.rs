use super::*;
use buzz_agent_controller::{AiConfiguration, EffortSelection};
use std::{collections::BTreeMap, os::unix::fs::PermissionsExt, path::Path};

fn tool(path: &Path, body: &str) {
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}

fn context(
    adapter_body: &str,
) -> (
    tempfile::TempDir,
    buzz_agent_controller::codex::CodexContext,
) {
    let root = tempfile::tempdir().unwrap();
    let adapter = root.path().join("codex-acp");
    let cli = root.path().join("codex");
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    tool(&adapter, adapter_body);
    tool(&cli, "#!/bin/sh\nexit 0\n");
    let context = buzz_agent_controller::codex::CodexContext::new(
        &adapter,
        &cli,
        &workspace,
        &BTreeMap::new(),
    )
    .unwrap();
    (root, context)
}

const INIT: &str = r#"printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"@agentclientprotocol/codex-acp","version":"1.10.0"}}}'"#;

#[test]
fn default_validation_sends_no_configuration_override_and_proves_inference() {
    let (_root, context) = context(&format!(
        r#"#!/bin/sh
read -r initialize
{INIT}
read -r new
case "$new" in *'"method":"session/new"'*'"mcpServers":[]'*) ;; *) exit 3 ;; esac
printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"validated"}}}}'
read -r prompt
case "$prompt" in *'"method":"session/prompt"'*) ;; *'session/set_config_option'*) exit 4 ;; *) exit 5 ;; esac
printf '%s\n' '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"validated","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"OK"}}}}}}}}'
printf '%s\n' '{{"jsonrpc":"2.0","id":3,"result":{{"stopReason":"end_turn","usage":{{"totalTokens":2,"inputTokens":1,"outputTokens":1}}}}}}'
read -r close
case "$close" in *'"method":"session/close"'*) ;; *) exit 6 ;; esac
printf '%s\n' '{{"jsonrpc":"2.0","id":4,"result":{{}}}}'
read -r done
"#
    ));
    assert_eq!(
        validate_inference(&context, "", &AiConfiguration::Default, "1.10.0", &|| true),
        Ok(())
    );
}

#[test]
fn advanced_validation_confirms_model_then_effort_before_inference() {
    let options = |model: &str, effort: &str| {
        format!(
            r#"[{{"id":"model","category":"model","type":"select","currentValue":"{model}","options":[{{"value":"alpha","name":"Alpha"}},{{"value":"beta","name":"Beta"}}]}},{{"id":"reasoning_effort","category":"thought_level","type":"select","currentValue":"{effort}","options":[{{"value":"low","name":"Low"}},{{"value":"high","name":"High"}}]}}]"#
        )
    };
    let initial = options("alpha", "low");
    let model = options("beta", "low");
    let effort = options("beta", "high");
    let (_root, context) = context(&format!(
        r#"#!/bin/sh
read -r initialize
{INIT}
read -r new
printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"validated","configOptions":{initial}}}}}'
read -r set_model
case "$set_model" in *'"configId":"model"'*'"value":"beta"'*) ;; *) exit 3 ;; esac
printf '%s\n' '{{"jsonrpc":"2.0","id":3,"result":{{"configOptions":{model}}}}}'
read -r set_effort
case "$set_effort" in *'"configId":"reasoning_effort"'*'"value":"high"'*) ;; *) exit 4 ;; esac
printf '%s\n' '{{"jsonrpc":"2.0","id":4,"result":{{"configOptions":{effort}}}}}'
read -r prompt
case "$prompt" in *'"method":"session/prompt"'*) ;; *) exit 5 ;; esac
printf '%s\n' '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"validated","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"OK"}}}}}}}}'
printf '%s\n' '{{"jsonrpc":"2.0","id":5,"result":{{"stopReason":"end_turn","usage":{{"totalTokens":2,"inputTokens":1,"outputTokens":1}}}}}}'
read -r close
printf '%s\n' '{{"jsonrpc":"2.0","id":6,"result":{{}}}}'
read -r done
"#
    ));
    let configuration = AiConfiguration::Advanced {
        effort: EffortSelection::Value {
            value: "high".into(),
        },
    };
    assert_eq!(
        validate_inference(&context, "beta", &configuration, "1.10.0", &|| true),
        Ok(())
    );
}

#[test]
fn terminal_failure_metadata_prevents_false_success() {
    let (_root, context) = context(&format!(
        r#"#!/bin/sh
read -r initialize
{INIT}
read -r new
printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"validated"}}}}'
read -r prompt
printf '%s\n' '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"validated","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"OK"}}}}}}}}'
printf '%s\n' '{{"jsonrpc":"2.0","id":3,"result":{{"stopReason":"end_turn","usage":{{"totalTokens":2,"inputTokens":1,"outputTokens":1}},"_meta":{{"jetbrains":{{"air":{{"sessionFailure":{{"id":"failure","revision":1,"category":"limit","severity":"error","title":"hidden","actions":[]}}}}}}}}}}}}'
sleep 60
"#
    ));
    assert_eq!(
        validate_inference(&context, "", &AiConfiguration::Default, "1.10.0", &|| true),
        Err(crate::codex_acp::Failure::Limit)
    );
}

#[test]
fn latest_begin_is_authoritative_and_old_cancel_does_not_cancel_it() {
    let host = Host::default();
    let first = host.begin().unwrap();
    let second = host.begin().unwrap();
    assert!(!host.current(first));
    assert!(host.current(second));
    host.cancel(first);
    assert!(host.current(second));
    host.cancel(second);
    assert!(!host.current(second));
}

#[test]
#[ignore = "requires the locally installed Codex CLI, adapter, and account"]
fn installed_default_validation_completes_real_inference() {
    let workspace = tempfile::tempdir().unwrap();
    let adapter = std::env::var_os("BUZZ_TEST_CODEX_ADAPTER")
        .map(std::path::PathBuf::from)
        .expect("set BUZZ_TEST_CODEX_ADAPTER to an installed adapter");
    let cli = std::env::var_os("BUZZ_TEST_CODEX_CLI")
        .map(std::path::PathBuf::from)
        .expect("set BUZZ_TEST_CODEX_CLI to an installed CLI");
    let context = buzz_agent_controller::codex::CodexContext::new(
        &adapter,
        &cli,
        workspace.path(),
        &BTreeMap::new(),
    )
    .unwrap();
    validate_inference(&context, "", &AiConfiguration::Default, "1.10.0", &|| true).unwrap();
}
