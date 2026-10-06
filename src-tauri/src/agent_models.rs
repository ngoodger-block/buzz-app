//! Native connection owner. No work on snapshot/render; only an explicit ticket
//! admits auth/catalog work. This lock is independent of agent Save/Stop.
use buzz_agent::{
    auth::{BrowserOpener, PkceOAuthConfig, PkceOAuthTokenSource},
    config::{Config, DatabricksModelFilter, Provider},
    AgentError,
};
use buzz_agent_controller::connection::{oauth_root, origin};
use buzz_agent_controller::AgentEdit;
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::Duration,
};
use tauri_plugin_opener::OpenerExt;

const CANCELLED: &str = "Connection request cancelled or expired";
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Defaults {
    host: String,
    filter: String,
}
pub(crate) fn defaults() -> Defaults {
    let defaults = buzz_agent_controller::build_defaults();
    Defaults {
        host: defaults.host,
        filter: defaults.filter,
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    id: Option<String>,
    expected_revision: Option<u64>,
    edit: Option<AgentEdit>,
    host: String,
    filter: String,
    action: Operation,
    /// Stable native identity. Editable executable names never grant managed
    /// Codex behavior.
    integration: Option<buzz_agent_controller::HarnessIntegration>,
    /// Optional model whose reported effort metadata should be returned.
    selected_model: Option<String>,
    /// Blank host/filter are inherited from write-only Agent defaults the UI
    /// cannot see, so native supplies them instead of treating blank as explicit.
    #[serde(default)]
    inherit_workspace: bool,
}
#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Operation {
    Connect,
    Refresh,
    Disconnect,
    /// One small completion with the draft's provider and model.
    Test,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Catalog {
    host: String,
    models: Vec<Model>,
    model_overridden: bool,
    disconnected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    tested_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    codex: Option<CodexCatalog>,
}
#[derive(Serialize)]
struct Model {
    id: String,
    name: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexCatalog {
    /// False means no usable model option was published. True with an empty
    /// `models` array is a known-empty catalog.
    models_known: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolved_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolved_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    effort: Option<CodexEffort>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexEffort {
    model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    current: Option<String>,
    options: Vec<Model>,
}
#[cfg(unix)]
#[derive(Debug)]
enum CodexRunError {
    Message(String),
    Transport(crate::codex_acp::Failure),
}
struct Ticket {
    id: u64,
    abort: Option<tokio::task::AbortHandle>,
    current: Option<Arc<AtomicBool>>,
    process_done: bool,
    cancelled: bool,
    created: std::time::Instant,
}
struct State {
    root: Result<PathBuf, String>,
    next: u64,
    pending: Option<Ticket>,
    closed: bool,
    cleanup_failed: bool,
}
#[cfg(unix)]
struct CodexFinish {
    owner: ModelHost,
    ticket: u64,
    complete: bool,
}
#[cfg(unix)]
impl CodexFinish {
    fn finish(mut self, result: Result<Catalog, CodexRunError>) -> Result<Catalog, String> {
        let mut state = self.owner.state.lock().map_err(|_| CANCELLED.to_owned())?;
        if !state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.id == self.ticket)
        {
            self.complete = true;
            return Err(CANCELLED.to_owned());
        }
        state.cleanup_failed |= matches!(
            &result,
            Err(CodexRunError::Transport(crate::codex_acp::Failure::Cleanup))
        );
        if let Some(pending) = state.pending.as_mut() {
            pending.process_done = true;
        }
        if state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.cancelled || state.closed)
        {
            state.pending = None;
        }
        self.owner.settled.notify_all();
        self.complete = true;
        match result {
            Ok(catalog) => Ok(catalog),
            Err(CodexRunError::Transport(failure)) => Err(codex_failure(failure)),
            Err(CodexRunError::Message(message)) => Err(message),
        }
    }
}
#[cfg(unix)]
impl Drop for CodexFinish {
    fn drop(&mut self) {
        if self.complete {
            return;
        }
        if let Ok(mut state) = self.owner.state.lock() {
            if state
                .pending
                .as_ref()
                .is_some_and(|pending| pending.id == self.ticket)
            {
                state.cleanup_failed = true;
                if let Some(pending) = state.pending.as_mut() {
                    pending.process_done = true;
                }
                if state
                    .pending
                    .as_ref()
                    .is_some_and(|pending| pending.cancelled || state.closed)
                {
                    state.pending = None;
                }
                self.owner.settled.notify_all();
            }
        }
    }
}
#[cfg(unix)]
struct CodexAdmission {
    owner: ModelHost,
    ticket: u64,
    retired: bool,
}
#[cfg(unix)]
impl CodexAdmission {
    fn retire(&mut self) -> Result<(), String> {
        let mut state = self.owner.state.lock().map_err(|_| CANCELLED)?;
        let pending = state
            .pending
            .as_ref()
            .filter(|pending| pending.id == self.ticket)
            .ok_or(CANCELLED)?;
        let current = pending
            .current
            .as_ref()
            .is_some_and(|current| current.load(Ordering::SeqCst));
        let cancelled = pending.cancelled || state.closed || !current;
        let cleanup_failed = state.cleanup_failed;
        state.pending = None;
        self.owner.settled.notify_all();
        self.retired = true;
        if cleanup_failed {
            Err("Codex model process cleanup could not be confirmed".into())
        } else if cancelled {
            Err(CANCELLED.into())
        } else {
            Ok(())
        }
    }
}
#[cfg(unix)]
impl Drop for CodexAdmission {
    fn drop(&mut self) {
        if !self.retired {
            let _ = self.owner.cancel(self.ticket);
        }
    }
}
#[derive(Clone)]
pub(crate) struct ModelHost {
    state: Arc<Mutex<State>>,
    settled: Arc<Condvar>,
    factory: Arc<dyn Factory>,
}
impl ModelHost {
    pub(crate) fn new(root: Result<PathBuf, String>) -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                root,
                next: 0,
                pending: None,
                closed: false,
                cleanup_failed: false,
            })),
            settled: Arc::new(Condvar::new()),
            factory: Arc::new(RuntimeFactory),
        }
    }
    fn begin(&self) -> Result<u64, String> {
        let mut state = self.state.lock().map_err(|_| CANCELLED)?;
        if state.closed || state.cleanup_failed {
            return Err(CANCELLED.into());
        }
        if state.pending.as_ref().is_some_and(|p| {
            p.abort.is_none()
                && p.current.is_none()
                && p.created.elapsed() > Duration::from_secs(15)
        }) {
            state.pending = None;
        }
        if state.pending.is_some() {
            return Err("Another model connection request is in progress; cancel it first".into());
        }
        state.next = state
            .next
            .checked_add(1)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or(CANCELLED)?;
        let id = state.next;
        state.pending = Some(Ticket {
            id,
            abort: None,
            current: None,
            process_done: false,
            cancelled: false,
            created: std::time::Instant::now(),
        });
        Ok(id)
    }
    fn cancel(&self, ticket: u64) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| CANCELLED)?;
        if let Some(pending) = state.pending.as_mut().filter(|p| p.id == ticket) {
            pending.cancelled = true;
            if let Some(current) = &pending.current {
                current.store(false, Ordering::SeqCst);
                if pending.process_done {
                    state.pending = None;
                    self.settled.notify_all();
                }
            } else if let Some(abort) = &pending.abort {
                // Keep admission occupied until JoinHandle confirms the future
                // (including callback/credential work) has actually been dropped.
                abort.abort();
            } else {
                state.pending = None;
                self.settled.notify_all();
            }
        }
        Ok(())
    }
    pub(crate) fn shutdown(&self) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| CANCELLED)?;
        state.closed = true;
        let owned = state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.current.is_some());
        if let Some(pending) = state.pending.as_mut() {
            pending.cancelled = true;
            if let Some(current) = &pending.current {
                current.store(false, Ordering::SeqCst);
            } else if let Some(abort) = &pending.abort {
                abort.abort();
            }
        }
        if !owned {
            state.pending = None;
            return (!state.cleanup_failed)
                .then_some(())
                .ok_or_else(|| "Model connection cleanup previously failed".into());
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.current.is_some() && !pending.process_done)
        {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err("Model connection cleanup could not be confirmed".into());
            }
            let (next, wait) = self
                .settled
                .wait_timeout(state, remaining)
                .map_err(|_| CANCELLED)?;
            state = next;
            if wait.timed_out()
                && state
                    .pending
                    .as_ref()
                    .is_some_and(|pending| pending.current.is_some() && !pending.process_done)
            {
                return Err("Model connection cleanup could not be confirmed".into());
            }
        }
        state.pending = None;
        (!state.cleanup_failed)
            .then_some(())
            .ok_or_else(|| "Model connection cleanup previously failed".into())
    }
    async fn run(
        &self,
        ticket: u64,
        work: impl std::future::Future<Output = Result<Catalog, String>> + Send + 'static,
    ) -> Result<Catalog, String> {
        let task = {
            let mut state = self.state.lock().map_err(|_| CANCELLED)?;
            let pending = state
                .pending
                .as_mut()
                .filter(|p| {
                    p.id == ticket
                        && p.abort.is_none()
                        && p.current.is_none()
                        && !p.cancelled
                        && p.created.elapsed() < Duration::from_secs(15)
                })
                .ok_or(CANCELLED)?;
            let task = tokio::spawn(async move {
                tokio::time::timeout(Duration::from_secs(180), work)
                    .await
                    .map_err(|_| "Connection timed out; retry explicitly".to_owned())?
            });
            pending.abort = Some(task.abort_handle());
            task
        };
        // The supervisor owns retirement even if the IPC response future is
        // dropped. Only the worker is abortable; admission reopens AFTER drop.
        let owner = self.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let result = task.await.map_err(|_| CANCELLED.to_owned()).and_then(|r| r);
            let result = (|| {
                let mut state = owner.state.lock().map_err(|_| CANCELLED)?;
                if !state.pending.as_ref().is_some_and(|p| p.id == ticket) {
                    return Err(CANCELLED.into());
                }
                let cancelled = state.pending.as_ref().is_some_and(|p| p.cancelled) || state.closed;
                state.pending = None;
                owner.settled.notify_all();
                if cancelled {
                    Err(CANCELLED.into())
                } else {
                    result
                }
            })();
            let _ = send.send(result);
        });
        receive.await.map_err(|_| CANCELLED.to_owned())?
    }
    #[cfg(unix)]
    async fn run_codex<V, F>(
        &self,
        ticket: u64,
        work: impl FnOnce(Arc<AtomicBool>) -> Result<Catalog, CodexRunError> + Send + 'static,
        validate: V,
    ) -> Result<Catalog, String>
    where
        V: FnOnce() -> F,
        F: std::future::Future<Output = Result<(), String>>,
    {
        let current = Arc::new(AtomicBool::new(true));
        {
            let mut state = self.state.lock().map_err(|_| CANCELLED)?;
            let pending = state
                .pending
                .as_mut()
                .filter(|pending| {
                    pending.id == ticket
                        && pending.abort.is_none()
                        && pending.current.is_none()
                        && !pending.cancelled
                        && pending.created.elapsed() < Duration::from_secs(15)
                })
                .ok_or(CANCELLED)?;
            pending.current = Some(current.clone());
        }
        let mut admission = CodexAdmission {
            owner: self.clone(),
            ticket,
            retired: false,
        };
        let final_current = current.clone();
        let owner = self.clone();
        let task = tokio::task::spawn_blocking(move || {
            let finish = CodexFinish {
                owner,
                ticket,
                complete: false,
            };
            finish.finish(work(current))
        });
        let result = task
            .await
            .map_err(|_| "Codex model process cleanup could not be confirmed".to_owned())?;
        if result.is_ok() {
            validate().await?;
            if !final_current.load(Ordering::SeqCst) {
                return Err(CANCELLED.into());
            }
        }
        admission.retire()?;
        result
    }
    fn cache(&self, _host: &str) -> Result<PathBuf, String> {
        let state = self.state.lock().map_err(|_| CANCELLED)?;
        oauth_root(&state.root.clone()?)
    }
}
struct Opener<R: tauri::Runtime>(tauri::AppHandle<R>);
impl<R: tauri::Runtime> BrowserOpener for Opener<R> {
    fn open(&self, url: &str) -> Result<(), String> {
        self.0
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|_| "Could not open the sign-in browser".into())
    }
}
fn resolve(
    request: &Request,
    context: &buzz_agent_controller::ModelContext,
) -> Result<(String, Option<DatabricksModelFilter>), String> {
    if request.host.len() > 4096 || request.filter.len() > 4096 {
        return Err("Connection settings are too long".into());
    }
    // An explicit agent workspace/filter must never be replaced by an inherited
    // default, even if a caller sends inheritWorkspace with blank request fields.
    let can_inherit = request.inherit_workspace
        && request
            .edit
            .as_ref()
            .is_some_and(|edit| edit.harness.databricks.is_none());
    let defer = |value: &str| can_inherit && value.is_empty();
    let host = origin(context.host.as_deref().unwrap_or(&request.host))?;
    if context.host.is_some() && !defer(&request.host) && origin(&request.host)? != host {
        return Err("Workspace conflicts with the saved/draft DATABRICKS_HOST override; use that workspace or edit the override".into());
    }
    let filter = match &context.filter {
        Some(native) if defer(&request.filter) => native,
        Some(native) if native != &request.filter => {
            return Err("Filter conflicts with the saved/draft DATABRICKS_MODEL_FILTER override; edit the override or match it explicitly".into());
        }
        _ => &request.filter,
    };
    let filter = DatabricksModelFilter::parse(Some(filter))
        .map_err(|_| "Invalid model filter".to_owned())?;
    Ok((host, filter))
}
#[tauri::command]
pub(crate) fn agent_models_begin(state: tauri::State<'_, ModelHost>) -> Result<u64, String> {
    state.begin()
}
#[tauri::command]
pub(crate) fn agent_models_cancel(
    state: tauri::State<'_, ModelHost>,
    ticket: u64,
) -> Result<(), String> {
    state.cancel(ticket)
}
#[tauri::command]
pub(crate) async fn agent_models_run<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, ModelHost>,
    agents: tauri::State<'_, crate::agents::AgentHost>,
    ticket: u64,
    request: Request,
) -> Result<Catalog, String> {
    let host = state.inner().clone();
    let controller = agents.inner().clone();
    if request.integration == Some(buzz_agent_controller::HarnessIntegration::Codex) {
        #[cfg(not(unix))]
        return host
            .run(ticket, async {
                Err("Codex model discovery is not supported on this platform".into())
            })
            .await;
        #[cfg(unix)]
        {
            if !matches!(request.action, Operation::Connect | Operation::Refresh) {
                return host
                    .run(ticket, async {
                        Err("Codex model discovery supports Browse and Refresh only".into())
                    })
                    .await;
            }
            let edit = request.edit.clone();
            let prepared = match edit.clone() {
                Some(edit) => {
                    controller
                        .codex_model_context(request.id.as_deref(), request.expected_revision, edit)
                        .await
                }
                None => Err("Agent draft is required for model lookup".into()),
            };
            let selected_model = request.selected_model.clone();
            return match prepared {
                Ok(context) => {
                    let validation_controller = controller.clone();
                    let validation_id = request.id.clone();
                    let validation_revision = request.expected_revision;
                    let validation_edit =
                        edit.ok_or_else(|| "Agent draft is required for model lookup".to_owned())?;
                    run_codex_request(&host, ticket, context, selected_model, move || async move {
                        validation_controller
                            .codex_model_context(
                                validation_id.as_deref(),
                                validation_revision,
                                validation_edit,
                            )
                            .await
                    })
                    .await
                }
                Err(error) => host.run(ticket, async move { Err(error) }).await,
            };
        }
    }
    if request.edit.as_ref().is_some_and(|e| {
        std::path::Path::new(&e.harness.command)
            .file_name()
            .and_then(|n| n.to_str())
            == Some("buzz-pi-acp")
    }) {
        let edit = request.edit.clone().unwrap();
        let prepared = controller
            .pi_model_context(
                request.id.as_deref(),
                request.expected_revision,
                edit.clone(),
            )
            .await;
        return host
            .run(ticket, async move {
                if request.action == Operation::Disconnect {
                    return Err("Pi credentials are managed by Pi".into());
                }
                let context = crate::pi_models::verify(prepared?).await?.into_context();
                if request.action == Operation::Test {
                    let harness = &edit.harness;
                    let tested_model =
                        crate::pi_models::test(context, &harness.provider, &harness.model).await?;
                    return Ok(Catalog {
                        host: String::new(),
                        models: vec![],
                        model_overridden: false,
                        disconnected: false,
                        tested_model: Some(tested_model),
                        codex: None,
                    });
                }
                let models = crate::pi_models::fetch(context)
                    .await?
                    .into_iter()
                    .map(|id| Model {
                        name: id.clone(),
                        id,
                    })
                    .collect();
                Ok(Catalog {
                    host: String::new(),
                    models,
                    model_overridden: false,
                    disconnected: false,
                    tested_model: None,
                    codex: None,
                })
            })
            .await;
    }
    let goose = request.edit.as_ref().is_some_and(|edit| {
        std::path::Path::new(&edit.harness.command)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| matches!(name.trim_end_matches(".exe"), "goose" | "goose-acp"))
    });
    if goose {
        // Goose's catalog handler may start OAuth on a cache miss. Only an
        // explicit Browse/Retry or Test may invoke Goose; Refresh stays headless.
        if !matches!(request.action, Operation::Connect | Operation::Test) {
            return host
                .run(ticket, async {
                    Err("Goose model lookup requires explicit Browse or Retry".into())
                })
                .await;
        }
        let prepared = match request.edit.clone() {
            Some(edit) => {
                controller
                    .goose_model_context(request.id.as_deref(), request.expected_revision, edit)
                    .await
            }
            None => Err("Agent draft is required for model lookup".to_owned()),
        };
        return host
            .run(ticket, async move {
                let context = prepared?;
                if request.action == Operation::Test {
                    // Saved environment overrides are write-only. Testing them
                    // must not return their hidden provider/model values to IPC.
                    let selection_overridden = context.model_overridden
                        || context.environment.contains_key("GOOSE_PROVIDER");
                    let tested_model = crate::goose_models::test(context).await?;
                    return Ok(Catalog {
                        host: String::new(),
                        models: vec![],
                        model_overridden: false,
                        disconnected: false,
                        tested_model: (!selection_overridden).then_some(tested_model),
                        codex: None,
                    });
                }
                let model_overridden = context.model_overridden;
                let models = crate::goose_models::fetch(context)
                    .await?
                    .into_iter()
                    .map(|id| Model {
                        name: id.clone(),
                        id,
                    })
                    .collect();
                Ok(Catalog {
                    host: String::new(),
                    models,
                    model_overridden,
                    disconnected: false,
                    tested_model: None,
                    codex: None,
                })
            })
            .await;
    }
    if request.action == Operation::Test {
        return host
            .run(ticket, async {
                Err("Connection tests are only available for Pi and Goose".into())
            })
            .await;
    }
    // Disconnect is recovery: changing provider or breaking saved settings must
    // not trap credentials. Its explicit host selects ONLY this app's cache.
    let prepared = if request.action == Operation::Disconnect {
        // An inherited workspace is sent blank; native resolves it from Agent
        // defaults without the draft, so recovery survives invalid settings.
        let named = if request.inherit_workspace && request.host.is_empty() {
            controller
                .inherited_workspace()
                .await
                .and_then(|workspace| {
                    workspace.ok_or_else(|| {
                        "Agent defaults no longer set a Databricks workspace".to_owned()
                    })
                })
        } else {
            controller.ensure_open().await.map(|_| request.host.clone())
        };
        named
            .and_then(|named| origin(&named))
            .and_then(|workspace| {
                host.cache(&workspace)
                    .map(|cache| (false, workspace, None, cache))
            })
    } else {
        // Short settings read only; never hold the controller across network waits.
        let context = match request.edit.clone() {
            Some(edit) => {
                controller
                    .model_context(request.id.as_deref(), request.expected_revision, edit)
                    .await
            }
            None => Err("Agent draft is required for model lookup".to_owned()),
        };
        context
            .and_then(|context| {
                resolve(&request, &context)
                    .map(|(workspace, filter)| (context.model_overridden, workspace, filter))
            })
            .and_then(|(overridden, workspace, filter)| {
                host.cache(&workspace)
                    .map(|cache| (overridden, workspace, filter, cache))
            })
    };
    let factory = state.factory.clone();
    let hide_inherited_host = request.inherit_workspace && request.host.is_empty();
    host.run(ticket, async move {
        let (model_overridden, workspace, filter, cache) = prepared?;
        if request.action == Operation::Disconnect {
            controller.disconnect(&workspace).await?;
            return Ok(Catalog {
                host: if hide_inherited_host {
                    String::new()
                } else {
                    workspace
                },
                models: vec![],
                model_overridden,
                disconnected: true,
                tested_model: None,
                codex: None,
            });
        }
        execute(
            request.action,
            workspace,
            filter,
            cache,
            model_overridden,
            factory,
            Arc::new(Opener(app)),
        )
        .await
    })
    .await
    .map(|mut catalog| {
        // The native connection uses the inherited write-only environment;
        // the catalog projection must not reveal its workspace URL to the UI.
        if hide_inherited_host {
            catalog.host.clear();
        }
        catalog
    })
}

