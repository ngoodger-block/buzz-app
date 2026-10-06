//! Explicit, bounded Codex binding checks. No model discovery or inference.
#[cfg(unix)]
use buzz_agent_controller::{codex::CodexContext, ContainedProcess};
use serde::Serialize;
#[cfg(unix)]
use std::{
    io::Read,
    process::{Command, Stdio},
};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};

#[cfg(unix)]
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(unix)]
const OUTPUT_LIMIT: usize = 64 * 1024;
#[cfg(unix)]
const MIN_ADAPTER: (u64, u64, u64) = (1, 10, 0);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Readiness {
    pub(crate) status: &'static str,
    message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    adapter_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cli_version: Option<String>,
}

#[cfg(unix)]
pub(crate) struct ToolBinding {
    pub(crate) adapter_version: String,
    cli_version: String,
}

impl Readiness {
    fn failed(status: &'static str, message: &'static str) -> Self {
        Self {
            status,
            message,
            adapter_version: None,
            cli_version: None,
        }
    }
}

pub(crate) struct Host {
    tickets: Mutex<Tickets>,
    settled: Condvar,
    lane: Arc<tokio::sync::Mutex<()>>,
    closed: AtomicBool,
}

#[derive(Default)]
struct Tickets {
    next: u64,
    active: Option<Active>,
    running: bool,
    cleanup_failed: bool,
}

struct Active {
    ticket: u64,
    claimed: bool,
    cancelled: Arc<AtomicBool>,
}

struct Finish {
    owner: Arc<Host>,
    ticket: u64,
    cleanup_failed: bool,
}
impl Drop for Finish {
    fn drop(&mut self) {
        self.owner.finished(self.ticket, self.cleanup_failed);
    }
}

impl Default for Host {
    fn default() -> Self {
        Self {
            tickets: Mutex::new(Tickets::default()),
            settled: Condvar::new(),
            lane: Arc::new(tokio::sync::Mutex::new(())),
            closed: AtomicBool::new(false),
        }
    }
}

impl Host {
    fn begin(&self) -> Result<u64, String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("Codex readiness is shutting down".into());
        }
        let mut tickets = self
            .tickets
            .lock()
            .map_err(|_| "Codex readiness is unavailable")?;
        if tickets.cleanup_failed {
            return Err("Codex readiness cleanup could not be confirmed".into());
        }
        if let Some(active) = &tickets.active {
            active.cancelled.store(true, Ordering::SeqCst);
        }
        let ticket = tickets
            .next
            .checked_add(1)
            .ok_or("Codex readiness ticket space exhausted")?;
        tickets.next = ticket;
        tickets.active = Some(Active {
            ticket,
            claimed: false,
            cancelled: Arc::new(AtomicBool::new(false)),
        });
        Ok(ticket)
    }

    fn claim(&self, ticket: u64) -> Result<Arc<AtomicBool>, String> {
        let mut tickets = self
            .tickets
            .lock()
            .map_err(|_| "Codex readiness is unavailable")?;
        let active = tickets
            .active
            .as_mut()
            .filter(|active| active.ticket == ticket && !active.claimed)
            .ok_or("Codex readiness request expired")?;
        active.claimed = true;
        Ok(active.cancelled.clone())
    }

    fn cancel(&self, ticket: u64) {
        if let Ok(tickets) = self.tickets.lock() {
            if let Some(active) = tickets
                .active
                .as_ref()
                .filter(|active| active.ticket == ticket)
            {
                active.cancelled.store(true, Ordering::SeqCst);
            }
        }
    }

    fn started(&self, ticket: u64) -> Result<(), String> {
        let mut tickets = self
            .tickets
            .lock()
            .map_err(|_| "Codex readiness is unavailable")?;
        let active = tickets
            .active
            .as_ref()
            .filter(|active| active.ticket == ticket);
        if self.closed.load(Ordering::SeqCst)
            || active.is_none()
            || active.is_some_and(|active| active.cancelled.load(Ordering::SeqCst))
        {
            return Err("Codex readiness request expired".into());
        }
        tickets.running = true;
        Ok(())
    }

    fn finished(&self, ticket: u64, cleanup_failed: bool) {
        if let Ok(mut tickets) = self.tickets.lock() {
            tickets.running = false;
            tickets.cleanup_failed |= cleanup_failed;
            if tickets.active.as_ref().map(|active| active.ticket) == Some(ticket) {
                tickets.active = None;
            }
            self.settled.notify_all();
        }
    }

    pub(crate) fn shutdown(&self) -> Result<(), String> {
        self.closed.store(true, Ordering::SeqCst);
        let mut tickets = self
            .tickets
            .lock()
            .map_err(|_| "Codex readiness cleanup could not be confirmed")?;
        if let Some(active) = &tickets.active {
            active.cancelled.store(true, Ordering::SeqCst);
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while tickets.running {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("Codex readiness cleanup could not be confirmed".into());
            }
            let (next, timed) = self
                .settled
                .wait_timeout(tickets, remaining)
                .map_err(|_| "Codex readiness cleanup could not be confirmed")?;
            tickets = next;
            if timed.timed_out() && tickets.running {
                return Err("Codex readiness cleanup could not be confirmed".into());
            }
        }
        if tickets.cleanup_failed {
            Err("Codex readiness cleanup could not be confirmed".into())
        } else {
            Ok(())
        }
    }
}

