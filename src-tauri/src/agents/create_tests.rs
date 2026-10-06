use super::*;
use std::sync::atomic::AtomicUsize;

#[derive(Default)]
struct MemoryCredentials {
    keys: Mutex<BTreeMap<String, Secret>>,
    denied: AtomicBool,
    adds: AtomicUsize,
    fail_record: Mutex<Option<PathBuf>>,
}
impl Credentials for MemoryCredentials {
    fn read_legacy(&self, _: LegacySource, _: &str) -> Result<Secret, String> {
        unreachable!()
    }
    fn read(&self, id: &str, pubkey: &str) -> Result<Option<Secret>, String> {
        if self.denied.load(Ordering::SeqCst) {
            return Err(IMPORT_GATE.into());
        }
        self.keys
            .lock()
            .unwrap()
            .get(id)
            .map(|key| Secret::parse(&key.hex(), pubkey))
            .transpose()
    }
    fn add(&self, id: &str, key: &Secret) -> Result<(), String> {
        self.adds.fetch_add(1, Ordering::SeqCst);
        self.keys
            .lock()
            .unwrap()
            .insert(id.into(), Secret::parse(&key.hex(), key.pubkey())?);
        if let Some(path) = self.fail_record.lock().unwrap().take() {
            std::fs::create_dir(path).unwrap();
        }
        Ok(())
    }
    fn delete(&self, id: &str, _: &str) -> Result<(), String> {
        self.keys.lock().unwrap().remove(id);
        Ok(())
    }
}

fn app_at(
    root: &std::path::Path,
    credentials: Arc<MemoryCredentials>,
) -> (
    AgentHost,
    tauri::App<MockRuntime>,
    tauri::WebviewWindow<MockRuntime>,
) {
    let host = AgentHost::open_with_credentials(
        Ok((
            root.join("store"),
            root.join("legacy"),
            root.join("workspace"),
        )),
        Err(RUNTIME_GATE.into()),
        credentials,
    );
    let app = mock_builder()
        .manage(host.clone())
        .manage(crate::harness_setup::HarnessSetup::default())
        .manage(crate::agent_models::ModelHost::new(Ok(root.join("store"))))
        .manage(Arc::new(crate::codex_readiness::Host::default()))
        .manage(Arc::new(crate::codex_validation::Host::default()))
        .manage(crate::identity::IdentityHost::fixture())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    (host, app, view)
}
fn edit(root: &std::path::Path, command: &str) -> Value {
    json!({"name":"Created", "systemPrompt":"", "workspace":root,
        "harness":{"command":command,"args":[],"model":"sample","provider":"sample"},"environment":{}})
}
fn request(view: &tauri::WebviewWindow<MockRuntime>, edit: &Value) -> Value {
    let owner = invoke(view, "identity_restore", json!({})).unwrap();
    json!({"requestId":uuid::Uuid::new_v4().to_string(),"destination":"wss://relay.example","owner":owner,"edit":edit})
}
fn authorize(view: &tauri::WebviewWindow<MockRuntime>, request: &Value, prepared: &Value) -> Value {
    invoke(view, "agent_control_create_authorize", json!({"destination":request["destination"],"owner":request["owner"],"pubkey":prepared["pubkey"]})).unwrap()
}
fn commit(
    view: &tauri::WebviewWindow<MockRuntime>,
    request: &Value,
    auth: &Value,
) -> Result<Value, Value> {
    invoke(
        view,
        "agent_control_create_commit",
        json!({"requestId":request["requestId"],"edit":request["edit"],"auth":auth.to_string()}),
    )
}

