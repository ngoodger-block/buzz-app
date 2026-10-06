import type { ObserverFrame } from "./observer";

const MAX_PROJECTED_TURNS = 5;
const MAX_GROUPS = 512;
const MAX_EVENTS_PER_GROUP = 64;
const MAX_TEXT = 256;
const FUTURE_SKEW_MS = 5000;

export type ObservedValue = Readonly<{
  value: string;
  observedAt: number;
}>;

export type ObservedSessionSettings = Readonly<{
  sessionId: string | null;
  turnId: string;
  workerIndex: number;
  channelId: string | null;
  sessionObservedAt: number | null;
  model: ObservedValue | null;
  effort: ObservedValue | null;
  requestedModel: string | null;
  modelRejection: "rejected" | "unsupported" | null;
  requestedEffort: string | null;
  effortRejected: boolean;
  failedAt: number | null;
}>;

type JsonObject = Record<string, unknown>;
type SettingKind = "model" | "effort";
type Event = Readonly<{
  seq: number;
  timestamp: number;
  kind: string;
  payload: JsonObject;
  sessionId: string | null;
}>;
type Group = {
  turnId: string;
  workerIndex: number;
  channelId: string | null;
  events: Event[];
  overflowed: boolean;
};
type ParsedSettings = Readonly<{
  model: { present: boolean; value: string | null };
  effort: { present: boolean; value: string | null };
  optionKinds: ReadonlyMap<string, SettingKind>;
}>;

const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

const safeText = (value: unknown): string | null =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_TEXT &&
  [...value].every(
    (character) =>
      character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
  )
    ? value
    : null;

const timestamp = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= Date.now() + FUTURE_SKEW_MS
    ? parsed
    : null;
};

const rpcId = (value: unknown): string | null => {
  if (typeof value === "string") {
    const id = safeText(value);
    return id ? `s:${id}` : null;
  }
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? `n:${String(value)}`
    : null;
};

function parseSettings(
  value: unknown,
  knownKinds: ReadonlyMap<string, SettingKind> = new Map(),
): ParsedSettings {
  const result = object(value);
  const options = Array.isArray(result?.configOptions)
    ? result.configOptions
    : [];
  const entries: Record<
    SettingKind,
    { id: string | null; value: string | null }[]
  > = { model: [], effort: [] };
  for (const value of options) {
    const option = object(value);
    const id = safeText(option?.configId) ?? safeText(option?.id);
    const category = option?.category;
    const kind =
      category === "model"
        ? "model"
        : category === "thought_level"
          ? "effort"
          : category === undefined || category === null
            ? id
              ? knownKinds.get(id)
              : undefined
            : undefined;
    if (kind) entries[kind].push({ id, value: safeText(option?.currentValue) });
  }

  const stableModel = entries.model;
  const legacyModel = safeText(object(result?.models)?.currentModelId);
  let model = stableModel.length === 1 ? (stableModel[0]?.value ?? null) : null;
  if (!stableModel.length) model = legacyModel;
  else if (legacyModel && model !== legacyModel) model = null;

  const optionKinds = new Map<string, SettingKind>();
  const collidedIds = new Set<string>();
  for (const kind of ["model", "effort"] as const) {
    const entry = entries[kind].length === 1 ? entries[kind][0] : undefined;
    if (!entry?.id || collidedIds.has(entry.id)) continue;
    const existing = optionKinds.get(entry.id);
    if (existing && existing !== kind) {
      optionKinds.delete(entry.id);
      collidedIds.add(entry.id);
    } else optionKinds.set(entry.id, kind);
  }
  return {
    model: {
      present: stableModel.length > 0 || legacyModel !== null,
      value: model,
    },
    effort: {
      present: entries.effort.length > 0,
      value:
        entries.effort.length === 1 ? (entries.effort[0]?.value ?? null) : null,
    },
    optionKinds,
  };
}

function relevantEvent(value: unknown):
  | (Event & {
      group: string;
      turnId: string;
      workerIndex: number;
      channelId: string | null;
    })
  | null {
  const item = object(value);
  const payload = object(item?.payload);
  const kind = safeText(item?.kind);
  const turnId = safeText(item?.turnId);
  const rawChannel = item?.channelId;
  const channelId = rawChannel === null ? null : safeText(rawChannel);
  const startedAt = timestamp(item?.startedAt);
  const at = timestamp(item?.timestamp);
  const seq = item?.seq;
  const workerIndex = item?.agentIndex;
  const sessionId = item?.sessionId === null ? null : safeText(item?.sessionId);
  if (
    !payload ||
    !kind ||
    !turnId ||
    (rawChannel !== null && !channelId) ||
    startedAt === null ||
    at === null ||
    !Number.isSafeInteger(seq) ||
    (seq as number) < 0 ||
    !Number.isSafeInteger(workerIndex) ||
    (workerIndex as number) < 0 ||
    (item?.sessionId !== null && !sessionId)
  )
    return null;

  if (kind === "acp_write") {
    if (
      ![
        "session/new",
        "session/set_config_option",
        "session/set_model",
        "session/prompt",
      ].includes(String(payload.method))
    )
      return null;
  } else if (kind === "acp_read") {
    const update = object(object(payload.params)?.update);
    const configUpdate =
      payload.method === "session/update" &&
      update?.sessionUpdate === "config_option_update";
    const response = !!rpcId(payload.id) && !("method" in payload);
    if (!configUpdate && !response) return null;
  } else if (
    ![
      "session_resolved",
      "control_result",
      "turn_error",
      "agent_panic",
    ].includes(kind)
  )
    return null;

  return {
    group: JSON.stringify([turnId, workerIndex, channelId, startedAt]),
    turnId,
    workerIndex: workerIndex as number,
    channelId,
    seq: seq as number,
    timestamp: at,
    kind,
    payload,
    sessionId,
  };
}