#[tauri::command]
pub(crate) fn codex_readiness_begin(state: tauri::State<'_, Arc<Host>>) -> Result<u64, String> {
    state.begin()
}

#[tauri::command]
pub(crate) fn codex_readiness_cancel(state: tauri::State<'_, Arc<Host>>, ticket: u64) {
    state.cancel(ticket);
}

#[tauri::command]
pub(crate) async fn codex_readiness_run(
    state: tauri::State<'_, Arc<Host>>,
    agents: tauri::State<'_, crate::agents::AgentHost>,
    ticket: u64,
) -> Result<Readiness, String> {
    let workspace = agents.default_workspace().await?;
    let owner = state.inner().clone();
    let cancelled = owner.claim(ticket)?;
    let result_cancelled = cancelled.clone();
    let lane = owner.lane.clone().lock_owned().await;
    if cancelled.load(Ordering::SeqCst) || owner.closed.load(Ordering::SeqCst) {
        return Err("Codex readiness check was cancelled".into());
    }
    owner.started(ticket)?;
    let check_owner = owner.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let _lane = lane;
        let mut finish = Finish {
            owner: check_owner.clone(),
            ticket,
            cleanup_failed: true,
        };
        let result = check(&workspace, || {
            !cancelled.load(Ordering::SeqCst) && !check_owner.closed.load(Ordering::SeqCst)
        });
        finish.cleanup_failed = result
            .as_ref()
            .is_ok_and(|readiness| readiness.status == "cleanup-failed");
        result
    })
    .await;
    let result = joined.map_err(|_| "Codex readiness check failed")??;
    if result_cancelled.load(Ordering::SeqCst) || owner.closed.load(Ordering::SeqCst) {
        return Err("Codex readiness check was cancelled".into());
    }
    Ok(result)
}

fn check(workspace: &Path, current: impl Fn() -> bool) -> Result<Readiness, String> {
    #[cfg(not(unix))]
    {
        let _ = (workspace, current);
        return Ok(Readiness::failed(
            "unsupported",
            "Codex binding is not enabled on this platform yet.",
        ));
    }
    #[cfg(unix)]
    {
        let context = match CodexContext::installed(workspace) {
            Ok(context) => context,
            Err(error) => return Ok(resolution_failure(&error)),
        };
        if !current() {
            return Err("Codex readiness check was cancelled".into());
        }
        check_context(context, &current)
    }
}

