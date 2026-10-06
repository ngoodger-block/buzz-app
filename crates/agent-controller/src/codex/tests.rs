use super::*;
use std::os::unix::fs::PermissionsExt;

fn tool(path: &Path, body: &str) {
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn canonical_binding_uses_one_exact_context_for_adapter_and_cli() {
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("bin");
    let workspace = root.path().join("workspace");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir(&workspace).unwrap();
    tool(&bin.join("node"), "#!/bin/sh\nexit 0\n");
    tool(&bin.join("codex-acp"), "#!/usr/bin/env node\n");
    tool(&bin.join("codex"), "#!/usr/bin/env node\n");
    let context = CodexContext::new(
        &bin.join("codex-acp"),
        &bin.join("codex"),
        &workspace,
        &BTreeMap::new(),
    )
    .unwrap();
    assert_eq!(
        context.interpreter,
        Some(bin.join("node").canonicalize().unwrap())
    );
    for command in [context.adapter_command(), context.cli_command()] {
        assert_eq!(
            command.get_current_dir(),
            Some(workspace.canonicalize().unwrap().as_path())
        );
        let env: BTreeMap<_, _> = command
            .get_envs()
            .filter_map(|(key, value)| value.map(|value| (key, value)))
            .collect();
        assert_eq!(
            env[OsStr::new("CODEX_PATH")],
            bin.join("codex").canonicalize().unwrap()
        );
        assert_eq!(
            env[OsStr::new("INITIAL_AGENT_MODE")],
            OsStr::new("agent-full-access")
        );
        assert!(!env.contains_key(OsStr::new("OPENAI_API_KEY")));
    }
}

#[test]
fn adapter_launches_the_exact_selected_cli_with_the_isolated_path() {
    let root = tempfile::tempdir().unwrap();
    let adapter_bin = root.path().join("adapter-bin");
    let cli_bin = root.path().join("cli-bin");
    let workspace = root.path().join("workspace");
    std::fs::create_dir_all(&adapter_bin).unwrap();
    std::fs::create_dir_all(&cli_bin).unwrap();
    std::fs::create_dir(&workspace).unwrap();
    let marker = root.path().join("selected-cli");
    tool(
        &adapter_bin.join("codex-acp"),
        "#!/bin/sh\n\"$CODEX_PATH\" --version\n",
    );
    tool(&cli_bin.join("node"), "#!/bin/sh\nexec /bin/sh \"$@\"\n");
    tool(
        &cli_bin.join("codex"),
        &format!(
            "#!/usr/bin/env node\nprintf selected > '{}'\n",
            marker.display()
        ),
    );
    let context = CodexContext::new(
        &adapter_bin.join("codex-acp"),
        &cli_bin.join("codex"),
        &workspace,
        &BTreeMap::new(),
    )
    .unwrap();
    assert!(context.adapter_command().status().unwrap().success());
    assert_eq!(std::fs::read_to_string(marker).unwrap(), "selected");
}

#[test]
fn adapter_uses_the_cli_bound_interpreter_when_interpreters_differ() {
    let root = tempfile::tempdir().unwrap();
    let adapter_bin = root.path().join("adapter-bin");
    let adapter_runtime = root.path().join("adapter-runtime");
    let cli_bin = root.path().join("cli-bin");
    let workspace = root.path().join("workspace");
    for directory in [&adapter_bin, &adapter_runtime, &cli_bin, &workspace] {
        std::fs::create_dir_all(directory).unwrap();
    }
    let adapter = adapter_bin.join("codex-acp");
    let cli = cli_bin.join("codex");
    let adapter_node = adapter_runtime.join("node");
    tool(
        &adapter_node,
        "#!/bin/sh\ncase \"$1\" in */codex-acp) ;; *) exit 9 ;; esac\nexec /bin/sh \"$@\"\n",
    );
    tool(
        &adapter,
        &format!("#!{}\n\"$CODEX_PATH\" --version\n", adapter_node.display()),
    );
    tool(
        &adapter_bin.join("node"),
        "#!/bin/sh\nexec /bin/sh \"$@\"\n",
    );
    tool(&cli, "#!/usr/bin/env node\nprintf cli-interpreter\n");
    let context = CodexContext::new(&adapter, &cli, &workspace, &BTreeMap::new()).unwrap();
    let output = context.adapter_command().output().unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(output.stdout, b"cli-interpreter");
}

#[test]
fn rejects_unsupported_or_unresolved_interpreters_and_context() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let adapter = root.path().join("codex-acp");
    let cli = root.path().join("codex");
    tool(&cli, "#!/bin/sh\nexit 0\n");
    for body in ["#!/usr/bin/env -S node\n", "#!relative\n", "#!"] {
        tool(&adapter, body);
        assert!(CodexContext::new(&adapter, &cli, &workspace, &BTreeMap::new()).is_err());
    }
    let mut overrides = BTreeMap::from([("SECRET".into(), "value".into())]);
    tool(&adapter, "#!/bin/sh\nexit 0\n");
    assert!(CodexContext::new(&adapter, &cli, &workspace, &overrides).is_err());
    overrides = BTreeMap::from([("CODEX_CONFIG".into(), "{}".into())]);
    assert!(CodexContext::new(&adapter, &cli, &workspace, &overrides).is_err());
}

