//! Runtime registry — P0: Grok + Codex enabled; Claude/Kimi listed disabled.

use std::sync::Arc;

use serde::Serialize;

use crate::runtime::capabilities::RuntimeCapabilities;
use crate::runtime::codex::CodexRuntime;
use crate::runtime::grok::GrokRuntime;
use crate::runtime::traits::{AgentRuntime, ProbeResult, RuntimeId};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDescriptor {
    pub id: RuntimeId,
    pub display_name: String,
    pub enabled: bool,
    pub capabilities: RuntimeCapabilities,
}

struct DisabledRuntime {
    id: RuntimeId,
    protocol: &'static str,
}

#[async_trait::async_trait]
impl AgentRuntime for DisabledRuntime {
    fn id(&self) -> RuntimeId {
        self.id
    }

    fn enabled(&self) -> bool {
        false
    }

    fn capabilities(&self) -> RuntimeCapabilities {
        RuntimeCapabilities::stub(self.protocol)
    }

    async fn probe(&self) -> ProbeResult {
        ProbeResult {
            runtime_id: self.id,
            found: false,
            path: None,
            version: None,
            detail: Some("P1+ reserved — not enabled in this build".into()),
        }
    }

    async fn connect(
        &self,
        _opts: crate::runtime::traits::ConnectOpts,
        _event_tx: tokio::sync::mpsc::UnboundedSender<crate::host::events::HostEvent>,
    ) -> Result<Box<dyn crate::runtime::traits::LiveSession>, crate::error::AgentError> {
        Err(crate::error::AgentError::new(
            crate::error::AgentErrorCode::CapabilityMissing,
            format!("{} is not enabled in P0", self.id.display_name()),
        ))
    }
}

pub fn registry() -> Vec<Arc<dyn AgentRuntime>> {
    vec![
        Arc::new(GrokRuntime),
        Arc::new(CodexRuntime),
        Arc::new(DisabledRuntime {
            id: RuntimeId::Claude,
            protocol: "stream_json",
        }),
        Arc::new(DisabledRuntime {
            id: RuntimeId::Kimi,
            protocol: "acp",
        }),
    ]
}

pub fn get(id: RuntimeId) -> Option<Arc<dyn AgentRuntime>> {
    registry().into_iter().find(|r| r.id() == id)
}

pub fn list_descriptors() -> Vec<RuntimeDescriptor> {
    registry()
        .into_iter()
        .map(|r| RuntimeDescriptor {
            id: r.id(),
            display_name: r.display_name().to_string(),
            enabled: r.enabled(),
            capabilities: r.capabilities(),
        })
        .collect()
}

pub async fn probe_all() -> Vec<ProbeResult> {
    let mut out = Vec::new();
    for r in registry() {
        if r.enabled() {
            out.push(r.probe().await);
        }
    }
    out
}

pub async fn probe_runtime(id: RuntimeId) -> Option<ProbeResult> {
    let r = get(id)?;
    Some(r.probe().await)
}
