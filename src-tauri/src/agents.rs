//! App lifetime, not page/plugin lifetime. Native startup uses app-owned resources.
use buzz_agent_controller::{
    Action, AgentEdit, ControlSnapshot, Controller, Credentials, ImportPreview, Imports,
    LegacySource, NewAgent, PlatformCredentials, ProcessStatus, RuntimeBundle, Store,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    #[serde(flatten)]
    pub(crate) data: ControlSnapshot,
    inventory_warnings: Vec<String>,
    import_available: bool,
    create_available: bool,
    avatar_editing_available: bool,
    local_inventory_actions: bool,
    default_workspace: String,
    harness_options: Vec<HarnessOption>,
    databricks_defaults: crate::agent_models::Defaults,
    agent_defaults: buzz_agent_controller::BuildDefaults,
    /// Running agents restarted by this save; absent on other responses.
    #[serde(skip_serializing_if = "Option::is_none")]
    restarted: Option<usize>,
    /// Agents whose automatic restart after this save failed (not skipped).
    #[serde(skip_serializing_if = "Option::is_none")]
    restart_failures: Option<usize>,
}
impl Snapshot {
    fn from(
        data: ControlSnapshot,
        import_available: bool,
        workspace: &std::path::Path,
        app_data: &std::path::Path,
    ) -> Self {
        Self {
            data,
            inventory_warnings: Vec::new(),
            import_available,
            // Platforms with a native credential store for the new identity.
            create_available: cfg!(any(
                target_os = "macos",
                target_os = "windows",
                target_os = "linux"
            )),
            avatar_editing_available: true,
            local_inventory_actions: true,
            default_workspace: workspace.to_string_lossy().into_owned(),
            harness_options: harness_options(app_data),
            databricks_defaults: crate::agent_models::defaults(),
            agent_defaults: buzz_agent_controller::build_defaults(),
            restarted: None,
            restart_failures: None,
        }
    }
}
// Editing suggestions and executable presence only. Availability does not
// establish provider credentials or an ACP session.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HarnessOption {
    id: buzz_agent_controller::HarnessIntegration,
    command: String,
    label: &'static str,
    available: bool,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    install_supported: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    update_supported: Option<bool>,
    default_args: &'static [&'static str],
    providers: &'static [ProviderOption],
    configuration_policy: buzz_agent_controller::HarnessConfigurationPolicy,
}
#[derive(Serialize)]
struct ProviderOption {
    value: &'static str,
    label: &'static str,
}
// Common IDs checked against Goose's provider registry (crates/goose/src/providers/init.rs)
// and declarative provider definitions. Custom IDs remain editable.
const GOOSE_PROVIDERS: &[ProviderOption] = &[
    ProviderOption {
        value: "anthropic",
        label: "Anthropic",
    },
    ProviderOption {
        value: "openai",
        label: "OpenAI",
    },
    ProviderOption {
        value: "openrouter",
        label: "OpenRouter",
    },
    ProviderOption {
        value: "google",
        label: "Google Gemini",
    },
    ProviderOption {
        value: "github_copilot",
        label: "GitHub Copilot",
    },
    ProviderOption {
        value: "databricks",
        label: "Databricks",
    },
    ProviderOption {
        value: "databricks_v2",
        label: "Databricks v2",
    },
    ProviderOption {
        value: "ollama",
        label: "Ollama",
    },
    ProviderOption {
        value: "groq",
        label: "Groq",
    },
    ProviderOption {
        value: "mistral",
        label: "Mistral AI",
    },
    ProviderOption {
        value: "together",
        label: "Together AI",
    },
    ProviderOption {
        value: "perplexity",
        label: "Perplexity",
    },
    ProviderOption {
        value: "cerebras",
        label: "Cerebras",
    },
    ProviderOption {
        value: "custom_deepseek",
        label: "DeepSeek",
    },
];

fn pi_status(cli: bool, adapter: bool, node: bool) -> &'static str {
    if !cli || !node {
        "cli-needed"
    } else if !adapter {
        "adapter-needed"
    } else {
        "ready"
    }
}

struct PiTools {
    cli: Option<PathBuf>,
    adapter: Option<PathBuf>,
    node: Option<PathBuf>,
}