#[test]
fn credential_denial_keeps_existing_harness_create_retry_usable() {
    for command in ["buzz-agent", "goose", "/fixture/buzz-pi-acp"] {
        let root = tempfile::tempdir().unwrap();
        let credentials = Arc::new(MemoryCredentials::default());
        let (_host, _app, view) = app_at(root.path(), credentials.clone());
        let request = request(&view, &edit(root.path(), command));
        let prepared = invoke(&view, "agent_control_create_prepare", request.clone()).unwrap();
        let auth = authorize(&view, &request, &prepared);
        credentials.denied.store(true, Ordering::SeqCst);
        assert_eq!(
            commit(&view, &request, &auth).unwrap_err(),
            json!(IMPORT_GATE)
        );
        assert!(invoke(&view, "agent_control_create_recovery", json!({}))
            .unwrap()
            .is_null());
        credentials.denied.store(false, Ordering::SeqCst);
        let retried = invoke(&view, "agent_control_create_prepare", request.clone()).unwrap();
        assert_eq!(retried, prepared);
        let result = commit(&view, &request, &auth).unwrap();
        assert_eq!(result["agents"].as_array().unwrap().len(), 1);
        assert_eq!(result["agents"][0]["id"], prepared["id"]);
        assert_eq!(credentials.adds.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn committed_create_survives_response_failure_and_fresh_host_retry() {
    let root = tempfile::tempdir().unwrap();
    let credentials = Arc::new(MemoryCredentials::default());
    let (host, app, view) = app_at(root.path(), credentials.clone());
    let request = request(&view, &edit(root.path(), "buzz-agent"));
    let prepared = invoke(&view, "agent_control_create_prepare", request.clone()).unwrap();
    let auth = authorize(&view, &request, &prepared);
    // Agent persistence succeeds; the following snapshot cannot read defaults.
    std::fs::write(root.path().join("store/defaults.json"), "invalid").unwrap();
    assert!(commit(&view, &request, &auth).is_err());
    std::fs::remove_file(root.path().join("store/defaults.json")).unwrap();
    // The mock app retains State clones; explicitly drop the entire native host.
    *host.0.lock().unwrap() = Err("Simulated app termination".into());
    drop(view);
    drop(app);
    drop(host);
    let (_host, _app, view) = app_at(root.path(), credentials.clone());
    let replay = invoke(&view, "agent_control_create_prepare", request.clone()).unwrap();
    assert_eq!(replay["id"], prepared["id"]);
    assert_eq!(replay["completed"], true);
    let snapshot = commit(&view, &request, &auth).unwrap();
    assert_eq!(snapshot["agents"].as_array().unwrap().len(), 1);
    assert_eq!(credentials.adds.load(Ordering::SeqCst), 1);
    let mut changed = request.clone();
    changed["edit"]["name"] = json!("Different");
    assert!(invoke(&view, "agent_control_create_prepare", changed).is_err());
    let mut other_owner = request.clone();
    other_owner["owner"] = json!("ab".repeat(32));
    assert!(invoke(&view, "agent_control_create_prepare", other_owner).is_err());
}

#[cfg(unix)]
fn codex_edit(root: &std::path::Path) -> Value {
    let mut edit = edit(root, root.join("tools/codex-acp").to_str().unwrap());
    edit["harness"]["integration"] = json!("codex");
    edit["harness"]["configuration"] = json!({"mode":"default"});
    edit["harness"]["model"] = json!("");
    edit["harness"]["provider"] = json!("");
    edit
}

#[cfg(unix)]
fn validate(view: &tauri::WebviewWindow<MockRuntime>, request: &Value) -> Result<Value, Value> {
    let ticket = invoke(view, "codex_validation_begin", json!({})).unwrap();
    invoke(
        view,
        "codex_validation_run",
        json!({"ticket":ticket,"request":request}),
    )
}

#[test]
#[cfg(unix)]
fn codex_native_admission_and_recovery_survive_a_fresh_host() {
    use std::os::unix::fs::PermissionsExt;
    const ROOT: &str = "BUZZ_TEST_NATIVE_CREATE_ROOT";
    // Isolate installed-tool discovery in a child test process. No global env
    // mutation, real CLI/account, relay, or platform credential store is used.
    let Ok(root) = std::env::var(ROOT) else {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("tools")).unwrap();
        for (name, script) in [
            (
                "codex",
                "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'codex-cli 0.151.0'; fi\n",
            ),
            (
                "codex-acp",
                r#"#!/bin/sh
if [ "$1" = --version ]; then echo '@agentclientprotocol/codex-acp 1.10.0'; exit; fi
read -r initialize
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"@agentclientprotocol/codex-acp","version":"1.10.0"}}}'
read -r new
printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"synthetic"}}'
read -r prompt
if [ -f "$HOME/reject" ]; then
  printf '%s\n' '{"jsonrpc":"2.0","id":3,"error":{"code":-32603,"message":"hidden","data":{"codexErrorInfo":"usageLimitExceeded"}}}'
else
  printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"synthetic","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"OK"}}}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn","usage":{"totalTokens":2,"outputTokens":1}}}'
