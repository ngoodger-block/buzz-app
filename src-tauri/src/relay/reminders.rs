//! NIP-ER reminders (kind 30300). Self-encrypted only; never a general NIP-44 or signing primitive.
use super::{verify_owned_event, Result};
use crate::identity::{EventTemplate, IdentityHost};
use nostr::{
    event::Event,
    key::{Keys, SecretKey},
    nips::nip44,
};
use serde::Deserialize;
use serde_json::{json, Value};

const KIND: u16 = 30300;
const MAX_PLAINTEXT: usize = 16 * 1024;
const DAY: u64 = 86_400;

fn hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn text(value: &Value, max: usize) -> bool {
    value
        .as_str()
        .is_some_and(|s| s.encode_utf16().count() <= max)
}

/// The Buzz target dialect shared with beta desktop and mobile: `{eventId, channelId, preview, authorPubkey}`.
fn validate_content(content: &Value, status: &str) -> Result<()> {
    let invalid = || "Invalid reminder".to_owned();
    let data = content.as_object().ok_or_else(invalid)?;
    if data
        .keys()
        .any(|key| !["target", "note", "status"].contains(&key.as_str()))
        || data.get("status").and_then(Value::as_str) != Some(status)
        || data.get("note").is_some_and(|note| !text(note, 4096))
    {
        return Err(invalid());
    }
    match data.get("target") {
        Some(target) => {
            let target = target.as_object().ok_or_else(invalid)?;
            let field = |name: &str| target.get(name).and_then(Value::as_str).unwrap_or_default();
            if target.len() != 4
                || !hex(field("eventId"), 64)
                || !hex(field("authorPubkey"), 64)
                || field("channelId").is_empty()
                || field("channelId").len() > 256
                || !target
                    .get("preview")
                    .is_some_and(|preview| text(preview, 1024))
            {
                return Err(invalid());
            }
        }
        None if data
            .get("note")
            .and_then(Value::as_str)
            .is_some_and(|n| !n.is_empty()) => {}
        None => return Err(invalid()),
    }
    Ok(())
}

/// Exactly the tags `relay_sign_reminder` writes; the tag selects the status it may carry.
fn tag_status(tags: &[Vec<String>]) -> Option<&'static str> {
    match tags {
        [d, schedule] if d.len() == 2 && d[0] == "d" && hex(&d[1], 32) && schedule.len() == 2 => {
            let digits = !schedule[1].is_empty()
                && schedule[1].bytes().all(|b| b.is_ascii_digit())
                && (schedule[1] == "0" || !schedule[1].starts_with('0'))
                && schedule[1].parse::<u64>().is_ok_and(|n| n < (1 << 53));
            match schedule[0].as_str() {
                "not_before" if digits => Some("pending"),
                "expiration" if digits => Some("closed"),
                _ => None,
            }
        }
        _ => None,
    }
}

fn status_matches(tag: &str, content: &Value) -> Option<&'static str> {
    let status = content.get("status").and_then(Value::as_str)?;
    match (tag, status) {
        ("pending", "pending") => Some("pending"),
        ("closed", "done") => Some("done"),
        ("closed", "cancelled") => Some("cancelled"),
        _ => None,
    }
}

fn decrypt(secret: &[u8; 32], viewer: &str, raw: &Value) -> Option<Value> {
    let event: Event = serde_json::from_value(raw.clone()).ok()?;
    event.verify().ok()?;
    let secret = SecretKey::from_slice(secret).ok()?;
    let public = Keys::new(secret.clone()).public_key();
    if event.kind.as_u16() != KIND || event.pubkey.to_hex() != viewer || event.pubkey != public {
        return None;
    }
    // Inspect raw tags: deserialization must not hide duplicate `d` selectors.
    let ds = raw["tags"]
        .as_array()?
        .iter()
        .filter(|tag| tag[0] == "d")
        .count();
    if ds != 1 || event.content.len() > 4 * MAX_PLAINTEXT {
        return None;
    }
    let plaintext = nip44::decrypt(&secret, &public, &event.content).ok()?;
    if plaintext.len() > MAX_PLAINTEXT {
        return None;
    }
    let content: Value = serde_json::from_str(&plaintext).ok()?;
    // Read and write share one rule: show only reminders this client could save again.
    let status = content.get("status").and_then(Value::as_str)?;
    validate_content(&content, status).ok()?;
    Some(json!({ "eventId": event.id.to_hex(), "content": content }))
}

/// Decrypt verified, self-authored reminders. Other clients may write records this
/// client cannot read or save, so invalid entries are skipped, not fatal to the list.
#[tauri::command]
pub(crate) async fn relay_decode_reminders(
    host: tauri::State<'_, IdentityHost>,
    events: Vec<Value>,
) -> Result<Value> {
    if events.len() > 256
        || serde_json::to_vec(&events)
            .map_err(|_| "Invalid reminders")?
            .len()
            > 4 * 1024 * 1024
    {
        return Err("Reminder decode capacity exceeded".into());
    }
    host.with_key(move |secret, viewer| {
        Ok(Value::Array(
            events
                .iter()
                .filter_map(|raw| decrypt(secret, viewer, raw))
                .collect(),
        ))
    })
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ReminderIntent {
    d: String,
    created_at: u64,
    not_before: Option<u64>,
    expiration: Option<u64>,
    content: Value,
}

/// Sign one self-encrypted reminder built from bounded intent, never caller ciphertext or tags.
#[tauri::command]
pub(crate) async fn relay_sign_reminder(
    host: tauri::State<'_, IdentityHost>,
    intent: ReminderIntent,
) -> Result<Value> {
    sign_reminder(host.inner(), intent, now()?).await
}

fn now() -> Result<u64> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "System clock is unavailable")?
        .as_secs())
}

