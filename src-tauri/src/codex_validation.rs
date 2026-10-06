//! Proof-backed native Codex inference admission. Validation never receives
//! Buzz identity, relay, authorization, or MCP configuration.
use buzz_agent_controller::{AgentEdit, CodexValidationDraft, NewAgent};
use serde::{Deserialize, Serialize};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const PROOF_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ValidationError {
    category: &'static str,
    message: &'static str,
}

impl ValidationError {
    fn new(category: &'static str, message: &'static str) -> Self {
        Self { category, message }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    request_id: String,
    id: Option<String>,
    expected_revision: Option<u64>,
    destination: Option<String>,
    owner: Option<String>,
    edit: AgentEdit,
}

#[derive(Clone, PartialEq)]
enum Target {
    Create { destination: String, owner: String },
    Edit { id: String, revision: u64 },
}

#[derive(Clone, PartialEq)]
pub(crate) struct Admission {
    request_id: String,
    target: Target,
    draft: CodexValidationDraft,
}

impl Admission {
    pub(crate) fn draft(&self) -> &CodexValidationDraft {
        &self.draft
    }
}

pub(crate) fn create_admission(
    request_id: &str,
    destination: &str,
    owner: &str,
    draft: Option<CodexValidationDraft>,
) -> Result<Option<Admission>, String> {
    if uuid::Uuid::parse_str(request_id).is_err() {
        return Err("Invalid create request".into());
    }
    let destination = NewAgent::validate_target(destination, owner)?;
    Ok(draft.map(|draft| Admission {
        request_id: request_id.into(),
        target: Target::Create {
            destination,
            owner: owner.into(),
        },
        draft,
    }))
}

pub(crate) fn edit_admission(
    request_id: &str,
    id: &str,
    revision: u64,
    draft: Option<CodexValidationDraft>,
) -> Result<Option<Admission>, String> {
    if uuid::Uuid::parse_str(request_id).is_err() {
        return Err("Invalid validation request".into());
    }
    Ok(draft.map(|draft| Admission {
        request_id: request_id.into(),
        target: Target::Edit {
            id: id.into(),
            revision,
        },
        draft,
    }))
}

struct Proof {
    ticket: u64,
    token: String,
    admission: Admission,
    created: Instant,
}

#[derive(Default)]
struct State {
    current: Option<u64>,
    proof: Option<Proof>,
    closed: bool,
}

pub(crate) struct Host {
    operations: Arc<crate::codex_readiness::Host>,
    lane: Arc<tokio::sync::Mutex<()>>,
    state: Mutex<State>,
}

impl Default for Host {
    fn default() -> Self {
        Self {
            operations: Arc::default(),
            lane: Arc::default(),
            state: Mutex::new(State::default()),
        }
    }
}

impl Host {
    fn begin(&self) -> Result<u64, ValidationError> {
        let mut state = self.state.lock().map_err(|_| unavailable())?;
        if state.closed {
            return Err(unavailable());
        }
        let ticket = self.operations.begin_owned().map_err(|_| unavailable())?;
        state.proof = None;
        state.current = Some(ticket);
        Ok(ticket)
    }

    fn cancel(&self, ticket: u64) {
        if let Ok(mut state) = self.state.lock() {
            if state.current == Some(ticket) {
                state.current = None;
            }
            if state
                .proof
                .as_ref()
                .is_some_and(|proof| proof.ticket == ticket)
            {
                state.proof = None;
            }
        }
        self.operations.cancel_owned(ticket);
    }

    fn current(&self, ticket: u64) -> bool {
        self.state
            .lock()
            .is_ok_and(|state| !state.closed && state.current == Some(ticket))
    }

    fn finish(&self, ticket: u64) {
        if let Ok(mut state) = self.state.lock() {
            if state.current == Some(ticket) {
                state.current = None;
            }
        }
    }

    fn seal(&self, ticket: u64, admission: Admission) -> Result<String, ValidationError> {
        let mut state = self.state.lock().map_err(|_| unavailable())?;
        if state.closed || state.current != Some(ticket) {
            return Err(cancelled());
        }
        let proof = uuid::Uuid::new_v4().to_string();
        state.proof = Some(Proof {
            ticket,
            token: proof.clone(),
            admission,
            created: Instant::now(),
        });
        state.current = None;
        Ok(proof)
    }

    pub(crate) fn consume(&self, proof: &str, expected: &Admission) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Codex validation proof is unavailable")?;
        let stored = state.proof.take();
        let proof = stored
            .filter(|stored| stored.token == proof && stored.created.elapsed() <= PROOF_TTL)
            .ok_or("Codex validation proof expired; validate again")?;
        if &proof.admission != expected {
            return Err("Codex validation does not match these settings; validate again".into());
        }
        Ok(())
    }

    pub(crate) fn shutdown(&self) -> Result<(), String> {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
            state.current = None;
            state.proof = None;
        }
        self.operations.shutdown()
    }
}

struct CallerAdmission {
    owner: Arc<Host>,
    ticket: u64,
    armed: bool,
}