// Production reuses the immutable engine with its existing auth policy. Tests replace only the
// network/auth transport behind the same command admission and operation logic.
trait Connection: Send + Sync {
    fn connect(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>>;
    fn models(
        &self,
        filter: Option<DatabricksModelFilter>,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<Vec<buzz_agent::catalog::ModelEntry>, AgentError>,
                > + Send
                + '_,
        >,
    >;
}
trait Factory: Send + Sync {
    fn open(
        &self,
        workspace: &str,
        cache: &std::path::Path,
        opener: Arc<dyn BrowserOpener>,
    ) -> Result<Box<dyn Connection>, String>;
}
struct RuntimeFactory;
struct RuntimeConnection {
    workspace: String,
    cache: PathBuf,
    auth: Arc<PkceOAuthTokenSource>,
}
impl Factory for RuntimeFactory {
    fn open(
        &self,
        workspace: &str,
        cache: &std::path::Path,
        opener: Arc<dyn BrowserOpener>,
    ) -> Result<Box<dyn Connection>, String> {
        let workspace = origin(workspace)?;
        Ok(Box::new(RuntimeConnection::new(workspace, cache, opener)?))
    }
}
impl RuntimeConnection {
    fn new(
        workspace: String,
        cache: &std::path::Path,
        opener: Arc<dyn BrowserOpener>,
    ) -> Result<Self, String> {
        if cfg!(windows) {
            return Err(buzz_agent_controller::connection::DATABRICKS_WINDOWS.into());
        }
        // Match the pinned runtime's discovery/client/scopes/namespace exactly.
        // Do not call the convenience wrapper: its default opener logs the URL.
        let auth = PkceOAuthTokenSource::new_with(
            PkceOAuthConfig {
                discovery_url: format!("{workspace}/oidc/.well-known/oauth-authorization-server"),
                client_id: "databricks-cli".into(),
                scopes: vec!["all-apis".into(), "offline_access".into()],
                cache_namespace: "databricks".into(),
                cache_dir_override: Some(cache.to_path_buf()),
            },
            opener,
        )
        .map_err(|_| "Could not open the app-isolated Databricks connection")?;
        Ok(Self {
            workspace,
            cache: cache.into(),
            auth,
        })
    }
}
impl Connection for RuntimeConnection {
    fn connect(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async {
            self.auth
                .interactive_login()
                .await
                .map_err(|_| "Sign-in was not completed. Choose Retry models when ready".into())
        })
    }
    fn models(
        &self,
        filter: Option<DatabricksModelFilter>,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<Vec<buzz_agent::catalog::ModelEntry>, AgentError>,
                > + Send
                + '_,
        >,
    > {
        Box::pin(async {
            let config = Config::for_discovery(
                Provider::DatabricksV2,
                String::new(),
                self.workspace.clone(),
                filter,
            );
            buzz_agent::discover_databricks_models_with_cache_dir(&config, Some(&self.cache)).await
        })
    }
}
async fn execute(
    action: Operation,
    workspace: String,
    filter: Option<DatabricksModelFilter>,
    cache: PathBuf,
    model_overridden: bool,
    factory: Arc<dyn Factory>,
    opener: Arc<dyn BrowserOpener>,
) -> Result<Catalog, String> {
    let connection = factory.open(&workspace, &cache, opener.clone())?;
    // The picker is user intent to discover models, not a mandatory login ceremony.
    // Reuse/refresh cached credentials first; unrelated failures must never open SSO.
    let entries = match connection.models(filter.clone()).await {
        Err(AgentError::LlmAuth(_)) if action == Operation::Connect => {
            // Discovery may have invalidated a rejected token on disk. Reopen after
            // that verdict rather than retaining a pre-discovery in-memory token.
            let connection = factory.open(&workspace, &cache, opener)?;
            connection.connect().await?;
            connection.models(filter).await
        }
        result => result,
    }
    .map_err(|error| match error {
        AgentError::LlmAuth(_) => "Sign-in required. Choose Retry models to sign in".to_owned(),
        _ => "Models unavailable. Check the workspace, filter or network and retry".to_owned(),
    })?;
    if entries.len() > 10_000
        || entries.iter().any(|m| {
            m.id.len() > 512
                || m.name.len() > 1024
                || m.id.chars().any(char::is_control)
                || m.name.chars().any(char::is_control)
        })
    {
        return Err("Model catalog exceeds the app's safe display limits; use a narrower filter or custom ID".into());
    }
    // Upstream's explicitly labelled authenticated-empty defaults are NOT
    // discovered IDs. Keep custom entry, show empty instead of guessing models.
    let models = entries
        .into_iter()
        .filter(|m| !m.name.ends_with(" (default catalog)"))
        .map(|m| Model {
            id: m.id,
            name: m.name,
        })
        .collect();
    Ok(Catalog {
        host: workspace,
        models,
        model_overridden,
        disconnected: false,
        tested_model: None,
        codex: None,
    })
}

#[cfg(unix)]
fn codex_readiness_failure(status: crate::codex_readiness::Readiness) -> CodexRunError {
    if status.status == "cleanup-failed" {
        CodexRunError::Transport(crate::codex_acp::Failure::Cleanup)
    } else {
        CodexRunError::Message(
            match status.status {
                "cancelled" => CANCELLED,
                "timeout" => "Codex tool verification timed out; retry explicitly",
                "output-limit" => "Codex tool verification exceeded its output limit",
                "signed-out" => "Sign in with the selected Codex CLI, then retry",
                "configuration-error" => "Codex configuration or login could not be read",
                "adapter-incompatible" => "The selected Codex ACP adapter is incompatible",
                "cli-incompatible" => "The selected Codex CLI is incompatible",
                _ => "Codex tools could not be verified",
            }
            .into(),
        )
    }
}

#[cfg(unix)]
fn codex_failure(failure: crate::codex_acp::Failure) -> String {
    match failure {
        crate::codex_acp::Failure::Cancelled => CANCELLED,
        crate::codex_acp::Failure::Timeout => "Codex model discovery timed out; retry explicitly",
        crate::codex_acp::Failure::OutputLimit => {
            "Codex model discovery exceeded its safe output limit"
        }
        crate::codex_acp::Failure::Cleanup => "Codex model process cleanup could not be confirmed",
        crate::codex_acp::Failure::Incompatible => {
            "Codex model discovery could not be completed with the selected tools"
        }
    }
    .into()
}

#[cfg(unix)]
fn codex_catalog(discovery: crate::codex_models::Discovery) -> Catalog {
    let models_known = discovery.models.is_some();
    let models = discovery
        .models
        .unwrap_or_default()
        .into_iter()
        .map(|entry| Model {
            id: entry.id,
            name: entry.name,
        })
        .collect();
    let effort = discovery.effort.map(|effort| CodexEffort {
        model: effort.model,
        current: effort.current,
        options: effort
            .options
            .into_iter()
            .map(|entry| Model {
                id: entry.id,
                name: entry.name,
            })
            .collect(),
    });
    Catalog {
        host: String::new(),
        models,
        model_overridden: false,
        disconnected: false,
        tested_model: None,
        codex: Some(CodexCatalog {
            models_known,
            resolved_model: discovery.resolved_model,
            resolved_effort: discovery.resolved_effort,
            effort,
        }),
    }
}

#[cfg(unix)]
fn discover_codex_context(
    context: &buzz_agent_controller::codex::CodexContext,
    selected_model: Option<&str>,
    current: &impl Fn() -> bool,
) -> Result<Catalog, CodexRunError> {
    let binding =
        crate::codex_readiness::check_tools(context, current).map_err(codex_readiness_failure)?;
    let discovery =
        crate::codex_models::discover(context, &binding.adapter_version, selected_model, current)
            .map_err(CodexRunError::Transport)?;
    Ok(codex_catalog(discovery))
}

#[cfg(unix)]
async fn run_codex_request<V, F>(
    host: &ModelHost,
    ticket: u64,
    context: buzz_agent_controller::codex::CodexContext,
    selected_model: Option<String>,
    revalidate: V,
) -> Result<Catalog, String>
where
    V: FnOnce() -> F,
    F: std::future::Future<Output = Result<buzz_agent_controller::codex::CodexContext, String>>,
{
    let expected = context.clone();
    host.run_codex(
        ticket,
        move |current| {
            discover_codex_context(&context, selected_model.as_deref(), &|| {
                current.load(Ordering::SeqCst)
            })
        },
        move || async move {
            let latest = revalidate().await?;
            (latest == expected)
                .then_some(())
                .ok_or_else(|| "Agent settings changed during Codex model discovery; retry".into())
        },
    )
    .await
}

#[cfg(test)]
mod tests;

// Windows refuses this OAuth engine: see databricks_oauth_is_unsupported_on_windows.
#[cfg(all(test, unix))]
mod bundled_tests;