#[cfg(unix)]
fn resolution_failure(error: &str) -> Readiness {
    if error.contains("Node.js") || error.contains("interpreter") {
        Readiness::failed(
            "interpreter-needed",
            "Install Node.js for the selected Codex CLI and ACP adapter, then check again.",
        )
    } else if error.contains("adapter") {
        Readiness::failed(
            "adapter-needed",
            "Install @agentclientprotocol/codex-acp 1.10.0 or later, then check again.",
        )
    } else if error.contains("CLI") {
        Readiness::failed("cli-needed", "Install the Codex CLI, then check again.")
    } else {
        Readiness::failed(
            "configuration-error",
            "Codex configuration could not be resolved. Repair it, then check again.",
        )
    }
}

#[cfg(unix)]
fn check_context(context: CodexContext, current: &impl Fn() -> bool) -> Result<Readiness, String> {
    let binding = match check_tools(&context, current) {
        Ok(binding) => binding,
        Err(status) => return Ok(status),
    };
    if let Err(failure) = crate::codex_acp::initialize(&context, &binding.adapter_version, current)
    {
        return Ok(acp_failure(failure));
    }
    Ok(Readiness {
        status: "binding-ready",
        message: "CLI, login, and ACP binding verified. Codex agent creation is not enabled yet.",
        adapter_version: Some(binding.adapter_version),
        cli_version: Some(binding.cli_version),
    })
}

#[cfg(unix)]
pub(crate) fn check_tools(
    context: &CodexContext,
    current: &impl Fn() -> bool,
) -> Result<ToolBinding, Readiness> {
    let adapter = readiness_probe(context.adapter_command(), &["--version"], current)?;
    let adapter_version = parse_version(&adapter.stdout, &["@agentclientprotocol/codex-acp "]);
    let Some(adapter_version) = adapter_version else {
        return Err(Readiness::failed(
                "adapter-incompatible",
                "The Codex ACP adapter is incompatible. Install @agentclientprotocol/codex-acp 1.10.0 or later.",
            ));
    };
    if !adapter.success || version_tuple(&adapter_version) < Some(MIN_ADAPTER) {
        return Err(Readiness::failed(
                "adapter-incompatible",
                "The Codex ACP adapter is incompatible. Install @agentclientprotocol/codex-acp 1.10.0 or later.",
            ));
    }
    let cli = readiness_probe(context.cli_command(), &["--version"], current)?;
    let Some(cli_version) = parse_version(&cli.stdout, &["codex-cli "]) else {
        return Err(Readiness::failed(
            "cli-incompatible",
            "The selected Codex CLI version could not be verified. Update Codex, then check again.",
        ));
    };
    if !cli.success {
        return Err(Readiness::failed(
            "cli-incompatible",
            "The selected Codex CLI version could not be verified. Update Codex, then check again.",
        ));
    }
    let login = readiness_probe(context.cli_command(), &["login", "status"], current)?;
    if !login.success {
        let combined = format!("{} {}", login.stdout, login.stderr).to_lowercase();
        if combined.contains("not logged in") || combined.contains("sign in") {
            return Err(Readiness::failed(
                "signed-out",
                "Sign in with the selected Codex CLI, then check again.",
            ));
        }
        return Err(Readiness::failed(
            "configuration-error",
            "Codex could not read its configuration or login. Repair it, then check again.",
        ));
    }
    Ok(ToolBinding {
        adapter_version,
        cli_version,
    })
}

#[cfg(unix)]
fn acp_failure(failure: crate::codex_acp::Failure) -> Readiness {
    use crate::codex_acp::Failure;
    match failure {
        Failure::Cancelled => {
            Readiness::failed("cancelled", "Codex readiness check was cancelled.")
        }
        Failure::Timeout => Readiness::failed(
            "timeout",
            "The Codex ACP adapter check timed out. Try again.",
        ),
        Failure::OutputLimit => Readiness::failed(
            "output-limit",
            "The Codex ACP adapter returned too much output.",
        ),
        Failure::Cleanup => Readiness::failed(
            "cleanup-failed",
            "The Codex ACP adapter process could not be cleaned up.",
        ),
        Failure::Incompatible => Readiness::failed(
            "adapter-incompatible",
            "The Codex ACP adapter is incompatible with this binding.",
        ),
    }
}

