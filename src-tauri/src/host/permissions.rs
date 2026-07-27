//! Host-owned permission gate.
//!
//! Adapters never decide whether a tool call may run. They call
//! [`PermissionBroker::request`] and await the Host's answer, which comes from
//! one of three places, in order:
//!
//! 1. the session's permission mode (`auto` / `full_access` → allow),
//! 2. a session-scoped "always allow" entry the user granted earlier,
//! 3. the user, via `session_permission_respond`.
//!
//! Every request resolves exactly once. If nobody answers within
//! [`REQUEST_TIMEOUT`] the request is denied, so a forgotten approval bar can
//! never wedge an agent process forever.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};

use crate::host::events::HostEvent;
use crate::runtime::PermissionMode;

/// How long an unanswered request waits before it is denied.
#[cfg(not(test))]
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
#[cfg(test)]
pub const REQUEST_TIMEOUT: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    AllowOnce,
    /// Allow now and remember for this session + tool.
    AllowAlways,
    Deny,
    /// User aborted the turn rather than judging the tool call.
    Cancel,
}

impl PermissionDecision {
    pub fn is_allowed(self) -> bool {
        matches!(self, Self::AllowOnce | Self::AllowAlways)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::AllowOnce => "allow_once",
            Self::AllowAlways => "allow_always",
            Self::Deny => "deny",
            Self::Cancel => "cancel",
        }
    }
}

/// Who produced a decision — surfaced to the UI so an auto-approved call is
/// visibly different from one the user approved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionSource {
    User,
    /// Session permission mode allowed it without asking.
    Mode,
    /// Matched a session-scoped "always allow" grant.
    Remembered,
    Timeout,
    /// Session disconnected / process exited while pending.
    Aborted,
}

#[derive(Debug, Clone)]
pub struct PermissionRequest {
    /// Stable key used for "always allow" grants (e.g. `commandExecution`).
    pub tool_name: String,
    pub title: String,
    pub preview: String,
}

struct BrokerInner {
    session_id: String,
    mode: Mutex<PermissionMode>,
    events: mpsc::UnboundedSender<HostEvent>,
    pending: Mutex<HashMap<String, oneshot::Sender<PermissionDecision>>>,
    always_allowed: Mutex<HashSet<String>>,
    next_id: AtomicU64,
}

/// Cheap to clone; every clone talks to the same session gate.
#[derive(Clone)]
pub struct PermissionBroker {
    inner: Arc<BrokerInner>,
}

impl std::fmt::Debug for PermissionBroker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PermissionBroker")
            .field("session_id", &self.inner.session_id)
            .field("mode", &*self.inner.mode.lock())
            .field("pending", &self.inner.pending.lock().len())
            .finish()
    }
}

impl PermissionBroker {
    pub fn new(
        session_id: impl Into<String>,
        mode: PermissionMode,
        events: mpsc::UnboundedSender<HostEvent>,
    ) -> Self {
        Self {
            inner: Arc::new(BrokerInner {
                session_id: session_id.into(),
                mode: Mutex::new(mode),
                events,
                pending: Mutex::new(HashMap::new()),
                always_allowed: Mutex::new(HashSet::new()),
                next_id: AtomicU64::new(1),
            }),
        }
    }

    pub fn session_id(&self) -> &str {
        &self.inner.session_id
    }

    pub fn mode(&self) -> PermissionMode {
        *self.inner.mode.lock()
    }

    pub fn set_mode(&self, mode: PermissionMode) {
        *self.inner.mode.lock() = mode;
    }

    pub fn has_pending(&self) -> bool {
        !self.inner.pending.lock().is_empty()
    }