impl CallerAdmission {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CallerAdmission {
    fn drop(&mut self) {
        if self.armed {
            self.owner.cancel(self.ticket);
        }
    }
}

#[derive(Serialize)]
pub(crate) struct ValidationProof {
    proof: String,
}

#[tauri::command]
pub(crate) fn codex_validation_begin(
    state: tauri::State<'_, Arc<Host>>,
) -> Result<u64, ValidationError> {
    state.begin()
}

#[tauri::command]
pub(crate) fn codex_validation_cancel(state: tauri::State<'_, Arc<Host>>, ticket: u64) {
    state.cancel(ticket);
}

#[tauri::command]
pub(crate) async fn codex_validation_run(
    state: tauri::State<'_, Arc<Host>>,
    agents: tauri::State<'_, crate::agents::AgentHost>,
    ticket: u64,
    request: Request,
) -> Result<Option<ValidationProof>, ValidationError> {
    if !state.current(ticket) {
        return Err(cancelled());
    }
    let mut caller = CallerAdmission {
        owner: state.inner().clone(),
        ticket,
        armed: true,
    };
    let Some(admission) = prepare(agents.inner(), &request).await? else {
        state.cancel(ticket);
        caller.disarm();
        return Ok(None);
    };
    let draft = admission.draft.clone();
    let owner = state.inner().clone();
    let operation = owner.operations.clone();
    let lane = owner.lane.clone().lock_owned().await;
    if !owner.current(ticket) {
        return Err(cancelled());
    }
    #[cfg(unix)]
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let _lane = lane;
        crate::codex_readiness::run_owned(
            operation,
            ticket,
            cancelled,
            |error| error.category == "cleanup",
            |cancelled_flag| {
                let current = || !cancelled_flag.load(std::sync::atomic::Ordering::SeqCst);
                let binding = crate::codex_readiness::check_tools(draft.context(), &current)
                    .map_err(readiness_error)?;
                validate_inference(
                    draft.context(),
                    draft.model(),
                    draft.configuration(),
                    &binding.adapter_version,
                    &current,
                )
                .map_err(failure_error)
            },
        )
    })
    .await;
    #[cfg(not(unix))]
    let joined: Result<Result<(), ValidationError>, ()> = {
        let _ = (draft, operation, lane);
        Ok(Err(ValidationError::new(
            "unsupported",
            "Native Codex validation is not available on this platform.",
        )))
    };
    let validation = match joined {
        Ok(result) => result,
        Err(_) => Err(ValidationError::new(
            "cleanup",
            "Codex validation cleanup could not be confirmed. Restart Buzz before retrying.",
        )),
    };
    if let Err(error) = validation {
        owner.finish(ticket);
        return Err(error);
    }
    if !owner.current(ticket) {
        return Err(cancelled());
    }
    let current = prepare(agents.inner(), &request).await?;
    if current.as_ref() != Some(&admission) {
        owner.finish(ticket);
        return Err(ValidationError::new(
            "stale",
            "Agent settings changed during validation. Reload and validate again.",
        ));
    }
    let result = owner
        .seal(ticket, admission)
        .map(|proof| Some(ValidationProof { proof }));
    if result.is_ok() {
        caller.disarm();
    }
    result
}

async fn prepare(
    agents: &crate::agents::AgentHost,
    request: &Request,
) -> Result<Option<Admission>, ValidationError> {
    if uuid::Uuid::parse_str(&request.request_id).is_err() {
        return Err(invalid());
    }
    match (
        request.id.as_ref(),
        request.expected_revision,
        request.destination.as_ref(),
        request.owner.as_ref(),
    ) {
        (Some(id), Some(revision), None, None) => {
            let draft = agents
                .codex_edit_validation(id.clone(), revision, request.edit.clone())
                .await
                .map_err(|_| invalid())?;
            edit_admission(&request.request_id, id, revision, draft).map_err(|_| invalid())
        }
        (None, None, Some(destination), Some(owner)) => {
            let draft = agents
                .codex_create_validation(request.edit.clone())
                .await
                .map_err(|_| invalid())?;
            create_admission(&request.request_id, destination, owner, draft).map_err(|_| invalid())
        }
        _ => Err(invalid()),
    }
}

