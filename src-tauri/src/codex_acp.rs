//! One bounded ACP transport for Codex readiness, discovery, and later validation.
#[cfg(unix)]
use buzz_agent_controller::{codex::CodexContext, ContainedProcess};
#[cfg(unix)]
use serde_json::{json, Value};
#[cfg(unix)]
use std::{
    io::{Read, Write},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

/// Sanitized transport failure. Adapter output never crosses this boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Failure {
    Cancelled,
    Timeout,
    OutputLimit,
    Cleanup,
    Incompatible,
    Rejected,
    Authentication,
    Quota,
    Context,
    Limit,
    Network,
    Model,
    Effort,
}

impl Failure {
    pub(crate) fn model(self) -> Self {
        if self == Self::Rejected {
            Self::Model
        } else {
            self
        }
    }

    pub(crate) fn effort(self) -> Self {
        if self == Self::Rejected {
            Self::Effort
        } else {
            self
        }
    }
}

#[cfg(unix)]
#[derive(Clone, Copy)]
pub(crate) struct Limits {
    deadline: Duration,
    output_bytes: usize,
    request_bytes: usize,
    messages: usize,
}

#[cfg(unix)]
impl Limits {
    pub(crate) fn readiness() -> Self {
        Self {
            deadline: Duration::from_secs(5),
            output_bytes: 64 * 1024,
            request_bytes: 16 * 1024,
            messages: 1_000,
        }
    }

    pub(crate) fn discovery() -> Self {
        Self {
            deadline: Duration::from_secs(15),
            output_bytes: 1024 * 1024,
            request_bytes: 16 * 1024,
            messages: 2_000,
        }
    }

    pub(crate) fn validation() -> Self {
        Self {
            deadline: Duration::from_secs(60),
            output_bytes: 1024 * 1024,
            request_bytes: 128 * 1024,
            messages: 4_000,
        }
    }
}

#[cfg(unix)]
struct WriteRequest {
    bytes: Vec<u8>,
    completed: mpsc::SyncSender<Result<(), ()>>,
}

#[cfg(unix)]
enum OutputEvent {
    Line(Vec<u8>),
    Closed,
    Failed,
}

#[cfg(unix)]
#[derive(Clone)]
struct Capture {
    used: Arc<AtomicUsize>,
    overflow: Arc<AtomicBool>,
    io_failed: Arc<AtomicBool>,
    byte_limit: usize,
}

#[cfg(unix)]
pub(crate) struct Client {
    process: ContainedProcess,
    writes: Option<mpsc::Sender<WriteRequest>>,
    output: mpsc::Receiver<OutputEvent>,
    writer: Option<JoinHandle<()>>,
    stdout: Option<JoinHandle<()>>,
    stderr: Option<JoinHandle<()>>,
    overflow: Arc<AtomicBool>,
    io_failed: Arc<AtomicBool>,
    deadline: Instant,
    limits: Limits,
    next_id: u64,
}

#[cfg(unix)]
impl Client {
    fn start(context: &CodexContext, limits: Limits) -> Result<Self, Failure> {
        let mut command = context.adapter_command();
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut process =
            ContainedProcess::spawn(&mut command).map_err(|_| Failure::Incompatible)?;
        let stdin = process.take_stdin().ok_or(Failure::Incompatible)?;
        let stdout = process.take_stdout().ok_or(Failure::Incompatible)?;
        let stderr = process.take_stderr().ok_or(Failure::Incompatible)?;
        let overflow = Arc::new(AtomicBool::new(false));
        let io_failed = Arc::new(AtomicBool::new(false));
        let capture = Capture {
            used: Arc::new(AtomicUsize::new(0)),
            overflow: overflow.clone(),
            io_failed: io_failed.clone(),
            byte_limit: limits.output_bytes,
        };
        let messages = Arc::new(AtomicUsize::new(0));
        let (write_send, write_receive) = mpsc::channel::<WriteRequest>();
        let writer = std::thread::spawn(move || {
            let mut stdin = stdin;
            for request in write_receive {
                let result = stdin
                    .write_all(&request.bytes)
                    .and_then(|_| stdin.flush())
                    .map_err(|_| ());
                let failed = result.is_err();
                let _ = request.completed.send(result);
                if failed {
                    break;
                }
            }
        });
        let (output_send, output) = mpsc::channel();
        let stdout = output_reader(
            stdout,
            output_send,
            capture.clone(),
            messages,
            limits.messages,
        );
        let stderr = drain_reader(stderr, capture);
        Ok(Self {
            process,
            writes: Some(write_send),
            output,
            writer: Some(writer),
            stdout: Some(stdout),
            stderr: Some(stderr),
            overflow,
            io_failed,
            deadline: Instant::now() + limits.deadline,
            limits,
            next_id: 0,
        })
    }

