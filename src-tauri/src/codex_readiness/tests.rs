use super::*;

#[test]
#[cfg(unix)]
fn version_parser_accepts_only_three_numeric_components() {
    assert_eq!(
        parse_version("codex-cli 0.151.0\n", &["codex-cli "]),
        Some("0.151.0".into())
    );
    assert_eq!(
        parse_version(
            "@agentclientprotocol/codex-acp 1.10.0",
            &["@agentclientprotocol/codex-acp "]
        ),
        Some("1.10.0".into())
    );
    assert_eq!(parse_version("codex-cli 0.151", &["codex-cli "]), None);
    assert_eq!(
        parse_version(
            "fake-codex-acp 1.10.0",
            &["@agentclientprotocol/codex-acp "]
        ),
        None
    );
}

#[test]
fn tickets_are_single_use_and_cancellation_never_targets_a_future_ticket() {
    let host = Host::default();
    host.cancel(1);
    let first = host.begin().unwrap();
    assert_eq!(first, 1);
    let first_cancelled = host.claim(first).unwrap();
    assert!(!first_cancelled.load(Ordering::SeqCst));
    assert!(host.claim(first).is_err());

    let second = host.begin().unwrap();
    assert_eq!(second, 2);
    assert!(first_cancelled.load(Ordering::SeqCst));
    let second_cancelled = host.claim(second).unwrap();
    host.cancel(99);
    assert!(!second_cancelled.load(Ordering::SeqCst));
    host.cancel(second);
    assert!(second_cancelled.load(Ordering::SeqCst));
}

#[test]
fn shutdown_waits_for_running_work_to_retire() {
    let host = Arc::new(Host::default());
    let ticket = host.begin().unwrap();
    host.claim(ticket).unwrap();
    host.started(ticket).unwrap();
    let ready = Arc::new(std::sync::Barrier::new(2));
    let (release, retirement) = std::sync::mpsc::channel();
    let worker = host.clone();
    let worker_ready = ready.clone();
    let worker = std::thread::spawn(move || {
        worker_ready.wait();
        retirement.recv().unwrap();
        drop(Finish {
            owner: worker,
            ticket,
            cleanup_failed: false,
        });
    });
    ready.wait();
    let (completed, completion) = std::sync::mpsc::channel();
    let shutdown_host = host.clone();
    let shutdown = std::thread::spawn(move || {
        completed.send(shutdown_host.shutdown()).unwrap();
    });
    while !host.closed.load(Ordering::SeqCst) {
        std::thread::yield_now();
    }
    assert!(matches!(
        completion.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));
    release.send(()).unwrap();
    completion.recv().unwrap().unwrap();
    worker.join().unwrap();
    shutdown.join().unwrap();
    assert!(host.begin().is_err());
}

#[test]
fn shutdown_between_claim_and_start_refuses_late_work() {
    let host = Host::default();
    let ticket = host.begin().unwrap();
    host.claim(ticket).unwrap();
    host.shutdown().unwrap();
    assert!(host.started(ticket).is_err());
}

#[test]
fn cleanup_failure_is_sticky_for_shutdown_and_future_admission() {
    let host = Host::default();
    let ticket = host.begin().unwrap();
    host.claim(ticket).unwrap();
    host.started(ticket).unwrap();
    host.finished(ticket, true);
    assert!(host.begin().is_err());
    assert!(host.shutdown().is_err());
}

