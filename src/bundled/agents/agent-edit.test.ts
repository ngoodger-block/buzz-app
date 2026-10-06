import { expect, it } from "vitest";
import { controlFixture } from "../../features/agents/control-testing";
import { agentDraft, agentEdit, agentProcessLabel } from "./agent-edit";
it("round-trips literal arguments including spaces and quotes; no opaque fields in edits", () => {
  const agent = controlFixture().agent;
  const draft = agentDraft(agent);
  expect(agentEdit(draft).harness.args).toEqual([
    "--literal",
    "two words",
    'quoted "value"',
  ]);
  expect(agentEdit(draft).environment).toEqual({});
  expect(agentEdit(draft)).not.toHaveProperty("pubkey");
  expect(agentEdit(draft).harness).not.toHaveProperty("environmentKeys");
});
it("validates without echoing rejected arguments or losing a draft", () => {
  const draft = agentDraft(controlFixture().agent);
  draft.args = "not-json";
  expect(() => agentEdit(draft)).toThrow("JSON array");
  expect(draft.args).toBe("not-json");
  for (const invalid of ["{}", "[1]", "null"])
    expect(() => agentEdit({ ...draft, args: invalid })).toThrow("JSON array");
});
it("environment patches distinguish preserve, replacement, empty and removal", () => {
  const draft = agentDraft(controlFixture().agent);
  expect(agentEdit(draft).environment).toEqual({});
  draft.environment = { REPLACE: "fixture-value", EMPTY: "", DELETE: null };
  expect(agentEdit(draft).environment).toEqual(draft.environment);
});
it("process-alive never claims relay readiness", () => {
  expect(agentProcessLabel(controlFixture().agent)).toBe(
    "Process running · relay readiness unverified",
  );
});

it("refuses argument values unsupported by the current ACP transport", () => {
  const draft = agentDraft(controlFixture().agent);
  for (const args of ['[""]', '["a,b"]']) {
    expect(() => agentEdit({ ...draft, args })).toThrow(
      "nonempty and cannot contain commas",
    );
  }
});

it("does not persist build suggestions on untouched save; explicit blanks stay explicit", () => {
  const agent = controlFixture().agent;
  const draft = agentDraft(agent);
  expect(agentEdit(draft).harness.databricks).toBeUndefined();
  draft.databricks = { host: "https://other.example", filter: "llm" };
  expect(agentEdit(draft).harness.databricks).toEqual(draft.databricks);
  agent.harness.databricks = { host: "", filter: "" };
  const saved = agentDraft(agent);
  expect(agentEdit(saved).harness.databricks).toEqual({ host: "", filter: "" });
  if (!saved.databricks) throw new Error("Missing saved settings");
  saved.databricks.host = "https://edited.example";
  expect(agent.harness.databricks.host).toBe("");
});

it("does not serialize hidden Databricks settings for managed Codex", () => {
  const draft = agentDraft(controlFixture().agent);
  draft.integration = "codex";
  draft.command = "/tools/codex-acp";
  draft.args = "[]";
  draft.provider = "";
  draft.model = "";
  draft.configuration = { mode: "default" };
  draft.databricks = { host: "not-an-origin", filter: "stale" };

  expect(agentEdit(draft).harness.databricks).toBeUndefined();
  expect(draft.databricks).toEqual({ host: "not-an-origin", filter: "stale" });
});

it("requires complete Codex modes without adding Default overrides", () => {
  const draft = agentDraft(controlFixture().agent);
  draft.integration = "codex";
  draft.command = "/tools/codex-acp";
  draft.args = "[]";
  draft.provider = "";
  draft.model = "";
  expect(() => agentEdit(draft)).toThrow("Choose Default or Advanced");

  draft.configuration = { mode: "default" };
  expect(agentEdit(draft).harness).toMatchObject({
    integration: "codex",
    model: "",
    provider: "",
    configuration: { mode: "default" },
  });
  draft.configuration = {
    mode: "advanced",
    effort: { kind: "value", value: "" },
  };
  expect(() => agentEdit(draft)).toThrow("Choose a model");
  draft.model = "model-a";
  expect(() => agentEdit(draft)).toThrow("Choose an effort level");
  draft.configuration = {
    mode: "advanced",
    effort: { kind: "unsupported" },
  };
  expect(agentEdit(draft).harness.configuration).toEqual({
    mode: "advanced",
    effort: { kind: "unsupported" },
  });
});

it("avatar edits preserve an omitted picture, retain managed artwork, and serialize explicit removal", () => {
  const agent = controlFixture().agent;
  expect(
    JSON.parse(JSON.stringify(agentEdit(agentDraft(agent)))),
  ).not.toHaveProperty("picture");
  agent.picture = "https://images.example/a.png";
  const draft = agentDraft(agent);
  expect(agentEdit(draft)).not.toHaveProperty("picture"); // An unchanged field is omitted, even with saved artwork.
  expect(
    agentEdit({ ...draft, picture: "https://images.example/new.png" }).picture,
  ).toBe("https://images.example/new.png");
  expect(agentEdit({ ...draft, picture: "" }).picture).toBe("");
});