function uniqueById(events: readonly Event[], kind: "acp_write" | "acp_read") {
  const values = new Map<string, Event | null>();
  for (const event of events) {
    if (event.kind !== kind) continue;
    if (kind === "acp_read" && "method" in event.payload) continue;
    const id = rpcId(event.payload.id);
    if (!id) continue;
    values.set(id, values.has(id) ? null : event);
  }
  return values;
}

function projectGroup(group: Group): ObservedSessionSettings | null {
  if (group.overflowed) return null;
  const events = [...group.events].sort(
    (left, right) => left.seq - right.seq || left.timestamp - right.timestamp,
  );
  const writes = uniqueById(events, "acp_write");
  const responses = uniqueById(events, "acp_read");
  const resolvedEvents = events.filter(
    (event) => event.kind === "session_resolved",
  );
  if (resolvedEvents.length > 1) return null;
  const resolved = resolvedEvents[0];
  const sessionId = safeText(resolved?.payload.sessionId);
  const sessionResolved =
    !!resolved && !!sessionId && resolved.sessionId === sessionId;
  let failedAt: number | null = null;
  for (const event of events)
    if (
      ["turn_error", "agent_panic"].includes(event.kind) &&
      (!sessionResolved || !event.sessionId || event.sessionId === sessionId)
    )
      failedAt = Math.max(failedAt ?? 0, event.timestamp);
  for (const [id, request] of writes) {
    const response = responses.get(id);
    if (
      request &&
      response &&
      request.seq < response.seq &&
      object(response.payload.error) &&
      ((request.payload.method === "session/new" && !sessionResolved) ||
        (request.payload.method === "session/prompt" &&
          sessionResolved &&
          object(request.payload.params)?.sessionId === sessionId))
    )
      failedAt = Math.max(failedAt ?? 0, response.timestamp);
  }
  if (!sessionResolved) {
    if (failedAt === null) return null;
    return Object.freeze({
      sessionId: null,
      turnId: group.turnId,
      workerIndex: group.workerIndex,
      channelId: group.channelId,
      sessionObservedAt: null,
      model: null,
      effort: null,
      requestedModel: null,
      modelRejection: null,
      requestedEffort: null,
      effortRejected: false,
      failedAt,
    });
  }

  let optionKinds = new Map<string, SettingKind>();
  let model: ObservedValue | null = null;
  let effort: ObservedValue | null = null;
  let requestedModel: string | null = null;
  let requestedEffort: string | null = null;
  let modelRejection: ObservedSessionSettings["modelRejection"] = null;
  let effortRejected = false;

  const open = [...writes.entries()]
    .filter(([, event]) => event?.payload.method === "session/new")
    .map(([id, request]) => ({ request, response: responses.get(id) }))
    .filter(
      ({ request, response }) =>
        !!request &&
        !!response &&
        request.seq < response.seq &&
        response.seq < resolved.seq &&
        !object(response.payload.error) &&
        safeText(object(response.payload.result)?.sessionId) === sessionId,
    );
  if (open.length > 1) return null;
  const opened = open[0]?.response;
  const settingChanges = [...writes.entries()]
    .map(([id, request]) => ({ request, response: responses.get(id) }))
    .filter(
      ({ request, response }) =>
        !!request &&
        !!response &&
        request.seq < response.seq &&
        object(request.payload.params)?.sessionId === sessionId &&
        ["session/set_config_option", "session/set_model"].includes(
          String(request.payload.method),
        ),
    )
    .filter(
      (change): change is { request: Event; response: Event } =>
        !!change.request && !!change.response,
    );
  const operations: (
    | { type: "open"; event: Event }
    | { type: "setting"; request: Event; event: Event }
    | { type: "control"; event: Event }
    | { type: "update"; event: Event }
  )[] = [];
  if (opened) operations.push({ type: "open", event: opened });
  for (const { request, response } of settingChanges)
    operations.push({ type: "setting", request, event: response });
  for (const event of events) {
    if (
      event.kind === "control_result" &&
      event.payload.type === "switch_model"
    )
      operations.push({ type: "control", event });
    if (
      event.kind === "acp_read" &&
      event.payload.method === "session/update" &&
      object(event.payload.params)?.sessionId === sessionId
    )
      operations.push({ type: "update", event });
  }
  operations.sort(
    (left, right) =>
      left.event.seq - right.event.seq ||
      left.event.timestamp - right.event.timestamp,
  );

  for (const operation of operations) {
    const event = operation.event;
    if (operation.type === "open") {
      const reported = parseSettings(event.payload.result);
      optionKinds = new Map(reported.optionKinds);
      model = reported.model.value
        ? { value: reported.model.value, observedAt: event.timestamp }
        : null;
      effort = reported.effort.value
        ? { value: reported.effort.value, observedAt: event.timestamp }
        : null;
      continue;
    }
    if (operation.type === "control") {
      const requested = safeText(event.payload.modelId);
      if (!requested) continue;
      if (event.payload.status === "unsupported_model") {
        requestedModel = requested;
        modelRejection = "unsupported";
      } else if (event.payload.status === "failure") {
        requestedModel = requested;
        modelRejection = "rejected";
      }
      continue;
    }
    if (operation.type === "update") {
      const update = object(object(event.payload.params)?.update);
      if (update?.sessionUpdate !== "config_option_update") continue;
      const reported = parseSettings(update, optionKinds);
      if (reported.model.present) {
        model = reported.model.value
          ? { value: reported.model.value, observedAt: event.timestamp }
          : null;
        if (!reported.effort.present) effort = null;
      }
      if (reported.effort.present)
        effort = reported.effort.value
          ? { value: reported.effort.value, observedAt: event.timestamp }
          : null;
      for (const [id, value] of reported.optionKinds)
        optionKinds.set(id, value);
      continue;
    }

    const params = object(operation.request.payload.params);
    if (!params) continue;
    const explicitModel =
      operation.request.payload.method === "session/set_model";
    const configId = safeText(params.configId);
    const kind = explicitModel
      ? "model"
      : configId
        ? optionKinds.get(configId)
        : undefined;
    const requested = safeText(explicitModel ? params.modelId : params.value);
    if (!kind || !requested) continue;
    const rejected = !!object(event.payload.error);
    if (kind === "model") {
      requestedModel = requested;
      modelRejection = rejected ? "rejected" : null;
      if (rejected) continue;
      const reported = parseSettings(event.payload.result);
      model = reported.model.value
        ? { value: reported.model.value, observedAt: event.timestamp }
        : null;
      effort = reported.effort.value
        ? { value: reported.effort.value, observedAt: event.timestamp }
        : null;
      optionKinds = new Map(reported.optionKinds);
    } else {
      requestedEffort = requested;
      effortRejected = rejected;
      if (rejected) continue;
      const reported = parseSettings(event.payload.result, optionKinds);
      effort = reported.effort.value
        ? { value: reported.effort.value, observedAt: event.timestamp }
        : null;
      if (reported.model.present)
        model = reported.model.value
          ? { value: reported.model.value, observedAt: event.timestamp }
          : null;
      for (const [id, value] of reported.optionKinds)
        optionKinds.set(id, value);
    }
  }

  return Object.freeze({
    sessionId,
    turnId: group.turnId,
    workerIndex: group.workerIndex,
    channelId: group.channelId,
    sessionObservedAt: resolved.timestamp,
    model,
    effort,
    requestedModel,
    modelRejection,
    requestedEffort,
    effortRejected,
    failedAt,
  });
}