#[cfg(unix)]
fn validate_inference(
    context: &buzz_agent_controller::codex::CodexContext,
    model: &str,
    configuration: &buzz_agent_controller::AiConfiguration,
    adapter_version: &str,
    current: &impl Fn() -> bool,
) -> Result<(), crate::codex_acp::Failure> {
    use crate::codex_acp::{self, Failure, Limits};
    use serde_json::{json, Value};
    codex_acp::run(context, Limits::validation(), current, |client| {
        client.initialize(adapter_version, current)?;
        let opened = client.request(
            "session/new",
            json!({"cwd": context.workspace, "mcpServers": []}),
            current,
        )?;
        let session_id = opened
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 512)
            .ok_or(Failure::Incompatible)?
            .to_owned();
        crate::codex_models::apply_configuration(
            client,
            &session_id,
            &opened,
            model,
            configuration,
            current,
        )?;
        let mut message = false;
        let mut terminal_failure = None;
        let result = client.request_observing(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{"type": "text", "text": "Reply with exactly OK."}]
            }),
            current,
            &mut |notification| {
                if notification.get("method").and_then(Value::as_str) != Some("session/update") {
                    return Ok(());
                }
                let params = notification.get("params").ok_or(Failure::Incompatible)?;
                if params.get("sessionId").and_then(Value::as_str) != Some(&session_id) {
                    return Err(Failure::Incompatible);
                }
                let update = params.get("update").ok_or(Failure::Incompatible)?;
                if let Some(failure) = codex_acp::failure_meta(update.get("_meta")) {
                    terminal_failure = Some(failure);
                }
                if update.get("sessionUpdate").and_then(Value::as_str)
                    == Some("agent_message_chunk")
                {
                    let text = update
                        .get("content")
                        .filter(|content| {
                            content.get("type").and_then(Value::as_str) == Some("text")
                        })
                        .and_then(|content| content.get("text"))
                        .and_then(Value::as_str)
                        .filter(|text| !text.is_empty() && text.len() <= 64 * 1024)
                        .ok_or(Failure::Incompatible)?;
                    let _ = text;
                    message = true;
                }
                Ok(())
            },
        )?;
        if let Some(failure) = codex_acp::failure_meta(result.get("_meta")).or(terminal_failure) {
            return Err(failure);
        }
        let usage = result.get("usage").ok_or(Failure::Incompatible)?;
        let completed = result.get("stopReason").and_then(Value::as_str) == Some("end_turn")
            && usage
                .get("totalTokens")
                .and_then(Value::as_u64)
                .is_some_and(|n| n > 0)
            && usage
                .get("outputTokens")
                .and_then(Value::as_u64)
                .is_some_and(|n| n > 0)
            && message;
        if !completed {
            return Err(Failure::Incompatible);
        }
        client.request("session/close", json!({"sessionId": session_id}), current)?;
        Ok(())
    })
}

#[cfg(not(unix))]
fn validate_inference(
    _: &buzz_agent_controller::codex::CodexContext,
    _: &str,
    _: &buzz_agent_controller::AiConfiguration,
    _: &str,
    _: &impl Fn() -> bool,
) -> Result<(), crate::codex_acp::Failure> {
    Err(crate::codex_acp::Failure::Incompatible)
}

fn readiness_error(readiness: crate::codex_readiness::Readiness) -> ValidationError {
    match readiness.status {
        "signed-out" => ValidationError::new(
            "authentication",
            "Sign in with the selected Codex CLI, then validate again.",
        ),
        "cleanup-failed" => ValidationError::new(
            "cleanup",
            "Codex validation cleanup could not be confirmed. Restart Buzz before retrying.",
        ),
        "cancelled" => cancelled(),
        _ => ValidationError::new(
            "configuration",
            "The selected Codex CLI and adapter could not be validated.",
        ),
    }
}

fn failure_error(failure: crate::codex_acp::Failure) -> ValidationError {
    use crate::codex_acp::Failure;
    match failure {
        Failure::Cancelled => cancelled(),
        Failure::Timeout => ValidationError::new(
            "timeout",
            "Codex validation timed out. Check the connection and try again.",
        ),
        Failure::OutputLimit => ValidationError::new(
            "limit",
            "Codex validation exceeded its bounded output limit.",
        ),
        Failure::Cleanup => ValidationError::new(
            "cleanup",
            "Codex validation cleanup could not be confirmed. Restart Buzz before retrying.",
        ),
        Failure::Authentication => ValidationError::new(
            "authentication",
            "Codex authentication is required. Sign in and validate again.",
        ),
        Failure::Quota => ValidationError::new(
            "quota",
            "Codex account quota or rate limit prevented validation.",
        ),
        Failure::Context => {
            ValidationError::new("context", "The Codex context window prevented validation.")
        }
        Failure::Limit => {
            ValidationError::new("limit", "A Codex session limit prevented validation.")
        }
        Failure::Network => ValidationError::new(
            "network",
            "Codex could not reach its service. Check the connection and validate again.",
        ),
        Failure::Model => ValidationError::new(
            "model",
            "Codex did not accept or confirm the selected model.",
        ),
        Failure::Effort => ValidationError::new(
            "effort",
            "Codex did not accept or confirm the selected effort.",
        ),
        Failure::Rejected | Failure::Incompatible => ValidationError::new(
            "incompatible",
            "Codex did not return valid completion evidence.",
        ),
    }
}

fn invalid() -> ValidationError {
    ValidationError::new(
        "invalid",
        "Codex validation request does not match a native execution change.",
    )
}

fn cancelled() -> ValidationError {
    ValidationError::new("cancelled", "Codex validation was cancelled or replaced.")
}

fn unavailable() -> ValidationError {
    ValidationError::new(
        "unavailable",
        "Codex validation is unavailable. Restart Buzz and try again.",
    )
}

#[cfg(all(test, unix))]
#[path = "codex_validation/tests.rs"]
mod tests;
