//! Canonical Codex CLI/adapter binding shared by readiness and later execution.
//! Resolution never authenticates, reads a model catalog, or mutates Codex state.
use crate::{installed, Result};
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const MAX_SHEBANG: usize = 512;
const PASSTHROUGH: &[&str] = &[
    "HOME",
    "CODEX_HOME",
    "TMPDIR",
    "USER",
    "LOGNAME",
    "LANG",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
];

/// Stable identity for the native-owned Codex integration.
pub const INTEGRATION_ID: &str = "codex";

/// A resolved executable and, for a script, its exact interpreter.
#[derive(Clone, PartialEq, Eq)]
struct BoundExecutable {
    selected: PathBuf,
    program: PathBuf,
    script: Option<PathBuf>,
}

/// Native-only binding. Equality is useful for fencing one operation, but
/// callers must re-run readiness because config files and authentication can
/// change without any path or environment value changing.
#[derive(Clone, PartialEq, Eq)]
pub struct CodexContext {
    /// Canonical selected ACP adapter path.
    pub adapter: PathBuf,
    /// Canonical selected Codex CLI path.
    pub cli: PathBuf,
    /// Exact adapter script interpreter, when the adapter is a script.
    pub interpreter: Option<PathBuf>,
    /// Exact CLI script interpreter, when the CLI is a script.
    pub cli_interpreter: Option<PathBuf>,
    /// Canonical workspace used by every command in this context.
    pub workspace: PathBuf,
    adapter_command: BoundExecutable,
    cli_command: BoundExecutable,
    environment: BTreeMap<OsString, OsString>,
}

impl CodexContext {
    /// Resolve the device-selected adapter and CLI without falling back to an
    /// adapter-bundled Codex engine.
    pub fn installed(workspace: &Path) -> Result<Self> {
        let adapter = installed("codex-acp").ok_or("Codex ACP adapter not found")?;
        let cli = installed("codex").ok_or("Codex CLI not found")?;
        Self::new(&adapter, &cli, workspace, &BTreeMap::new())
    }

    /// Resolve an explicit pair. This is the later per-agent binding seam and
    /// also keeps tests from depending on ambient tools.
    pub fn new(
        adapter: &Path,
        cli: &Path,
        workspace: &Path,
        overrides: &BTreeMap<String, String>,
    ) -> Result<Self> {
        let workspace = workspace
            .canonicalize()
            .map_err(|_| "Codex workspace does not exist")?;
        if !workspace.is_dir() {
            return Err("Codex workspace is not a directory".into());
        }
        let mut directories = Vec::new();
        for path in [adapter, cli] {
            if let Some(parent) = path.parent().filter(|path| path.is_absolute()) {
                directories.push(parent.to_path_buf());
            }
        }
        directories.extend(default_directories());
        let adapter_command = bind(adapter, &directories, "Codex ACP adapter")?;
        let cli_command = bind(cli, &directories, "Codex CLI")?;
        let adapter = adapter_command.selected.clone();
        let cli = cli_command.selected.clone();
        let interpreter = adapter_command
            .script
            .as_ref()
            .map(|_| adapter_command.program.clone());
        let cli_interpreter = cli_command
            .script
            .as_ref()
            .map(|_| cli_command.program.clone());

        if std::env::var_os("CODEX_CONFIG").is_some() || overrides.contains_key("CODEX_CONFIG") {
            return Err("CODEX_CONFIG is not supported by Codex readiness yet".into());
        }
        let mut environment = BTreeMap::new();
        for key in PASSTHROUGH {
            if let Some(value) = std::env::var_os(key) {
                environment.insert(OsString::from(key), value);
            }
        }
        for (key, value) in overrides {
            if !PASSTHROUGH.contains(&key.as_str()) {
                return Err(format!("Codex binding does not permit {key}"));
            }
            environment.insert(key.into(), value.into());
        }
        environment.insert("CODEX_PATH".into(), cli.as_os_str().to_owned());
        environment.insert("INITIAL_AGENT_MODE".into(), "agent-full-access".into());
        let path = std::env::join_paths(
            [
                interpreter.as_deref().and_then(Path::parent),
                cli_interpreter.as_deref().and_then(Path::parent),
                cli.parent(),
                adapter.parent(),
                Some(Path::new("/usr/bin")),
                Some(Path::new("/bin")),
                Some(Path::new("/usr/sbin")),
                Some(Path::new("/sbin")),
            ]
            .into_iter()
            .flatten(),
        )
        .map_err(|_| "Invalid Codex tools path")?;
        environment.insert("PATH".into(), path);
        Ok(Self {
            adapter,
            cli,
            interpreter,
            cli_interpreter,
            workspace,
            adapter_command,
            cli_command,
            environment,
        })
    }