const latestObservation = (report: ObservedSessionSettings) =>
  Math.max(
    report.sessionObservedAt ?? 0,
    report.model?.observedAt ?? 0,
    report.effort?.observedAt ?? 0,
    report.failedAt ?? 0,
  );

/**
 * Project safe historical turn facts from the existing owner- and
 * access-filtered activity stream. Reports never certify the current launch or
 * saved revision; clearing, eviction, and generation changes remove evidence.
 */
export function observedSessionSettings(
  records: readonly ObserverFrame[],
  agent: string,
): ObservedSessionSettings[] {
  const groups = new Map<string, Group>();
  for (const record of records) {
    if (record.agent !== agent) continue;
    let envelope: JsonObject | undefined;
    try {
      envelope = object(JSON.parse(record.plaintext));
    } catch {
      continue;
    }
    const children =
      envelope?.kind === "batch"
        ? object(envelope.payload)?.events
        : [envelope];
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      const event = relevantEvent(child);
      if (!event) continue;
      let group = groups.get(event.group);
      if (!group) {
        if (groups.size >= MAX_GROUPS) return [];
        group = {
          turnId: event.turnId,
          workerIndex: event.workerIndex,
          channelId: event.channelId,
          events: [],
          overflowed: false,
        };
        groups.set(event.group, group);
      }
      if (group.events.length >= MAX_EVENTS_PER_GROUP) group.overflowed = true;
      else group.events.push(event);
    }
  }
  return [...groups.values()]
    .map(projectGroup)
    .filter((report): report is ObservedSessionSettings => !!report)
    .sort(
      (left, right) =>
        latestObservation(right) - latestObservation(left) ||
        (left.sessionId ?? "").localeCompare(right.sessionId ?? "") ||
        left.turnId.localeCompare(right.turnId),
    )
    .slice(0, MAX_PROJECTED_TURNS);
}