#[test]
#[cfg(unix)]
fn owned_worker_panic_retires_with_sticky_cleanup_failure() {
    let host = Arc::new(Host::default());
    let ticket = host.begin_owned().unwrap();
    let worker = host.clone();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let _: Result<(), Readiness> = run_owned(
            worker,
            ticket,
            || Readiness::failed("cancelled", "cancelled"),
            |_| false,
            |_| panic!("synthetic owned readiness failure"),
        );
    }));
    assert!(result.is_err());
    assert_eq!(
        host.retirement().unwrap_err(),
        "Codex readiness cleanup could not be confirmed"
    );
    assert!(host.begin_owned().is_err());
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::collections::BTreeMap;
    use std::os::unix::fs::PermissionsExt;

    struct Script {
        _directory: tempfile::TempDir,
        path: std::path::PathBuf,
    }

    impl Script {
        fn path(&self) -> &std::path::Path {
            &self.path
        }
    }

    fn script(body: &str) -> Script {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("probe");
        std::fs::write(&path, body).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        Script {
            _directory: directory,
            path,
        }
    }

    fn fixture_context(adapter_body: &str, cli_body: &str) -> (tempfile::TempDir, CodexContext) {
        let root = tempfile::tempdir().unwrap();
        let adapter = root.path().join("codex-acp");
        let cli = root.path().join("codex");
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        for (path, body) in [(&adapter, adapter_body), (&cli, cli_body)] {
            std::fs::write(path, body).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let context = CodexContext::new(&adapter, &cli, &workspace, &BTreeMap::new()).unwrap();
        (root, context)
    }

    const ADAPTER: &str = r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '@agentclientprotocol/codex-acp 1.10.0\n'
  exit 0
fi
IFS= read -r request
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"@agentclientprotocol/codex-acp","version":"1.10.0"}}}'
sleep 60
"#;
    const CLI: &str = r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'codex-cli 0.151.0\n'
elif [ "$1" = "login" ] && [ "$2" = "status" ]; then
  printf 'Logged in\n'
else
  exit 1
