//! Integration policy, shared by native validation and the editor snapshot.
use crate::{agent_defaults::harness_kind, Result};
use serde::{Deserialize, Serialize};

/// Static integration rules, not authentication or model capability evidence.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessConfigurationPolicy {
    /// Who owns authentication; provider-specific credentials stay provider-specific.
    pub authentication: AuthenticationPolicy,
    /// How the provider selector is configured.
    pub provider: ProviderPolicy,
    /// Persisted managed modes admitted by this integration. Legacy fields are separate.
    pub supported_modes: &'static [ConfigurationMode],
    /// Requirement at the existing launch/default-save boundary, not during store reads.
    pub model: ModelRequirement,
    /// Whether this integration reports model-specific effort capabilities.
    pub effort_discovery: EffortDiscovery,
    /// Worker environment selector keys; their values never cross this contract.
    pub selector_environment: Option<SelectorEnvironment>,
}

/// Stable native integration identity. Editable executable names never grant
/// managed policy or access semantics.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HarnessIntegration {
    /// Bundled Buzz Agent integration.
    BuzzAgent,
    /// Bundled Goose integration.
    Goose,
    /// Installed Pi adapter integration.
    Pi,
    /// Installed Codex CLI and ACP adapter integration.
    Codex,
    /// Arbitrary executable without managed semantics.
    External,
}

/// Authentication ownership does not imply an API key is required.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthenticationPolicy {
    /// Buzz configures authentication for the selected provider.
    Provider,
    /// The harness owns sign-in; Buzz can supply provider-specific overrides.
    HarnessWithOverrides,
    /// Authentication belongs to the custom executable.
    External,
}

/// Provider configuration strategy; no provider registry or credential values.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderPolicy {
    /// A scalar provider mapped into worker environment.
    Selector,
    /// Providers are discovered from the harness's model catalog.
    Discovered,
    /// Custom values remain editable; launch requires external configuration.
    External,
}

/// Explicit managed intent, distinct from legacy blank-field inheritance.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigurationMode {
    /// Delegate model and effort to the integration.
    Default,
    /// Explicit model and discovered effort selection.
    Advanced,
}

/// Model requirements for the existing selector interface.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelRequirement {
    /// Blank selectors retain the existing inheritance rules.
    Optional,
    /// Selecting a provider also requires a model.
    WithProvider,
}

/// Static discovery support; unknown is never confirmed lack of effort control.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EffortDiscovery {
    /// This integration does not yet report model-specific effort metadata.
    Unknown,
}

/// Environment keys used by the worker's provider/model selectors.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct SelectorEnvironment {
    /// Model selector key.
    pub model: &'static str,
    /// Provider selector key.
    pub provider: &'static str,
}

impl HarnessConfigurationPolicy {
    /// Policy selected by a native-owned integration identity.
    pub fn for_integration(integration: HarnessIntegration) -> Self {
        let mut policy = Self {
            authentication: AuthenticationPolicy::External,
            provider: ProviderPolicy::External,
            supported_modes: &[],
            model: ModelRequirement::Optional,
            effort_discovery: EffortDiscovery::Unknown,
            selector_environment: None,
        };
        match integration {
            HarnessIntegration::BuzzAgent => {
                policy.authentication = AuthenticationPolicy::Provider;
                policy.provider = ProviderPolicy::Selector;
                policy.selector_environment = Some(SelectorEnvironment {
                    model: "BUZZ_AGENT_MODEL",
                    provider: "BUZZ_AGENT_PROVIDER",
                });
            }
            HarnessIntegration::Goose => {
                policy.authentication = AuthenticationPolicy::HarnessWithOverrides;
                policy.provider = ProviderPolicy::Selector;
                policy.selector_environment = Some(SelectorEnvironment {
                    model: "GOOSE_MODEL",
                    provider: "GOOSE_PROVIDER",
                });
            }
            HarnessIntegration::Pi => {
                policy.authentication = AuthenticationPolicy::HarnessWithOverrides;
                policy.provider = ProviderPolicy::Discovered;
                policy.model = ModelRequirement::WithProvider;
            }
            HarnessIntegration::Codex => {
                policy.authentication = AuthenticationPolicy::External;
                policy.provider = ProviderPolicy::External;
            }
            HarnessIntegration::External => {}
        }
        policy
    }

    /// Existing harness classification only; this grants no executable trust.
    pub fn for_command(command: &str) -> Self {
        Self::for_integration(match harness_kind(command) {
            Some("buzz-agent") => HarnessIntegration::BuzzAgent,
            Some("goose") => HarnessIntegration::Goose,
            Some("pi") => HarnessIntegration::Pi,
            _ => HarnessIntegration::External,
        })
    }

    /// Validate only at the existing selection/launch admission points.
    /// Stored legacy values remain readable and editable even when launch fails.
    pub(crate) fn validate_selection(self, provider: &str, model: &str) -> Result<()> {
        if self.model == ModelRequirement::WithProvider && !provider.is_empty() && model.is_empty()
        {
            return Err("Choose a Pi model for the selected provider, or clear both fields to use Pi defaults".into());
        }
        if self.provider == ProviderPolicy::External && !provider.is_empty() {
            return Err("Set provider configuration through this external harness's environment; a provider selector mapping is not available".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