    /// Exact adapter command with isolated effective context.
    pub fn adapter_command(&self) -> Command {
        self.command(&self.adapter_command)
    }

    /// Exact installed CLI command with the same context as the adapter.
    pub fn cli_command(&self) -> Command {
        self.command(&self.cli_command)
    }

    fn command(&self, executable: &BoundExecutable) -> Command {
        let mut command = Command::new(&executable.program);
        if let Some(script) = &executable.script {
            command.arg(script);
        }
        command
            .env_clear()
            .envs(&self.environment)
            .current_dir(&self.workspace)
            .stdin(Stdio::null());
        command
    }
}

fn bind(path: &Path, directories: &[PathBuf], label: &str) -> Result<BoundExecutable> {
    if !path.is_absolute() {
        return Err(format!("{label} path must be absolute"));
    }
    executable(path).map_err(|_| format!("{label} is missing or not executable"))?;
    let selected = path
        .canonicalize()
        .map_err(|_| format!("Could not canonicalize {label}"))?;
    let Some(interpreter) = shebang(&selected)? else {
        return Ok(BoundExecutable {
            selected: selected.clone(),
            program: selected,
            script: None,
        });
    };
    let program = if interpreter == Path::new("/usr/bin/env") {
        resolve("node", directories).ok_or("Codex adapter and CLI scripts require Node.js")?
    } else {
        if !interpreter.is_absolute() {
            return Err(format!("{label} uses a relative interpreter"));
        }
        resolve(interpreter.as_os_str(), directories)
            .ok_or_else(|| format!("{label} interpreter is missing"))?
    };
    Ok(BoundExecutable {
        selected: selected.clone(),
        program,
        script: Some(selected),
    })
}

fn shebang(path: &Path) -> Result<Option<PathBuf>> {
    let mut bytes = [0u8; MAX_SHEBANG + 1];
    let count = std::fs::File::open(path)
        .and_then(|mut file| file.read(&mut bytes))
        .map_err(|_| "Could not inspect Codex executable")?;
    if !bytes[..count].starts_with(b"#!") {
        return Ok(None);
    }
    let end = bytes[..count]
        .iter()
        .position(|byte| *byte == b'\n')
        .ok_or("Codex executable has an oversized interpreter line")?;
    let line = std::str::from_utf8(&bytes[2..end])
        .map_err(|_| "Codex executable has an invalid interpreter line")?;
    let mut words = line.split_whitespace();
    let interpreter = words
        .next()
        .filter(|value| !value.is_empty())
        .ok_or("Codex executable has no interpreter")?;
    if interpreter == "/usr/bin/env" {
        if words.next() != Some("node") || words.next().is_some() {
            return Err("Codex executable uses an unsupported env interpreter".into());
        }
    } else if words.next().is_some() {
        return Err("Codex executable uses unsupported interpreter arguments".into());
    }
    Ok(Some(interpreter.into()))
}

fn resolve(name: impl AsRef<OsStr>, directories: &[PathBuf]) -> Option<PathBuf> {
    let name = Path::new(name.as_ref());
    let candidates: Vec<_> = if name.is_absolute() {
        vec![name.to_path_buf()]
    } else {
        directories
            .iter()
            .map(|directory| directory.join(name))
            .collect()
    };
    candidates.into_iter().find_map(|path| {
        executable(&path).ok()?;
        path.canonicalize().ok()
    })
}

fn executable(path: &Path) -> Result<()> {
    let metadata = path.metadata().map_err(|_| "Executable is missing")?;
    if !metadata.is_file() {
        return Err("Executable is not a file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err("File is not executable".into());
        }
    }
    Ok(())
}

fn default_directories() -> Vec<PathBuf> {
    let mut result = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        result.push(PathBuf::from(home).join(".local/bin"));
    }
    result.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    result.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].map(PathBuf::from));
    result.retain(|path| path.is_absolute());
    result
}

#[cfg(all(test, unix))]
mod tests;