fi
"#;

    #[test]
    fn production_readiness_seam_distinguishes_binding_and_failures() {
        assert_eq!(
            resolution_failure("Codex adapter and CLI scripts require Node.js").status,
            "interpreter-needed"
        );
        assert_eq!(
            resolution_failure("Codex ACP adapter not found").status,
            "adapter-needed"
        );
        assert_eq!(
            resolution_failure("Codex CLI not found").status,
            "cli-needed"
        );
        assert_eq!(
            resolution_failure("CODEX_CONFIG is not supported").status,
            "configuration-error"
        );

        let (_root, ready) = fixture_context(ADAPTER, CLI);
        let result = check_context(ready, &|| true).unwrap();
        assert_eq!(result.status, "binding-ready");
        assert_eq!(result.adapter_version.as_deref(), Some("1.10.0"));
        assert_eq!(result.cli_version.as_deref(), Some("0.151.0"));

        let old = ADAPTER.replace("1.10.0", "0.16.0");
        let (_root, context) = fixture_context(&old, CLI);
        assert_eq!(
            check_context(context, &|| true).unwrap().status,
            "adapter-incompatible"
        );

        let signed_out = CLI.replace(
            "printf 'Logged in\\n'",
            "printf 'Not logged in\\n' >&2; exit 1",
        );
        let (_root, context) = fixture_context(ADAPTER, &signed_out);
        assert_eq!(
            check_context(context, &|| true).unwrap().status,
            "signed-out"
        );

        let broken = CLI.replace(
            "printf 'Logged in\\n'",
            "printf 'invalid config' >&2; exit 1",
        );
        let (_root, context) = fixture_context(ADAPTER, &broken);
        assert_eq!(
            check_context(context, &|| true).unwrap().status,
            "configuration-error"
        );

        let wrong_handshake = ADAPTER.replace("\"version\":\"1.10.0\"", "\"version\":\"2.0.0\"");
        let (_root, context) = fixture_context(&wrong_handshake, CLI);
        assert_eq!(
            check_context(context, &|| true).unwrap().status,
            "adapter-incompatible"
        );

        let wrong_identity = ADAPTER.replace(
            "\"name\":\"@agentclientprotocol/codex-acp\"",
            "\"name\":\"lookalike-codex-acp\"",
        );
        let (_root, context) = fixture_context(&wrong_identity, CLI);
        assert_eq!(
            check_context(context, &|| true).unwrap().status,
            "adapter-incompatible"
        );
    }

    #[test]
    fn production_readiness_seam_bounds_output_and_honors_cancellation() {
        let flood = r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  while :; do printf 1234567890; done
fi
"#;
        let (_root, context) = fixture_context(flood, CLI);
        assert_eq!(
            check_context(context, &|| true).unwrap().status,
            "output-limit"
        );

        let (_root, context) = fixture_context(ADAPTER, CLI);
        assert_eq!(
            check_context(context, &|| false).unwrap().status,
            "cancelled"
        );

        let hanging = script("#!/bin/sh\nsleep 60\n");
        assert_eq!(
            readiness_probe(Command::new(hanging.path()), &[], &|| true)
                .err()
                .unwrap()
                .status,
            "timeout"
        );
    }

    #[test]
    #[ignore = "requires explicitly selected installed Codex CLI/adapter; no session or inference"]
    fn selected_production_binding() {
        let adapter = std::env::var_os("BUZZ_TEST_CODEX_ADAPTER").unwrap();
        let cli = std::env::var_os("BUZZ_TEST_CODEX_CLI").unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let context = CodexContext::new(
            std::path::Path::new(&adapter),
            std::path::Path::new(&cli),
            workspace.path(),
            &BTreeMap::new(),
        )
        .unwrap();
        let result = check_context(context, &|| true).unwrap();
        assert_eq!(result.status, "binding-ready", "{}", result.message);
        eprintln!(
            "Codex binding verified: adapter {}; CLI {}",
            result.adapter_version.as_deref().unwrap_or("unknown"),
            result.cli_version.as_deref().unwrap_or("unknown")
        );
    }

    #[test]
    fn bounded_probe_reports_success_failure_timeout_and_cancellation() {
        let success = script("#!/bin/sh\nprintf 'codex-cli 0.151.0\\n'\n");
        let output = probe(Command::new(success.path()), &[], PROBE_TIMEOUT, &|| true).unwrap();
        assert!(output.success);
        assert_eq!(output.stdout, "codex-cli 0.151.0\n");

        let failure = script("#!/bin/sh\nprintf 'private detail' >&2\nexit 1\n");
        let output = probe(Command::new(failure.path()), &[], PROBE_TIMEOUT, &|| true).unwrap();
        assert!(!output.success);
        assert_eq!(output.stderr, "private detail");

        let hanging = script("#!/bin/sh\nsleep 60\n");
        assert!(probe(
            Command::new(hanging.path()),
            &[],
            Duration::from_millis(30),
            &|| true,
        )
        .err()
        .unwrap()
        .contains("timed out"));
        assert!(
            probe(Command::new(hanging.path()), &[], PROBE_TIMEOUT, &|| false)
                .err()
                .unwrap()
                .contains("cancelled")
        );

        let marker = tempfile::NamedTempFile::new().unwrap();
        let tree = script("#!/bin/sh\nsleep 60 &\nprintf '%s %s' \"$$\" \"$!\" > \"$1\"\nwait\n");
        let marker_path = marker.path().to_string_lossy().into_owned();
        let current = || {
            std::fs::read_to_string(marker.path())
                .map(|value| value.split_whitespace().count() != 2)
                .unwrap_or(true)
        };
        assert!(probe(
            Command::new(tree.path()),
            &[&marker_path],
            PROBE_TIMEOUT,
            &current,
        )
        .err()
        .unwrap()
        .contains("cancelled"));
        let pids = std::fs::read_to_string(marker.path()).unwrap();
        let pids: Vec<_> = pids.split_whitespace().collect();
        assert_eq!(pids.len(), 2);
        for pid in pids {
            assert!(!Command::new("/bin/ps")
                .args(["-p", pid, "-o", "pid="])
                .output()
                .unwrap()
                .status
                .success());
        }
    }

    #[test]
    fn bounded_probe_stops_output_floods() {
        let flooding = script("#!/bin/sh\nwhile :; do printf 1234567890; done\n");
        assert!(
            probe(Command::new(flooding.path()), &[], PROBE_TIMEOUT, &|| true)
                .err()
                .unwrap()
                .contains("output exceeded")
        );

        let finite = script(
            "#!/bin/sh\ni=0\nwhile [ \"$i\" -lt 7000 ]; do printf 1234567890; i=$((i + 1)); done\n",
        );
        assert!(
            probe(Command::new(finite.path()), &[], PROBE_TIMEOUT, &|| true)
                .err()
                .unwrap()
                .contains("output exceeded")
        );
    }
}