async fn sign_reminder(host: &IdentityHost, intent: ReminderIntent, now: u64) -> Result<Value> {
    let invalid = || "Invalid reminder".to_owned();
    let schedule = match (intent.not_before, intent.expiration) {
        (Some(at), None) if at < (1 << 53) => ("not_before", at, "pending"),
        (None, Some(at)) if (now + 29 * DAY..=now + 91 * DAY).contains(&at) => {
            let status = intent.content.get("status").and_then(Value::as_str);
            (
                "expiration",
                at,
                if status == Some("done") {
                    "done"
                } else {
                    "cancelled"
                },
            )
        }
        _ => return Err(invalid()),
    };
    // created_at = max(now, previous + 1); allow a small lead for a future-dated predecessor.
    if !hex(&intent.d, 32) || intent.created_at + 60 < now || intent.created_at > now + 3600 {
        return Err(invalid());
    }
    validate_content(&intent.content, schedule.2)?;
    let plaintext = serde_json::to_string(&intent.content).map_err(|_| invalid())?;
    if plaintext.len() > MAX_PLAINTEXT {
        return Err(invalid());
    }
    let content = host
        .with_key(move |secret, _| {
            let secret = SecretKey::from_slice(secret).map_err(|_| "Invalid reminder")?;
            let public = Keys::new(secret.clone()).public_key();
            nip44::encrypt(&secret, &public, &plaintext, nip44::Version::V2)
                .map_err(|_| "Could not encrypt reminder".into())
        })
        .await?;
    host.sign(EventTemplate {
        kind: KIND,
        created_at: intent.created_at,
        content,
        tags: vec![
            vec!["d".into(), intent.d],
            vec![schedule.0.into(), schedule.1.to_string()],
        ],
    })
    .await
}