#[test]
fn rejects_adapter_paths_or_arguments_that_buzz_acp_cannot_represent() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let cli = root.path().join("codex");
    tool(&cli, "#!/bin/sh\nexit 0\n");
    for name in ["codex,acp", " codex-acp "] {
        let adapter = root.path().join(name);
        tool(&adapter, "#!/bin/sh\nexit 0\n");
        assert!(CodexContext::new(&adapter, &cli, &workspace, &BTreeMap::new()).is_err());
    }
    let adapter = root.path().join("codex-acp");
    tool(&adapter, "#!/bin/sh\nexit 0\n");
    let context = CodexContext::new(&adapter, &cli, &workspace, &BTreeMap::new()).unwrap();
    assert!(context.adapter_launch(&["--model=other".into()]).is_err());
}

#[test]
fn binding_equality_fences_path_workspace_and_configuration_context() {
    let root = tempfile::tempdir().unwrap();
    let first = root.path().join("first");
    let second = root.path().join("second");
    std::fs::create_dir(&first).unwrap();
    std::fs::create_dir(&second).unwrap();
    let adapter = root.path().join("codex-acp");
    let cli = root.path().join("codex");
    tool(&adapter, "#!/bin/sh\nexit 0\n");
    tool(&cli, "#!/bin/sh\nexit 0\n");
    let base = CodexContext::new(&adapter, &cli, &first, &BTreeMap::new()).unwrap();
    assert!(base == CodexContext::new(&adapter, &cli, &first, &BTreeMap::new()).unwrap());
    assert!(base != CodexContext::new(&adapter, &cli, &second, &BTreeMap::new()).unwrap());
    assert!(
        base != CodexContext::new(
            &adapter,
            &cli,
            &first,
            &BTreeMap::from([("CODEX_HOME".into(), second.display().to_string())]),
        )
        .unwrap()
    );
}

#[test]
fn agent_context_excludes_defaults_owned_by_other_harnesses() {
    let effective = BTreeMap::from([
        ("DATABRICKS_HOST".into(), "https://private.example".into()),
        ("GOOSE_PROVIDER".into(), "private-provider".into()),
        ("OPENAI_API_KEY".into(), "private-key".into()),
        ("CODEX_HOME".into(), "/tmp/codex-home".into()),
    ]);
    assert_eq!(
        agent_environment(&effective),
        BTreeMap::from([("CODEX_HOME".into(), "/tmp/codex-home".into())])
    );
}