fi
read -r close
printf '%s\n' '{"jsonrpc":"2.0","id":4,"result":{}}'
read -r done
"#,
            ),
        ] {
            let source = root.path().join(format!("{name}.sh"));
            let tool = root.path().join("tools").join(name);
            std::fs::write(&source, script).unwrap();
            assert!(std::process::Command::new("/bin/cp")
                .args([&source, &tool])
                .status()
                .unwrap()
                .success());
            std::fs::set_permissions(tool, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "agents::tests::creation::codex_native_admission_and_recovery_survive_a_fresh_host",
                "--nocapture",
            ])
            .env(ROOT, root.path())
            .env("HOME", root.path())
            .env("CODEX_HOME", root.path())
            .env_remove("CODEX_CONFIG")
            .env(
                "PATH",
                std::env::join_paths([
                    root.path().join("tools"),
                    PathBuf::from("/usr/bin"),
                    PathBuf::from("/bin"),
                ])
                .unwrap(),
            )
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    };
    let root = PathBuf::from(root);
    let credentials = Arc::new(MemoryCredentials::default());
    let expected_id = {
        let (host, _app, view) = app_at(&root, credentials.clone());
        let mut request = request(&view, &codex_edit(&root));
        std::fs::write(root.join("reject"), "").unwrap();
        assert_eq!(validate(&view, &request).unwrap_err()["category"], "quota");
        assert!(invoke(&view, "agent_control_create_prepare", request.clone()).is_err());
        assert!(host.with(|host| Ok(host.creating.is_none())).unwrap());
        assert!(!root.join("store/agents.json").exists());
        assert_eq!(credentials.adds.load(Ordering::SeqCst), 0);
        std::fs::remove_file(root.join("reject")).unwrap();
        // A cancelled proof cannot prepare an identity.
        let ticket = invoke(&view, "codex_validation_begin", json!({})).unwrap();
        let proof = invoke(
            &view,
            "codex_validation_run",
            json!({"ticket":ticket,"request":request}),
        )
        .unwrap();
        invoke(&view, "codex_validation_cancel", json!({"ticket":ticket})).unwrap();
        request["validationProof"] = proof["proof"].clone();
        assert!(invoke(&view, "agent_control_create_prepare", request.clone()).is_err());
        request.as_object_mut().unwrap().remove("validationProof");
        let proof = validate(&view, &request).unwrap();
        let mut changed = request.clone();
        changed["edit"]["systemPrompt"] = json!("Changed after validation");
        changed["validationProof"] = proof["proof"].clone();
        assert!(invoke(&view, "agent_control_create_prepare", changed).is_err());
        let mut consumed = request.clone();
        consumed["validationProof"] = proof["proof"].clone();
        assert!(invoke(&view, "agent_control_create_prepare", consumed).is_err());
        let proof = validate(&view, &request).unwrap();
        request["validationProof"] = proof["proof"].clone();
        let prepared = invoke(&view, "agent_control_create_prepare", request.clone()).unwrap();
        let auth = authorize(&view, &request, &prepared);
        // Fail the record write after the key is durable, leaving only the
        // on-disk journal and synthetic secure storage for the next host.
        *credentials.fail_record.lock().unwrap() = Some(root.join("store/agents.previous.json"));
        assert!(commit(&view, &request, &auth).is_err());
        assert!(invoke(&view, "agent_control_create_recovery", json!({}))
            .unwrap()
            .is_object());
        assert_eq!(credentials.adds.load(Ordering::SeqCst), 1);
        *host.0.lock().unwrap() = Err("Simulated app termination".into());
        prepared["id"].clone()
    };
    std::fs::remove_dir(root.join("store/agents.previous.json")).unwrap();
    let (_host, _app, view) = app_at(&root, credentials.clone());
    let recovery = invoke(&view, "agent_control_create_recovery", json!({})).unwrap();
    let auth = authorize(&view, &recovery, &recovery);
    // Signing again demonstrably changes bytes; both authorize the same key.
    assert_ne!(auth, authorize(&view, &recovery, &recovery));
    let mut edit = codex_edit(&root);
    edit["name"] = json!("Changed");
    let resume = |edit: Value, auth: &Value| {
        invoke(
            &view,
            "agent_control_create_resume",
            json!({"requestId":recovery["requestId"],"edit":edit,"auth":auth.to_string()}),
        )
    };
    assert!(resume(edit, &auth).is_err());
    let mut forged = auth.clone();
    forged[3] = json!("00".repeat(64));
    assert!(resume(codex_edit(&root), &forged).is_err());
    let result = resume(codex_edit(&root), &auth).unwrap();
    assert_eq!(result["agents"].as_array().unwrap().len(), 1);
    assert_eq!(result["agents"][0]["id"], expected_id);
    assert_eq!(credentials.adds.load(Ordering::SeqCst), 1);
    assert!(invoke(&view, "agent_control_create_recovery", json!({}))
        .unwrap()
        .is_null());
    // Exercise Edit admission through the same invoke boundary. A failure
    // preserves the saved revision; a proof admits only the revision tested.
    let before = result["agents"][0].clone();
    let mut edit = codex_edit(&root);
    edit["systemPrompt"] = json!("Validated instructions");
    let mut validation = json!({"requestId":uuid::Uuid::new_v4().to_string(),"id":expected_id,
        "expectedRevision":before["revision"],"edit":edit});
    std::fs::write(root.join("reject"), "").unwrap();
    assert_eq!(
        validate(&view, &validation).unwrap_err()["category"],
        "quota"
    );
    assert!(invoke(
        &view,
        "agent_control_save",
        json!({"id":expected_id,"expectedRevision":before["revision"],"edit":edit})
    )
    .is_err());
    assert_eq!(
        invoke(&view, "agent_control_snapshot", json!({})).unwrap()["agents"][0],
        before
    );
    std::fs::remove_file(root.join("reject")).unwrap();
    let proof = validate(&view, &validation).unwrap();
    let mut name_only = codex_edit(&root);
    name_only["name"] = json!("Renamed");
    let renamed = invoke(
        &view,
        "agent_control_save",
        json!({"id":expected_id,"expectedRevision":before["revision"],"edit":name_only}),
    )
    .unwrap();
    assert!(invoke(
        &view,
        "agent_control_save",
        json!({"id":expected_id,"expectedRevision":before["revision"],"edit":edit,
        "validationRequestId":validation["requestId"],"validationProof":proof["proof"]})
    )
    .is_err());
    assert_eq!(
        invoke(&view, "agent_control_snapshot", json!({})).unwrap()["agents"],
        renamed["agents"]
    );
    validation["expectedRevision"] = renamed["agents"][0]["revision"].clone();
    let proof = validate(&view, &validation).unwrap();
    let saved = invoke(
        &view,
        "agent_control_save",
        json!({"id":expected_id,"expectedRevision":validation["expectedRevision"],"edit":edit,
        "validationRequestId":validation["requestId"],"validationProof":proof["proof"]}),
    )
    .unwrap();
    assert_eq!(saved["agents"][0]["systemPrompt"], "Validated instructions");
    assert_eq!(
        saved["agents"][0]["revision"],
        renamed["agents"][0]["revision"].as_u64().unwrap() + 1
    );
}
