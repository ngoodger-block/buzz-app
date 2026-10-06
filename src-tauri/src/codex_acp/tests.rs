use super::*;
use std::time::Duration;
use std::{collections::BTreeMap, os::unix::fs::PermissionsExt, path::Path};

fn tool(path: &Path, body: &str) {
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}

fn make_context(adapter_body: &str) -> (tempfile::TempDir, CodexContext) {
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

#[test]
fn production_transport_initializes_exact_identity_and_retires() {
    let (_root, context) = make_context(
        r#"#!/bin/sh
IFS= read -r request
case "$request" in
  *'"method":"initialize"'*) ;;
  *) exit 2 ;;
esac
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"@agentclientprotocol/codex-acp","version":"1.10.0"}}}'
sleep 60
"#,
    );
    assert_eq!(initialize(&context, "1.10.0", &|| true), Ok(()));
}

#[test]
fn production_transport_rejects_unsolicited_client_requests() {
    let (_root, context) = make_context(
        r#"#!/bin/sh
IFS= read -r request
printf '%s\n' '{"jsonrpc":"2.0","id":90,"method":"fs/read_text_file","params":{"path":"private"}}'
sleep 60
"#,
    );
    assert_eq!(
        initialize(&context, "1.10.0", &|| true),
        Err(Failure::Incompatible)
    );
}

fn limits(deadline: Duration, output_bytes: usize) -> Limits {
    Limits {
        deadline,
        output_bytes,
        request_bytes: 16 * 1024,
        messages: 32,
    }
}

#[test]
fn production_transport_bounds_timeout_cancellation_and_output() {
    let (_root, context) = make_context("#!/bin/sh\nread -r request\nsleep 60\n");
    let timeout = run(
        &context,
        limits(Duration::from_millis(50), 4096),
        &|| true,
        |client| client.initialize("1.10.0", &|| true),
    );
    assert_eq!(timeout, Err(Failure::Timeout));

    let (_root, context) = make_context("#!/bin/sh\nread -r request\nsleep 60\n");
    let cancelled = run(
        &context,
        limits(Duration::from_secs(1), 4096),
        &|| false,
        |client| client.initialize("1.10.0", &|| false),
    );
    assert_eq!(cancelled, Err(Failure::Cancelled));

    let (_root, context) =
        make_context("#!/bin/sh\nread -r request\nprintf '12345678901234567890\\n'\nexit 0\n");
    let overflow = run(
        &context,
        limits(Duration::from_secs(1), 8),
        &|| true,
        |client| client.initialize("1.10.0", &|| true),
    );
    assert_eq!(overflow, Err(Failure::OutputLimit));
}