    pub(crate) fn request(
        &mut self,
        method: &str,
        params: Value,
        current: &impl Fn() -> bool,
    ) -> Result<Value, Failure> {
        self.request_observing(method, params, current, &mut |_| Ok(()))
    }

    pub(crate) fn request_observing(
        &mut self,
        method: &str,
        params: Value,
        current: &impl Fn() -> bool,
        notification: &mut impl FnMut(&Value) -> Result<(), Failure>,
    ) -> Result<Value, Failure> {
        self.next_id = self.next_id.checked_add(1).ok_or(Failure::Incompatible)?;
        let id = self.next_id;
        let mut bytes = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .map_err(|_| Failure::Incompatible)?;
        bytes.push(b'\n');
        if bytes.len() > self.limits.request_bytes {
            return Err(Failure::Incompatible);
        }
        let (completed, write) = mpsc::sync_channel(1);
        self.writes
            .as_ref()
            .ok_or(Failure::Cleanup)?
            .send(WriteRequest { bytes, completed })
            .map_err(|_| Failure::Incompatible)?;
        let mut written = false;
        loop {
            self.check(current)?;
            if !written {
                match write.try_recv() {
                    Ok(Ok(())) => written = true,
                    Ok(Err(())) | Err(mpsc::TryRecvError::Disconnected) => {
                        return Err(Failure::Incompatible);
                    }
                    Err(mpsc::TryRecvError::Empty) => {}
                }
            }
            match self.output.recv_timeout(Duration::from_millis(20)) {
                Ok(OutputEvent::Line(line)) => {
                    let value: Value =
                        serde_json::from_slice(&line).map_err(|_| Failure::Incompatible)?;
                    if value.get("method").is_some() && value.get("id").is_some() {
                        return Err(Failure::Incompatible);
                    }
                    if value.get("method").is_some() {
                        if value.get("jsonrpc") != Some(&Value::String("2.0".into())) {
                            return Err(Failure::Incompatible);
                        }
                        notification(&value)?;
                        continue;
                    }
                    if value.get("jsonrpc") != Some(&Value::String("2.0".into()))
                        || value.get("id") != Some(&Value::Number(id.into()))
                    {
                        return Err(Failure::Incompatible);
                    }
                    if let Some(error) = value.get("error") {
                        return Err(typed_error(error));
                    }
                    return value.get("result").cloned().ok_or(Failure::Incompatible);
                }
                Ok(OutputEvent::Closed | OutputEvent::Failed) => {
                    return Err(Failure::Incompatible);
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(Failure::Incompatible);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }

    fn check(&mut self, current: &impl Fn() -> bool) -> Result<(), Failure> {
        if !current() {
            return Err(Failure::Cancelled);
        }
        if self.overflow.load(Ordering::SeqCst) {
            return Err(Failure::OutputLimit);
        }
        if Instant::now() >= self.deadline {
            return Err(Failure::Timeout);
        }
        match self.process.alive() {
            Ok(true) => Ok(()),
            Ok(false) => Err(Failure::Incompatible),
            Err(_) => Err(Failure::Cleanup),
        }
    }

    pub(crate) fn initialize(
        &mut self,
        adapter_version: &str,
        current: &impl Fn() -> bool,
    ) -> Result<(), Failure> {
        let result = self.request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {
                    "_meta": {
                        "jetbrains": {
                            "air": {
                                "version": 1,
                                "capabilities": ["sessionFailure"]
                            }
                        }
                    }
                },
                "clientInfo": {
                    "name": "buzz-codex",
                    "version": "0.0.0"
                }
            }),
            current,
        )?;
        if result["protocolVersion"] != 1
            || result["agentInfo"]["name"] != "@agentclientprotocol/codex-acp"
            || result["agentInfo"]["version"] != adapter_version
        {
            return Err(Failure::Incompatible);
        }
        Ok(())
    }

    fn close(mut self) -> Result<(), Failure> {
        self.writes.take();
        if self.process.stop().is_err() {
            return Err(Failure::Cleanup);
        }
        let mut joined = true;
        for thread in [self.writer.take(), self.stdout.take(), self.stderr.take()]
            .into_iter()
            .flatten()
        {
            joined &= thread.join().is_ok();
        }
        if !joined {
            return Err(Failure::Incompatible);
        }
        if self.overflow.load(Ordering::SeqCst) {
            return Err(Failure::OutputLimit);
        }
        if self.io_failed.load(Ordering::SeqCst) {
            return Err(Failure::Incompatible);
        }
        Ok(())
    }
}