/// Admit for publication only a record shaped exactly like `relay_sign_reminder` output.
pub(super) async fn admit_reminder(host: &IdentityHost, event: &Value) -> Result<()> {
    let invalid = || "Invalid reminder".to_owned();
    if event["kind"].as_u64() != Some(u64::from(KIND)) {
        return Err(invalid());
    }
    verify_owned_event(host, event).await?;
    let tags: Vec<Vec<String>> =
        serde_json::from_value(event["tags"].clone()).map_err(|_| invalid())?;
    let tag = tag_status(&tags).ok_or_else(invalid)?;
    let raw = event.clone();
    let decoded = host
        .with_key(move |secret, viewer| Ok(decrypt(secret, viewer, &raw)))
        .await?
        .ok_or_else(invalid)?;
    // `decrypt` already ran `validate_content`; the tag must select the content's status.
    status_matches(tag, &decoded["content"])
        .map(|_| ())
        .ok_or_else(invalid)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> Value {
        json!({"eventId": "a".repeat(64), "channelId": "c1", "preview": "hi", "authorPubkey": "b".repeat(64)})
    }

    fn intent(not_before: Option<u64>, expiration: Option<u64>, status: &str) -> ReminderIntent {
        ReminderIntent {
            d: "0123456789abcdef0123456789abcdef".into(),
            created_at: 1_000_000,
            not_before,
            expiration,
            content: json!({"target": target(), "status": status}),
        }
    }

    #[test]
    fn content_accepts_the_shared_target_dialect_only() {
        assert!(
            validate_content(&json!({"target": target(), "status": "pending"}), "pending").is_ok()
        );
        assert!(validate_content(&json!({"note": "call", "status": "done"}), "done").is_ok());
        // NIP-ER spec shape, unknown keys, status mismatch and empty records stay rejected.
        for bad in [
            json!({"target": {"id": "x", "a": "y", "relays": [], "preview": "p"}, "status": "pending"}),
            json!({"target": target(), "status": "pending", "extra": 1}),
            json!({"target": target(), "status": "done"}),
            json!({"note": "", "status": "pending"}),
            json!("text"),
        ] {
            assert!(validate_content(&bad, "pending").is_err(), "{bad}");
        }
    }

    #[test]
    fn tags_mirror_the_relay_not_before_validator() {
        let tags = |name: &str, value: &str| {
            vec![
                vec![
                    "d".to_string(),
                    "0123456789abcdef0123456789abcdef".to_string(),
                ],
                vec![name.to_string(), value.to_string()],
            ]
        };
        assert_eq!(
            tag_status(&tags("not_before", "1700000000")),
            Some("pending")
        );
        assert_eq!(
            tag_status(&tags("expiration", "1700000000")),
            Some("closed")
        );
        for value in ["", "01", "1e9", "-1", "9007199254740992"] {
            assert_eq!(tag_status(&tags("not_before", value)), None, "{value}");
        }
        assert_eq!(tag_status(&tags("alt", "1")), None);
        let mut extra = tags("not_before", "1");
        extra.push(vec!["p".into(), "x".into()]);
        assert_eq!(tag_status(&extra), None);
    }

    #[tokio::test]
    async fn signs_decodes_and_admits_only_own_reminders() {
        let host = IdentityHost::fixture();
        let now = 1_000_000;
        let pending = sign_reminder(&host, intent(Some(now + 60), None, "pending"), now)
            .await
            .unwrap();
        assert_eq!(pending["kind"], 30300);
        assert_eq!(pending["tags"][1], json!(["not_before", "1000060"]));
        admit_reminder(&host, &pending).await.unwrap();
        let viewer = host.viewer().await.unwrap();
        let decoded = host
            .with_key({
                let pending = pending.clone();
                move |secret, viewer| Ok(decrypt(secret, viewer, &pending))
            })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(decoded["content"]["target"], target());
        assert_eq!(pending["pubkey"], viewer);

        let done = sign_reminder(&host, intent(None, Some(now + 40 * DAY), "done"), now)
            .await
            .unwrap();
        assert_eq!(done["tags"][1][0], "expiration");
        admit_reminder(&host, &done).await.unwrap();

        // Wrong schedule/status pairing, out-of-window expiration, stale clocks and bad d tags.
        for bad in [
            intent(Some(now), None, "done"),
            intent(None, Some(now + DAY), "done"),
            intent(Some(now), Some(now + 40 * DAY), "pending"),
            ReminderIntent {
                created_at: now - 3600,
                ..intent(Some(now), None, "pending")
            },
            ReminderIntent {
                d: "not-hex".into(),
                ..intent(Some(now), None, "pending")
            },
        ] {
            assert!(sign_reminder(&host, bad, now).await.is_err());
        }

        // A tampered record fails signature verification and is skipped, not admitted.
        let mut tampered = pending.clone();
        tampered["tags"][1][1] = json!("1");
        assert!(admit_reminder(&host, &tampered).await.is_err());
        let skipped = host
            .with_key(move |secret, viewer| Ok(decrypt(secret, viewer, &tampered)))
            .await
            .unwrap();
        assert!(skipped.is_none());
    }

    /// Encrypt and sign arbitrary content, as beta or mobile may have written it.
    async fn seal(host: &IdentityHost, content: Value) -> Value {
        let plaintext = content.to_string();
        let sealed = host
            .with_key(move |secret, _| {
                let secret = SecretKey::from_slice(secret).unwrap();
                let public = Keys::new(secret.clone()).public_key();
                Ok(nip44::encrypt(&secret, &public, &plaintext, nip44::Version::V2).unwrap())
            })
            .await
            .unwrap();
        host.sign(EventTemplate {
            kind: KIND,
            created_at: 1_000_000,
            content: sealed,
            tags: vec![
                vec!["d".into(), "0123456789abcdef0123456789abcdef".into()],
                vec!["not_before".into(), "1000060".into()],
            ],
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn decode_skips_reminders_this_client_could_not_save() {
        let host = IdentityHost::fixture();
        let decode =
            |event: Value| host.with_key(move |secret, viewer| Ok(decrypt(secret, viewer, &event)));
        let normal = seal(&host, json!({"target": target(), "status": "pending"})).await;
        assert!(decode(normal).await.unwrap().is_some());
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}".repeat(100);
        let mut emoji = target();
        emoji["preview"] = json!(family);
        let mut empty = target();
        empty["channelId"] = json!("");
        empty["authorPubkey"] = json!("");
        for (name, content) in [
            (
                "4,097-char note",
                json!({"target": target(), "note": "n".repeat(4097), "status": "pending"}),
            ),
            (
                "100 family emoji preview",
                json!({"target": emoji, "status": "pending"}),
            ),
            (
                "empty channel and author",
                json!({"target": empty, "status": "pending"}),
            ),
            (
                "17,000-char note",
                json!({"note": "n".repeat(17_000), "status": "pending"}),
            ),
        ] {
            let event = seal(&host, content).await;
            assert!(decode(event).await.unwrap().is_none(), "{name}");
        }
    }

    #[tokio::test]
    async fn admit_rejects_foreign_pubkeys_and_other_kinds() {
        let host = IdentityHost::fixture();
        let now = 1_000_000;
        let own = sign_reminder(&host, intent(Some(now + 60), None, "pending"), now)
            .await
            .unwrap();

        // Another author's reminder; the pubkey check runs before signature verification.
        let mut foreign = own.clone();
        foreign["pubkey"] = json!("b".repeat(64));
        assert!(admit_reminder(&host, &foreign).await.is_err());

        // Our own pubkey but not a reminder kind.
        let mut wrong_kind = own.clone();
        wrong_kind["kind"] = json!(30078);
        assert!(admit_reminder(&host, &wrong_kind).await.is_err());
    }
}