    /// Ask the Host for a decision. Blocks the calling adapter task (not the
    /// stdio reader) until resolved, remembered, or timed out.
    pub async fn request(&self, req: PermissionRequest) -> PermissionDecision {
        let request_id = format!(
            "{}#{}",
            self.inner.session_id,
            self.inner.next_id.fetch_add(1, Ordering::SeqCst)
        );

        if let Some(source) = self.short_circuit(&req.tool_name) {
            self.emit_request(&request_id, &req, true);
            self.emit_resolved(&request_id, PermissionDecision::AllowOnce, source);
            return PermissionDecision::AllowOnce;
        }

        let (tx, rx) = oneshot::channel();
        self.inner
            .pending
            .lock()
            .insert(request_id.clone(), tx);
        self.emit_request(&request_id, &req, false);

        let decision = match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(decision)) => decision,
            // Sender dropped: `abort_all` already emitted a resolution.
            Ok(Err(_)) => return PermissionDecision::Deny,
            Err(_) => {
                self.inner.pending.lock().remove(&request_id);
                tracing::warn!(
                    "permission request {request_id} timed out after {}s; denying",
                    REQUEST_TIMEOUT.as_secs()
                );
                self.emit_resolved(&request_id, PermissionDecision::Deny, DecisionSource::Timeout);
                return PermissionDecision::Deny;
            }
        };

        if decision == PermissionDecision::AllowAlways {
            self.inner.always_allowed.lock().insert(req.tool_name.clone());
        }
        self.emit_resolved(&request_id, decision, DecisionSource::User);
        decision
    }

    /// Answer a pending request. Errors when the id is unknown, which normally
    /// means it already timed out or the session went away.
    pub fn resolve(&self, request_id: &str, decision: PermissionDecision) -> Result<(), String> {
        let tx = self
            .inner
            .pending
            .lock()
            .remove(request_id)
            .ok_or_else(|| format!("no pending permission request: {request_id}"))?;
        tx.send(decision)
            .map_err(|_| "permission request is no longer awaited".to_string())
    }

    /// Fail every pending request — used when the agent process exits or the
    /// user disconnects, so no adapter task is left hanging.
    pub fn abort_all(&self) {
        let pending: Vec<(String, oneshot::Sender<PermissionDecision>)> =
            self.inner.pending.lock().drain().collect();
        for (request_id, tx) in pending {
            self.emit_resolved(
                &request_id,
                PermissionDecision::Cancel,
                DecisionSource::Aborted,
            );
            let _ = tx.send(PermissionDecision::Cancel);
        }
    }

    /// Forget session-scoped "always allow" grants.
    pub fn clear_grants(&self) {
        self.inner.always_allowed.lock().clear();
    }

    fn short_circuit(&self, tool_name: &str) -> Option<DecisionSource> {
        if self.mode().auto_allow() {
            return Some(DecisionSource::Mode);
        }
        if self.inner.always_allowed.lock().contains(tool_name) {
            return Some(DecisionSource::Remembered);
        }
        None
    }

    fn emit_request(&self, request_id: &str, req: &PermissionRequest, auto_allowed: bool) {
        let _ = self.inner.events.send(HostEvent::PermissionRequest {
            request_id: request_id.to_string(),
            tool_name: req.tool_name.clone(),
            title: req.title.clone(),
            preview: req.preview.chars().take(2000).collect(),
            auto_allowed,
        });
    }

    fn emit_resolved(
        &self,
        request_id: &str,
        decision: PermissionDecision,
        source: DecisionSource,
    ) {
        let _ = self.inner.events.send(HostEvent::PermissionResolved {
            request_id: request_id.to_string(),
            decision,
            source,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn broker(mode: PermissionMode) -> (PermissionBroker, mpsc::UnboundedReceiver<HostEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (PermissionBroker::new("s1", mode, tx), rx)
    }

    fn req(tool: &str) -> PermissionRequest {
        PermissionRequest {
            tool_name: tool.into(),
            title: "t".into(),
            preview: "p".into(),
        }
    }

    #[tokio::test]
    async fn auto_mode_allows_without_asking() {
        let (broker, mut rx) = broker(PermissionMode::Auto);
        let decision = broker.request(req("commandExecution")).await;
        assert_eq!(decision, PermissionDecision::AllowOnce);
        assert!(!broker.has_pending());

        let HostEvent::PermissionRequest { auto_allowed, .. } = rx.recv().await.unwrap() else {
            panic!("expected a request event");
        };
        assert!(auto_allowed);
    }

    #[tokio::test]
    async fn ask_mode_waits_for_the_user() {
        let (broker, mut rx) = broker(PermissionMode::Ask);
        let waiting = {
            let broker = broker.clone();
            tokio::spawn(async move { broker.request(req("fileChange")).await })
        };

        let HostEvent::PermissionRequest { request_id, .. } = rx.recv().await.unwrap() else {
            panic!("expected a request event");
        };
        broker
            .resolve(&request_id, PermissionDecision::AllowOnce)
            .unwrap();

        assert_eq!(waiting.await.unwrap(), PermissionDecision::AllowOnce);
    }

    #[tokio::test]
    async fn allow_always_is_remembered_for_the_session() {
        let (broker, mut rx) = broker(PermissionMode::Ask);
        let waiting = {
            let broker = broker.clone();
            tokio::spawn(async move { broker.request(req("commandExecution")).await })
        };
        let HostEvent::PermissionRequest { request_id, .. } = rx.recv().await.unwrap() else {
            panic!("expected a request event");
        };
        broker
            .resolve(&request_id, PermissionDecision::AllowAlways)
            .unwrap();
        assert!(waiting.await.unwrap().is_allowed());

        // Second call for the same tool no longer blocks.
        let decision = broker.request(req("commandExecution")).await;
        assert_eq!(decision, PermissionDecision::AllowOnce);

        // A different tool still asks.
        let broker2 = broker.clone();
        let pending = tokio::spawn(async move { broker2.request(req("fileChange")).await });
        tokio::task::yield_now().await;
        assert!(broker.has_pending());
        broker.abort_all();
        assert_eq!(pending.await.unwrap(), PermissionDecision::Cancel);
    }

    #[tokio::test]
    async fn abort_all_unblocks_pending_requests() {
        let (broker, _rx) = broker(PermissionMode::Ask);
        let waiting = {
            let broker = broker.clone();
            tokio::spawn(async move { broker.request(req("x")).await })
        };
        tokio::task::yield_now().await;
        broker.abort_all();
        assert_eq!(waiting.await.unwrap(), PermissionDecision::Cancel);
        assert!(!broker.has_pending());
    }

    #[tokio::test]
    async fn unanswered_request_times_out_to_deny() {
        let (broker, mut rx) = broker(PermissionMode::Ask);
        let waiting = {
            let broker = broker.clone();
            tokio::spawn(async move { broker.request(req("slowTool")).await })
        };

        let HostEvent::PermissionRequest { request_id, .. } = rx.recv().await.unwrap() else {
            panic!("expected a request event");
        };
        assert!(broker.has_pending());

        tokio::time::sleep(REQUEST_TIMEOUT + Duration::from_millis(20)).await;

        assert_eq!(waiting.await.unwrap(), PermissionDecision::Deny);
        assert!(!broker.has_pending());

        let HostEvent::PermissionResolved {
            request_id: resolved_request_id,
            decision,
            source,
        } = rx.recv().await.unwrap() else {
            panic!("expected a resolution event");
        };
        assert_eq!(resolved_request_id, request_id);
        assert_eq!(decision, PermissionDecision::Deny);
        assert_eq!(source, DecisionSource::Timeout);
    }

    #[test]
    fn resolving_an_unknown_request_is_an_error() {
        let (broker, _rx) = broker(PermissionMode::Ask);
        assert!(broker
            .resolve("nope", PermissionDecision::AllowOnce)
            .is_err());
    }
}
