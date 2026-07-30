//! Interned runtime identifier.
//!
//! Runtime ids come from manifests (built-in + user-provided under
//! `<data>/runtimes/*.json`), so the full set is not known at compile time.
//! Ids are interned for the process lifetime, which keeps `RuntimeId` `Copy`
//! and cheap to compare while still accepting ids we have never seen.

use std::collections::HashSet;
use std::fmt;
use std::sync::OnceLock;

use parking_lot::Mutex;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Upper bound on an id, so a corrupt `meta.json` cannot leak unbounded memory.
const MAX_ID_LEN: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct RuntimeId(&'static str);

fn interner() -> &'static Mutex<HashSet<&'static str>> {
    static INTERNER: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();
    INTERNER.get_or_init(|| Mutex::new(HashSet::new()))
}

impl RuntimeId {
    /// Ids the Host itself references by name (protocol quirks, defaults).
    /// Everything else flows through manifests.
    pub const GROK: Self = Self("grok");
    pub const CODEX: Self = Self("codex");

    const COMPILE_TIME: [Self; 2] = [Self::GROK, Self::CODEX];

    /// Normalize (trim + lowercase) and intern. Rejects empty, over-long, or
    /// non `[a-z0-9_-]` ids.
    pub fn parse(raw: &str) -> Option<Self> {
        let norm = raw.trim().to_ascii_lowercase();
        if norm.is_empty() || norm.len() > MAX_ID_LEN {
            return None;
        }
        if !norm
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return None;
        }
        Some(Self::intern(&norm))
    }

    /// Intern an already-normalized id.
    fn intern(norm: &str) -> Self {
        if let Some(known) = Self::COMPILE_TIME.iter().find(|k| k.0 == norm) {
            return *known;
        }
        let mut guard = interner().lock();
        if let Some(existing) = guard.get(norm) {
            return Self(existing);
        }
        let leaked: &'static str = Box::leak(norm.to_string().into_boxed_str());
        guard.insert(leaked);
        Self(leaked)
    }

    pub fn as_str(self) -> &'static str {
        self.0
    }
}

impl fmt::Display for RuntimeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

impl Serialize for RuntimeId {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.0)
    }
}

impl<'de> Deserialize<'de> for RuntimeId {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(d)?;
        Self::parse(&raw)
            .ok_or_else(|| serde::de::Error::custom(format!("invalid runtime id: {raw}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_normalizes_and_interns() {
        assert_eq!(RuntimeId::parse("  GROK "), Some(RuntimeId::GROK));
        let a = RuntimeId::parse("kimi").unwrap();
        let b = RuntimeId::parse("KIMI").unwrap();
        assert_eq!(a, b);
        assert_eq!(a.as_str().as_ptr(), b.as_str().as_ptr());
    }

    #[test]
    fn parse_rejects_malformed_ids() {
        assert_eq!(RuntimeId::parse(""), None);
        assert_eq!(RuntimeId::parse("has space"), None);
        assert_eq!(RuntimeId::parse("a/b"), None);
        assert_eq!(RuntimeId::parse(&"x".repeat(MAX_ID_LEN + 1)), None);
    }

    #[test]
    fn round_trips_as_plain_string() {
        let json = serde_json::to_string(&RuntimeId::CODEX).unwrap();
        assert_eq!(json, "\"codex\"");
        let back: RuntimeId = serde_json::from_str("\"codex\"").unwrap();
        assert_eq!(back, RuntimeId::CODEX);
    }
}