#[cfg(unix)]
fn typed_error(error: &Value) -> Failure {
    let info = error
        .get("data")
        .and_then(|data| data.get("codexErrorInfo"));
    typed_codex_error(info).unwrap_or(Failure::Rejected)
}

#[cfg(unix)]
fn typed_codex_error(info: Option<&Value>) -> Option<Failure> {
    match info? {
        Value::String(value) => match value.as_str() {
            "unauthorized" => Some(Failure::Authentication),
            "usageLimitExceeded" | "rateLimitExceeded" => Some(Failure::Quota),
            "sessionBudgetExceeded" => Some(Failure::Limit),
            "contextWindowExceeded" => Some(Failure::Context),
            _ => None,
        },
        Value::Object(value)
            if value.contains_key("httpConnectionFailed")
                || value.contains_key("responseStreamConnectionFailed")
                || value.contains_key("responseStreamDisconnected")
                || value.contains_key("responseTooManyFailedAttempts") =>
        {
            if value
                .values()
                .any(|details| details.get("httpStatusCode").and_then(Value::as_u64) == Some(401))
            {
                Some(Failure::Authentication)
            } else {
                Some(Failure::Network)
            }
        }
        _ => None,
    }
}

#[cfg(unix)]
pub(crate) fn failure_meta(value: Option<&Value>) -> Option<Failure> {
    let failure = value?.get("jetbrains")?.get("air")?.get("sessionFailure")?;
    if failure.get("severity").and_then(Value::as_str) != Some("error") {
        return None;
    }
    let category = failure.get("category")?.as_str()?;
    match category {
        "access" => Some(Failure::Authentication),
        "connection" => Some(Failure::Network),
        "limit" => Some(Failure::Limit),
        _ => Some(Failure::Incompatible),
    }
}

#[cfg(unix)]
fn account(used: &AtomicUsize, overflow: &AtomicBool, count: usize, limit: usize) -> bool {
    let previous = used.fetch_add(count, Ordering::SeqCst);
    if previous > limit || count > limit.saturating_sub(previous) {
        overflow.store(true, Ordering::SeqCst);
        false
    } else {
        true
    }
}

#[cfg(unix)]
fn output_reader(
    mut reader: impl Read + Send + 'static,
    send: mpsc::Sender<OutputEvent>,
    capture: Capture,
    messages: Arc<AtomicUsize>,
    message_limit: usize,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut line = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let count = match reader.read(&mut chunk) {
                Ok(0) => {
                    let _ = send.send(OutputEvent::Closed);
                    return;
                }
                Ok(count) => count,
                Err(_) => {
                    capture.io_failed.store(true, Ordering::SeqCst);
                    let _ = send.send(OutputEvent::Failed);
                    return;
                }
            };
            if !account(&capture.used, &capture.overflow, count, capture.byte_limit) {
                return;
            }
            for byte in &chunk[..count] {
                if *byte == b'\n' {
                    if messages.fetch_add(1, Ordering::SeqCst) >= message_limit {
                        capture.overflow.store(true, Ordering::SeqCst);
                        return;
                    }
                    if send
                        .send(OutputEvent::Line(std::mem::take(&mut line)))
                        .is_err()
                    {
                        return;
                    }
                } else {
                    line.push(*byte);
                }
            }
        }
    })
}

#[cfg(unix)]
fn drain_reader(mut reader: impl Read + Send + 'static, capture: Capture) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => return,
                Err(_) => {
                    capture.io_failed.store(true, Ordering::SeqCst);
                    return;
                }
                Ok(count)
                    if !account(&capture.used, &capture.overflow, count, capture.byte_limit) =>
                {
                    return;
                }
                Ok(_) => {}
            }
        }
    })
}

#[cfg(unix)]
pub(crate) fn initialize(
    context: &CodexContext,
    adapter_version: &str,
    current: &impl Fn() -> bool,
) -> Result<(), Failure> {
    run(context, Limits::readiness(), current, |client| {
        client.initialize(adapter_version, current)
    })
}

#[cfg(unix)]
pub(crate) fn run<T>(
    context: &CodexContext,
    limits: Limits,
    _current: &impl Fn() -> bool,
    operation: impl FnOnce(&mut Client) -> Result<T, Failure>,
) -> Result<T, Failure> {
    let mut client = Client::start(context, limits)?;
    let result = operation(&mut client);
    let cleanup = client.close();
    cleanup.and(result)
}

#[cfg(all(test, unix))]
mod tests;
