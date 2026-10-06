use super::*;
use crate::{defaults::selectors, store::tests::fixture, Store};
use std::collections::BTreeMap;

#[test]
fn existing_integrations_expose_policy_without_advertising_unimplemented_modes_or_effort() {
    for (command, auth, provider, model, keys) in [
        (
            "buzz-agent",
            AuthenticationPolicy::Provider,
            ProviderPolicy::Selector,
            ModelRequirement::Optional,
            Some(("BUZZ_AGENT_MODEL", "BUZZ_AGENT_PROVIDER")),
        ),
        (
            "/tools/buzz-agent",
            AuthenticationPolicy::Provider,
            ProviderPolicy::Selector,
            ModelRequirement::Optional,
            Some(("BUZZ_AGENT_MODEL", "BUZZ_AGENT_PROVIDER")),
        ),
        (
            "goose",
            AuthenticationPolicy::HarnessWithOverrides,
            ProviderPolicy::Selector,
            ModelRequirement::Optional,
            Some(("GOOSE_MODEL", "GOOSE_PROVIDER")),
        ),
        (
            "/tools/goose-acp.exe",
            AuthenticationPolicy::HarnessWithOverrides,
            ProviderPolicy::Selector,
            ModelRequirement::Optional,
            Some(("GOOSE_MODEL", "GOOSE_PROVIDER")),
        ),
        (
            "/tools/buzz-pi-acp",
            AuthenticationPolicy::HarnessWithOverrides,
            ProviderPolicy::Discovered,
            ModelRequirement::WithProvider,
            None,
        ),
        (
            "/tools/custom-acp",
            AuthenticationPolicy::External,
            ProviderPolicy::External,
            ModelRequirement::Optional,
            None,
        ),
        (
            "codex-acp",
            AuthenticationPolicy::External,
            ProviderPolicy::External,
            ModelRequirement::Optional,
            None,
        ),
    ] {
        let policy = HarnessConfigurationPolicy::for_command(command);
        assert_eq!(
            (policy.authentication, policy.provider, policy.model),
            (auth, provider, model),
            "{command}"
        );
        assert!(policy.supported_modes.is_empty());
        assert_eq!(policy.effort_discovery, EffortDiscovery::Unknown);
        let mut agent = fixture();
        agent.harness.command = command.into();
        let env = keys.map_or_else(BTreeMap::new, |(model, provider)| {
            BTreeMap::from([
                (model.into(), "override-model".into()),
                (provider.into(), "override-provider".into()),
            ])
        });
        let selected = selectors(&agent.harness, &env);
        assert_eq!(selected.keys, keys);
        if keys.is_some() {
            assert_eq!(selected.model, Some("override-model"));
            assert_eq!(selected.provider, Some("override-provider"));
        } else {
            assert_eq!(selected.model, Some("test-model"));
            assert_eq!(selected.provider, None);
        }
    }
}

#[test]
fn codex_policy_requires_explicit_native_identity() {
    let managed = HarnessConfigurationPolicy::for_integration(HarnessIntegration::Codex);
    let basename = HarnessConfigurationPolicy::for_command("codex-acp");
    assert_eq!(managed.authentication, AuthenticationPolicy::External);
    assert_eq!(managed.provider, ProviderPolicy::External);
    assert_eq!(
        managed.supported_modes,
        &[ConfigurationMode::Default, ConfigurationMode::Advanced]
    );
    assert_eq!(managed.effort_discovery, EffortDiscovery::ModelSpecific);
    assert!(basename.supported_modes.is_empty());
    assert_eq!(basename.effort_discovery, EffortDiscovery::Unknown);
}

#[test]
fn policy_does_not_migrate_or_reject_legacy_records_on_store_read() {
    for command in [
        "buzz-agent",
        "goose",
        "/tools/goose-acp",
        "/tools/buzz-pi-acp",
        "/tools/custom-acp",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().to_owned()).unwrap();
        let mut agent = fixture();
        agent.harness.command = command.into();
        // Pi with only a provider, and unmapped custom providers, must remain
        // readable/editable even though launch admission refuses them.
        agent.harness.model.clear();
        let saved = serde_json::to_value(&agent).unwrap();
        store.insert(vec![agent]).unwrap();
        let before = std::fs::read(dir.path().join("agents.json")).unwrap();
        drop(store);
        let reopened = Store::open(dir.path().to_owned()).unwrap();
        assert_eq!(
            serde_json::to_value(&reopened.agents().unwrap()[0]).unwrap(),
            saved
        );
        assert_eq!(
            std::fs::read(dir.path().join("agents.json")).unwrap(),
            before
        );
    }
}

#[test]
fn pi_selection_keeps_pair_and_transport_constraints() {
    for (provider, model, valid) in [
        ("", "", true),
        ("", "model", true),
        ("provider", "model", true),
        ("provider", "", false),
        ("bad/provider", "model", false),
        ("provider", "-flag", false),
        ("provider", "a,b", false),
    ] {
        assert_eq!(
            crate::pi::validate_selection(provider, model).is_ok(),
            valid
        );
    }
}