fn pi_choice(user: PiTools, managed: PiTools) -> (Option<PathBuf>, &'static str, bool) {
    // An existing, complete user install always wins. Otherwise use the
    // app-owned pair only when its pinned Node can run its npm shims.
    let user_ready = user.cli.is_some() && user.adapter.is_some() && user.node.is_some();
    let managed_selected = !user_ready && managed.adapter.is_some() && managed.node.is_some();
    let selected = if user_ready {
        user
    } else if managed_selected {
        PiTools {
            cli: managed.cli.or(user.cli),
            ..managed
        }
    } else {
        user
    };
    let status = pi_status(
        selected.cli.is_some(),
        selected.adapter.is_some(),
        selected.node.is_some(),
    );
    (selected.adapter, status, managed_selected)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn pi_current(app_data: &std::path::Path) -> bool {
    crate::managed_pi::current(app_data)
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn pi_current(_: &std::path::Path) -> bool {
    true
}

fn harness_options(app_data: &std::path::Path) -> Vec<HarnessOption> {
    let (pi, pi_status, pi_managed) = pi_choice(
        PiTools {
            cli: buzz_agent_controller::installed("pi"),
            adapter: buzz_agent_controller::installed("buzz-pi-acp"),
            node: buzz_agent_controller::installed("node"),
        },
        PiTools {
            cli: buzz_agent_controller::managed_tool(app_data, "pi"),
            adapter: buzz_agent_controller::managed_tool(app_data, "buzz-pi-acp"),
            node: buzz_agent_controller::managed_tool(app_data, "node"),
        },
    );
    vec![
        HarnessOption {
            id: buzz_agent_controller::HarnessIntegration::BuzzAgent,
            command: "buzz-agent".into(),
            configuration_policy: buzz_agent_controller::HarnessConfigurationPolicy::for_command(
                "buzz-agent",
            ),
            label: "Buzz Agent",
            available: true,
            status: "ready",
            install_supported: None,
            update_supported: None,
            default_args: &[],
            // Windows refuses Databricks sign-in (DATABRICKS_WINDOWS): omit it.
            providers: &[
                ProviderOption {
                    value: "databricks_v2",
                    label: "Databricks v2",
                },
                ProviderOption {
                    value: "openai",
                    label: "OpenAI",
                },
            ][usize::from(cfg!(windows))..],
        },
        HarnessOption {
            id: buzz_agent_controller::HarnessIntegration::Goose,
            command: "goose".into(),
            configuration_policy: buzz_agent_controller::HarnessConfigurationPolicy::for_command(
                "goose",
            ),
            label: "Goose",
            available: true,
            status: "ready",
            install_supported: None,
            update_supported: None,
            default_args: &[],
            providers: GOOSE_PROVIDERS,
        },
        HarnessOption {
            id: buzz_agent_controller::HarnessIntegration::Pi,
            configuration_policy: buzz_agent_controller::HarnessConfigurationPolicy::for_command(
                "buzz-pi-acp",
            ),
            command: pi.map_or_else(
                || "buzz-pi-acp".into(),
                |p| p.to_string_lossy().into_owned(),
            ),
            label: "Pi",
            available: pi_status == "ready",
            status: pi_status,
            install_supported: Some(cfg!(all(
                any(target_os = "macos", target_os = "linux"),
                any(target_arch = "x86_64", target_arch = "aarch64")
            ))),
            update_supported: Some(pi_managed && pi_status == "ready" && !pi_current(app_data)),
            default_args: &[],
            // Pi reports signed-in providers through its model catalog.
            providers: &[],
        },
        HarnessOption {
            id: buzz_agent_controller::HarnessIntegration::Codex,
            command: buzz_agent_controller::installed("codex-acp").map_or_else(
                || "codex-acp".into(),
                |path| path.to_string_lossy().into_owned(),
            ),
            configuration_policy:
                buzz_agent_controller::HarnessConfigurationPolicy::for_integration(
                    buzz_agent_controller::HarnessIntegration::Codex,
                ),
            label: "Codex",
            available: false,
            status: "not-enabled",
            install_supported: None,
            update_supported: None,
            default_args: &[],
            providers: &[],
        },
    ]
}

struct LogChallenge {
    id: String,
    pubkey: String,
    relay_url: String,
    nonce: String,
    issued: std::time::Instant,
}

struct PendingStart {
    ticket: u64,
    current: Arc<AtomicBool>,
    workspace: Option<String>,
    status: ProcessStatus,
    revision: u64,
    replay_floor: Option<u64>,
    codex: Option<PendingCodex>,
}

#[derive(Clone)]
struct PendingCodex {
    owner: Arc<crate::codex_readiness::Host>,
    ticket: u64,
}
struct MentionReplay {
    revision: u64,
    floor: u64,
}

struct PendingCreate {
    request_id: String,
    destination: String,
    owner: String,
    prepared: Arc<NewAgent>,
    admission: Option<crate::codex_validation::Admission>,
}

struct Host {
    inventory_warnings: Vec<String>,
    controller: Controller,
    imports: Imports,
    legacy_parent: PathBuf,
    workspace: PathBuf,
    app_data: PathBuf,
    closed: bool,
    credentials: Arc<dyn Credentials>,
    starts: BTreeMap<String, PendingStart>,
    codex_retiring: BTreeMap<String, PendingCodex>,
    queued: BTreeMap<String, Option<MentionReplay>>,
    next_start: u64,
    /// Agents with an explicit Start/Stop since open; queued restore skips them.
    acted: BTreeSet<String>,
    profiles: BTreeMap<String, Arc<tokio::sync::Mutex<()>>>,
    log_challenges: BTreeMap<String, LogChallenge>,
    creating: Option<PendingCreate>,
    codex_cleanup_failed: bool,
    #[cfg(test)]
    codex_context: Option<Arc<CodexContextResolver>>,
    legacy_check: fn() -> Result<(), String>,
}
#[cfg(test)]
type CodexContextResolver = dyn Fn(&str, u64) -> Result<Option<buzz_agent_controller::codex::CodexContext>, String>
    + Send
    + Sync;
impl Host {
    fn open(
        root: PathBuf,
        legacy_parent: PathBuf,
        workspace: PathBuf,
        bundle: Result<RuntimeBundle, String>,
        credentials: Arc<dyn Credentials>,
    ) -> Result<Self, String> {
        let app_data = root
            .parent()
            .ok_or("Invalid local agent storage")?
            .to_path_buf();
        let mut store = Store::open(root)?;
        let inventory_warnings = store.migrate_legacy(&legacy_parent);
        let queued = store
            .snapshot()?
            .agents
            .into_iter()
            .filter_map(|agent| {
                startup_trace(serde_json::json!({
                    "phase": "selection", "agent": agent.id,
                    "enabled": agent.enabled, "startOnAppLaunch": agent.start_on_app_launch,
                    "selected": agent.start_on_app_launch,
                }));
                agent.start_on_app_launch.then_some((agent.id, None))
            })
            .collect();
        let mut controller = Controller::new(
            store,
            credentials.clone(),
            bundle,
            legacy_parent.join("dev.local.buzz.agent-ownership"),
        );
        controller.protect_control_paths(
            crate::Manager::from_env().map(|manager| vec![manager.storage_root().to_path_buf()]),
        );
        Ok(Self {
            inventory_warnings,
            controller,
            imports: Imports::default(),
            legacy_parent,
            workspace,
            app_data,
            closed: false,
            credentials,
            starts: BTreeMap::new(),
            codex_retiring: BTreeMap::new(),
            queued,
            next_start: 0,
            acted: BTreeSet::new(),
            profiles: BTreeMap::new(),
            log_challenges: BTreeMap::new(),
            creating: None,
            codex_cleanup_failed: false,
            #[cfg(test)]
            codex_context: None,
            legacy_check: refuse_legacy,
        })
    }
    fn snapshot(&mut self) -> Result<Snapshot, String> {
        let mut data = self.controller.snapshot()?;
        for agent in &mut data.agents {
            if let Some(pending) = self.starts.get(&agent.id) {
                agent.status = pending.status;
                agent.error = None;
            } else if self.queued.contains_key(&agent.id) {
                agent.status = ProcessStatus::Waiting;
                agent.error = None;
            }
        }
        let mut snapshot = Snapshot::from(
            data,
            cfg!(target_os = "macos"),
            &self.workspace,
            &self.app_data,
        );
        snapshot.inventory_warnings = self.inventory_warnings.clone();
        Ok(snapshot)
    }
    fn action(&mut self, id: &str, action: Action) -> Result<Snapshot, String> {
        self.cancel_start(id);
        self.queued.remove(id);
        self.acted.insert(id.to_owned());
        self.controller.action(id, action)?;
        self.snapshot()
    }
    fn take_start(&mut self, id: &str, ticket: u64) -> Result<PendingStart, String> {
        if self.starts.get(id).map(|pending| pending.ticket) != Some(ticket) {
            return Err(START_CANCELLED.into());
        }
        self.starts.remove(id).ok_or_else(|| START_CANCELLED.into())
    }
    fn cancel_start(&mut self, id: &str) {
        if let Some(pending) = self.starts.remove(id) {
            pending.current.store(false, Ordering::SeqCst);
            if let Some(codex) = pending.codex {
                codex.owner.cancel_owned(codex.ticket);
                self.codex_retiring.insert(id.to_owned(), codex);
            }
        }
    }
    fn check_codex_retirement(&mut self, id: &str) -> Result<(), String> {
        let Some(pending) = self.codex_retiring.get(id) else {
            return Ok(());
        };
        match pending.owner.retirement() {
            Ok(true) => {
                self.codex_retiring.remove(id);
                Ok(())
            }
            Ok(false) => Err("Previous Codex readiness cleanup is still in progress".into()),
            Err(error) => {
                self.codex_cleanup_failed = true;
                Err(error)
            }
        }
    }
    fn codex_launch_context(
        &self,
        id: &str,
        revision: u64,
    ) -> Result<Option<buzz_agent_controller::codex::CodexContext>, String> {
        #[cfg(test)]
        if let Some(resolve) = &self.codex_context {
            return resolve(id, revision);
        }
        self.controller.codex_launch_context(id, revision)
    }
    fn attach_mention(&mut self, id: &str, revision: u64, floor: u64) -> Result<(), String> {
        let current = self.controller.snapshot()?;
        if !current
            .agents
            .iter()
            .any(|a| a.id == id && a.revision == revision)
        {
            return Err("Saved settings changed; mention replay was not attached".into());
        }
        if let Some(pending) = self.starts.get_mut(id) {
            if pending.revision != revision {
                return Err("Saved settings changed; mention replay was not attached".into());
            }
            pending.replay_floor = Some(pending.replay_floor.map_or(floor, |old| old.min(floor)));
        } else if let Some(replay) = self.queued.get_mut(id) {
            if replay.as_ref().is_some_and(|old| old.revision != revision) {
                return Err("Saved settings changed; mention replay was not attached".into());
            }
            let floor = replay.as_ref().map_or(floor, |old| old.floor.min(floor));
            *replay = Some(MentionReplay { revision, floor });
        } else {
            return Err(
                "Launch already finished or was cancelled; mention replay could not be confirmed"
                    .into(),
            );
        }
        Ok(())
    }
    fn refuse_legacy(&self, id: &str) -> Result<(), String> {
        if self.controller.requires_legacy_handover(id)? {
            (self.legacy_check)()
        } else {
            Ok(())
        }
    }
    fn shutdown(&mut self) -> Result<(), String> {
        self.closed = true; // Fence queued commands before shutdown starts.
        for (id, pending) in std::mem::take(&mut self.starts) {
            pending.current.store(false, Ordering::SeqCst);
            if let Some(codex) = pending.codex {
                codex.owner.cancel_owned(codex.ticket);
                self.codex_retiring.insert(id, codex);
            }
        }
        let mut cleanup_error = None;
        for pending in self.codex_retiring.values() {
            if let Err(error) = pending.owner.shutdown() {
                cleanup_error.get_or_insert(error);
            }
        }
        let controller = self.controller.shutdown();
        match (cleanup_error, controller) {
            (Some(error), _) => Err(error),
            (None, result) => result,
        }
    }
    fn log_challenge(
        &mut self,
        id: String,
        pubkey: String,
        relay_url: String,
    ) -> Result<String, String> {
        self.controller.log_target(&id, &pubkey, &relay_url)?;
        let nonce = uuid::Uuid::new_v4().to_string();
        self.log_challenges
            .retain(|_, pending| pending.issued.elapsed() <= std::time::Duration::from_secs(20));
        if self.log_challenges.len() >= 4 {
            return Err("Too many pending log authorizations".into());
        }
        self.log_challenges.insert(
            nonce.clone(),
            LogChallenge {
                id,
                pubkey,
                relay_url,
                nonce: nonce.clone(),
                issued: std::time::Instant::now(),
            },
        );
        Ok(nonce)
    }
    fn read_log(
        &mut self,
        id: &str,
        pubkey: &str,
        relay_url: &str,
        nonce: &str,
        signature: &str,
    ) -> Result<String, String> {
        // Consume before comparison or I/O; even a failed proof cannot be replayed.
        let challenge = self
            .log_challenges
            .remove(nonce)
            .ok_or("Log authorization expired")?;
        if challenge.issued.elapsed() > std::time::Duration::from_secs(20)
            || challenge.id != id
            || challenge.pubkey != pubkey
            || challenge.relay_url != relay_url
            || challenge.nonce != nonce
        {
            return Err("Log authorization expired".into());
        }
        self.controller
            .read_log(id, pubkey, relay_url, nonce, signature)
    }
}

type ProfilePublication = (
    tokio::sync::OwnedMutexGuard<()>,
    buzz_agent_controller::CreationProfile,
    Arc<dyn Credentials>,
);

#[derive(Clone)]
pub(crate) struct AgentHost(
    Arc<Mutex<Result<Host, String>>>,
    Arc<AtomicBool>,
    Arc<tokio::sync::Mutex<()>>,
);
impl AgentHost {
    pub(crate) fn initialize(
        paths: Result<(PathBuf, PathBuf, PathBuf), String>,
        resources: Result<PathBuf, String>,
    ) -> Self {
        Self::initialize_with(move || {
            let bundle = resources.and_then(RuntimeBundle::new);
            paths.and_then(|(root, legacy, workspace)| {
                Host::open(
                    root,
                    legacy,
                    workspace,
                    bundle,
                    Arc::new(PlatformCredentials::default()),
                )
            })
        })
    }
    fn initialize_with(open: impl FnOnce() -> Result<Host, String> + Send + 'static) -> Self {
        let state = Arc::new(Mutex::new(Err(
            "Agent runtime is initializing; retry shortly".into(),
        )));
        let closed = Arc::new(AtomicBool::new(false));
        let admission = Arc::new(tokio::sync::Mutex::new(()));
        // Initialization is the first admitted operation. Callers wait for its
        // real outcome rather than treating the placeholder as a permanent error.
        let initializing = admission
            .clone()
            .try_lock_owned()
            .expect("new admission mutex");
        let owner = Self(state.clone(), closed.clone(), admission.clone());
        tauri::async_runtime::spawn(async move {
            let opened = tauri::async_runtime::spawn_blocking(open)
                .await
                .unwrap_or_else(|_| Err("Agent runtime initialization failed".into()));
            if closed.load(Ordering::SeqCst) {
                return;
            }
            if let Ok(mut state) = state.lock() {
                *state = opened;
            }
            drop(initializing); // restore itself enters through native admission.
            Self(state, closed, admission).restore().await;
        });
        owner
    }
    // Synchronous admission belongs on a blocking worker; external waits release it.
    fn with<T>(&self, operation: impl FnOnce(&mut Host) -> Result<T, String>) -> Result<T, String> {
        if self.1.load(Ordering::SeqCst) {
            return Err("Agent host is shutting down".into());
        }
        let mut state = self.0.lock().map_err(|_| {
            "Native agent state is unavailable after an operation failed; restart the app"
        })?;
        let host = state.as_mut().map_err(|message| message.clone())?;
        if self.1.load(Ordering::SeqCst) || host.closed {
            return Err("Agent host is shutting down".into());
        }
        operation(host)
    }
    async fn begin_profile(&self, id: &str) -> Result<ProfilePublication, String> {
        let id = id.to_owned();
        run(self.clone(), move |host| {
            let profile = host.controller.creation_profile(&id)?;
            let guard = host
                .profiles
                .entry(id.to_owned())
                .or_default()
                .clone()
                .try_lock_owned()
                .map_err(|_| {
                    "Profile publication is already in progress; refresh status before retrying"
                })?;
            Ok((guard, profile, host.credentials.clone()))
        })
        .await
    }
    pub(crate) async fn restore(&self) {
        let ids = run(self.clone(), |host| {
            let ids = match host.controller.launch_ids() {
                Ok(ids) => ids,
                Err(error) => {
                    for (id, _) in std::mem::take(&mut host.queued) {
                        host.controller.record_error(&id, error.clone());
                    }
                    return Err(error);
                }
            };
            let mut queued = std::mem::take(&mut host.queued);
            host.queued = ids
                .into_iter()
                .filter(|id| !host.acted.contains(id))
                .map(|id| {
                    let replay = queued.remove(&id).flatten();
                    (id, replay)
                })
                .collect();
            Ok(host.queued.keys().cloned().collect::<Vec<_>>())
        })
        .await
        .unwrap_or_default();
        for id in ids {
            let begin = std::time::Instant::now();
            startup_trace(serde_json::json!({"phase": "start", "agent": id}));
            let result = start(self.clone(), id.clone(), Action::Start, true, None, None).await;
            let agent = result
                .as_ref()
                .ok()
                .and_then(|snapshot| snapshot.data.agents.iter().find(|agent| agent.id == id));
            startup_trace(serde_json::json!({
                "phase": "end", "agent": id, "status": agent.map(|agent| agent.status),
                "returnedError": result.is_err(), "agentError": agent.map(|agent| agent.error.is_some()),
                "elapsedMs": begin.elapsed().as_millis(),
            }));
        }
    }
    pub(crate) async fn ensure_open(&self) -> Result<(), String> {
        run(self.clone(), |_| Ok(())).await
    }
    pub(crate) async fn inherited_workspace(&self) -> Result<Option<String>, String> {
        run(self.clone(), |host| host.controller.inherited_workspace()).await
    }
    pub(crate) async fn default_workspace(&self) -> Result<PathBuf, String> {
        run(self.clone(), |host| Ok(host.workspace.clone())).await
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) async fn waiting_for_pi(&self) -> Result<Vec<String>, String> {
        self.waiting_for(crate::harness_setup::waiting_for_pi).await
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    async fn waiting_for(
        &self,
        predicate: fn(&buzz_agent_controller::AgentView) -> bool,
    ) -> Result<Vec<String>, String> {
        run(self.clone(), move |host| {
            Ok(host
                .controller
                .snapshot()?
                .agents
                .iter()
                .filter(|agent| predicate(agent))
                .map(|agent| agent.id.clone())
                .collect())
        })
        .await
    }
    pub(crate) async fn disconnect(&self, workspace: &str) -> Result<(), String> {
        let workspace = buzz_agent_controller::connection::origin(workspace)?;
        run(self.clone(), move |host| {
            host.controller.disconnect(&workspace)?;
            // A successful Disconnect also retires pre-existing credential waits.
            // Otherwise their late completion could start against the removed cache.
            let cancelled: Vec<_> = host
                .starts
                .iter()
                .filter(|(_, pending)| pending.workspace.as_deref() == Some(&workspace))
                .map(|(id, _)| id.clone())
                .collect();
            for id in cancelled {
                host.cancel_start(&id);
                host.controller.record_error(
                    &id,
                    "Start cancelled by Disconnect; reconnect and retry Start".into(),
                );
            }
            // Queued restore has not acquired a ticket yet; fence it too.
            let queued: Vec<_> = host.queued.keys().cloned().collect();
            for id in queued {
                if host
                    .controller
                    .credential_request(&id)
                    .is_ok_and(|request| request.3.as_deref() == Some(&workspace))
                {
                    host.queued.remove(&id);
                    host.acted.insert(id.clone());
                    host.controller.record_error(
                        &id,
                        "Start cancelled by Disconnect; reconnect and retry Start".into(),
                    );
                }
            }
            Ok(())
        })
        .await
    }
    pub(crate) async fn model_context(
        &self,
        id: Option<&str>,
        revision: Option<u64>,
        edit: AgentEdit,
    ) -> Result<buzz_agent_controller::ModelContext, String> {
        let id = id.map(str::to_owned);
        run(self.clone(), move |host| match (id.as_deref(), revision) {
            (Some(id), Some(revision)) => host.controller.model_context(id, revision, edit),
            (None, None) => Controller::draft_model_context(host.controller.effective_draft(edit)?),
            _ => Err("Invalid agent model context".into()),
        })
        .await
    }
    pub(crate) async fn goose_model_context(
        &self,
        id: Option<&str>,
        revision: Option<u64>,
        edit: AgentEdit,
    ) -> Result<buzz_agent_controller::GooseModelContext, String> {
        let id = id.map(str::to_owned);
        run(self.clone(), move |host| match (id.as_deref(), revision) {
            (Some(id), Some(revision)) => host.controller.goose_model_context(id, revision, edit),
            (None, None) => host
                .controller
                .draft_goose_model_context(host.controller.effective_draft(edit)?),
            _ => Err("Invalid agent model context".into()),
        })
        .await
    }
    pub(crate) async fn pi_model_context(
        &self,
        id: Option<&str>,
        revision: Option<u64>,
        edit: AgentEdit,
    ) -> Result<buzz_agent_controller::pi::PiContext, String> {
        let id = id.map(str::to_owned);
        run(self.clone(), move |host| match (id.as_deref(), revision) {
            (Some(id), Some(revision)) => host.controller.pi_model_context(id, revision, edit),
            (None, None) => {
                Controller::draft_pi_model_context(host.controller.effective_draft(edit)?)
            }
            _ => Err("Invalid agent model context".into()),
        })
        .await
    }
    pub(crate) async fn codex_model_context(
        &self,
        id: Option<&str>,
        revision: Option<u64>,
        edit: AgentEdit,
    ) -> Result<buzz_agent_controller::codex::CodexContext, String> {
        let id = id.map(str::to_owned);
        run(self.clone(), move |host| match (id.as_deref(), revision) {
            (Some(id), Some(revision)) => host.controller.codex_model_context(id, revision, edit),
            (None, None) => {
                Controller::draft_codex_model_context(host.controller.effective_draft(edit)?)
            }
            _ => Err("Invalid agent model context".into()),
        })
        .await
    }
    pub(crate) async fn codex_create_validation(
        &self,
        edit: AgentEdit,
    ) -> Result<Option<buzz_agent_controller::CodexValidationDraft>, String> {
        run(self.clone(), move |host| {
            host.controller.codex_create_validation(edit)
        })
        .await
    }
    pub(crate) async fn codex_edit_validation(
        &self,
        id: String,
        revision: u64,
        edit: AgentEdit,
    ) -> Result<Option<buzz_agent_controller::CodexValidationDraft>, String> {
        run(self.clone(), move |host| {
            host.controller.codex_edit_validation(&id, revision, edit)
        })
        .await
    }
    pub(crate) fn shutdown(&self) -> Result<(), String> {
        self.1.store(true, Ordering::SeqCst);
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Agent host shutdown could not be confirmed")?;
        if let Ok(host) = state.as_mut() {
            host.shutdown()?;
        }
        Ok(())
    }
}
async fn run<T: Send + 'static>(
    state: AgentHost,
    operation: impl FnOnce(&mut Host) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    // FIFO admission keeps a queued Start preparation ahead of a later recovery
    // Stop. The worker owns admission through completion, even if its caller drops.
    // Credential/network waits happen between runs, so Stop can still fence them.
    let admission = state.2.clone().lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _admission = admission;
        state.with(operation)
    })
    .await
    .map_err(|_| "Native agent operation failed; refresh status before retrying")?
}
#[tauri::command]
pub(crate) async fn agent_control_log_challenge(
    state: tauri::State<'_, AgentHost>,
    id: String,
    pubkey: String,
    relay_url: String,
) -> Result<String, String> {
    run(state.inner().clone(), move |host| {
        host.log_challenge(id, pubkey, relay_url)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_read_log(
    state: tauri::State<'_, AgentHost>,
    id: String,
    pubkey: String,
    relay_url: String,
    nonce: String,
    signature: String,
) -> Result<String, String> {
    run(state.inner().clone(), move |host| {
        host.read_log(&id, &pubkey, &relay_url, &nonce, &signature)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_snapshot(
    state: tauri::State<'_, AgentHost>,
) -> Result<Snapshot, String> {
    run(state.inner().clone(), |host| host.snapshot()).await
}
#[tauri::command]
pub(crate) async fn agent_control_save(
    state: tauri::State<'_, AgentHost>,
    validation: tauri::State<'_, Arc<crate::codex_validation::Host>>,
    id: String,
    expected_revision: u64,
    edit: AgentEdit,
    validation_request_id: Option<String>,
    validation_proof: Option<String>,
) -> Result<Snapshot, String> {
    let validation = validation.inner().clone();
    save_and_restart(state.inner().clone(), move |host| {
        let draft = host
            .controller
            .codex_edit_validation(&id, expected_revision, edit.clone())?;
        let admission = match draft {
            Some(draft) => {
                let request = validation_request_id
                    .as_deref()
                    .ok_or("Validate this Codex change before saving")?;
                let admission = crate::codex_validation::edit_admission(
                    request,
                    &id,
                    expected_revision,
                    Some(draft),
                )?
                .ok_or("Validate this Codex change before saving")?;
                let proof = validation_proof
                    .as_deref()
                    .ok_or("Validate this Codex change before saving")?;
                validation.consume(proof, &admission)?;
                Some(admission)
            }
            None => {
                if validation_request_id.is_some() || validation_proof.is_some() {
                    return Err("Codex validation does not match this save".into());
                }
                None
            }
        };
        match admission {
            Some(admission) => host
                .controller
                .save_codex_validated(&id, expected_revision, edit, admission.draft())
                .map(drop),
            None => host.controller.save(&id, expected_revision, edit).map(drop),
        }
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_save_defaults(
    state: tauri::State<'_, AgentHost>,
    edit: buzz_agent_controller::AgentDefaultsEdit,
) -> Result<Snapshot, String> {
    save_and_restart(state.inner().clone(), move |host| {
        host.controller.save_defaults(edit).map(drop)
    })
    .await
}
/// Save, then restart only agents that were running before and after it and whose
/// effective settings changed. Stopped or disabled agents are never started.
async fn save_and_restart(
    owner: AgentHost,
    save: impl FnOnce(&mut Host) -> Result<(), String> + Send + 'static,
) -> Result<Snapshot, String> {
    let changed = run(owner.clone(), move |host| {
        let before = host.controller.running_settings()?;
        save(host)?;
        let after = host.controller.running_settings()?;
        Ok(changed_running(before, after))
    })
    .await?;
    let (mut restarted, mut failures) = (0, 0);
    for id in changed {
        // Re-checked under the lock: Stop wins, and a subsequent user Start
        // may already have launched the saved settings.
        let result = start_guarded(
            owner.clone(),
            id.clone(),
            Action::Restart,
            false,
            None,
            Some((needs_save_restart, NO_SAVE_RESTART)),
        )
        .await;
        match restart_outcome(&id, result) {
            RestartOutcome::Restarted => restarted += 1,
            RestartOutcome::Skipped => {}
            RestartOutcome::Failed => failures += 1,
        }
    }
    let mut snapshot = run(owner, |host| host.snapshot()).await?;
    snapshot.restarted = Some(restarted);
    snapshot.restart_failures = Some(failures);
    Ok(snapshot)
}
#[derive(Debug, PartialEq)]
enum RestartOutcome {
    Restarted,
    /// No longer needed, or an explicit Stop/newer action won: not a failure.
    Skipped,
    Failed,
}
const NO_SAVE_RESTART: &str = "Agent no longer needs a save restart";
fn restart_outcome(id: &str, result: Result<Snapshot, String>) -> RestartOutcome {
    match result {
        Err(error) if error == NO_SAVE_RESTART || error == START_CANCELLED => {
            RestartOutcome::Skipped
        }
        Err(_) => RestartOutcome::Failed,
        Ok(snapshot) => match snapshot.data.agents.iter().find(|agent| agent.id == id) {
            // A denied credential prompt or failed stop leaves the old process
            // running; only a launch of the saved settings counts as a restart.
            Some(agent) if is_running(agent) && agent.restart_diff.is_empty() => {
                RestartOutcome::Restarted
            }
            // Stop disabled it while the restart was in flight.
            Some(agent) if !agent.enabled => RestartOutcome::Skipped,
            _ => RestartOutcome::Failed,
        },
    }
}
/// Agents live both before and after a save whose effective settings differ.
fn changed_running(
    before: BTreeMap<String, serde_json::Value>,
    after: BTreeMap<String, serde_json::Value>,
) -> Vec<String> {
    after
        .into_iter()
        .filter(|(id, settings)| before.get(id).is_some_and(|old| old != settings))
        .map(|(id, _)| id)
        .collect()
}
fn is_running(agent: &buzz_agent_controller::AgentView) -> bool {
    agent.enabled && agent.status == buzz_agent_controller::ProcessStatus::Running
}
fn needs_save_restart(agent: &buzz_agent_controller::AgentView) -> bool {
    is_running(agent) && !agent.restart_diff.is_empty()
}
#[tauri::command]
pub(crate) async fn agent_control_start_on_app_launch(
    state: tauri::State<'_, AgentHost>,
    id: String,
    enabled: bool,
) -> Result<Snapshot, String> {
    run(state.inner().clone(), move |host| {
        host.controller.set_start_on_app_launch(&id, enabled)?;
        if !enabled {
            host.queued.remove(&id);
        }
        host.snapshot()
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_delete(
    state: tauri::State<'_, AgentHost>,
    id: String,
    expected_revision: u64,
) -> Result<Snapshot, String> {
    run(state.inner().clone(), move |host| {
        host.cancel_start(&id);
        host.queued.remove(&id);
        host.acted.insert(id.clone());
        host.controller.delete(&id, expected_revision)?;
        host.snapshot()
    })
    .await
}
// This only annotates an admitted launch; it cannot start or resurrect an agent.
#[tauri::command]
pub(crate) async fn agent_control_attach_mention(
    state: tauri::State<'_, AgentHost>,
    id: String,
    expected_revision: u64,
    replay_floor: u64,
) -> Result<(), String> {
    run(state.inner().clone(), move |host| {
        host.attach_mention(&id, expected_revision, replay_floor)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_action(
    state: tauri::State<'_, AgentHost>,
    id: String,
    action: Action,
    replay_floor: Option<u64>,
) -> Result<Snapshot, String> {
    let owner = state.inner().clone();
    if matches!(action, Action::Stop) {
        return run(owner, move |host| host.action(&id, action)).await;
    }
    start(owner, id, action, false, replay_floor, None).await
}
// Only explicit nonsecret fields belong here; never pass snapshots/config/errors.
fn startup_trace(value: serde_json::Value) {
    if cfg!(debug_assertions) {
        use std::io::Write;
        let _ = writeln!(
            std::io::stderr().lock(),
            "[agent-startup] pid={} {value}",
            std::process::id()
        );
    }
}
pub(crate) const NOT_WAITING_FOR_PI: &str = "Agent no longer waiting for Pi";
#[derive(Clone, Copy)]
#[cfg_attr(
    not(any(target_os = "macos", target_os = "linux")),
    expect(
        dead_code,
        reason = "Harness installation is unavailable on this platform"
    )
)]
pub(crate) enum InstallRestart {
    Pi,
}
pub(crate) async fn start(
    owner: AgentHost,
    id: String,
    action: Action,
    restore: bool,
    replay_floor: Option<u64>,
    install_restart: Option<InstallRestart>,
) -> Result<Snapshot, String> {
    let guard = install_restart.map(|harness| -> StartGuard {
        match harness {
            InstallRestart::Pi => (crate::harness_setup::waiting_for_pi, NOT_WAITING_FOR_PI),
        }
    });
    start_guarded(owner, id, action, restore, replay_floor, guard).await
}
const START_CANCELLED: &str = "Start cancelled by a newer action";
type StartGuard = (fn(&buzz_agent_controller::AgentView) -> bool, &'static str);

struct StartAdmission {
    owner: AgentHost,
    id: String,
    ticket: u64,
    current: Arc<AtomicBool>,
    retired: bool,
}

impl Drop for StartAdmission {
    fn drop(&mut self) {
        if self.retired {
            return;
        }
        self.current.store(false, Ordering::SeqCst);
        let _ = self.owner.with(|host| {
            if host.starts.get(&self.id).map(|pending| pending.ticket) == Some(self.ticket) {
                host.cancel_start(&self.id);
            }
            Ok(())
        });
    }
}

#[cfg(unix)]
struct CodexStartCheck {
    result: Result<Option<buzz_agent_controller::codex::CodexLaunchPreflight>, String>,
    cleanup_failed: bool,
}

#[cfg(unix)]
async fn check_codex_start(
    pending: PendingCodex,
    context: buzz_agent_controller::codex::CodexContext,
    current: Arc<AtomicBool>,
) -> CodexStartCheck {
    let owner = pending.owner.clone();
    let ticket = pending.ticket;
    let checked = tauri::async_runtime::spawn_blocking(move || {
        crate::codex_readiness::check_binding_owned(owner, ticket, &context, &|| {
            current.load(Ordering::SeqCst)
        })
        .map(|_| buzz_agent_controller::codex::CodexLaunchPreflight::new(context))
        .map(Some)
    })
    .await;
    match checked {
        Ok(Ok(preflight)) => CodexStartCheck {
            result: Ok(preflight),
            cleanup_failed: false,
        },
        Ok(Err(status)) => CodexStartCheck {
            cleanup_failed: status.status == "cleanup-failed",
            result: Err(codex_start_failure(status)),
        },
        Err(_) => CodexStartCheck {
            result: Err("Codex readiness cleanup could not be confirmed".into()),
            cleanup_failed: true,
        },
    }
}

fn check_guard(host: &mut Host, id: &str, guard: Option<StartGuard>) -> Result<(), String> {
    let Some((eligible, refusal)) = guard else {
        return Ok(());
    };
    if host
        .controller
        .snapshot()?
        .agents
        .iter()
        .any(|agent| agent.id == id && eligible(agent))
    {
        Ok(())
    } else {
        Err(refusal.into())
    }
}
async fn start_guarded(
    owner: AgentHost,
    id: String,
    action: Action,
    restore: bool,
    replay_floor: Option<u64>,
    guard: Option<StartGuard>,
) -> Result<Snapshot, String> {
    let target = id.clone();
    let admission_owner = owner.clone();
    let prepared = run(owner.clone(), move |host| {
        let id = target;
        let queued_replay = host.queued.remove(&id).flatten();
        if restore && (host.acted.contains(&id) || !host.controller.launch_ids()?.contains(&id)) {
            return Err("Agent disabled before restore".into());
        }
        // Re-check while holding the controller, not just when the caller
        // chose this agent: Stop or Edit may have changed it since.
        check_guard(host, &id, guard)?;
        host.check_codex_retirement(&id)?;
        if host.starts.contains_key(&id) {
            return Err("Agent start already in progress; use Stop to cancel".into());
        }
        if !restore {
            host.acted.insert(id.clone());
        }
        let request = match host.controller.credential_request(&id) {
            Ok(request) => request,
            Err(error) => {
                host.controller.record_error(&id, error.clone());
                return Err(error);
            }
        };
        if queued_replay
            .as_ref()
            .is_some_and(|replay| replay.revision != request.2)
        {
            let error = "Saved settings changed; retry Start for pending mentions".to_owned();
            host.controller.record_error(&id, error.clone());
            return Err(error);
        }
        let replay_floor = queued_replay.map_or(replay_floor, |replay| {
            Some(replay_floor.map_or(replay.floor, |floor| floor.min(replay.floor)))
        });
        if let Err(error) = host.refuse_legacy(&id) {
            host.controller.record_error(&id, error.clone());
            return Err(error);
        }
        let pi = host.controller.pi_launch_context(&id, request.2);
        let codex = host.codex_launch_context(&id, request.2);
        if codex.as_ref().is_ok_and(Option::is_some) && host.codex_cleanup_failed {
            return Err("Codex readiness cleanup previously failed; restart the app".into());
        }
        let codex_pending = if codex.as_ref().is_ok_and(Option::is_some) {
            let owner = Arc::new(crate::codex_readiness::Host::default());
            let ticket = owner.begin_owned()?;
            Some(PendingCodex { owner, ticket })
        } else {
            None
        };
        host.next_start = host
            .next_start
            .checked_add(1)
            .ok_or("Start sequence exhausted")?;
        let ticket = host.next_start;
        let current = Arc::new(AtomicBool::new(true));
        host.starts.insert(
            id.clone(),
            PendingStart {
                ticket,
                current: current.clone(),
                workspace: request.3.clone(),
                status: ProcessStatus::Waiting,
                revision: request.2,
                replay_floor,
                codex: codex_pending.clone(),
            },
        );
        let admission = StartAdmission {
            owner: admission_owner,
            id: id.clone(),
            ticket,
            current: current.clone(),
            retired: false,
        };
        Ok((
            request,
            ticket,
            host.credentials.clone(),
            pi,
            codex,
            codex_pending,
            current,
            admission,
        ))
    })
    .await?;
    let (
        (credential, pubkey, revision, _workspace),
        ticket,
        credentials,
        pi,
        codex,
        codex_pending,
        current,
        mut admission,
    ) = prepared;
    let probed_pi = matches!(&pi, Ok(Some(_)));
    let preflight = match pi {
        Ok(Some(pi)) => crate::pi_models::verify(pi)
            .await
            .map(|pi| buzz_agent_controller::pi::LaunchPreflight::new(Some(pi))),
        Ok(None) => Ok(buzz_agent_controller::pi::LaunchPreflight::new(None)),
        Err(error) => Err(error),
    };
    let probed_codex = matches!(&codex, Ok(Some(_)));
    #[cfg(unix)]
    let codex_preflight = match codex {
        Ok(Some(context)) => {
            let pending = codex_pending.ok_or("Missing Codex readiness owner")?;
            let checked = check_codex_start(pending, context, current.clone()).await;
            if checked.cleanup_failed {
                run(owner.clone(), |host| {
                    host.codex_cleanup_failed = true;
                    Ok(())
                })
                .await?;
            }
            checked.result
        }
        Ok(None) => Ok(None),
        Err(error) => Err(error),
    };
    #[cfg(not(unix))]
    let codex_preflight = match codex {
        Ok(Some(_)) => {
            let _ = codex_pending;
            Err("Codex execution is not supported on this platform".into())
        }
        Ok(None) => Ok(None),
        Err(error) => Err(error),
    };
    let preflights = preflight.and_then(|pi| codex_preflight.map(|codex| (pi, codex)));
    if (probed_pi || probed_codex) && preflights.is_ok() {
        let target = id.clone();
        run(owner.clone(), move |host| {
            host.starts
                .get(&target)
                .filter(|pending| pending.ticket == ticket)
                .ok_or(START_CANCELLED)?;
            Ok(())
        })
        .await?;
    }
    // OS permission prompts never hold the controller. Stop/quit invalidate the
    // ticket while the OS owns its dialog; a late key cannot start a listener.
    let acquired = if preflights.is_ok() {
        tauri::async_runtime::spawn_blocking(move || {
            if !restore && replay_floor.is_none() && guard.is_none() {
                credentials.retry();
            }
            credentials.read(&credential, &pubkey)
        })
        .await
        .map_err(|_| "Native credential operation failed".to_owned())
        .and_then(|v| v)
        .and_then(|v| v.ok_or("Saved agent key is unavailable; nothing was started".into()))
    } else {
        Err(preflights.as_ref().err().unwrap().clone())
    };
    let target = id.clone();
    if acquired.is_ok() {
        run(owner.clone(), move |host| {
            let pending = host
                .starts
                .get_mut(&target)
                .filter(|pending| pending.ticket == ticket)
                .ok_or(START_CANCELLED)?;
            pending.status = ProcessStatus::Starting;
            Ok(())
        })
        .await?;
    }
    let result = run(owner, move |host| {
        let replay_floor = host.take_start(&id, ticket)?.replay_floor;
        let key = match acquired {
            Ok(key) => key,
            Err(error) => {
                host.controller.record_error(&id, error);
                return host.snapshot();
            }
        };
        if let Err(error) = host.refuse_legacy(&id) {
            host.controller.record_error(&id, error);
            return host.snapshot();
        }
        // The OS credential prompt can outlast the agent (e.g. its listener
        // exited); eligibility must still hold right before Restart enables it.
        check_guard(host, &id, guard)?;
        let (pi, codex) = preflights?;
        if let Err(error) = host.controller.action_with_preflights(
            &id,
            action,
            revision,
            &key,
            replay_floor,
            buzz_agent_controller::LaunchPreflights {
                pi: &pi,
                codex: codex.as_ref(),
            },
        ) {
            host.controller.record_error(&id, error);
        }
        host.snapshot()
    })
    .await;
    admission.retired = true;
    result
}

#[cfg(unix)]
fn codex_start_failure(status: crate::codex_readiness::Readiness) -> String {
    match status.status {
        "cancelled" => START_CANCELLED,
        "timeout" => "Codex tool verification timed out; retry Start",
        "output-limit" => "Codex tool verification exceeded its output limit",
        "signed-out" => "Sign in with the selected Codex CLI, then retry Start",
        "configuration-error" => "Codex configuration or login could not be read",
        "adapter-incompatible" => "The selected Codex ACP adapter is incompatible",
        "cli-incompatible" => "The selected Codex CLI is incompatible",
        "cleanup-failed" => "Codex readiness cleanup could not be confirmed",
        _ => "Codex tools could not be verified",
    }
    .into()
}
#[tauri::command]
pub(crate) async fn agent_control_use_here(
    state: tauri::State<'_, AgentHost>,
    id: String,
    resolution: buzz_agent_controller::CommunityResolution,
) -> Result<Snapshot, String> {
    run(state.inner().clone(), move |host| {
        host.controller.use_here(&id, resolution)?;
        host.snapshot()
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_local_clone_settings(
    state: tauri::State<'_, AgentHost>,
    id: String,
) -> Result<buzz_agent_controller::CloneSettings, String> {
    run(state.inner().clone(), move |host| {
        host.controller.local_clone_settings(&id)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_clone_settings(
    state: tauri::State<'_, AgentHost>,
    source: LegacySource,
    pubkey: String,
) -> Result<buzz_agent_controller::CloneSettings, String> {
    run(state.inner().clone(), move |host| {
        Imports::clone_settings(source, host.legacy_parent.clone(), &pubkey)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_import_preview(
    state: tauri::State<'_, AgentHost>,
    source: LegacySource,
    destination: String,
) -> Result<ImportPreview, String> {
    run(state.inner().clone(), move |host| {
        host.imports.preview(
            source,
            host.legacy_parent.clone(),
            host.workspace.clone(),
            &destination,
        )
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_import_commit(
    state: tauri::State<'_, AgentHost>,
    token: String,
    ids: Vec<String>,
) -> Result<Snapshot, String> {
    let owner = state.inner().clone();
    let (prepared, credentials) = run(owner.clone(), move |host| {
        let prepared = host
            .controller
            .prepare_import(&mut host.imports, &token, &ids)?;
        // Consume the preview so concurrent IPC cannot import it twice.
        host.imports.discard();
        Ok((prepared, host.credentials.clone()))
    })
    .await?;
    let imported = tauri::async_runtime::spawn_blocking(move || {
        credentials.retry();
        prepared.acquire(credentials.as_ref())
    })
    .await
    .map_err(|_| "Native import credential operation failed")??;
    run(owner, move |host| {
        host.controller.commit_import(imported)?;
        host.snapshot()
    })
    .await
}

#[tauri::command]
pub(crate) async fn agent_control_create_prepare(
    state: tauri::State<'_, AgentHost>,
    validation: tauri::State<'_, Arc<crate::codex_validation::Host>>,
    request_id: String,
    destination: String,
    owner: String,
    edit: AgentEdit,
    validation_proof: Option<String>,
) -> Result<serde_json::Value, String> {
    let validation = validation.inner().clone();
    run(state.inner().clone(), move |host| {
        if let Some(pending) = host.controller.pending_create_recovery()? {
            return Err(if pending.request_id == request_id {
                "This create requires recovery; resume or discard it before retrying".into()
            } else {
                "Another agent creation requires recovery first".into()
            });
        }
        let draft = host.controller.codex_create_validation(edit)?;
        let admission =
            crate::codex_validation::create_admission(&request_id, &destination, &owner, draft)?;
        if let Some(pending) = host
            .creating
            .as_ref()
            .filter(|pending| pending.request_id == request_id)
        {
            if pending.admission != admission || !pending.prepared.matches(&destination, &owner)? {
                return Err("Create settings changed; validate and start again".into());
            }
            return Ok(serde_json::json!({
                "id": pending.prepared.id,
                "pubkey": pending.prepared.key.pubkey()
            }));
        }
        match (&admission, validation_proof.as_deref()) {
            (Some(admission), Some(proof)) => validation.consume(proof, admission)?,
            (Some(_), None) => return Err("Validate this Codex agent before creating it".into()),
            (None, Some(_)) => return Err("Codex validation does not match this create".into()),
            (None, None) => {}
        }
        let canonical = NewAgent::validate_target(&destination, &owner)?;
        let prepared = Arc::new(NewAgent::prepare(&canonical, &owner)?);
        let response = serde_json::json!({"id": prepared.id, "pubkey": prepared.key.pubkey()});
        host.creating = Some(PendingCreate {
            request_id,
            destination: canonical,
            owner,
            prepared,
            admission,
        });
        Ok(response)
    })
    .await
}

fn bind_create_recovery(
    mut record: buzz_agent_controller::PendingCreateRecovery,
    edit: &AgentEdit,
    auth: &str,
    admission: Option<&crate::codex_validation::Admission>,
) -> Result<buzz_agent_controller::PendingCreateRecovery, String> {
    let codex = admission
        .map(|admission| admission.draft().commitment())
        .transpose()?;
    let bytes = serde_json::to_vec(&serde_json::json!({
        "requestId": record.request_id,
        "destination": record.destination,
        "owner": record.owner,
        "agentId": record.agent_id,
        "pubkey": record.pubkey,
        "edit": edit,
        "auth": auth,
        "codex": codex,
    }))
    .map_err(|_| "Could not bind the create recovery request")?;
    record.commitment = format!("{:x}", Sha256::digest(bytes));
    Ok(record)
}

fn read_create_recovery_key(
    credentials: &dyn Credentials,
    pending: &buzz_agent_controller::PendingCreateRecovery,
) -> Result<buzz_agent_controller::Secret, String> {
    credentials
        .read(&pending.agent_id, &pending.pubkey)?
        .ok_or_else(|| {
            "The pending create has no durable key; discard it and validate again".into()
        })
}

fn discard_create_recovery_key(
    credentials: &dyn Credentials,
    pending: &buzz_agent_controller::PendingCreateRecovery,
) -> Result<(), String> {
    if credentials
        .read(&pending.agent_id, &pending.pubkey)?
        .is_some()
    {
        credentials.delete(&pending.agent_id, &pending.pubkey)?;
    }
    if credentials
        .read(&pending.agent_id, &pending.pubkey)?
        .is_some()
    {
        return Err("Pending credential cleanup could not be confirmed".into());
    }
    Ok(())
}
/// Owner attestation for the pending create's generated key only. The
/// identity may read OS credentials, so the agent host stays unlocked.
#[tauri::command]
pub(crate) async fn agent_control_create_authorize(
    state: tauri::State<'_, AgentHost>,
    identity: tauri::State<'_, crate::identity::IdentityHost>,
    destination: String,
    owner: String,
    pubkey: String,
) -> Result<Vec<String>, String> {
    let (owner, pubkey) = run(state.inner().clone(), move |host| {
        let pending = host
            .creating
            .as_ref()
            .ok_or("Create request expired; reopen Add agent")?;
        if pending.prepared.key.pubkey() != pubkey
            || !pending.prepared.matches(&destination, &owner)?
        {
            return Err("Authorization does not match the pending create request".into());
        }
        Ok((owner, pubkey))
    })
    .await?;
    identity.inner().authorize_agent(owner, pubkey).await
}
#[tauri::command]
pub(crate) async fn agent_control_create_commit(
    state: tauri::State<'_, AgentHost>,
    request_id: String,
    edit: AgentEdit,
    auth: String,
) -> Result<Snapshot, String> {
    let owner = state.inner().clone();
    let lane = owner.2.clone().lock_owned().await;
    let (prepared, credentials, request_id, edit, auth, admission, recovery) =
        owner.with(|host| {
            let pending = host
                .creating
                .as_ref()
                .filter(|pending| pending.request_id == request_id)
                .ok_or("Create request expired; reopen Add agent")?;
            let current = crate::codex_validation::create_admission(
                &request_id,
                &pending.destination,
                &pending.owner,
                host.controller.codex_create_validation(edit.clone())?,
            )?;
            if current != pending.admission {
                return Err("Create settings changed; validate and start again".into());
            }
            let prepared = &pending.prepared;
            prepared.validate(edit.clone(), &auth)?;
            let recovery = bind_create_recovery(
                buzz_agent_controller::PendingCreateRecovery {
                    request_id: request_id.clone(),
                    agent_id: prepared.id.clone(),
                    pubkey: prepared.key.pubkey().into(),
                    destination: pending.destination.clone(),
                    owner: pending.owner.clone(),
                    commitment: String::new(),
                },
                &edit,
                &auth,
                pending.admission.as_ref(),
            )?;
            host.controller.stage_create_recovery(recovery.clone())?;
            Ok((
                prepared.clone(),
                host.credentials.clone(),
                request_id,
                edit,
                auth,
                pending.admission.clone(),
                recovery,
            ))
        })?;
    let saved = prepared.clone();
    let (_lane, saved) = tauri::async_runtime::spawn_blocking(move || {
        credentials.retry();
        let result = saved.save_key(credentials.as_ref());
        (lane, result)
    })
    .await
    .map_err(|_| "Native credential operation failed")?;
    saved?;
    owner.with(move |host| {
        let pending = host
            .creating
            .as_ref()
            .filter(|pending| pending.request_id == request_id)
            .ok_or("Create request was replaced")?;
        let current = crate::codex_validation::create_admission(
            &request_id,
            &pending.destination,
            &pending.owner,
            host.controller.codex_create_validation(edit.clone())?,
        )?;
        if current != admission || pending.admission != admission {
            return Err("Create settings changed; validate and start again".into());
        }
        if host.creating.as_ref().map(|pending| &pending.request_id) != Some(&request_id) {
            return Err("Create request was replaced".into());
        }
        host.controller
            .finish_create_recovery(&prepared, edit, &auth, &recovery)?;
        host.creating = None;
        host.snapshot()
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateRecoveryView {
    request_id: String,
    agent_id: String,
    pubkey: String,
    destination: String,
    owner: String,
}

impl From<buzz_agent_controller::PendingCreateRecovery> for CreateRecoveryView {
    fn from(value: buzz_agent_controller::PendingCreateRecovery) -> Self {
        Self {
            request_id: value.request_id,
            agent_id: value.agent_id,
            pubkey: value.pubkey,
            destination: value.destination,
            owner: value.owner,
        }
    }
}

#[tauri::command]
pub(crate) async fn agent_control_create_recovery(
    state: tauri::State<'_, AgentHost>,
) -> Result<Option<CreateRecoveryView>, String> {
    run(state.inner().clone(), |host| {
        Ok(host.controller.pending_create_recovery()?.map(Into::into))
    })
    .await
}

#[tauri::command]
pub(crate) async fn agent_control_create_resume(
    state: tauri::State<'_, AgentHost>,
    request_id: String,
    edit: AgentEdit,
    auth: String,
) -> Result<Snapshot, String> {
    let owner = state.inner().clone();
    let lane = owner.2.clone().lock_owned().await;
    let (pending, credentials) = owner.with(|host| {
        let pending = host
            .controller
            .pending_create_recovery()?
            .filter(|pending| pending.request_id == request_id)
            .ok_or("Create recovery request no longer exists")?;
        let admission = crate::codex_validation::create_admission(
            &pending.request_id,
            &pending.destination,
            &pending.owner,
            host.controller.codex_create_validation(edit.clone())?,
        )?;
        let expected = bind_create_recovery(pending.clone(), &edit, &auth, admission.as_ref())?;
        if expected != pending {
            return Err(
                "Create recovery input changed; use the original settings or discard it".into(),
            );
        }
        Ok((pending, host.credentials.clone()))
    })?;
    let key_pending = pending.clone();
    let (_lane, key) = tauri::async_runtime::spawn_blocking(move || {
        credentials.retry();
        let result = read_create_recovery_key(credentials.as_ref(), &key_pending);
        (lane, result)
    })
    .await
    .map_err(|_| "Native credential recovery failed")?;
    let key = key?;
    let prepared = NewAgent::recover(&pending.destination, &pending.owner, &pending.agent_id, key)?;
    owner.with(move |host| {
        let admission = crate::codex_validation::create_admission(
            &pending.request_id,
            &pending.destination,
            &pending.owner,
            host.controller.codex_create_validation(edit.clone())?,
        )?;
        let expected = bind_create_recovery(pending.clone(), &edit, &auth, admission.as_ref())?;
        if expected != pending {
            return Err(
                "Create recovery input changed; use the original settings or discard it".into(),
            );
        }
        host.controller
            .finish_create_recovery(&prepared, edit, &auth, &pending)?;
        host.creating = None;
        host.snapshot()
    })
}

#[tauri::command]
pub(crate) async fn agent_control_create_discard(
    state: tauri::State<'_, AgentHost>,
    request_id: String,
) -> Result<Option<CreateRecoveryView>, String> {
    let owner = state.inner().clone();
    let lane = owner.2.clone().lock_owned().await;
    let (pending, credentials) = owner.with(|host| {
        let pending = host
            .controller
            .pending_create_recovery()?
            .filter(|pending| pending.request_id == request_id)
            .ok_or("Create recovery request no longer exists")?;
        Ok((pending, host.credentials.clone()))
    })?;
    let key_pending = pending.clone();
    let (_lane, discarded) = tauri::async_runtime::spawn_blocking(move || {
        credentials.retry();
        let result = discard_create_recovery_key(credentials.as_ref(), &key_pending);
        (lane, result)
    })
    .await
    .map_err(|_| "Native credential recovery failed")?;
    discarded?;
    owner.with(move |host| {
        host.controller.discard_create_recovery(&pending)?;
        host.creating = None;
        Ok(None)
    })
}
#[tauri::command]
pub(crate) async fn agent_control_creation_profile(
    state: tauri::State<'_, AgentHost>,
    id: String,
) -> Result<Snapshot, String> {
    publish_profile(state.inner().clone(), id).await
}

async fn publish_profile(owner: AgentHost, id: String) -> Result<Snapshot, String> {
    // Native ownership survives renderer reloads. Refuse overlapping publication,
    // while allowing settings Save to advance the revision and retain pending.
    let (publication, profile, credentials) = owner.begin_profile(&id).await?;
    let (profile, key) = tauri::async_runtime::spawn_blocking(move || {
        credentials.retry();
        credentials
            .read(&profile.credential_id, &profile.pubkey)
            .map(|key| (profile, key))
    })
    .await
    .map_err(|_| "Native credential operation failed")??;
    let key = key.ok_or("Agent key unavailable")?;
    owner.ensure_open().await?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| "Profile client unavailable")?;
    publish_acquired(&owner, &id, &profile, &key, &client, publication).await
}

async fn publish_acquired(
    owner: &AgentHost,
    id: &str,
    profile: &buzz_agent_controller::CreationProfile,
    key: &buzz_agent_controller::Secret,
    client: &reqwest::Client,
    _publication: tokio::sync::OwnedMutexGuard<()>,
) -> Result<Snapshot, String> {
    let target = id.to_owned();
    let revision = profile.revision;
    profile_http::publish(client, profile, key, || async {
        run(owner.clone(), move |host| {
            let current = host.controller.creation_profile(&target)?;
            if current.revision != revision {
                return Err("Saved profile changed; retry publication".into());
            }
            Ok(())
        })
        .await
    })
    .await?;
    let id = id.to_owned();
    run(owner.clone(), move |host| {
        host.controller.profile_published(&id, revision)?;
        host.snapshot()
    })
    .await
}

mod profile_http;

#[cfg(test)]
pub(crate) mod tests;

// Advisory handover guard only: unmodified old Buzz does not share our lock and
// can be launched afterward. Never inspect process environments or terminate it.
fn refuse_legacy_listing(listing: &str) -> Result<(), String> {
    for line in listing.lines() {
        let executable = line
            .trim()
            .split_once(char::is_whitespace)
            .map(|(_, exe)| exe.trim())
            .unwrap_or("");
        let name = std::path::Path::new(executable)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        if name == "buzz-desktop"
            || executable.contains("/Buzz.app/Contents/MacOS/")
            || executable.contains("/Buzz Dev.app/Contents/MacOS/")
        {
            return Err(
                "Stop old Buzz before starting agents here; simultaneous ownership is unsupported"
                    .into(),
            );
        }
    }
    Ok(())
}
fn refuse_legacy() -> Result<(), String> {
    let output = std::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,comm="])
        .env_clear()
        .output()
        .map_err(|_| "Could not check old Buzz processes; Start refused")?;
    if !output.status.success() || output.stdout.len() > 4 * 1024 * 1024 {
        return Err("Could not check old Buzz processes; Start refused".into());
    }
    refuse_legacy_listing(&String::from_utf8_lossy(&output.stdout))
}

/// Trusted plugin service: native state remains authoritative for all start paths.
#[tauri::command]
pub(crate) async fn agent_security(
    state: tauri::State<'_, AgentHost>,
    request: buzz_agent_controller::security::Request,
) -> Result<serde_json::Value, String> {
    let owner = state.inner().clone();
    let provider = match &request {
        buzz_agent_controller::security::Request::Register { provider, .. } => {
            Some(provider.clone())
        }
        _ => None,
    };
    let result = run(owner.clone(), move |host| host.controller.security(request)).await?;
    if let Some(provider) = provider {
        tauri::async_runtime::spawn(async move {
            let ids = owner
                .with(|host| host.controller.security_restore_ids(&provider))
                .unwrap_or_default();
            for id in ids {
                let _ = start(owner.clone(), id, Action::Start, true, None, None).await;
            }
        });
    }
    Ok(result)
}