#[cfg(unix)]
fn readiness_probe(
    command: Command,
    args: &[&str],
    current: &impl Fn() -> bool,
) -> Result<Output, Readiness> {
    probe(command, args, PROBE_TIMEOUT, current).map_err(|error| {
        if error.contains("cancelled") {
            Readiness::failed("cancelled", "Codex readiness check was cancelled.")
        } else if error.contains("timed out") {
            Readiness::failed("timeout", "Codex readiness check timed out. Try again.")
        } else if error.contains("output exceeded") {
            Readiness::failed(
                "output-limit",
                "Codex readiness output exceeded its safety limit.",
            )
        } else if error.contains("cleanup failed") {
            Readiness::failed(
                "cleanup-failed",
                "Codex readiness process cleanup could not be confirmed.",
            )
        } else {
            Readiness::failed(
                "check-failed",
                "Codex readiness could not be checked. Try again.",
            )
        }
    })
}

#[cfg(unix)]
struct Output {
    success: bool,
    stdout: String,
    stderr: String,
}

#[cfg(unix)]
fn probe(
    mut command: Command,
    args: &[&str],
    timeout: Duration,
    current: &impl Fn() -> bool,
) -> Result<Output, String> {
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut process = ContainedProcess::spawn(&mut command)
        .map_err(|_| "Could not start Codex readiness process")?;
    let stdout = process
        .take_stdout()
        .ok_or("Could not capture Codex output")?;
    let stderr = process
        .take_stderr()
        .ok_or("Could not capture Codex output")?;
    let overflow = Arc::new(AtomicBool::new(false));
    let out = capture(stdout, overflow.clone());
    let err = capture(stderr, overflow.clone());
    let deadline = Instant::now() + timeout;
    loop {
        if !current() {
            process
                .stop()
                .map_err(|_| "Codex readiness process cleanup failed")?;
            let _ = (out.join(), err.join());
            return Err("Codex readiness check was cancelled".into());
        }
        if overflow.load(Ordering::SeqCst) {
            process
                .stop()
                .map_err(|_| "Codex readiness process cleanup failed")?;
            let _ = (out.join(), err.join());
            return Err("Codex readiness output exceeded its limit".into());
        }
        if !process
            .alive()
            .map_err(|_| "Codex readiness process cleanup failed")?
        {
            break;
        }
        if Instant::now() >= deadline {
            process
                .stop()
                .map_err(|_| "Codex readiness process cleanup failed")?;
            let _ = (out.join(), err.join());
            return Err("Codex readiness check timed out".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let success = process.exit_success() == Some(true);
    let stdout = out
        .join()
        .map_err(|_| "Could not capture Codex output")?
        .map_err(|_| "Could not read Codex output")?;
    let stderr = err
        .join()
        .map_err(|_| "Could not capture Codex output")?
        .map_err(|_| "Could not read Codex output")?;
    if overflow.load(Ordering::SeqCst) {
        return Err("Codex readiness output exceeded its limit".into());
    }
    Ok(Output {
        success,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

#[cfg(unix)]
fn capture(
    mut reader: impl Read + Send + 'static,
    overflow: Arc<AtomicBool>,
) -> std::thread::JoinHandle<std::io::Result<Vec<u8>>> {
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Err(error) => return Err(error),
                Ok(count) => {
                    let remaining = OUTPUT_LIMIT.saturating_sub(kept.len());
                    kept.extend_from_slice(&chunk[..count.min(remaining)]);
                    if count > remaining {
                        overflow.store(true, Ordering::SeqCst);
                    }
                }
            }
        }
        Ok(kept)
    })
}

#[cfg(unix)]
fn parse_version(output: &str, prefixes: &[&str]) -> Option<String> {
    let line = output.trim();
    for prefix in prefixes {
        if let Some(value) = line.strip_prefix(prefix) {
            let value = value.trim();
            if version_tuple(value).is_some() {
                return Some(value.to_owned());
            }
        }
    }
    None
}

#[cfg(unix)]
fn version_tuple(value: &str) -> Option<(u64, u64, u64)> {
    let mut parts = value.split('.');
    let result = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    parts.next().is_none().then_some(result)
}

#[cfg(test)]
mod tests;
