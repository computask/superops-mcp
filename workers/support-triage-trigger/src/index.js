var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/config.ts
var DEFAULT_DEBOUNCE_SECONDS = 45;
var DEFAULT_MAX_DEBOUNCE_SECONDS = 120;
var DEFAULT_COOLDOWN_SECONDS = 120;
var DEFAULT_FAST_DEBOUNCE_SECONDS = 10;
var DEFAULT_FAST_MAX_DEBOUNCE_SECONDS = 30;
var DEFAULT_FAST_COOLDOWN_SECONDS = 5;
var DEFAULT_FAST_INGESTION_GRACE_SECONDS = 15;
var DEFAULT_FAST_NEW_EMAIL_LOOKBACK_SECONDS = 60;
var DEFAULT_NEW_EMAIL_LOOKBACK_SECONDS = 300;
var DEFAULT_RESULT_WATCHDOG_SECONDS = 30 * 60;
var DEFAULT_RESULT_POLL_DUE_GATING_ENABLED = true;
var DEFAULT_AGENT_TIMING_TELEMETRY_ENABLED = true;
var DEFAULT_STALE_RUN_RECOVERY_ENABLED = true;
var DEFAULT_RECONCILIATION_ELIGIBILITY_SEPARATION_ENABLED = false;
var DEFAULT_ACCEPTED_RUN_MAX_AGE_SECONDS = 60 * 60;
var DEFAULT_RESULT_MAX_RETRIES = 6;
var DEFAULT_RESULT_MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;
var DEFAULT_GRAPH_SWEEP_ENABLED = false;
var DEFAULT_GRAPH_SWEEP_LOOKBACK_SECONDS = 15 * 60;
var DEFAULT_GRAPH_SWEEP_MAX_MESSAGES = 100;
var DEFAULT_SUBSCRIPTION_LIFETIME_MINUTES = 45;
var DEFAULT_SUBSCRIPTION_RENEWAL_LEAD_MINUTES = 15;
var DEFAULT_HISTORY_RETENTION_DAYS = 30;
var DEFAULT_HISTORY_MAX_ROWS = 5e4;
function get(env, key) {
  const value = env[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
__name(get, "get");
function parseBoolean(value, fallback) {
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
__name(parseBoolean, "parseBoolean");
function parsePositiveSeconds(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
__name(parsePositiveSeconds, "parsePositiveSeconds");
function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
__name(parsePositiveInteger, "parsePositiveInteger");
function parseScopeMode(value) {
  if (value === "new-email-tickets" || value === "full-new-calls") return value;
  return "full-new-calls";
}
__name(parseScopeMode, "parseScopeMode");
function loadConfig(env) {
  const scopeMode = parseScopeMode(get(env, "TRIAGE_TRIGGER_SCOPE_MODE"));
  const fastTargetedModeEnabled = scopeMode === "new-email-tickets" && parseBoolean(get(env, "TRIAGE_FAST_TARGETED_MODE_ENABLED"), false);
  const debounceSeconds = parsePositiveSeconds(
    get(env, "TRIAGE_TRIGGER_DEBOUNCE_SECONDS"),
    DEFAULT_DEBOUNCE_SECONDS
  );
  const maxDebounceSeconds = Math.max(
    debounceSeconds,
    parsePositiveSeconds(
      get(env, "TRIAGE_TRIGGER_MAX_DEBOUNCE_SECONDS"),
      DEFAULT_MAX_DEBOUNCE_SECONDS
    )
  );
  const fastDebounceSeconds = parsePositiveSeconds(
    get(env, "TRIAGE_FAST_DEBOUNCE_SECONDS"),
    DEFAULT_FAST_DEBOUNCE_SECONDS
  );
  const fastMaxDebounceSeconds = Math.max(
    fastDebounceSeconds,
    parsePositiveSeconds(
      get(env, "TRIAGE_FAST_MAX_DEBOUNCE_SECONDS"),
      DEFAULT_FAST_MAX_DEBOUNCE_SECONDS
    )
  );
  const cooldownSeconds = parsePositiveSeconds(
    get(env, "WORKSPACE_AGENT_TRIGGER_COOLDOWN_SECONDS"),
    DEFAULT_COOLDOWN_SECONDS
  );
  const fastCooldownSeconds = parsePositiveSeconds(
    get(env, "TRIAGE_FAST_COOLDOWN_SECONDS"),
    DEFAULT_FAST_COOLDOWN_SECONDS
  );
  const fastIngestionGraceSeconds = parsePositiveSeconds(
    get(env, "TRIAGE_FAST_INGESTION_GRACE_SECONDS"),
    DEFAULT_FAST_INGESTION_GRACE_SECONDS
  );
  const fastNewEmailLookbackSeconds = parsePositiveSeconds(
    get(env, "TRIAGE_FAST_NEW_EMAIL_LOOKBACK_SECONDS"),
    DEFAULT_FAST_NEW_EMAIL_LOOKBACK_SECONDS
  );
  const historyRetentionDays = Math.min(
    365,
    parsePositiveInteger(
      get(env, "TRIAGE_HISTORY_RETENTION_DAYS"),
      DEFAULT_HISTORY_RETENTION_DAYS
    )
  );
  const historyMaxRows = Math.min(
    1e5,
    parsePositiveInteger(
      get(env, "TRIAGE_HISTORY_MAX_ROWS"),
      DEFAULT_HISTORY_MAX_ROWS
    )
  );
  return {
    enabled: parseBoolean(get(env, "AUTOMATED_TRIAGE_TRIGGER_ENABLED"), false),
    scopeMode,
    fastTargetedModeEnabled,
    newEmailLookbackMs: parsePositiveSeconds(
      get(env, "TRIAGE_NEW_EMAIL_LOOKBACK_SECONDS"),
      DEFAULT_NEW_EMAIL_LOOKBACK_SECONDS
    ) * 1e3,
    fastNewEmailLookbackMs: fastNewEmailLookbackSeconds * 1e3,
    debounceMs: (fastTargetedModeEnabled ? fastDebounceSeconds : debounceSeconds) * 1e3,
    maxDebounceMs: (fastTargetedModeEnabled ? fastMaxDebounceSeconds : maxDebounceSeconds) * 1e3,
    cooldownMs: (fastTargetedModeEnabled ? fastCooldownSeconds : cooldownSeconds) * 1e3,
    fastIngestionGraceMs: fastIngestionGraceSeconds * 1e3,
    resultCallbackEnabled: parseBoolean(get(env, "TRIAGE_RESULT_CALLBACK_ENABLED"), false),
    resultWatchdogMs: parsePositiveSeconds(
      get(env, "TRIAGE_RESULT_WATCHDOG_SECONDS"),
      DEFAULT_RESULT_WATCHDOG_SECONDS
    ) * 1e3,
    resultPollDueGatingEnabled: parseBoolean(
      get(env, "TRIAGE_RESULT_POLL_DUE_GATING_ENABLED"),
      DEFAULT_RESULT_POLL_DUE_GATING_ENABLED
    ),
    agentTimingTelemetryEnabled: parseBoolean(
      get(env, "TRIAGE_AGENT_TIMING_TELEMETRY_ENABLED"),
      DEFAULT_AGENT_TIMING_TELEMETRY_ENABLED
    ),
    staleRunRecoveryEnabled: parseBoolean(
      get(env, "TRIAGE_STALE_RUN_RECOVERY_ENABLED"),
      DEFAULT_STALE_RUN_RECOVERY_ENABLED
    ),
    reconciliationEligibilitySeparationEnabled: parseBoolean(
      get(env, "TRIAGE_RECONCILIATION_ELIGIBILITY_SEPARATION_ENABLED"),
      DEFAULT_RECONCILIATION_ELIGIBILITY_SEPARATION_ENABLED
    ),
    acceptedRunMaxAgeMs: parsePositiveSeconds(
      get(env, "TRIAGE_ACCEPTED_RUN_MAX_AGE_SECONDS"),
      DEFAULT_ACCEPTED_RUN_MAX_AGE_SECONDS
    ) * 1e3,
    resultMaxRetries: parsePositiveInteger(
      get(env, "TRIAGE_RESULT_MAX_RETRIES"),
      DEFAULT_RESULT_MAX_RETRIES
    ),
    configurationRetryExitEnabled: parseBoolean(get(env, "TRIAGE_CONFIGURATION_RETRY_EXIT_ENABLED"), false),
    resultMaxRetryAfterMs: parsePositiveSeconds(
      get(env, "TRIAGE_RESULT_MAX_RETRY_AFTER_SECONDS"),
      DEFAULT_RESULT_MAX_RETRY_AFTER_SECONDS
    ) * 1e3,
    graphSweepEnabled: parseBoolean(
      get(env, "TRIAGE_GRAPH_SWEEP_ENABLED"),
      DEFAULT_GRAPH_SWEEP_ENABLED
    ),
    graphSweepLookbackMs: parsePositiveSeconds(
      get(env, "TRIAGE_GRAPH_SWEEP_LOOKBACK_SECONDS"),
      DEFAULT_GRAPH_SWEEP_LOOKBACK_SECONDS
    ) * 1e3,
    graphSweepMaxMessages: parsePositiveInteger(
      get(env, "TRIAGE_GRAPH_SWEEP_MAX_MESSAGES"),
      DEFAULT_GRAPH_SWEEP_MAX_MESSAGES
    ),
    subscriptionLifetimeMs: parsePositiveSeconds(
      get(env, "GRAPH_SUBSCRIPTION_LIFETIME_MINUTES"),
      DEFAULT_SUBSCRIPTION_LIFETIME_MINUTES
    ) * 60 * 1e3,
    subscriptionRenewalLeadMs: parsePositiveSeconds(
      get(env, "GRAPH_SUBSCRIPTION_RENEWAL_LEAD_MINUTES"),
      DEFAULT_SUBSCRIPTION_RENEWAL_LEAD_MINUTES
    ) * 60 * 1e3,
    historyRetentionDays,
    historyMaxRows,
    graphTenantId: get(env, "GRAPH_TENANT_ID"),
    graphClientId: get(env, "GRAPH_CLIENT_ID"),
    graphClientSecret: get(env, "GRAPH_CLIENT_SECRET"),
    graphSupportMailboxUpn: get(env, "GRAPH_SUPPORT_MAILBOX_UPN"),
    graphWebhookClientState: get(env, "GRAPH_WEBHOOK_CLIENT_STATE"),
    graphNotificationUrl: get(env, "GRAPH_NOTIFICATION_URL"),
    graphLifecycleNotificationUrl: get(env, "GRAPH_LIFECYCLE_NOTIFICATION_URL") ?? get(env, "GRAPH_NOTIFICATION_URL"),
    graphApiBaseUrl: get(env, "GRAPH_API_BASE_URL") ?? "https://graph.microsoft.com/v1.0",
    workspaceAgentTriggerUrl: get(env, "WORKSPACE_AGENT_TRIGGER_URL"),
    workspaceAgentAccessToken: get(env, "WORKSPACE_AGENT_ACCESS_TOKEN"),
    historyResetToken: get(env, "TRIAGE_HISTORY_RESET_TOKEN")
  };
}
__name(loadConfig, "loadConfig");
function missingGraphConfiguration(config) {
  const missing = [];
  if (!config.graphTenantId) missing.push("GRAPH_TENANT_ID");
  if (!config.graphClientId) missing.push("GRAPH_CLIENT_ID");
  if (!config.graphClientSecret) missing.push("GRAPH_CLIENT_SECRET");
  if (!config.graphSupportMailboxUpn) missing.push("GRAPH_SUPPORT_MAILBOX_UPN");
  if (!config.graphWebhookClientState) missing.push("GRAPH_WEBHOOK_CLIENT_STATE");
  if (!config.graphNotificationUrl) missing.push("GRAPH_NOTIFICATION_URL");
  return missing;
}
__name(missingGraphConfiguration, "missingGraphConfiguration");
function missingAgentConfiguration(config) {
  const missing = [];
  if (!config.workspaceAgentTriggerUrl) missing.push("WORKSPACE_AGENT_TRIGGER_URL");
  if (!config.workspaceAgentAccessToken) missing.push("WORKSPACE_AGENT_ACCESS_TOKEN");
  return missing;
}
__name(missingAgentConfiguration, "missingAgentConfiguration");

// src/worker-fetch.ts
function boundWorkerFetch(input, init) {
  return globalThis.fetch(input, init);
}
__name(boundWorkerFetch, "boundWorkerFetch");

// src/graph.ts
var GraphApiError = class extends Error {
  constructor(operation, status, metadata = {}) {
    super(`Microsoft Graph ${operation} failed with status ${status}`);
    this.operation = operation;
    this.status = status;
    this.metadata = metadata;
    this.name = "GraphApiError";
  }
  operation;
  status;
  metadata;
  static {
    __name(this, "GraphApiError");
  }
};
var GraphConfigurationError = class extends Error {
  constructor(missing) {
    super("Microsoft Graph configuration is incomplete");
    this.missing = missing;
    this.name = "GraphConfigurationError";
  }
  missing;
  static {
    __name(this, "GraphConfigurationError");
  }
};
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
__name(isRecord, "isRecord");
function safeField(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : void 0;
}
__name(safeField, "safeField");
function safeMessage(value) {
  if (typeof value !== "string") return void 0;
  let normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return void 0;
  normalized = normalized.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/((?:token|secret|password|api[_-]?key|authorization|cookie)\s*[:=]\s*)\S+/gi, "$1[redacted]").replace(/https?:\/\/\S+/gi, "[redacted-url]").replace(/[A-Za-z]:\\[^\s)\"']+/g, "[redacted-path]").replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]");
  return normalized.length > 512 ? `${normalized.slice(0, 512)}...` : normalized;
}
__name(safeMessage, "safeMessage");
async function readSafeErrorMetadata(response) {
  let body;
  try {
    body = await response.clone().json();
  } catch {
    return {};
  }
  if (!isRecord(body)) return {};
  const nestedError = isRecord(body.error) ? body.error : body;
  return {
    errorType: safeField(nestedError.type ?? nestedError.error_type, 128),
    errorCode: safeField(nestedError.code ?? nestedError.error_code, 128),
    requestId: safeField(body.request_id ?? body.requestId ?? nestedError.request_id, 128),
    errorMessage: safeMessage(nestedError.message ?? body.message)
  };
}
__name(readSafeErrorMetadata, "readSafeErrorMetadata");
function asSubscription(value) {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.expirationDateTime !== "string") {
    throw new Error("Microsoft Graph returned an invalid subscription record");
  }
  return {
    id: value.id,
    resource: typeof value.resource === "string" ? value.resource : "",
    expirationDateTime: value.expirationDateTime
  };
}
__name(asSubscription, "asSubscription");
function graphResourceForMailbox(upn) {
  return `/users/${encodeURIComponent(upn)}/mailFolders('inbox')/messages`;
}
__name(graphResourceForMailbox, "graphResourceForMailbox");
var GraphSubscriptionManager = class {
  constructor(config, fetcher = boundWorkerFetch, logger2) {
    this.config = config;
    this.fetcher = fetcher;
    this.logger = logger2;
  }
  config;
  fetcher;
  logger;
  static {
    __name(this, "GraphSubscriptionManager");
  }
  async ensure(existing, now, force = false) {
    this.assertConfigured();
    if (!force && existing && this.expiresAfterRenewalWindow(existing, now)) {
      return existing;
    }
    const token = await this.getAccessToken();
    if (existing) {
      const existingExpiry = Date.parse(existing.expirationDateTime);
      const existingExpired = !Number.isFinite(existingExpiry) || existingExpiry <= now;
      try {
        return await this.renew(existing, token, now);
      } catch (error) {
        const errorMessage = error instanceof GraphApiError ? error.metadata.errorMessage?.toLowerCase() ?? "" : "";
        const canRecreate = error instanceof GraphApiError && (error.status === 404 || error.status === 410 || error.status === 400 && (existingExpired || errorMessage.includes("about to expire")));
        if (!canRecreate) {
          throw error;
        }
        this.logger?.warn("graph_subscription_unusable_recreating", {
          status: error instanceof GraphApiError ? error.status : null,
          expired: existingExpired
        });
        if (!existingExpired && errorMessage.includes("about to expire")) {
          return this.replace(existing, token, now);
        }
      }
    }
    return this.create(token, now);
  }
  async recoverLifecycle(existing, event, now) {
    this.assertConfigured();
    if (event === "missed") return existing;
    const token = await this.getAccessToken();
    if (event === "subscriptionRemoved" || !existing) return this.create(token, now);
    const response = await this.fetcher(
      `${this.apiBase()}/subscriptions/${encodeURIComponent(existing.id)}/reauthorize`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        }
      }
    );
    if (!response.ok && response.status !== 204) {
      throw new GraphApiError(
        "reauthorize subscription",
        response.status,
        await readSafeErrorMetadata(response)
      );
    }
    return existing;
  }
  /**
   * Return a metadata-only safety sweep for recently received Inbox mail.
   *
   * Graph notifications are the fast path, but Microsoft Graph recommends a
   * resynchronisation mechanism for missed notifications. This call never
   * requests message bodies, previews, subjects, senders, or attachments. It
   * turns each message id into the same safe created signal consumed by the
   * coordinator; notification/resource deduplication prevents a sweep from
   * creating a second batch for a message already delivered by Graph.
   */
  async listRecentEmailNotifications(since, maxMessages) {
    this.assertConfigured();
    const token = await this.getAccessToken();
    const resource = graphResourceForMailbox(this.config.graphSupportMailboxUpn);
    const url = new URL(`${this.apiBase()}${resource}`);
    url.searchParams.set("$select", "id,createdDateTime,receivedDateTime");
    url.searchParams.set(
      "$filter",
      `receivedDateTime ge ${new Date(Math.max(0, since)).toISOString()}`
    );
    url.searchParams.set("$orderby", "receivedDateTime desc");
    url.searchParams.set("$top", String(Math.min(1e3, Math.max(1, maxMessages))));
    const response = await this.fetcher(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      }
    });
    if (!response.ok) {
      throw new GraphApiError(
        "list recent Inbox messages",
        response.status,
        await readSafeErrorMetadata(response)
      );
    }
    const body = await response.json();
    if (!isRecord(body) || !Array.isArray(body.value)) {
      throw new Error("Microsoft Graph returned an invalid message collection");
    }
    const notifications = [];
    for (const item of body.value) {
      if (!isRecord(item) || typeof item.id !== "string" || item.id.length === 0) continue;
      const receivedDateTime = typeof item.receivedDateTime === "string" ? item.receivedDateTime : typeof item.createdDateTime === "string" ? item.createdDateTime : void 0;
      const receivedAt = receivedDateTime === void 0 ? NaN : Date.parse(receivedDateTime);
      if (Number.isFinite(receivedAt) && receivedAt < since) continue;
      notifications.push({
        id: `graph-sweep-${item.id}`,
        subscriptionId: "graph-sweep",
        clientState: this.config.graphWebhookClientState,
        changeType: "created",
        resource: `${resource}/${encodeURIComponent(item.id)}`,
        resourceData: { id: item.id }
      });
    }
    return {
      notifications,
      partial: typeof body["@odata.nextLink"] === "string"
    };
  }
  expiresAfterRenewalWindow(record, now) {
    const expiry = Date.parse(record.expirationDateTime);
    return Number.isFinite(expiry) && expiry - now > this.config.subscriptionRenewalLeadMs;
  }
  assertConfigured() {
    const missing = missingGraphConfiguration(this.config);
    if (missing.length > 0) throw new GraphConfigurationError(missing);
  }
  apiBase() {
    return this.config.graphApiBaseUrl.replace(/\/$/, "");
  }
  async getAccessToken() {
    const response = await this.fetcher(
      `https://login.microsoftonline.com/${encodeURIComponent(this.config.graphTenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.config.graphClientId,
          client_secret: this.config.graphClientSecret,
          scope: "https://graph.microsoft.com/.default",
          grant_type: "client_credentials"
        })
      }
    );
    if (!response.ok) {
      throw new GraphApiError("token acquisition", response.status, await readSafeErrorMetadata(response));
    }
    const body = await response.json();
    if (!isRecord(body) || typeof body.access_token !== "string" || body.access_token.length === 0) {
      throw new Error("Microsoft Graph token response was invalid");
    }
    return body.access_token;
  }
  async create(token, now) {
    const expirationDateTime = new Date(now + this.config.subscriptionLifetimeMs).toISOString();
    const response = await this.fetcher(`${this.apiBase()}/subscriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        changeType: "created",
        notificationUrl: this.config.graphNotificationUrl,
        lifecycleNotificationUrl: this.config.graphLifecycleNotificationUrl,
        resource: graphResourceForMailbox(this.config.graphSupportMailboxUpn),
        expirationDateTime,
        clientState: this.config.graphWebhookClientState
      })
    });
    if (!response.ok) {
      throw new GraphApiError("create subscription", response.status, await readSafeErrorMetadata(response));
    }
    return asSubscription(await response.json());
  }
  async replace(existing, token, now) {
    const replacement = await this.create(token, now);
    try {
      await this.remove(existing.id, token);
    } catch (error) {
      this.logger?.warn("graph_subscription_old_record_delete_failed", {
        reason: error instanceof GraphApiError ? "request" : "unknown",
        status: error instanceof GraphApiError ? error.status : null
      });
    }
    return replacement;
  }
  async remove(id, token) {
    const response = await this.fetcher(
      `${this.apiBase()}/subscriptions/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` }
      }
    );
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      throw new GraphApiError("delete subscription", response.status, await readSafeErrorMetadata(response));
    }
  }
  async renew(existing, token, now) {
    const expirationDateTime = new Date(now + this.config.subscriptionLifetimeMs).toISOString();
    const response = await this.fetcher(
      `${this.apiBase()}/subscriptions/${encodeURIComponent(existing.id)}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ expirationDateTime })
      }
    );
    if (!response.ok) {
      throw new GraphApiError("renew subscription", response.status, await readSafeErrorMetadata(response));
    }
    return asSubscription(await response.json());
  }
};

// src/safe-telemetry.ts
var SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
var SAFE_ITEM_KEY_PATTERN = /^[A-Za-z0-9._:#-]{1,128}$/;
var SAFE_TICKET_NUMBER_PATTERN = /^#?[0-9]{1,40}$/;
var SAFE_OPERATION_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,96}$/;
var SAFE_DIAGNOSTIC_STAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
var OPERATION_STATES = /* @__PURE__ */ new Set([
  "Running",
  "ContinuationRequired",
  "Rescheduled",
  "Completed",
  "CompletedWithFailures",
  "Failed",
  "Cancelled"
]);
var TICKET_OUTCOMES = /* @__PURE__ */ new Set([
  "completed",
  "skipped",
  "deferred",
  "failed",
  "not_attempted"
]);
var TICKET_STAGES = /* @__PURE__ */ new Set([
  "bounded_query",
  "evidence_recovery",
  "triage_apply",
  "operation_continuation",
  "verification",
  "configuration",
  "unknown"
]);
var TICKET_REASON_CODES = /* @__PURE__ */ new Set([
  "already_handled",
  "no_action",
  "rate_limit",
  "unavailable",
  "stale",
  "validation",
  "partial_write",
  "not_attempted",
  "unknown"
]);
var MCP_REQUEST_TYPES = /* @__PURE__ */ new Set([
  "initialRead",
  "paginationRead",
  "metadataValidation",
  "duplicateNoteCheck",
  "write",
  "fallbackWrite",
  "verificationRead",
  "retry",
  "custom"
]);
var MCP_OPERATION_TYPES = /* @__PURE__ */ new Set([
  "query",
  "mutation",
  "subscription",
  "serviceBinding",
  "durableObject",
  "workflow"
]);
var MCP_STATUSES = /* @__PURE__ */ new Set([
  "networkError",
  "requestTimeout"
]);
var RETRY_SOURCES = /* @__PURE__ */ new Set(["retry-after", "backoff"]);
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isRecord2, "isRecord");
function keysAreBounded(value, allowed) {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}
__name(keysAreBounded, "keysAreBounded");
function boundedInteger(value, minimum = 0, maximum = 1e9) {
  if (value === void 0) return void 0;
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum ? value : null;
}
__name(boundedInteger, "boundedInteger");
function safeReference(value, pattern = SAFE_REFERENCE_PATTERN) {
  if (value === void 0) return void 0;
  return typeof value === "string" && pattern.test(value) ? value : null;
}
__name(safeReference, "safeReference");
function parseSafeOperationStatus(value) {
  if (value === void 0) return void 0;
  if (!isRecord2(value) || !keysAreBounded(value, [
    "state",
    "continuationRequired",
    "pendingCount",
    "failedCount",
    "partialWriteCount",
    "ambiguousWriteCount",
    "waitingForRateLimitCount",
    "continuationCount",
    "terminalFailureClass",
    "replaySafe",
    "humanReconciliationRequired",
    "ticketNumbers"
  ])) return null;
  if (typeof value.state !== "string" || !OPERATION_STATES.has(value.state)) {
    return null;
  }
  const status = {
    state: value.state
  };
  if (value.continuationRequired !== void 0) {
    if (typeof value.continuationRequired !== "boolean") return null;
    status.continuationRequired = value.continuationRequired;
  }
  for (const key of [
    "pendingCount",
    "failedCount",
    "partialWriteCount",
    "ambiguousWriteCount",
    "waitingForRateLimitCount",
    "continuationCount"
  ]) {
    const count = boundedInteger(value[key], 0, 1e3);
    if (count === null) return null;
    if (count !== void 0) status[key] = count;
  }
  const terminalFailureClass = safeReference(value.terminalFailureClass);
  if (terminalFailureClass === null) return null;
  if (terminalFailureClass !== void 0) status.terminalFailureClass = terminalFailureClass;
  for (const key of ["replaySafe", "humanReconciliationRequired"]) {
    if (value[key] === void 0) continue;
    if (typeof value[key] !== "boolean") return null;
    status[key] = value[key];
  }
  if (value.ticketNumbers !== void 0) {
    if (!Array.isArray(value.ticketNumbers) || value.ticketNumbers.length > 500) return null;
    const seen = /* @__PURE__ */ new Set();
    const ticketNumbers = [];
    for (const ticketNumber of value.ticketNumbers) {
      if (typeof ticketNumber !== "string" || !SAFE_TICKET_NUMBER_PATTERN.test(ticketNumber) || seen.has(ticketNumber)) return null;
      seen.add(ticketNumber);
      ticketNumbers.push(ticketNumber);
    }
    status.ticketNumbers = ticketNumbers;
  }
  return status;
}
__name(parseSafeOperationStatus, "parseSafeOperationStatus");
function parseTicketOutcomes(value) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value) || value.length > 500) return null;
  const seen = /* @__PURE__ */ new Set();
  const parsed = [];
  for (const item of value) {
    if (!isRecord2(item) || !keysAreBounded(item, ["ticketNumber", "outcome", "stage", "reasonCode"])) {
      return null;
    }
    if (typeof item.ticketNumber !== "string" || !SAFE_TICKET_NUMBER_PATTERN.test(item.ticketNumber) || seen.has(item.ticketNumber)) {
      return null;
    }
    if (typeof item.outcome !== "string" || !TICKET_OUTCOMES.has(item.outcome)) {
      return null;
    }
    if (item.stage !== void 0 && (typeof item.stage !== "string" || !TICKET_STAGES.has(item.stage))) {
      return null;
    }
    if (item.reasonCode !== void 0 && (typeof item.reasonCode !== "string" || !TICKET_REASON_CODES.has(item.reasonCode))) {
      return null;
    }
    seen.add(item.ticketNumber);
    parsed.push({
      ticketNumber: item.ticketNumber,
      outcome: item.outcome,
      ...item.stage === void 0 ? {} : { stage: item.stage },
      ...item.reasonCode === void 0 ? {} : { reasonCode: item.reasonCode }
    });
  }
  return parsed;
}
__name(parseTicketOutcomes, "parseTicketOutcomes");
function safeDiagnosticMessage(value) {
  if (value === void 0) return void 0;
  if (typeof value !== "string") return null;
  let message = value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (message.length === 0) return void 0;
  message = message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/((?:token|secret|password|api[_-]?key|authorization|cookie)\s*[:=]\s*)\S+/gi, "$1[redacted]").replace(/https?:\/\/\S+/gi, "[redacted-url]").replace(/[A-Za-z]:\\[^\s)\"']+/g, "[redacted-path]").replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]");
  return message.length > 512 ? `${message.slice(0, 512)}...` : message;
}
__name(safeDiagnosticMessage, "safeDiagnosticMessage");
function parseFailureDiagnostic(value) {
  if (!isRecord2(value) || !keysAreBounded(value, [
    "stage",
    "errorType",
    "errorCode",
    "httpStatus",
    "message",
    "requestIndex",
    "operationName",
    "itemKey"
  ])) return null;
  const stage = value.stage === void 0 ? void 0 : typeof value.stage === "string" && SAFE_DIAGNOSTIC_STAGE_PATTERN.test(value.stage) ? value.stage : null;
  const errorType = safeReference(value.errorType);
  const errorCode = safeReference(value.errorCode);
  const httpStatus = boundedInteger(value.httpStatus, 100, 599);
  const requestIndex = boundedInteger(value.requestIndex, 1, 1e3);
  const message = safeDiagnosticMessage(value.message);
  const operationName = safeReference(value.operationName, SAFE_OPERATION_NAME_PATTERN);
  const itemKey = safeReference(value.itemKey, SAFE_ITEM_KEY_PATTERN);
  if (stage === null || errorType === null || errorCode === null || httpStatus === null || requestIndex === null || message === null || operationName === null || itemKey === null) {
    return null;
  }
  return {
    ...stage === void 0 ? {} : { stage },
    ...errorType === void 0 ? {} : { errorType },
    ...errorCode === void 0 ? {} : { errorCode },
    ...httpStatus === void 0 ? {} : { httpStatus },
    ...message === void 0 ? {} : { message },
    ...requestIndex === void 0 ? {} : { requestIndex },
    ...operationName === void 0 ? {} : { operationName },
    ...itemKey === void 0 ? {} : { itemKey }
  };
}
__name(parseFailureDiagnostic, "parseFailureDiagnostic");
function parseSafeFailureDiagnostics(value) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value) || value.length > 32) return null;
  const diagnostics = [];
  for (const item of value) {
    const parsed = parseFailureDiagnostic(item);
    if (parsed === null) return null;
    diagnostics.push(parsed);
  }
  return diagnostics;
}
__name(parseSafeFailureDiagnostics, "parseSafeFailureDiagnostics");
function parseMcpRequestTrace(value) {
  if (!isRecord2(value) || !keysAreBounded(value, [
    "index",
    "type",
    "operationType",
    "operationName",
    "itemKey",
    "status",
    "retryCount",
    "durationMs",
    "ok"
  ])) return null;
  const index = boundedInteger(value.index, 1, 1e3);
  if (index === void 0 || index === null) return null;
  if (typeof value.type !== "string" || !MCP_REQUEST_TYPES.has(value.type)) return null;
  const operationType = value.operationType === void 0 ? void 0 : typeof value.operationType === "string" && MCP_OPERATION_TYPES.has(value.operationType) ? value.operationType : null;
  if (operationType === null) return null;
  const operationName = safeReference(value.operationName, SAFE_OPERATION_NAME_PATTERN);
  const itemKey = safeReference(value.itemKey, SAFE_ITEM_KEY_PATTERN);
  if (operationName === null || itemKey === null) return null;
  const status = value.status === void 0 ? void 0 : typeof value.status === "number" && Number.isInteger(value.status) && value.status >= 100 && value.status <= 599 ? value.status : typeof value.status === "string" && MCP_STATUSES.has(value.status) ? value.status : null;
  if (status === null) return null;
  const retryCount = boundedInteger(value.retryCount, 0, 100);
  const durationMs = boundedInteger(value.durationMs, 0, 864e5);
  if (retryCount === null || durationMs === null) return null;
  if (value.ok !== void 0 && typeof value.ok !== "boolean") return null;
  return {
    index,
    type: value.type,
    ...operationType === void 0 ? {} : { operationType },
    ...operationName === void 0 ? {} : { operationName },
    ...itemKey === void 0 ? {} : { itemKey },
    ...status === void 0 ? {} : { status },
    ...retryCount === void 0 ? {} : { retryCount },
    ...durationMs === void 0 ? {} : { durationMs },
    ...value.ok === void 0 ? {} : { ok: value.ok }
  };
}
__name(parseMcpRequestTrace, "parseMcpRequestTrace");
function parseMcpRetryTrace(value) {
  if (!isRecord2(value) || !keysAreBounded(value, [
    "attempt",
    "source",
    "retryAfterSupplied",
    "suppliedDelayMs",
    "parsedDelayMs",
    "cappedDelayMs",
    "actualDelayMs",
    "operationName",
    "itemKey"
  ])) return null;
  const attempt = boundedInteger(value.attempt, 1, 100);
  const parsedDelayMs = boundedInteger(value.parsedDelayMs, 0, 864e5);
  const cappedDelayMs = boundedInteger(value.cappedDelayMs, 0, 864e5);
  const actualDelayMs = boundedInteger(value.actualDelayMs, 0, 864e5);
  if (attempt === void 0 || attempt === null || parsedDelayMs === void 0 || parsedDelayMs === null || cappedDelayMs === void 0 || cappedDelayMs === null || actualDelayMs === void 0 || actualDelayMs === null || typeof value.source !== "string" || !RETRY_SOURCES.has(value.source) || typeof value.retryAfterSupplied !== "boolean") return null;
  const suppliedDelayMs = boundedInteger(value.suppliedDelayMs, 0, 864e5);
  if (suppliedDelayMs === null) return null;
  const operationName = safeReference(value.operationName, SAFE_OPERATION_NAME_PATTERN);
  const itemKey = safeReference(value.itemKey, SAFE_ITEM_KEY_PATTERN);
  if (operationName === null || itemKey === null) return null;
  return {
    attempt,
    source: value.source,
    retryAfterSupplied: value.retryAfterSupplied,
    ...suppliedDelayMs === void 0 ? {} : { suppliedDelayMs },
    parsedDelayMs,
    cappedDelayMs,
    actualDelayMs,
    ...operationName === void 0 ? {} : { operationName },
    ...itemKey === void 0 ? {} : { itemKey }
  };
}
__name(parseMcpRetryTrace, "parseMcpRetryTrace");
function parseSafeTicketOutcomes(value) {
  return parseTicketOutcomes(value);
}
__name(parseSafeTicketOutcomes, "parseSafeTicketOutcomes");
function parseSafeMcpExecution(value) {
  if (value === void 0) return void 0;
  if (!isRecord2(value) || !keysAreBounded(value, [
    "executionTraceId",
    "invocationId",
    "operationId",
    "toolName",
    "durationMs",
    "subrequestsUsed",
    "subrequestBudget",
    "subrequestSafetyMargin",
    "retryCount",
    "requestTrace",
    "requestTraceTruncated",
    "requestsByType",
    "retryTrace",
    "failureDiagnostics"
  ])) return null;
  const executionTraceId = safeReference(value.executionTraceId);
  const invocationId = safeReference(value.invocationId);
  const operationId = safeReference(value.operationId);
  const toolName = safeReference(value.toolName, /^superops_[A-Za-z0-9_]{1,96}$/);
  if (executionTraceId === null || invocationId === null || operationId === null || toolName === null) return null;
  const durationMs = boundedInteger(value.durationMs, 0, 864e5);
  const subrequestsUsed = boundedInteger(value.subrequestsUsed, 0, 1e3);
  const subrequestBudget = boundedInteger(value.subrequestBudget, 0, 1e3);
  const subrequestSafetyMargin = boundedInteger(value.subrequestSafetyMargin, 0, 1e3);
  const retryCount = boundedInteger(value.retryCount, 0, 1e3);
  if (durationMs === null || subrequestsUsed === null || subrequestBudget === null || subrequestSafetyMargin === null || retryCount === null) return null;
  let requestTrace;
  if (value.requestTrace !== void 0) {
    if (!Array.isArray(value.requestTrace) || value.requestTrace.length > 128) return null;
    requestTrace = [];
    const seenIndexes = /* @__PURE__ */ new Set();
    for (const item of value.requestTrace) {
      const parsed = parseMcpRequestTrace(item);
      if (parsed === null || seenIndexes.has(parsed.index)) return null;
      seenIndexes.add(parsed.index);
      requestTrace.push(parsed);
    }
  }
  if (value.requestTraceTruncated !== void 0 && typeof value.requestTraceTruncated !== "boolean") return null;
  let requestsByType;
  if (value.requestsByType !== void 0) {
    if (!isRecord2(value.requestsByType)) return null;
    requestsByType = {};
    for (const [key, countValue] of Object.entries(value.requestsByType)) {
      if (!MCP_REQUEST_TYPES.has(key)) return null;
      const count = boundedInteger(countValue, 0, 1e3);
      if (count === void 0 || count === null) return null;
      requestsByType[key] = count;
    }
  }
  let retryTrace;
  if (value.retryTrace !== void 0) {
    if (!Array.isArray(value.retryTrace) || value.retryTrace.length > 128) return null;
    retryTrace = [];
    for (const item of value.retryTrace) {
      const parsed = parseMcpRetryTrace(item);
      if (parsed === null) return null;
      retryTrace.push(parsed);
    }
  }
  const failureDiagnostics = parseSafeFailureDiagnostics(value.failureDiagnostics);
  if (failureDiagnostics === null) return null;
  return {
    ...executionTraceId === void 0 ? {} : { executionTraceId },
    ...invocationId === void 0 ? {} : { invocationId },
    ...operationId === void 0 ? {} : { operationId },
    ...toolName === void 0 ? {} : { toolName },
    ...durationMs === void 0 ? {} : { durationMs },
    ...subrequestsUsed === void 0 ? {} : { subrequestsUsed },
    ...subrequestBudget === void 0 ? {} : { subrequestBudget },
    ...subrequestSafetyMargin === void 0 ? {} : { subrequestSafetyMargin },
    ...retryCount === void 0 ? {} : { retryCount },
    ...requestTrace === void 0 ? {} : { requestTrace },
    ...value.requestTraceTruncated === void 0 ? {} : { requestTraceTruncated: value.requestTraceTruncated },
    ...requestsByType === void 0 ? {} : { requestsByType },
    ...retryTrace === void 0 ? {} : { retryTrace },
    ...failureDiagnostics === void 0 ? {} : { failureDiagnostics }
  };
}
__name(parseSafeMcpExecution, "parseSafeMcpExecution");

// src/state.ts
var SEEN_NOTIFICATION_TTL_MS = 24 * 60 * 60 * 1e3;
var MAX_SEEN_NOTIFICATIONS = 500;
var MAX_DISPATCH_HISTORY = 96;
var MAX_NEEDS_ATTENTION_SCOPES = 96;
var MAX_AGENT_STATUS_POLL_COUNT = 1e3;
var MAX_AGENT_TIMING_MS = 864e5;
var DISPATCH_HISTORY_EVENTS = /* @__PURE__ */ new Set([
  "notification_accepted",
  "notification_queued",
  "notification_batch_processed",
  "dispatch_started",
  "agent_trigger_failed",
  "retry_scheduled",
  "active_run_wait",
  "stale_run_recovered",
  "agent_accepted",
  "agent_run_status_checked",
  "result_callback_received",
  "batch_completed",
  "batch_failed",
  "orphan_recovered",
  "reconciliation_parked",
  "reconciliation_released",
  "subscription_maintenance_completed",
  "subscription_maintenance_failed",
  "graph_sweep_completed",
  "graph_sweep_failed",
  "alarm_started",
  "alarm_completed",
  "alarm_failed",
  "maintenance_started",
  "maintenance_completed",
  "maintenance_failed"
]);
var DISPATCH_HISTORY_WAIT_REASONS = /* @__PURE__ */ new Set([
  "active_agent_run",
  "unavailable_retry",
  "reconciliation_hold",
  "result_watchdog",
  "transport_retry",
  "callback_retry",
  "bounded_recovery",
  "cooldown"
]);
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isRecord3, "isRecord");
function isDispatchHistoryEvent(value) {
  return typeof value === "string" && DISPATCH_HISTORY_EVENTS.has(value);
}
__name(isDispatchHistoryEvent, "isDispatchHistoryEvent");
function isDispatchHistoryWaitReason(value) {
  return typeof value === "string" && DISPATCH_HISTORY_WAIT_REASONS.has(value);
}
__name(isDispatchHistoryWaitReason, "isDispatchHistoryWaitReason");
function isScopeMode(value) {
  return value === "new-email-tickets" || value === "full-new-calls";
}
__name(isScopeMode, "isScopeMode");
function isFailureKind(value) {
  return value === "configuration" || value === "authentication" || value === "transient" || value === "ambiguous" || value === "permanent" || value === "subscription";
}
__name(isFailureKind, "isFailureKind");
function isResultStatus(value) {
  return value === "complete" || value === "retryable_rate_limit" || value === "terminal_failure";
}
__name(isResultStatus, "isResultStatus");
function isAgentRunStatus(value) {
  return value === "queued" || value === "in_progress" || value === "suspended" || value === "completed" || value === "failed" || value === "unavailable";
}
__name(isAgentRunStatus, "isAgentRunStatus");
function isDispatchHistorySource(value) {
  return value === "cloudflare_alarm" || value === "cron_maintenance";
}
__name(isDispatchHistorySource, "isDispatchHistorySource");
function isPendingDispatchWaitReason(value) {
  return value === "active_agent_run" || value === "unavailable_retry" || value === "reconciliation_hold";
}
__name(isPendingDispatchWaitReason, "isPendingDispatchWaitReason");
var DISPATCH_HISTORY_PHASE_STATUSES = /* @__PURE__ */ new Set([
  "disabled",
  "not_configured",
  "updated",
  "failed",
  "idle",
  "complete",
  "cooldown",
  "accepted",
  "awaiting_result",
  "result_overdue",
  "retry_scheduled",
  "authentication_required",
  "configuration",
  "permanent_failure"
]);
function safeReference2(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : void 0;
}
__name(safeReference2, "safeReference");
function boundedInteger2(value, minimum = 0, maximum = 1e9) {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum ? value : void 0;
}
__name(boundedInteger2, "boundedInteger");
function epochMilliseconds(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 9999999999999 ? value : null;
}
__name(epochMilliseconds, "epochMilliseconds");
function safeHistoryTimestamp(value) {
  if (typeof value !== "string" || value.length > 64) return void 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : void 0;
}
__name(safeHistoryTimestamp, "safeHistoryTimestamp");
function normalizedUnavailableRetryWindow(value) {
  if (!isRecord3(value) || !isRecord3(value.scope) || value.scope.mode !== "new-email-tickets" || value.scope.source !== "EMAIL") {
    return null;
  }
  const createdFrom = safeHistoryTimestamp(value.scope.createdFrom);
  const createdTo = safeHistoryTimestamp(value.scope.createdTo);
  const notificationWindowStartedAt = epochMilliseconds(value.notificationWindowStartedAt);
  const notificationWindowEndedAt = epochMilliseconds(value.notificationWindowEndedAt);
  const retryCount = boundedInteger2(value.retryCount, 1);
  const dueAt = epochMilliseconds(value.dueAt);
  if (createdFrom === void 0 || createdTo === void 0 || notificationWindowStartedAt === null || notificationWindowEndedAt === null || retryCount === void 0 || dueAt === null) {
    return null;
  }
  return {
    scope: { mode: "new-email-tickets", createdFrom, createdTo, source: "EMAIL" },
    notificationWindowStartedAt,
    notificationWindowEndedAt,
    notificationLookbackMs: epochMilliseconds(value.notificationLookbackMs),
    lastNotificationAt: epochMilliseconds(value.lastNotificationAt),
    debounceWindowStartedAt: epochMilliseconds(value.debounceWindowStartedAt),
    retryCount,
    dueAt
  };
}
__name(normalizedUnavailableRetryWindow, "normalizedUnavailableRetryWindow");
function normalizedReconciliationHold(value) {
  if (!isRecord3(value) || !isRecord3(value.scope) || value.scope.mode !== "new-email-tickets" || value.scope.source !== "EMAIL") return null;
  const triggerId = safeReference2(value.triggerId);
  const createdFrom = safeHistoryTimestamp(value.scope.createdFrom);
  const createdTo = safeHistoryTimestamp(value.scope.createdTo);
  const notificationWindowStartedAt = epochMilliseconds(value.notificationWindowStartedAt);
  const notificationWindowEndedAt = epochMilliseconds(value.notificationWindowEndedAt);
  const notificationLookbackMs = epochMilliseconds(value.notificationLookbackMs);
  const lastNotificationAt = epochMilliseconds(value.lastNotificationAt);
  const debounceWindowStartedAt = epochMilliseconds(value.debounceWindowStartedAt);
  const retryCount = boundedInteger2(value.retryCount);
  const dispatchAttempt = boundedInteger2(value.dispatchAttempt);
  const dueAt = epochMilliseconds(value.dueAt);
  if (triggerId === void 0 || createdFrom === void 0 || createdTo === void 0 || notificationWindowStartedAt === null || notificationWindowEndedAt === null || retryCount === void 0 || dispatchAttempt === void 0 || dueAt === null) return null;
  return {
    triggerId,
    scope: { mode: "new-email-tickets", createdFrom, createdTo, source: "EMAIL" },
    notificationWindowStartedAt,
    notificationWindowEndedAt,
    notificationLookbackMs,
    lastNotificationAt,
    debounceWindowStartedAt,
    retryCount,
    dispatchAttempt,
    dueAt
  };
}
__name(normalizedReconciliationHold, "normalizedReconciliationHold");
function normalizedAttentionBlockedWindow(value) {
  if (!isRecord3(value)) return null;
  const notificationWindowStartedAt = epochMilliseconds(value.notificationWindowStartedAt);
  if (notificationWindowStartedAt === null) return null;
  const reason = value.reason === "new_message" || value.reason === "lifecycle" || value.reason === null ? value.reason : null;
  const lastLifecycleEvent = value.lastLifecycleEvent === "missed" || value.lastLifecycleEvent === "subscriptionRemoved" || value.lastLifecycleEvent === "reauthorizationRequired" ? value.lastLifecycleEvent : null;
  return {
    reason,
    notificationWindowStartedAt,
    notificationWindowEndedAt: epochMilliseconds(value.notificationWindowEndedAt),
    notificationLookbackMs: epochMilliseconds(value.notificationLookbackMs),
    lastNotificationAt: epochMilliseconds(value.lastNotificationAt),
    debounceWindowStartedAt: epochMilliseconds(value.debounceWindowStartedAt),
    unavailableRetryCount: boundedInteger2(value.unavailableRetryCount) ?? 0,
    lifecycleRecoveryRequested: value.lifecycleRecoveryRequested === true,
    lastLifecycleEvent
  };
}
__name(normalizedAttentionBlockedWindow, "normalizedAttentionBlockedWindow");
function normalizedTriageRunScope(value) {
  if (!isRecord3(value)) return null;
  if (value.mode === "new-email-tickets" && value.source === "EMAIL") {
    const createdFrom = safeHistoryTimestamp(value.createdFrom);
    const createdTo = safeHistoryTimestamp(value.createdTo);
    if (createdFrom === void 0 || createdTo === void 0 || Date.parse(createdFrom) >= Date.parse(createdTo)) {
      return null;
    }
    return { mode: "new-email-tickets", createdFrom, createdTo, source: "EMAIL" };
  }
  if (value.mode === "full-new-calls" && (value.reason === "configured" || value.reason === "lifecycle-recovery")) {
    return { mode: "full-new-calls", reason: value.reason };
  }
  return null;
}
__name(normalizedTriageRunScope, "normalizedTriageRunScope");
function triageScopesEqual(left, right) {
  return left.mode === right.mode && (left.mode === "new-email-tickets" && right.mode === "new-email-tickets" ? left.createdFrom === right.createdFrom && left.createdTo === right.createdTo && left.source === right.source : left.mode === "full-new-calls" && right.mode === "full-new-calls" && left.reason === right.reason);
}
__name(triageScopesEqual, "triageScopesEqual");
function normalizedNeedsAttentionScopes(value, legacyScope) {
  const scopes = [];
  const add = /* @__PURE__ */ __name((scope) => {
    if (scope !== null && !scopes.some((existing) => triageScopesEqual(existing, scope))) {
      scopes.push(scope);
    }
  }, "add");
  if (Array.isArray(value)) {
    for (const item of value) add(normalizedTriageRunScope(item));
  }
  add(legacyScope);
  return scopes.slice(-MAX_NEEDS_ATTENTION_SCOPES);
}
__name(normalizedNeedsAttentionScopes, "normalizedNeedsAttentionScopes");
function normalizedHistoryEntry(value) {
  const at = isRecord3(value) ? safeHistoryTimestamp(value.at) : void 0;
  if (!isRecord3(value) || at === void 0 || !isDispatchHistoryEvent(value.event)) return null;
  const scopeMode = value.scopeMode === null || value.scopeMode === void 0 ? null : isScopeMode(value.scopeMode) ? value.scopeMode : null;
  const scopeCreatedFrom = safeHistoryTimestamp(value.scopeCreatedFrom);
  const scopeCreatedTo = safeHistoryTimestamp(value.scopeCreatedTo);
  const eventId = boundedInteger2(value.eventId, 1);
  const entry = {
    eventId: eventId ?? 0,
    at,
    batchSequence: value.batchSequence === null || value.batchSequence === void 0 ? null : boundedInteger2(value.batchSequence) ?? null,
    event: value.event,
    scopeMode
  };
  const attempt = boundedInteger2(value.attempt, 1);
  const retryCount = boundedInteger2(value.retryCount);
  const httpStatus = boundedInteger2(value.httpStatus, 100, 599);
  const failureKind = isFailureKind(value.failureKind) ? value.failureKind : void 0;
  const errorType = typeof value.errorType === "string" && value.errorType.length <= 128 ? value.errorType : void 0;
  const errorCode = typeof value.errorCode === "string" && value.errorCode.length <= 128 ? value.errorCode : void 0;
  const retryAfterSeconds = boundedInteger2(value.retryAfterSeconds, 0, 86400);
  const upstreamRequestId = safeReference2(value.upstreamRequestId);
  const nextAt = safeHistoryTimestamp(value.nextAt);
  const waitMs = boundedInteger2(value.waitMs);
  const waitReason = isDispatchHistoryWaitReason(value.waitReason) ? value.waitReason : void 0;
  const agentRunStatus = isAgentRunStatus(value.agentRunStatus) ? value.agentRunStatus : void 0;
  const agentRunIdPresent = typeof value.agentRunIdPresent === "boolean" ? value.agentRunIdPresent : void 0;
  const agentStatusPollCount2 = boundedInteger2(value.agentStatusPollCount, 0, MAX_AGENT_STATUS_POLL_COUNT);
  const agentStatusPollDurationMs = boundedInteger2(value.agentStatusPollDurationMs, 0, MAX_AGENT_TIMING_MS);
  const agentAcceptedToCallbackMs = boundedInteger2(value.agentAcceptedToCallbackMs, 0, MAX_AGENT_TIMING_MS);
  const resultStatus = isResultStatus(value.resultStatus) ? value.resultStatus : void 0;
  const failureStage = value.failureStage === "bounded_query" || value.failureStage === "evidence_recovery" || value.failureStage === "triage_apply" || value.failureStage === "operation_continuation" || value.failureStage === "configuration" ? value.failureStage : void 0;
  const ticketsConsidered = boundedInteger2(value.ticketsConsidered);
  const ticketsCompleted = boundedInteger2(value.ticketsCompleted);
  const ticketsDeferred = boundedInteger2(value.ticketsDeferred);
  const superopsAttempts = boundedInteger2(value.superopsAttempts);
  const superopsRetries = boundedInteger2(value.superopsRetries);
  const runDurationMs = boundedInteger2(value.runDurationMs);
  const notificationCount = boundedInteger2(value.notificationCount, 1);
  const discoveredCount = boundedInteger2(value.discoveredCount);
  const acceptedCount = boundedInteger2(value.acceptedCount);
  const duplicateCount = boundedInteger2(value.duplicateCount);
  const rejectedCount = boundedInteger2(value.rejectedCount);
  const partial = typeof value.partial === "boolean" ? value.partial : void 0;
  const scheduledAt = safeHistoryTimestamp(value.scheduledAt);
  const alarmLatenessMs = boundedInteger2(value.alarmLatenessMs);
  const durationMs = boundedInteger2(value.durationMs);
  const source = isDispatchHistorySource(value.source) ? value.source : void 0;
  const phaseStatus = typeof value.phaseStatus === "string" && DISPATCH_HISTORY_PHASE_STATUSES.has(value.phaseStatus) ? value.phaseStatus : void 0;
  const subscriptionExpirationAt = safeHistoryTimestamp(value.subscriptionExpirationAt);
  const operationId = safeReference2(value.operationId);
  const resultReference = safeReference2(value.resultReference);
  const operationStatus = parseSafeOperationStatus(value.operationStatus);
  const ticketOutcomes = parseSafeTicketOutcomes(value.ticketOutcomes);
  const failureDiagnostics = parseSafeFailureDiagnostics(value.failureDiagnostics);
  const mcpExecution = parseSafeMcpExecution(value.mcpExecution);
  Object.assign(entry, {
    ...attempt === void 0 ? {} : { attempt },
    ...retryCount === void 0 ? {} : { retryCount },
    ...httpStatus === void 0 ? {} : { httpStatus },
    ...failureKind === void 0 ? {} : { failureKind },
    ...errorType === void 0 ? {} : { errorType },
    ...errorCode === void 0 ? {} : { errorCode },
    ...retryAfterSeconds === void 0 ? {} : { retryAfterSeconds },
    ...upstreamRequestId === void 0 ? {} : { upstreamRequestId },
    ...nextAt === void 0 ? {} : { nextAt },
    ...waitMs === void 0 ? {} : { waitMs },
    ...waitReason === void 0 ? {} : { waitReason },
    ...agentRunStatus === void 0 ? {} : { agentRunStatus },
    ...agentRunIdPresent === void 0 ? {} : { agentRunIdPresent },
    ...agentStatusPollCount2 === void 0 ? {} : { agentStatusPollCount: agentStatusPollCount2 },
    ...agentStatusPollDurationMs === void 0 ? {} : { agentStatusPollDurationMs },
    ...agentAcceptedToCallbackMs === void 0 ? {} : { agentAcceptedToCallbackMs },
    ...resultStatus === void 0 ? {} : { resultStatus },
    ...failureStage === void 0 ? {} : { failureStage },
    ...ticketsConsidered === void 0 ? {} : { ticketsConsidered },
    ...ticketsCompleted === void 0 ? {} : { ticketsCompleted },
    ...ticketsDeferred === void 0 ? {} : { ticketsDeferred },
    ...superopsAttempts === void 0 ? {} : { superopsAttempts },
    ...superopsRetries === void 0 ? {} : { superopsRetries },
    ...runDurationMs === void 0 ? {} : { runDurationMs },
    ...notificationCount === void 0 ? {} : { notificationCount },
    ...discoveredCount === void 0 ? {} : { discoveredCount },
    ...acceptedCount === void 0 ? {} : { acceptedCount },
    ...duplicateCount === void 0 ? {} : { duplicateCount },
    ...rejectedCount === void 0 ? {} : { rejectedCount },
    ...partial === void 0 ? {} : { partial },
    ...scheduledAt === void 0 ? {} : { scheduledAt },
    ...alarmLatenessMs === void 0 ? {} : { alarmLatenessMs },
    ...durationMs === void 0 ? {} : { durationMs },
    ...source === void 0 ? {} : { source },
    ...phaseStatus === void 0 ? {} : { phaseStatus },
    ...subscriptionExpirationAt === void 0 ? {} : { subscriptionExpirationAt },
    ...operationId === void 0 ? {} : { operationId },
    ...resultReference === void 0 ? {} : { resultReference },
    ...operationStatus === void 0 || operationStatus === null ? {} : { operationStatus },
    ...scopeCreatedFrom === void 0 ? {} : { scopeCreatedFrom },
    ...scopeCreatedTo === void 0 ? {} : { scopeCreatedTo },
    ...ticketOutcomes === void 0 || ticketOutcomes === null ? {} : { ticketOutcomes },
    ...failureDiagnostics === void 0 || failureDiagnostics === null ? {} : { failureDiagnostics },
    ...mcpExecution === void 0 || mcpExecution === null ? {} : { mcpExecution }
  });
  return entry;
}
__name(normalizedHistoryEntry, "normalizedHistoryEntry");
function createInitialState() {
  return {
    seenNotificationFingerprints: [],
    debounceWindowStartedAt: null,
    dueAt: null,
    lastNotificationAt: null,
    pending: false,
    pendingReason: null,
    pendingTriggerId: null,
    pendingNotificationWindowStartedAt: null,
    pendingNotificationWindowEndedAt: null,
    pendingNotificationLookbackMs: null,
    pendingTriggerScope: null,
    pendingDispatchWasQueued: false,
    pendingDispatchWaitReason: null,
    executionPhase: null,
    dispatchAttempt: 0,
    resultDeadlineAt: null,
    triggerSequence: 0,
    cooldownUntil: 0,
    retryCount: 0,
    emptyTargetedRecoveryPending: false,
    lifecycleRecoveryRequested: false,
    lastLifecycleEvent: null,
    lastAcceptedTrigger: null,
    lastResultReport: null,
    lastFailure: null,
    dispatchHistorySequence: 0,
    dispatchHistory: [],
    lastHistoryPrunedAt: null,
    subscription: null,
    lastNotificationBatchAt: null,
    lastAcceptedNotificationAt: null,
    lastRejectedNotificationAt: null,
    lastDuplicateNotificationAt: null,
    acceptedNotificationCount: 0,
    rejectedNotificationCount: 0,
    duplicateNotificationCount: 0,
    lastGraphSweepAt: null,
    lastGraphSweepMessageCount: 0,
    lastGraphSweepErrorAt: null,
    pendingTicketOutcomes: null,
    acceptedRunLeaseUnknown: false,
    queuedPending: false,
    queuedReason: null,
    queuedNotificationWindowStartedAt: null,
    queuedNotificationWindowEndedAt: null,
    queuedNotificationLookbackMs: null,
    queuedLastNotificationAt: null,
    queuedDebounceWindowStartedAt: null,
    queuedDueAt: null,
    queuedUnavailableRetryCount: 0,
    unavailableRetryWindow: null,
    queuedLifecycleRecoveryRequested: false,
    queuedLastLifecycleEvent: null,
    needsAttentionScope: null,
    needsAttentionScopes: [],
    candidateAttentionFenceActive: false,
    needsAttentionAt: null,
    needsAttentionRetryCount: 0,
    needsAttentionCount: 0,
    reconciliationHold: null,
    sharedRateLimitUntil: null,
    queuedBlockedByAttention: false,
    attentionBlockedWindow: null
  };
}
__name(createInitialState, "createInitialState");
function normalizeState(value) {
  const initial = createInitialState();
  const legacyNeedsAttentionScope = normalizedTriageRunScope(value?.needsAttentionScope);
  const needsAttentionScopes = normalizedNeedsAttentionScopes(
    value?.needsAttentionScopes,
    legacyNeedsAttentionScope
  );
  const persistedHistory = Array.isArray(value?.dispatchHistory) ? value.dispatchHistory.map(normalizedHistoryEntry).filter((entry) => entry !== null).slice(-MAX_DISPATCH_HISTORY) : initial.dispatchHistory;
  let dispatchHistorySequence = boundedInteger2(value?.dispatchHistorySequence) ?? 0;
  const usedEventIds = /* @__PURE__ */ new Set();
  const dispatchHistory = persistedHistory.map((entry) => {
    let eventId = entry.eventId;
    if (eventId <= 0 || usedEventIds.has(eventId)) {
      dispatchHistorySequence = Math.min(1e9, dispatchHistorySequence + 1);
      eventId = dispatchHistorySequence;
    } else {
      dispatchHistorySequence = Math.max(dispatchHistorySequence, eventId);
    }
    usedEventIds.add(eventId);
    return eventId === entry.eventId ? entry : { ...entry, eventId };
  });
  const normalized = {
    ...initial,
    ...value,
    emptyTargetedRecoveryPending: value?.emptyTargetedRecoveryPending === true,
    seenNotificationFingerprints: Array.isArray(value?.seenNotificationFingerprints) ? value.seenNotificationFingerprints : initial.seenNotificationFingerprints,
    pendingDispatchWasQueued: value?.pendingDispatchWasQueued === true,
    pendingDispatchWaitReason: isPendingDispatchWaitReason(value?.pendingDispatchWaitReason) ? value.pendingDispatchWaitReason : value?.pendingDispatchWasQueued === true ? "active_agent_run" : null,
    queuedUnavailableRetryCount: boundedInteger2(value?.queuedUnavailableRetryCount) ?? 0,
    unavailableRetryWindow: normalizedUnavailableRetryWindow(value?.unavailableRetryWindow),
    needsAttentionScope: legacyNeedsAttentionScope ?? needsAttentionScopes.at(-1) ?? null,
    needsAttentionScopes,
    candidateAttentionFenceActive: value?.candidateAttentionFenceActive === true,
    needsAttentionAt: epochMilliseconds(value?.needsAttentionAt),
    needsAttentionRetryCount: boundedInteger2(value?.needsAttentionRetryCount) ?? 0,
    needsAttentionCount: boundedInteger2(value?.needsAttentionCount) ?? 0,
    reconciliationHold: normalizedReconciliationHold(value?.reconciliationHold),
    sharedRateLimitUntil: epochMilliseconds(value?.sharedRateLimitUntil),
    queuedBlockedByAttention: value?.queuedBlockedByAttention === true,
    pendingTicketOutcomes: parseSafeTicketOutcomes(value?.pendingTicketOutcomes) ?? null,
    dispatchHistorySequence,
    dispatchHistory,
    lastHistoryPrunedAt: epochMilliseconds(value?.lastHistoryPrunedAt),
    acceptedRunLeaseUnknown: value?.acceptedRunLeaseUnknown === true,
    attentionBlockedWindow: normalizedAttentionBlockedWindow(value?.attentionBlockedWindow)
  };
  if (normalized.pending && normalized.executionPhase === null) {
    normalized.executionPhase = "pending_dispatch";
  }
  if (!normalized.pending) {
    normalized.executionPhase = null;
    normalized.resultDeadlineAt = null;
    normalized.acceptedRunLeaseUnknown = false;
  } else if (normalized.acceptedRunLeaseUnknown && (normalized.executionPhase !== "awaiting_result" || typeof normalized.lastAcceptedTrigger?.runId === "string")) {
    normalized.acceptedRunLeaseUnknown = false;
  }
  return normalized;
}
__name(normalizeState, "normalizeState");
function appendDispatchHistory(state, entry, now) {
  state.dispatchHistorySequence = Math.min(1e9, state.dispatchHistorySequence + 1);
  state.dispatchHistory.push({
    eventId: state.dispatchHistorySequence,
    ...entry,
    at: new Date(now).toISOString()
  });
  if (state.dispatchHistory.length > MAX_DISPATCH_HISTORY) {
    state.dispatchHistory.splice(0, state.dispatchHistory.length - MAX_DISPATCH_HISTORY);
  }
}
__name(appendDispatchHistory, "appendDispatchHistory");
function isObject(value) {
  return typeof value === "object" && value !== null;
}
__name(isObject, "isObject");
function asNotification(value) {
  if (!isObject(value)) return null;
  const resourceData = isObject(value.resourceData) ? { id: typeof value.resourceData.id === "string" ? value.resourceData.id : void 0 } : void 0;
  return {
    id: typeof value.id === "string" ? value.id : void 0,
    subscriptionId: typeof value.subscriptionId === "string" ? value.subscriptionId : void 0,
    clientState: typeof value.clientState === "string" ? value.clientState : void 0,
    changeType: typeof value.changeType === "string" ? value.changeType : void 0,
    lifecycleEvent: typeof value.lifecycleEvent === "string" ? value.lifecycleEvent : void 0,
    resource: typeof value.resource === "string" ? value.resource : void 0,
    subscriptionExpirationDateTime: typeof value.subscriptionExpirationDateTime === "string" ? value.subscriptionExpirationDateTime : void 0,
    resourceData
  };
}
__name(asNotification, "asNotification");
function selectNotificationCollection(value) {
  if (!isObject(value) || !Array.isArray(value.value)) return null;
  return {
    value: value.value.map(asNotification).filter((item) => item !== null)
  };
}
__name(selectNotificationCollection, "selectNotificationCollection");
function fnv1a(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
__name(fnv1a, "fnv1a");
function notificationFingerprint(notification, index) {
  const messageIdentity = notification.resourceData?.id ?? notification.resource ?? notification.id;
  const identity = [
    messageIdentity,
    notification.changeType,
    notification.lifecycleEvent
  ].filter(Boolean).join("");
  return fnv1a(identity || `empty-${index}`);
}
__name(notificationFingerprint, "notificationFingerprint");
function increment(value) {
  return Math.min(Number.MAX_SAFE_INTEGER, value + 1);
}
__name(increment, "increment");
function equalSecret(expected, actual) {
  if (!actual || expected.length !== actual.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  }
  return difference === 0;
}
__name(equalSecret, "equalSecret");
function cleanupSeen(state, now) {
  state.seenNotificationFingerprints = state.seenNotificationFingerprints.filter((item) => now - item.seenAt <= SEEN_NOTIFICATION_TTL_MS).slice(-MAX_SEEN_NOTIFICATIONS);
}
__name(cleanupSeen, "cleanupSeen");
function dispatchDelayMs(config) {
  return config.debounceMs + (config.fastTargetedModeEnabled ? config.fastIngestionGraceMs : 0);
}
__name(dispatchDelayMs, "dispatchDelayMs");
function maxDispatchDelayMs(config) {
  return config.maxDebounceMs + (config.fastTargetedModeEnabled ? config.fastIngestionGraceMs : 0);
}
__name(maxDispatchDelayMs, "maxDispatchDelayMs");
function notificationWindowDurationMs(config) {
  return config.debounceMs + config.cooldownMs + maxDispatchDelayMs(config);
}
__name(notificationWindowDurationMs, "notificationWindowDurationMs");
function nextPendingTriggerId(state) {
  state.triggerSequence += 1;
  return `triage-${state.triggerSequence}-${crypto.randomUUID()}`;
}
__name(nextPendingTriggerId, "nextPendingTriggerId");
function currentBatchIsFrozen(state) {
  return state.pending && (state.pendingTriggerScope !== null || state.pendingDispatchWasQueued === true || state.pendingDispatchWaitReason !== null) || state.unavailableRetryWindow !== null || state.reconciliationHold !== null || state.queuedBlockedByAttention && state.attentionBlockedWindow === null;
}
__name(currentBatchIsFrozen, "currentBatchIsFrozen");
function registerLifecycleEvent(state, event, config, now) {
  if (currentBatchIsFrozen(state)) {
    state.queuedPending = true;
    if (config.scopeMode !== "new-email-tickets" || state.queuedNotificationWindowStartedAt === null) {
      state.queuedReason = "lifecycle";
      state.queuedDueAt = now;
    }
    state.queuedLifecycleRecoveryRequested = true;
    state.queuedLastLifecycleEvent = event;
    return;
  }
  state.lifecycleRecoveryRequested = true;
  state.lastLifecycleEvent = event;
  state.pending = true;
  if (config.scopeMode !== "new-email-tickets" || state.pendingNotificationWindowStartedAt === null) {
    state.pendingReason = "lifecycle";
  }
  state.executionPhase = "pending_dispatch";
  if (state.pendingReason === "lifecycle") {
    state.debounceWindowStartedAt = null;
    state.dueAt = now;
  }
  state.pendingTriggerId ??= nextPendingTriggerId(state);
}
__name(registerLifecycleEvent, "registerLifecycleEvent");
function registerCreatedNotification(state, config, now, lookbackMs) {
  // Never consume a late notification in a window that cannot give its ticket
  // the configured ingestion grace. Preserve the first batch's bounded deadline
  // and retain overflow in the existing next-window queue instead.
  const exceedsIngestionDeadline = config.fastTargetedModeEnabled && state.pending &&
    state.debounceWindowStartedAt !== null &&
    now + dispatchDelayMs(config) > state.debounceWindowStartedAt + maxDispatchDelayMs(config);
  if (currentBatchIsFrozen(state) || exceedsIngestionDeadline || state.queuedPending && state.queuedUnavailableRetryCount > 0) {
    state.queuedPending = true;
    if (config.scopeMode === "new-email-tickets" || state.queuedReason !== "lifecycle") {
      state.queuedReason = "new_message";
    }
    state.queuedLastNotificationAt = now;
    state.queuedNotificationWindowStartedAt ??= now;
    state.queuedNotificationWindowEndedAt = Math.max(
      state.queuedNotificationWindowEndedAt ?? now,
      now + notificationWindowDurationMs(config)
    );
    state.queuedNotificationLookbackMs = Math.max(
      state.queuedNotificationLookbackMs ?? 0,
      lookbackMs
    );
    const windowStart2 = state.queuedDebounceWindowStartedAt ?? now;
    state.queuedDebounceWindowStartedAt ??= windowStart2;
    const newDueAt = now + dispatchDelayMs(config);
    state.queuedDueAt = Math.max(
      state.queuedDueAt ?? newDueAt,
      newDueAt
    );
    return;
  }
  state.lastNotificationAt = now;
  state.pending = true;
  if (config.scopeMode === "new-email-tickets" || state.pendingReason !== "lifecycle") {
    state.pendingReason = "new_message";
  }
  state.executionPhase = "pending_dispatch";
  state.pendingTriggerId ??= nextPendingTriggerId(state);
  state.pendingNotificationWindowStartedAt ??= now;
  state.pendingNotificationLookbackMs = Math.max(
    state.pendingNotificationLookbackMs ?? 0,
    lookbackMs
  );
  state.pendingNotificationWindowEndedAt ??= state.pendingNotificationWindowStartedAt + notificationWindowDurationMs(config);
  const windowStart = state.debounceWindowStartedAt ?? now;
  state.debounceWindowStartedAt ??= windowStart;
  if (state.pendingReason === "new_message") {
    state.dueAt = Math.min(
      windowStart + maxDispatchDelayMs(config),
      now + dispatchDelayMs(config)
    );
  }
}
__name(registerCreatedNotification, "registerCreatedNotification");
function registerNotifications(state, collection, expectedClientState, config, now, lookbackMs = config.newEmailLookbackMs) {
  cleanupSeen(state, now);
  if (collection.value.length > 0) state.lastNotificationBatchAt = now;
  let accepted = 0;
  let duplicates = 0;
  let rejected = 0;
  const lifecycleEvents = [];
  for (const [index, notification] of collection.value.entries()) {
    if (!expectedClientState || !equalSecret(expectedClientState, notification.clientState)) {
      rejected += 1;
      state.rejectedNotificationCount = increment(state.rejectedNotificationCount);
      state.lastRejectedNotificationAt = now;
      continue;
    }
    const fingerprint = notificationFingerprint(notification, index);
    if (state.seenNotificationFingerprints.some((item) => item.fingerprint === fingerprint)) {
      duplicates += 1;
      state.duplicateNotificationCount = increment(state.duplicateNotificationCount);
      state.lastDuplicateNotificationAt = now;
      continue;
    }
    state.seenNotificationFingerprints.push({ fingerprint, seenAt: now });
    if (notification.lifecycleEvent === "missed" || notification.lifecycleEvent === "subscriptionRemoved" || notification.lifecycleEvent === "reauthorizationRequired") {
      lifecycleEvents.push(notification.lifecycleEvent);
      registerLifecycleEvent(state, notification.lifecycleEvent, config, now);
      continue;
    }
    if (notification.changeType !== "created") {
      rejected += 1;
      state.rejectedNotificationCount = increment(state.rejectedNotificationCount);
      state.lastRejectedNotificationAt = now;
      continue;
    }
    accepted += 1;
    state.acceptedNotificationCount = increment(state.acceptedNotificationCount);
    state.lastAcceptedNotificationAt = now;
    registerCreatedNotification(state, config, now, lookbackMs);
  }
  cleanupSeen(state, now);
  return {
    accepted,
    duplicates,
    rejected,
    lifecycleEvents,
    scheduledAt: state.dueAt ?? state.queuedDueAt
  };
}
__name(registerNotifications, "registerNotifications");
function makeDueForDispatch(state, now) {
  if (state.dueAt === null || state.dueAt > now) return false;
  if (state.executionPhase === "awaiting_result") return false;
  state.dueAt = null;
  state.debounceWindowStartedAt = null;
  state.pending = true;
  state.executionPhase = "pending_dispatch";
  return true;
}
__name(makeDueForDispatch, "makeDueForDispatch");
function resetPendingDispatch(state) {
  state.debounceWindowStartedAt = null;
  state.dueAt = null;
  state.pending = false;
  state.pendingReason = null;
  state.pendingTriggerId = null;
  state.pendingNotificationWindowStartedAt = null;
  state.pendingNotificationWindowEndedAt = null;
  state.pendingNotificationLookbackMs = null;
  state.pendingTriggerScope = null;
  state.pendingDispatchWasQueued = false;
  state.pendingDispatchWaitReason = null;
  state.executionPhase = null;
  state.dispatchAttempt = 0;
  state.resultDeadlineAt = null;
  state.retryCount = 0;
  state.emptyTargetedRecoveryPending = false;
  state.pendingTicketOutcomes = null;
  state.acceptedRunLeaseUnknown = false;
}
__name(resetPendingDispatch, "resetPendingDispatch");
function resetQueuedDispatch(state) {
  state.queuedPending = state.attentionBlockedWindow !== null;
  state.queuedReason = null;
  state.queuedNotificationWindowStartedAt = null;
  state.queuedNotificationWindowEndedAt = null;
  state.queuedNotificationLookbackMs = null;
  state.queuedLastNotificationAt = null;
  state.queuedDebounceWindowStartedAt = null;
  state.queuedDueAt = null;
  state.queuedUnavailableRetryCount = 0;
  state.queuedLifecycleRecoveryRequested = false;
  state.queuedLastLifecycleEvent = null;
  state.queuedBlockedByAttention = state.attentionBlockedWindow !== null;
}
__name(resetQueuedDispatch, "resetQueuedDispatch");
function promoteQueuedDispatch(state, now, config) {
  if (!state.queuedPending || state.unavailableRetryWindow !== null || state.queuedBlockedByAttention && state.attentionBlockedWindow === null || state.sharedRateLimitUntil !== null && state.sharedRateLimitUntil > now) return false;
  const hasEmailWindow = state.queuedNotificationWindowStartedAt !== null;
  if (config.scopeMode === "new-email-tickets" && !hasEmailWindow) {
    state.lifecycleRecoveryRequested ||= state.queuedLifecycleRecoveryRequested;
    state.lastLifecycleEvent ??= state.queuedLastLifecycleEvent;
    resetQueuedDispatch(state);
    return false;
  }
  state.pending = true;
  state.pendingDispatchWasQueued = true;
  state.pendingDispatchWaitReason = "active_agent_run";
  state.pendingReason = config.scopeMode === "new-email-tickets" && hasEmailWindow ? "new_message" : state.queuedReason;
  state.pendingTriggerId = nextPendingTriggerId(state);
  state.pendingNotificationWindowStartedAt = state.queuedNotificationWindowStartedAt;
  state.pendingNotificationWindowEndedAt = state.queuedNotificationWindowEndedAt ?? (state.queuedNotificationWindowStartedAt === null ? null : state.queuedNotificationWindowStartedAt + notificationWindowDurationMs(config));
  state.pendingNotificationLookbackMs = state.queuedNotificationLookbackMs;
  state.lastNotificationAt = state.queuedLastNotificationAt;
  state.debounceWindowStartedAt = state.queuedDebounceWindowStartedAt;
  state.dueAt = Math.max(now, state.queuedDueAt ?? now);
  state.pendingTriggerScope = null;
  state.executionPhase = "pending_dispatch";
  state.dispatchAttempt = 0;
  state.resultDeadlineAt = null;
  state.retryCount = Math.min(config.resultMaxRetries, state.queuedUnavailableRetryCount);
  state.emptyTargetedRecoveryPending = false;
  state.lifecycleRecoveryRequested = state.queuedLifecycleRecoveryRequested;
  state.lastLifecycleEvent = state.queuedLastLifecycleEvent;
  resetQueuedDispatch(state);
  return true;
}
__name(promoteQueuedDispatch, "promoteQueuedDispatch");
function promoteUnavailableRetryDispatch(state, now, config) {
  const retry = state.unavailableRetryWindow;
  if (retry === null || retry.dueAt > now || state.sharedRateLimitUntil !== null && state.sharedRateLimitUntil > now) return false;
  state.pending = true;
  state.pendingDispatchWasQueued = true;
  state.pendingDispatchWaitReason = "unavailable_retry";
  state.pendingReason = "new_message";
  state.pendingTriggerId = nextPendingTriggerId(state);
  state.pendingNotificationWindowStartedAt = retry.notificationWindowStartedAt;
  state.pendingNotificationWindowEndedAt = retry.notificationWindowEndedAt;
  state.pendingNotificationLookbackMs = retry.notificationLookbackMs;
  state.lastNotificationAt = retry.lastNotificationAt;
  state.debounceWindowStartedAt = retry.debounceWindowStartedAt;
  state.dueAt = now;
  state.pendingTriggerScope = retry.scope;
  state.executionPhase = "pending_dispatch";
  state.dispatchAttempt = 0;
  state.resultDeadlineAt = null;
  state.retryCount = Math.min(config.resultMaxRetries, retry.retryCount);
  state.emptyTargetedRecoveryPending = false;
  state.unavailableRetryWindow = null;
  return true;
}
__name(promoteUnavailableRetryDispatch, "promoteUnavailableRetryDispatch");
function markAccepted(state, now, record, cooldownMs) {
  resetPendingDispatch(state);
  state.cooldownUntil = now + cooldownMs;
  state.lastAcceptedTrigger = {
    triggerId: record.triggerId,
    acceptedAt: new Date(now).toISOString(),
    scopeMode: record.scopeMode,
    conversationUrl: record.conversationUrl,
    runId: record.runId
  };
}
__name(markAccepted, "markAccepted");
function markAcceptedAwaitingResult(state, now, record, cooldownMs, watchdogMs) {
  const resultDeadlineAt = now + watchdogMs;
  state.pending = true;
  state.executionPhase = "awaiting_result";
  state.dispatchAttempt = record.attempt;
  state.resultDeadlineAt = resultDeadlineAt;
  state.dueAt = resultDeadlineAt;
  state.debounceWindowStartedAt = null;
  state.cooldownUntil = now + cooldownMs;
  state.lastAcceptedTrigger = {
    triggerId: record.triggerId,
    acceptedAt: new Date(now).toISOString(),
    scopeMode: record.scopeMode,
    conversationUrl: record.conversationUrl,
    runId: record.runId
  };
  state.lastFailure = null;
  state.acceptedRunLeaseUnknown = false;
  return resultDeadlineAt;
}
__name(markAcceptedAwaitingResult, "markAcceptedAwaitingResult");
function markFailure(state, kind, now, retryAt) {
  state.lastFailure = {
    kind,
    recordedAt: new Date(now).toISOString(),
    retryAt: retryAt === void 0 ? void 0 : new Date(retryAt).toISOString()
  };
}
__name(markFailure, "markFailure");
function retryDelayMs(retryCount) {
  const exponent = Math.max(0, Math.min(retryCount - 1, 4));
  return Math.min(30 * 60 * 1e3, 60 * 1e3 * 2 ** exponent);
}
__name(retryDelayMs, "retryDelayMs");
function targetedConfigurationRetryDelayMs(retryCount) {
  const exponent = Math.max(0, Math.min(retryCount - 1, 3));
  return Math.min(2 * 60 * 1e3, 15 * 1e3 * 2 ** exponent);
}
__name(targetedConfigurationRetryDelayMs, "targetedConfigurationRetryDelayMs");
function targetedReconciliationRetryDelayMs(retryCount) {
  const exponent = Math.max(0, Math.min(retryCount - 1, 2));
  return Math.min(2 * 60 * 1e3, 30 * 1e3 * 2 ** exponent);
}
__name(targetedReconciliationRetryDelayMs, "targetedReconciliationRetryDelayMs");

// src/trigger-client.ts
function isRecord4(value) {
  return typeof value === "object" && value !== null;
}
__name(isRecord4, "isRecord");
function safeErrorField(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : void 0;
}
__name(safeErrorField, "safeErrorField");
function safeErrorMessage(value) {
  if (typeof value !== "string") return void 0;
  let normalized = value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return void 0;
  normalized = normalized.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/((?:token|secret|password|api[_-]?key|authorization|cookie)\s*[:=]\s*)\S+/gi, "$1[redacted]").replace(/https?:\/\/\S+/gi, "[redacted-url]").replace(/[A-Za-z]:\\[^\s)\"']+/g, "[redacted-path]").replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]");
  return normalized.length > 512 ? `${normalized.slice(0, 512)}...` : normalized;
}
__name(safeErrorMessage, "safeErrorMessage");
function safeRetryAfterSeconds(response) {
  const raw = response.headers.get("Retry-After")?.trim();
  if (!raw) return void 0;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) return void 0;
  return Math.floor(seconds);
}
__name(safeRetryAfterSeconds, "safeRetryAfterSeconds");
function safeApiTriggerId(value) {
  if (!value) return void 0;
  try {
    const match = new URL(value).pathname.match(/\/workspace_agents\/(agtch_[^/]+)\/trigger$/);
    return match?.[1];
  } catch {
    return void 0;
  }
}
__name(safeApiTriggerId, "safeApiTriggerId");
function safeRunStatus(value) {
  return value === "queued" || value === "in_progress" || value === "suspended" || value === "completed" || value === "failed" ? value : void 0;
}
__name(safeRunStatus, "safeRunStatus");
async function readSafeErrorMetadata2(response) {
  const headerRequestId = safeErrorField(
    response.headers.get("x-request-id")?.trim() ?? response.headers.get("request-id")?.trim()
  );
  let body;
  try {
    body = await response.clone().json();
  } catch {
    return headerRequestId === void 0 ? {} : { requestId: headerRequestId };
  }
  if (!isRecord4(body)) return headerRequestId === void 0 ? {} : { requestId: headerRequestId };
  const nestedError = isRecord4(body.error) ? body.error : body;
  return {
    errorType: safeErrorField(nestedError.type ?? nestedError.error_type),
    errorCode: safeErrorField(nestedError.code ?? nestedError.error_code),
    requestId: safeErrorField(
      body.request_id ?? body.requestId ?? nestedError.request_id
    ) ?? headerRequestId,
    errorMessage: safeErrorMessage(nestedError.message ?? body.message)
  };
}
__name(readSafeErrorMetadata2, "readSafeErrorMetadata");
function isExplicitChannelUnavailableResponse(status, errorMetadata) {
  return status === 409 && errorMetadata.errorType === "invalid_request_error" && errorMetadata.errorMessage?.replace(/[.!?]+$/, "").trim().toLowerCase() === "the workspace agent trigger is not currently available";
}
__name(isExplicitChannelUnavailableResponse, "isExplicitChannelUnavailableResponse");
function buildAgentInput(triggerId, scope, attempt = 1, resultCallbackEnabled = false) {
  const resultCallbackInstructions = resultCallbackEnabled ? [
    "",
    "Result callback required: true",
    `Dispatch attempt: ${attempt}`,
    "Callback contract preflight (before any SuperOps action, no network call required): check the exposed triage_result_report input schema supports metadata.operationStatus, metadata.ticketOutcomes, and metadata.mcpExecution. If one is absent, report terminal_failure with failureStage=configuration and safe errorCode=callback_schema_stale using only supported fields, then stop without any SuperOps read or write. Do not test this by making an invalid callback or bypass a denied action. If the callback action itself is unavailable, stop and explicitly identify that configuration error. Otherwise proceed with the bounded query; the connector's display version alone is not a failure.",
    "Before ending, call triage_result_report exactly once with this Trigger ID and dispatch attempt.",
    "ZERO-CANDIDATE SHORT-CIRCUIT (mandatory immediately after the first query): if superops_tickets_query returns pagination.complete=true, pagination.truncated=false, errors=[], and records=[], call triage_result_report immediately with status=complete, failureStage=bounded_query, ticketsConsidered=0, ticketsCompleted=0, ticketsDeferred=0, and ticketOutcomes=[]; call no evidence recovery, history, field-options, apply, operation, or other action, do not invent mcpExecution, and stop. This conclusive empty result is still followed only by the Worker's single bounded ingestion recovery; do not widen the window or queue.",
    "Use complete only after the bounded run is complete with verified final effects or after a pending durable continuation is confirmed by its safe operation state; use retryable_rate_limit only when a SuperOps read rate limit prevents completion before apply; use terminal_failure for a terminal durable failure, ambiguity, or other non-retryable failure.",
    "Include only the tool's bounded safe metadata; safe ticket display numbers are allowed only in ticketOutcomes and operationStatus.ticketNumbers, never ticket, email, note, or customer content.",
    "Correlation rule: pass this exact Trigger ID as batchId to the single superops_tickets_apply_triage_plan call. This is a correlation key only; it does not widen the fixed candidate set or authorize another apply.",
    "Ticket outcome telemetry: include metadata.ticketOutcomes with exactly one entry for every candidate from the bounded snapshot. Use only the safe display ticketNumber plus outcome completed, skipped, deferred, failed, or not_attempted; add the coarse stage and reasonCode enums when known. Include an entry for a verified existing-note skip, a deferred evidence result, a stale/validation failure, and every item that was not reached. Use an empty array only when the bounded query conclusively returned no candidates. Never include subject, requester, company, email text, note text, or a free-text reason.",
    "Durable operation telemetry: when superops_tickets_apply_triage_plan returns an operation object, copy only its safe outcome into metadata.operationStatus: state, continuationRequired, pendingCount, failedCount, partialWriteCount, ambiguousWriteCount, waitingForRateLimitCount, continuationCount, terminalFailureClass from operation.errorClass when present, replaySafe, humanReconciliationRequired, and ticketNumbers only from operation.items[*].itemId. Copy operationId/resultReference from the returned safe references. A state of Running, ContinuationRequired, or Rescheduled with no humanReconciliationRequired flag is a pending handoff: report complete and stop without another apply. A state of CompletedWithFailures, Failed, or Cancelled, any ambiguousWriteCount greater than zero, or humanReconciliationRequired=true is terminal failure/human reconciliation: report terminal_failure and never replay the window or mutation. Do not invent missing operation fields.",
    "MCP execution telemetry: whenever any triage MCP response contains a safe mcpExecution block, copy the entire block into callback metadata, including executionTraceId, invocationId, operationId, toolName, durationMs, subrequestsUsed, retryCount, requestsByType, requestTrace, retryTrace, requestTraceTruncated, and failureDiagnostics when present. This applies to validation, rate-limit, partial, and terminal responses; never omit the block because the run failed. Copy failureDiagnostics exactly, including the short sanitized message when present. Do not copy raw failureReason, terminalFailureReason, request bodies, GraphQL, headers, tokens, ticket/customer content, or free-text explanations into the callback. If a response genuinely contains no safe mcpExecution block, omit mcpExecution only then and report the bounded failure stage.",
    "Live v6 telemetry compatibility: the apply response may expose the safe execution object under the top-level key execution, not mcpExecution. When execution is present, normalize only these fields into metadata.mcpExecution: executionTraceId, invocationId, operationId, toolName, durationMs; execution.subrequests.used/budget/safetyMargin to subrequestsUsed/subrequestBudget/subrequestSafetyMargin; execution.retries.count to retryCount; and execution.requestsByType to requestsByType. Omit absent requestTrace, retryTrace, or failureDiagnostics fields; do not pass the raw execution wrapper or invent values. If an Agent/app risk gate rejects apply before SuperOps execution, no mcpExecution or operationId may exist: report terminal_failure with failureStage triage_apply, exact candidate counts/outcomes, and any safe failureDiagnostics, never complete or replay."
  ] : [];
  if (scope.mode === "new-email-tickets") {
    return [
      "Run the automated SuperOps triage for only the newly created email tickets in this bounded window.",
      "Do not triage the rest of the New Calls queue.",
      "The Worker has already validated and supplied the scope. Do not report a configuration failure merely because the attached connector is labelled v6 or the runtime namespaces an action; match the action by its description and make the bounded query first after any required callback contract preflight. Use configuration failure only when the supplied scope itself is missing/malformed, no matching action is actually exposed, or the required callback contract is stale.",
      'V2 history gate: use policyMode "scheduled-new-calls-v2". For each genuine or actionable candidate, complete bounded issue recurrence/similarity and historical solution/post-solution recurrence checks before the single safe apply; run independent history checks in parallel when possible. Add bounded cross-client/emerging signals when useful, record explicit unknown/degraded states when unavailable, and never widen the exact window or queue, replay a write, or issue a second apply.',
      "Email routing rule: this is a customer-email intake workflow. Any ticket that needs a human or engineer reply, clarification, investigation, or follow-up must remain in New Calls: use policyDisposition customer_request, manual_intake, or engineer_review as appropriate, but always use action leave and omit target.status. Never use action update or set Awaiting Engineer in scheduled-new-calls-v2. Only a conclusively no-action item may use resolve_no_action with action resolve.",
      "Concurrent engineer-edit rule: expectedUpdatedTime is the hard concurrency fence. If a candidate's updatedTime changed after the bounded snapshot, classify that candidate as skipped with reasonCode stale, do not overwrite its status/fields, do not add a duplicate note, and do not retry that candidate; continue processing the other fixed candidates. This is a per-ticket safety outcome, not permission to widen the window or queue.",
      "Strict note-enum gate: when an optional history section is included, its text must contain the exact matching enum token, not a loose synonym: Historical issue uses issueRecurrence=recurrent; Historical solution uses solutionHistory=prior_solution_found; Post-solution recurrence uses postSolutionRecurrence=observed_recurrence; Cross-client signal uses crossClientSignal=watch or crossClientSignal=credible; Emerging issue uses emergingIssueSignal=watch or emergingIssueSignal=credible; Current script recommendation uses currentScriptRecommendation=<non-empty value>. Omit optional sections whose state is not positive.",
      `Overlap/idempotency rule: the bounded lookback can show a ticket that an earlier email-triggered run already handled. After successful evidence recovery, if a private/internal note's HTML-stripped canonical text begins with "TRIAGE SUMMARY", treat that ticket as already handled by this workflow: do not include it in the apply plan and do not add a second note. Count it as completed for the safe callback. Only apply this skip when notes were requested and successfully recovered; unavailable notes are not proof of prior triage.`,
      "Partial evidence rule: triage_evidence_recover returns an individual result for each requested ticket. If the top-level result is incomplete but a result has ok:true with evidence, retain and process that ticket (including the verified existing-note skip) instead of discarding it. Defer only the individual results that are unavailable, rate-limited, or otherwise unsuccessful; never invent an action for a failed result, widen the window, or repeat successful evidence in the same run. Do not treat retry telemetry alone as a failure: a successful tool result with ok:true, complete:true, or usable evidence remains usable even when its execution metadata reports internal retries. Only report retryable_rate_limit when the returned result is unusable and explicitly reports a rate limit (for example rateLimited:true or errorClass SuperOpsRateLimit). If any deferred result is a SuperOps rate limit, report retryable_rate_limit with completed/deferred counts that add up to considered; otherwise report the bounded terminal failure after applying the successful results if safe.",
      "Latency and rate-limit rule: reuse non-empty classification values from successful evidence. Do not call field-options merely to prefetch or revalidate values; the apply action performs authoritative live validation. Call field-options at most once, only for genuinely missing or ambiguous values, and request only the needed fields. If a SuperOps read is rate-limited before apply, report retryable_rate_limit immediately and let the coordinator retry the same exact window; do not sleep or perform local retries.",
      "",
      "Scope mode: new-email-tickets",
      `Created from (inclusive): ${scope.createdFrom}`,
      `Created to (exclusive): ${scope.createdTo}`,
      `Source: ${scope.source}`,
      "Authoritative trigger payload (use these values exactly; they are already validated by the trigger):",
      JSON.stringify({
        scopeMode: scope.mode,
        createdFrom: scope.createdFrom,
        createdTo: scope.createdTo,
        source: scope.source,
        triggerId,
        dispatchAttempt: attempt,
        resultCallbackRequired: resultCallbackEnabled
      }),
      `Trigger ID: ${triggerId}`,
      ...resultCallbackInstructions
    ].join("\n");
  }
  return [
    "Run the standing automated SuperOps New Calls triage now.",
    "Scope mode: full-new-calls",
    `Scope reason: ${scope.reason}`,
    "",
    `Trigger ID: ${triggerId}`,
    ...resultCallbackInstructions
  ].join("\n");
}
__name(buildAgentInput, "buildAgentInput");
var WorkspaceAgentTriggerClient = class {
  constructor(config, fetcher = boundWorkerFetch, logger2) {
    this.config = config;
    this.fetcher = fetcher;
    this.logger = logger2;
  }
  config;
  fetcher;
  logger;
  static {
    __name(this, "WorkspaceAgentTriggerClient");
  }
  async getRunDiagnostics(runId) {
    if (missingAgentConfiguration(this.config).length > 0 || !/^apirun_[A-Za-z0-9_-]{1,128}$/.test(runId)) {
      return { status: "unavailable" };
    }
    try {
      const triggerUrl = new URL(this.config.workspaceAgentTriggerUrl);
      if (!triggerUrl.pathname.endsWith("/trigger")) return { status: "unavailable" };
      triggerUrl.pathname = `${triggerUrl.pathname.slice(0, -"/trigger".length)}/runs/${encodeURIComponent(runId)}`;
      const response = await this.fetcher(triggerUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.workspaceAgentAccessToken}`,
          "OpenAI-Beta": "workspace_agent_runs=v1"
        }
      });
      if (!response.ok) {
        const errorMetadata2 = await readSafeErrorMetadata2(response);
        this.logger?.warn("agent_run_status_unavailable", {
          status: response.status,
          apiTriggerId: safeApiTriggerId(this.config.workspaceAgentTriggerUrl) ?? null,
          errorType: errorMetadata2.errorType ?? null,
          errorCode: errorMetadata2.errorCode ?? null,
          requestIdPresent: errorMetadata2.requestId !== void 0
        });
        return { status: "unavailable", httpStatus: response.status, ...errorMetadata2 };
      }
      const errorMetadata = await readSafeErrorMetadata2(response);
      let body;
      try {
        body = await response.json();
      } catch {
        return { status: "unavailable" };
      }
      if (!isRecord4(body)) return { status: "unavailable" };
      const diagnostics = {
        status: safeRunStatus(body.status) ?? "unavailable",
        ...errorMetadata
      };
      this.logger?.info("agent_run_diagnostics", {
        status: diagnostics.status,
        apiTriggerId: safeApiTriggerId(this.config.workspaceAgentTriggerUrl) ?? null,
        errorType: diagnostics.errorType ?? null,
        errorCode: diagnostics.errorCode ?? null,
        requestIdPresent: diagnostics.requestId !== void 0
      });
      return diagnostics;
    } catch (error) {
      const errorMessage = error instanceof Error ? safeErrorMessage(error.message) : void 0;
      this.logger?.warn("agent_run_status_unavailable", {
        errorType: error instanceof Error ? error.name : "unknown",
        errorMessage: errorMessage ?? null
      });
      return {
        status: "unavailable",
        errorType: error instanceof Error ? error.name : "unknown",
        errorCode: "status_transport_error",
        errorMessage
      };
    }
  }
  async getRunStatus(runId) {
    return (await this.getRunDiagnostics(runId)).status;
  }
  async trigger(triggerId, scope, attempt = 1, resultCallbackEnabled = false) {
    if (missingAgentConfiguration(this.config).length > 0) {
      this.logger?.warn("agent_trigger_not_configured");
      return { kind: "configuration" };
    }
    try {
      const response = await this.fetcher(this.config.workspaceAgentTriggerUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.workspaceAgentAccessToken}`,
          "Content-Type": "application/json",
          // Transport retries for one dispatch attempt stay idempotent. A
          // callback-directed retry increments the attempt so OpenAI queues a
          // fresh Agent run for the same immutable ticket window.
          "Idempotency-Key": resultCallbackEnabled ? `workspace-agent-trigger-v4:${triggerId}:attempt:${attempt}` : `workspace-agent-trigger-v3:${triggerId}`,
          "OpenAI-Beta": "workspace_agent_runs=v1"
        },
        body: JSON.stringify({
          input: buildAgentInput(triggerId, scope, attempt, resultCallbackEnabled)
        })
      });
      if (response.status === 202) {
        let responseBody = null;
        try {
          responseBody = await response.json();
        } catch {
          responseBody = null;
        }
        const conversationUrl = isRecord4(responseBody) && typeof responseBody.conversation_url === "string" ? responseBody.conversation_url : void 0;
        const runId = isRecord4(responseBody) && typeof responseBody.agent_trigger_run_id === "string" ? responseBody.agent_trigger_run_id : void 0;
        this.logger?.info("agent_trigger_accepted", {
          triggerId,
          scopeMode: scope.mode,
          apiTriggerId: safeApiTriggerId(this.config.workspaceAgentTriggerUrl) ?? null,
          runId: runId ?? null,
          runIdPresent: runId !== void 0,
          conversationUrlPresent: conversationUrl !== void 0
        });
        return {
          kind: "accepted",
          conversationUrl,
          runId
        };
      }
      const errorMetadata = await readSafeErrorMetadata2(response);
      if (response.status === 401 || response.status === 403) {
        this.logger?.warn("agent_trigger_authentication_failure", {
          status: response.status,
          apiTriggerId: safeApiTriggerId(this.config.workspaceAgentTriggerUrl) ?? null,
          ...errorMetadata
        });
        return {
          kind: "authentication",
          httpStatus: response.status,
          errorType: errorMetadata.errorType,
          errorCode: errorMetadata.errorCode,
          errorMessage: errorMetadata.errorMessage,
          requestId: errorMetadata.requestId
        };
      }
      if (response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500) {
        if (isExplicitChannelUnavailableResponse(response.status, errorMetadata)) {
          this.logger?.warn("agent_trigger_channel_unavailable", {
            status: response.status,
            apiTriggerId: safeApiTriggerId(this.config.workspaceAgentTriggerUrl) ?? null,
            ...errorMetadata
          });
          return {
            kind: "configuration",
            channelUnavailable: true,
            httpStatus: response.status,
            errorType: errorMetadata.errorType,
            errorCode: errorMetadata.errorCode,
            errorMessage: errorMetadata.errorMessage,
            requestId: errorMetadata.requestId,
            retryAfterSeconds: safeRetryAfterSeconds(response)
          };
        }
        this.logger?.warn("agent_trigger_retryable_failure", {
          status: response.status,
          apiTriggerId: safeApiTriggerId(this.config.workspaceAgentTriggerUrl) ?? null,
          ...errorMetadata
        });
        return {
          kind: response.status >= 500 ? "ambiguous" : "transient",
          httpStatus: response.status,
          errorType: errorMetadata.errorType,
          errorCode: errorMetadata.errorCode,
          errorMessage: errorMetadata.errorMessage,
          requestId: errorMetadata.requestId,
          retryAfterSeconds: safeRetryAfterSeconds(response)
        };
      }
      this.logger?.warn("agent_trigger_permanent_failure", {
        status: response.status,
        apiTriggerId: safeApiTriggerId(this.config.workspaceAgentTriggerUrl) ?? null,
        ...errorMetadata
      });
      return {
        kind: "permanent",
        httpStatus: response.status,
        errorType: errorMetadata.errorType,
        errorCode: errorMetadata.errorCode,
        errorMessage: errorMetadata.errorMessage,
        requestId: errorMetadata.requestId
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? safeErrorMessage(error.message) : void 0;
      this.logger?.warn("agent_trigger_network_failure", {
        errorType: error instanceof Error ? error.name : "unknown",
        errorMessage: errorMessage ?? null
      });
      return {
        kind: "ambiguous",
        errorType: error instanceof Error ? error.name : "network_error",
        errorCode: "transport_error",
        errorMessage
      };
    }
  }
};

// src/queue-guards.ts
function exhaustedZeroWorkConfiguration(state, config) {
  const report = state.lastResultReport;
  const metadata = report?.metadata;
  return config.configurationRetryExitEnabled && state.pending && state.pendingTriggerScope?.mode === "new-email-tickets" && state.executionPhase === "retry_wait" && state.retryCount >= config.resultMaxRetries && report?.triggerId === state.pendingTriggerId && report.attempt === state.dispatchAttempt && report.status === "terminal_failure" && metadata?.failureStage === "configuration" && metadata.ticketsConsidered === 0 && metadata.ticketsCompleted === 0 && metadata.ticketsDeferred === 0 && (metadata.ticketOutcomes?.length ?? 0) === 0 && (state.pendingTicketOutcomes?.length ?? 0) === 0 && metadata.operationId === void 0 && metadata.resultReference === void 0 && metadata.operationStatus === void 0 && metadata.mcpExecution === void 0 && !("mcpInvocationTimings" in metadata);
}
__name(exhaustedZeroWorkConfiguration, "exhaustedZeroWorkConfiguration");
function coordinatorProgressFields(state) {
  let action = "idle";
  let dueAt = null;
  const legacyAttentionBlockedQueue = state.queuedBlockedByAttention && state.attentionBlockedWindow === null;
  if (state.pending) {
    action = state.executionPhase === "awaiting_result" ? "awaiting_agent_result" : state.executionPhase ?? "pending_dispatch";
    dueAt = state.dueAt ?? state.resultDeadlineAt;
    if (state.executionPhase === "pending_dispatch" && dueAt !== null) {
      dueAt = Math.max(dueAt, state.cooldownUntil);
    }
  } else if (state.unavailableRetryWindow !== null) {
    action = "unavailable_trigger_retry";
    dueAt = state.unavailableRetryWindow.dueAt;
  } else if (state.reconciliationHold !== null) {
    action = "reconciliation_hold";
    dueAt = state.reconciliationHold.dueAt;
  } else if (state.queuedPending && state.queuedNotificationWindowStartedAt !== null) {
    action = legacyAttentionBlockedQueue ? "queued_attention_blocked" : "queued_dispatch";
    dueAt = legacyAttentionBlockedQueue || state.queuedDueAt === null ? null : Math.max(state.queuedDueAt, state.cooldownUntil);
  } else if (state.attentionBlockedWindow !== null) {
    action = "queued_attention_blocked";
  }
  if (state.sharedRateLimitUntil !== null && state.sharedRateLimitUntil > Date.now()) {
    dueAt = dueAt === null ? state.sharedRateLimitUntil : Math.max(dueAt, state.sharedRateLimitUntil);
  }
  const acceptedAt = Date.parse(state.lastAcceptedTrigger?.acceptedAt ?? "");
  const active = state.pendingTriggerScope;
  const attention = state.needsAttentionScope;
  return {
    currentAction: action,
    nextActionAt: dueAt !== null && Number.isFinite(dueAt) ? new Date(dueAt).toISOString() : null,
    triggerAcceptedAfterAttention: state.needsAttentionAt !== null && Number.isFinite(acceptedAt) ? acceptedAt > state.needsAttentionAt : null,
    attentionScopeIsActive: state.pending && active?.mode === "new-email-tickets" && attention?.mode === "new-email-tickets" && active.createdFrom === attention.createdFrom && active.createdTo === attention.createdTo
  };
}
__name(coordinatorProgressFields, "coordinatorProgressFields");

// src/coordinator.ts
var MAX_AGENT_STATUS_POLL_COUNT2 = 1e3;
var MAX_AGENT_TIMING_MS2 = 864e5;
var UNAVAILABLE_TRIGGER_RETRY_DELAY_MS = 15 * 60 * 1e3;
function separationEnabled(config) {
  return config.reconciliationEligibilitySeparationEnabled;
}
__name(separationEnabled, "separationEnabled");
function finiteScopeBounds(scope) {
  const from = Date.parse(scope.createdFrom);
  const to = Date.parse(scope.createdTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return null;
  return { from, to };
}
__name(finiteScopeBounds, "finiteScopeBounds");
function targetedScopesOverlap(left, right) {
  if (left.mode !== "new-email-tickets" || right.mode !== "new-email-tickets") return true;
  const leftBounds = finiteScopeBounds(left);
  const rightBounds = finiteScopeBounds(right);
  if (leftBounds === null || rightBounds === null) return true;
  return leftBounds.from < rightBounds.to && rightBounds.from < leftBounds.to;
}
__name(targetedScopesOverlap, "targetedScopesOverlap");
function targetedScopesDisjoint(left, right) {
  return !targetedScopesOverlap(left, right);
}
__name(targetedScopesDisjoint, "targetedScopesDisjoint");
function scopeIdentity(scope) {
  return scope.mode === "new-email-tickets" ? `EMAIL|${scope.createdFrom}|${scope.createdTo}` : `FULL|${scope.reason}`;
}
__name(scopeIdentity, "scopeIdentity");
function windowScope(mode, windowStartedAt, windowEndedAt, lookbackMs, config) {
  if (mode !== "new-email-tickets" || windowStartedAt === null) return null;
  const end = windowEndedAt ?? windowStartedAt;
  const lookback = Math.max(0, lookbackMs ?? config.newEmailLookbackMs);
  if (!Number.isFinite(end) || end <= windowStartedAt) return null;
  return {
    mode: "new-email-tickets",
    createdFrom: new Date(Math.max(0, windowStartedAt - lookback)).toISOString(),
    createdTo: new Date(end).toISOString(),
    source: "EMAIL"
  };
}
__name(windowScope, "windowScope");
function queuedEmailScope(state, config) {
  return windowScope(
    config.scopeMode,
    state.queuedNotificationWindowStartedAt,
    state.queuedNotificationWindowEndedAt,
    state.queuedNotificationLookbackMs,
    config
  );
}
__name(queuedEmailScope, "queuedEmailScope");
function attentionBlockedWindowScope(state, config) {
  const blocked = state.attentionBlockedWindow;
  if (blocked === null) return null;
  return windowScope(
    config.scopeMode,
    blocked.notificationWindowStartedAt,
    blocked.notificationWindowEndedAt,
    blocked.notificationLookbackMs,
    config
  );
}
__name(attentionBlockedWindowScope, "attentionBlockedWindowScope");
function attentionScopes(state) {
  if (state.needsAttentionScopes.length > 0) return state.needsAttentionScopes;
  return state.needsAttentionScope === null ? [] : [state.needsAttentionScope];
}
__name(attentionScopes, "attentionScopes");
function attentionFenceIsActive(state, config) {
  return separationEnabled(config) || state.candidateAttentionFenceActive || state.attentionBlockedWindow !== null;
}
__name(attentionFenceIsActive, "attentionFenceIsActive");
function scopeOverlapsAttention(state, config, candidate) {
  if (!attentionFenceIsActive(state, config)) return false;
  if (attentionScopes(state).some((scope) => targetedScopesOverlap(scope, candidate))) return true;
  const blockedScope = attentionBlockedWindowScope(state, config);
  return blockedScope !== null && targetedScopesOverlap(blockedScope, candidate);
}
__name(scopeOverlapsAttention, "scopeOverlapsAttention");
function pendingEmailScopeForComparison(state, config) {
  if (state.pendingTriggerScope?.mode === "new-email-tickets") return state.pendingTriggerScope;
  return windowScope(
    config.scopeMode,
    state.pendingNotificationWindowStartedAt,
    state.pendingNotificationWindowEndedAt,
    state.pendingNotificationLookbackMs,
    config
  );
}
__name(pendingEmailScopeForComparison, "pendingEmailScopeForComparison");
function attentionBlockedWindowFromQueued(state) {
  if (!state.queuedPending || state.queuedNotificationWindowStartedAt === null) return null;
  return {
    reason: state.queuedReason,
    notificationWindowStartedAt: state.queuedNotificationWindowStartedAt,
    notificationWindowEndedAt: state.queuedNotificationWindowEndedAt,
    notificationLookbackMs: state.queuedNotificationLookbackMs,
    lastNotificationAt: state.queuedLastNotificationAt,
    debounceWindowStartedAt: state.queuedDebounceWindowStartedAt,
    unavailableRetryCount: state.queuedUnavailableRetryCount,
    lifecycleRecoveryRequested: state.queuedLifecycleRecoveryRequested,
    lastLifecycleEvent: state.queuedLastLifecycleEvent
  };
}
__name(attentionBlockedWindowFromQueued, "attentionBlockedWindowFromQueued");
function attentionBlockedWindowFromPending(state) {
  if (!state.pending || state.pendingNotificationWindowStartedAt === null) return null;
  return {
    reason: state.pendingReason,
    notificationWindowStartedAt: state.pendingNotificationWindowStartedAt,
    notificationWindowEndedAt: state.pendingNotificationWindowEndedAt,
    notificationLookbackMs: state.pendingNotificationLookbackMs,
    lastNotificationAt: state.lastNotificationAt,
    debounceWindowStartedAt: state.debounceWindowStartedAt,
    unavailableRetryCount: 0,
    lifecycleRecoveryRequested: state.lifecycleRecoveryRequested,
    lastLifecycleEvent: state.lastLifecycleEvent
  };
}
__name(attentionBlockedWindowFromPending, "attentionBlockedWindowFromPending");
function mergeAttentionBlockedWindow(state, incoming) {
  const existing = state.attentionBlockedWindow;
  if (existing === null) {
    state.attentionBlockedWindow = { ...incoming };
  } else {
    existing.reason = existing.reason === "new_message" || incoming.reason === "new_message" ? "new_message" : existing.reason ?? incoming.reason;
    existing.notificationWindowStartedAt = Math.min(
      existing.notificationWindowStartedAt,
      incoming.notificationWindowStartedAt
    );
    existing.notificationWindowEndedAt = existing.notificationWindowEndedAt === null ? incoming.notificationWindowEndedAt : incoming.notificationWindowEndedAt === null ? existing.notificationWindowEndedAt : Math.max(existing.notificationWindowEndedAt, incoming.notificationWindowEndedAt);
    existing.notificationLookbackMs = Math.max(
      existing.notificationLookbackMs ?? 0,
      incoming.notificationLookbackMs ?? 0
    );
    existing.lastNotificationAt = existing.lastNotificationAt === null ? incoming.lastNotificationAt : incoming.lastNotificationAt === null ? existing.lastNotificationAt : Math.max(existing.lastNotificationAt, incoming.lastNotificationAt);
    existing.debounceWindowStartedAt = existing.debounceWindowStartedAt === null ? incoming.debounceWindowStartedAt : incoming.debounceWindowStartedAt === null ? existing.debounceWindowStartedAt : Math.min(existing.debounceWindowStartedAt, incoming.debounceWindowStartedAt);
    existing.unavailableRetryCount = Math.max(
      existing.unavailableRetryCount,
      incoming.unavailableRetryCount
    );
    existing.lifecycleRecoveryRequested ||= incoming.lifecycleRecoveryRequested;
    existing.lastLifecycleEvent = incoming.lastLifecycleEvent ?? existing.lastLifecycleEvent;
  }
  state.queuedBlockedByAttention = true;
}
__name(mergeAttentionBlockedWindow, "mergeAttentionBlockedWindow");
function parkQueuedAttentionWindow(state) {
  const blocked = attentionBlockedWindowFromQueued(state);
  if (blocked === null) return false;
  mergeAttentionBlockedWindow(state, blocked);
  resetQueuedDispatch(state);
  state.queuedBlockedByAttention = true;
  return true;
}
__name(parkQueuedAttentionWindow, "parkQueuedAttentionWindow");
function parkPendingAttentionWindow(state) {
  const blocked = attentionBlockedWindowFromPending(state);
  if (blocked === null) return false;
  mergeAttentionBlockedWindow(state, blocked);
  resetPendingDispatch(state);
  state.queuedPending = true;
  state.queuedBlockedByAttention = true;
  return true;
}
__name(parkPendingAttentionWindow, "parkPendingAttentionWindow");
function migrateLegacyAttentionBlockedQueue(state) {
  if (!state.queuedBlockedByAttention || state.attentionBlockedWindow !== null || !state.queuedPending) return;
  parkQueuedAttentionWindow(state);
}
__name(migrateLegacyAttentionBlockedQueue, "migrateLegacyAttentionBlockedQueue");
function sharedRateLimitActive(state, now) {
  return state.sharedRateLimitUntil !== null && state.sharedRateLimitUntil > now;
}
__name(sharedRateLimitActive, "sharedRateLimitActive");
function clearExpiredSharedRateLimit(state, now) {
  if (state.sharedRateLimitUntil !== null && state.sharedRateLimitUntil <= now) {
    state.sharedRateLimitUntil = null;
  }
}
__name(clearExpiredSharedRateLimit, "clearExpiredSharedRateLimit");
function setSharedRateLimitGate(state, config, report, now, delayMs) {
  if (!separationEnabled(config) || report.status !== "retryable_rate_limit") return;
  const nextAt = now + Math.max(1e3, delayMs);
  state.sharedRateLimitUntil = Math.max(state.sharedRateLimitUntil ?? 0, nextAt);
}
__name(setSharedRateLimitGate, "setSharedRateLimitGate");
function queuedOverlapsAttention(state, config) {
  if (!attentionFenceIsActive(state, config) || !state.queuedPending) return false;
  const queuedScope = queuedEmailScope(state, config);
  return queuedScope === null || scopeOverlapsAttention(state, config, queuedScope);
}
__name(queuedOverlapsAttention, "queuedOverlapsAttention");
function queuedOverlapsReconciliationHold(state, config) {
  if (!separationEnabled(config) || state.reconciliationHold === null || !state.queuedPending) return false;
  const queuedScope = queuedEmailScope(state, config);
  return queuedScope === null || targetedScopesOverlap(state.reconciliationHold.scope, queuedScope);
}
__name(queuedOverlapsReconciliationHold, "queuedOverlapsReconciliationHold");
function refreshQueuedAttentionBlock(state, config) {
  if (!attentionFenceIsActive(state, config) || !state.queuedPending) return;
  if (queuedOverlapsAttention(state, config)) {
    parkQueuedAttentionWindow(state);
  }
}
__name(refreshQueuedAttentionBlock, "refreshQueuedAttentionBlock");
function blockPendingIfAttentionOverlaps(state, config, now) {
  if (!attentionFenceIsActive(state, config) || !state.pending || state.needsAttentionScope === null) return;
  const pendingScope = pendingEmailScopeForComparison(state, config);
  if (pendingScope === null || scopeOverlapsAttention(state, config, pendingScope)) {
    if (!parkPendingAttentionWindow(state)) {
      queueCurrentEmailWindow(state, now);
      state.queuedBlockedByAttention = true;
      state.queuedDueAt = null;
      resetPendingDispatch(state);
    }
  }
}
__name(blockPendingIfAttentionOverlaps, "blockPendingIfAttentionOverlaps");
function batchSequenceFromTriggerId(triggerId) {
  const value = triggerId?.match(/^triage-(\d+)-/)?.[1];
  if (!value) return null;
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}
__name(batchSequenceFromTriggerId, "batchSequenceFromTriggerId");
function boundedAgentTimingMs(value) {
  return Math.min(MAX_AGENT_TIMING_MS2, Math.max(0, Math.floor(value)));
}
__name(boundedAgentTimingMs, "boundedAgentTimingMs");
function agentStatusPollCount(state, triggerId, attempt) {
  const batchSequence = batchSequenceFromTriggerId(triggerId) ?? (state.pending ? state.triggerSequence : null);
  return Math.min(
    MAX_AGENT_STATUS_POLL_COUNT2,
    state.dispatchHistory.reduce(
      (count, entry) => count + (entry.event === "agent_run_status_checked" && entry.batchSequence === batchSequence && entry.attempt === attempt ? 1 : 0),
      0
    )
  );
}
__name(agentStatusPollCount, "agentStatusPollCount");
function agentResultTimingHistoryDetails(state, config, triggerId, attempt, now) {
  if (!config.agentTimingTelemetryEnabled) return {};
  const acceptedAt = state.lastAcceptedTrigger?.acceptedAt;
  const acceptedAtMs = acceptedAt === void 0 ? Number.NaN : Date.parse(acceptedAt);
  const acceptedToCallbackMs = Number.isFinite(acceptedAtMs) ? boundedAgentTimingMs(now - acceptedAtMs) : void 0;
  return {
    agentStatusPollCount: agentStatusPollCount(state, triggerId, attempt),
    ...acceptedToCallbackMs === void 0 ? {} : { agentAcceptedToCallbackMs: acceptedToCallbackMs }
  };
}
__name(agentResultTimingHistoryDetails, "agentResultTimingHistoryDetails");
function recordDispatchHistory(state, now, details, scope) {
  const { batchSequence, scopeMode, ...rest } = details;
  const inheritedTicketOutcomes = details.event !== "notification_accepted" && details.event !== "notification_queued" && details.event !== "notification_batch_processed" && state.pendingTicketOutcomes !== null ? state.pendingTicketOutcomes : void 0;
  const effectiveScope = scope ?? state.pendingTriggerScope;
  const scopeForWindow = scope ?? (details.event === "notification_accepted" || details.event === "notification_queued" || details.event === "notification_batch_processed" ? null : state.pendingTriggerScope);
  appendDispatchHistory(
    state,
    {
      ...rest,
      batchSequence: batchSequence !== void 0 ? batchSequence : batchSequenceFromTriggerId(state.pendingTriggerId) ?? (state.pending ? state.triggerSequence : null),
      scopeMode: scopeMode !== void 0 ? scopeMode : effectiveScope?.mode ?? null,
      scopeCreatedFrom: details.scopeCreatedFrom !== void 0 ? details.scopeCreatedFrom : scopeForWindow?.mode === "new-email-tickets" ? scopeForWindow.createdFrom : void 0,
      scopeCreatedTo: details.scopeCreatedTo !== void 0 ? details.scopeCreatedTo : scopeForWindow?.mode === "new-email-tickets" ? scopeForWindow.createdTo : void 0,
      ticketOutcomes: rest.ticketOutcomes ?? inheritedTicketOutcomes
    },
    now
  );
}
__name(recordDispatchHistory, "recordDispatchHistory");
function resultHistoryDetails(report, additionalFailureDiagnostics = []) {
  const metadata = report.metadata;
  const failureDiagnostics = [
    ...metadata?.failureDiagnostics ?? [],
    ...additionalFailureDiagnostics
  ].slice(0, 32);
  return {
    attempt: report.attempt,
    resultStatus: report.status,
    retryAfterSeconds: report.retryAfterSeconds,
    operationId: metadata?.operationId,
    resultReference: metadata?.resultReference,
    operationStatus: metadata?.operationStatus,
    failureStage: metadata?.failureStage,
    ticketsConsidered: metadata?.ticketsConsidered,
    ticketsCompleted: metadata?.ticketsCompleted,
    ticketsDeferred: metadata?.ticketsDeferred,
    superopsAttempts: metadata?.superopsAttempts,
    superopsRetries: metadata?.superopsRetries,
    runDurationMs: metadata?.runDurationMs,
    ticketOutcomes: metadata?.ticketOutcomes,
    failureDiagnostics: failureDiagnostics.length > 0 ? failureDiagnostics : void 0,
    mcpExecution: metadata?.mcpExecution
  };
}
__name(resultHistoryDetails, "resultHistoryDetails");
function agentRunFailureDiagnostics(diagnostics) {
  const hasDiagnostic = diagnostics.errorType !== void 0 || diagnostics.errorCode !== void 0 || diagnostics.errorMessage !== void 0 || diagnostics.httpStatus !== void 0 || diagnostics.status === "failed" || diagnostics.status === "unavailable";
  if (!hasDiagnostic) return [];
  return [{
    stage: "agent_run_status",
    ...diagnostics.errorType === void 0 ? {} : { errorType: diagnostics.errorType },
    errorCode: diagnostics.errorCode ?? (diagnostics.status === "failed" ? "run_failed" : diagnostics.status === "unavailable" ? "run_status_unavailable" : void 0),
    ...diagnostics.httpStatus === void 0 ? {} : { httpStatus: diagnostics.httpStatus },
    ...diagnostics.errorMessage === void 0 ? {} : { message: diagnostics.errorMessage }
  }];
}
__name(agentRunFailureDiagnostics, "agentRunFailureDiagnostics");
function agentTriggerFailureDiagnostics(attempt) {
  return [{
    stage: "agent_trigger",
    errorType: attempt.errorType,
    errorCode: attempt.errorCode ?? `agent_trigger_${attempt.kind}`,
    ...attempt.httpStatus === void 0 ? {} : { httpStatus: attempt.httpStatus },
    ...attempt.errorMessage === void 0 ? {} : { message: attempt.errorMessage }
  }];
}
__name(agentTriggerFailureDiagnostics, "agentTriggerFailureDiagnostics");
function missingCallbackDiagnostics(reason) {
  return [{
    stage: "agent_callback",
    errorType: "callback_contract",
    errorCode: reason,
    message: reason === "result_callback_missing" ? "Agent run reached a terminal state without calling triage_result_report." : "Accepted Agent trigger did not return a run ID, so callback correlation was unavailable."
  }];
}
__name(missingCallbackDiagnostics, "missingCallbackDiagnostics");
function callbackContractDiagnostics(report) {
  const metadata = report.metadata;
  const callbackFailureDiagnosticCount = metadata?.failureDiagnostics?.length ?? 0;
  const mcpFailureDiagnosticCount = metadata?.mcpExecution?.failureDiagnostics?.length ?? 0;
  const diagnostics = [];
  if (report.status !== "complete" && callbackFailureDiagnosticCount === 0 && mcpFailureDiagnosticCount === 0) {
    diagnostics.push({
      stage: metadata?.failureStage ?? "agent_callback",
      errorType: "callback_contract",
      errorCode: "failure_diagnostics_missing",
      message: "Agent result omitted failureDiagnostics and MCP failure diagnostics."
    });
  }
  if (report.status !== "complete" && metadata?.mcpExecution === void 0) {
    diagnostics.push({
      stage: "agent_callback",
      errorType: "callback_contract",
      errorCode: "mcp_execution_missing",
      message: "Agent result omitted mcpExecution telemetry."
    });
  }
  if ((metadata?.ticketsConsidered ?? 0) > 0 && metadata?.ticketOutcomes === void 0) {
    diagnostics.push({
      stage: "agent_callback",
      errorType: "callback_contract",
      errorCode: "ticket_outcomes_missing",
      message: "Agent result omitted ticketOutcomes for a non-empty candidate set."
    });
  }
  if (metadata?.failureStage === "operation_continuation" && (metadata.operationId === void 0 && metadata.resultReference === void 0)) {
    diagnostics.push({
      stage: "agent_callback",
      errorType: "callback_contract",
      errorCode: "operation_reference_missing",
      message: "Agent result omitted the safe durable operation reference needed to correlate a continuation handoff."
    });
  }
  if (metadata?.failureStage === "operation_continuation" && (metadata.operationId !== void 0 || metadata.resultReference !== void 0) && metadata.operationStatus === void 0) {
    diagnostics.push({
      stage: "agent_callback",
      errorType: "callback_contract",
      errorCode: "operation_status_missing",
      message: "Agent result omitted the safe durable operation status needed to distinguish a pending handoff from a terminal failure."
    });
  }
  const ticketOutcomes = metadata?.ticketOutcomes;
  if (report.status === "complete" && ticketOutcomes !== void 0 && ticketOutcomes.length > 0) {
    const hasAlreadyHandledSkip = ticketOutcomes.some(
      (item) => item.outcome === "skipped" && item.reasonCode === "already_handled"
    );
    if (metadata?.ticketsConsidered === void 0 || metadata.ticketsCompleted === void 0 || metadata.ticketsDeferred === void 0) {
      diagnostics.push({
        stage: "agent_callback",
        errorType: "callback_contract",
        errorCode: "completion_counts_missing",
        message: "Agent result omitted completion counts for a non-empty candidate set."
      });
    } else if (metadata.ticketsConsidered !== ticketOutcomes.length || metadata.ticketsCompleted + metadata.ticketsDeferred !== metadata.ticketsConsidered) {
      diagnostics.push({
        stage: "agent_callback",
        errorType: "callback_contract",
        errorCode: "completion_counts_mismatch",
        message: "Agent result completion counts do not match ticketOutcomes."
      });
    }
    if (metadata?.mcpExecution === void 0 && hasAlreadyHandledSkip) {
      diagnostics.push({
        stage: "agent_callback",
        errorType: "callback_contract",
        errorCode: "mcp_execution_missing_for_existing_note_skip",
        message: "Agent result claimed an existing-note skip without MCP execution telemetry."
      });
    }
    if (hasAlreadyHandledSkip && (metadata?.failureStage === "bounded_query" || metadata?.failureStage === "evidence_recovery") && metadata?.mcpExecution !== void 0 && !isProvenAlreadyHandledCompletion(report)) {
      diagnostics.push({
        stage: "agent_callback",
        errorType: "callback_contract",
        errorCode: "already_handled_evidence_proof_missing",
        message: "Agent result claimed an already-handled completion without matching evidence-recovery telemetry."
      });
    }
  }
  return diagnostics;
}
__name(callbackContractDiagnostics, "callbackContractDiagnostics");
var RETRY_BLOCKING_CALLBACK_DIAGNOSTICS = /* @__PURE__ */ new Set([
  "failure_diagnostics_missing",
  "mcp_execution_missing",
  "ticket_outcomes_missing"
]);
var EVIDENCE_RECOVERY_TOOL_NAME = "superops_tickets_triage_evidence_recover";
function isProvenAlreadyHandledCompletion(report) {
  const metadata = report.metadata;
  const ticketOutcomes = metadata?.ticketOutcomes;
  if (report.status !== "complete" || metadata === void 0 || metadata.failureStage !== "bounded_query" && metadata.failureStage !== "evidence_recovery" || ticketOutcomes === void 0 || ticketOutcomes.length === 0 || metadata.ticketsConsidered !== ticketOutcomes.length || metadata.ticketsCompleted !== ticketOutcomes.length || metadata.ticketsDeferred !== 0 || ticketOutcomes.some((item) => item.outcome !== "skipped" || item.reasonCode !== "already_handled")) return false;
  const operationStatus = metadata.operationStatus;
  if (operationStatus !== void 0 && (operationStatus.state !== "Completed" || (operationStatus.pendingCount ?? 0) > 0 || (operationStatus.failedCount ?? 0) > 0 || (operationStatus.partialWriteCount ?? 0) > 0 || (operationStatus.ambiguousWriteCount ?? 0) > 0 || (operationStatus.waitingForRateLimitCount ?? 0) > 0 || operationStatus.continuationRequired === true || operationStatus.humanReconciliationRequired === true || operationStatus.terminalFailureClass !== void 0)) return false;
  const mcpExecution = metadata.mcpExecution;
  const requestsByType = mcpExecution?.requestsByType;
  return mcpExecution?.toolName === EVIDENCE_RECOVERY_TOOL_NAME && (metadata.failureDiagnostics?.length ?? 0) === 0 && (mcpExecution.failureDiagnostics?.length ?? 0) === 0 && (requestsByType?.duplicateNoteCheck ?? 0) >= ticketOutcomes.length && (requestsByType?.verificationRead ?? 0) >= ticketOutcomes.length;
}
__name(isProvenAlreadyHandledCompletion, "isProvenAlreadyHandledCompletion");
function terminalApplyFailureNeedsHumanReconciliation(report) {
  if (report.status !== "terminal_failure" || report.metadata?.failureStage !== "triage_apply") {
    return false;
  }
  const metadata = report.metadata;
  const candidateSetUnknownOrNonEmpty = metadata.ticketsConsidered === void 0 || metadata.ticketsConsidered > 0 || (metadata.ticketsCompleted ?? 0) > 0 || (metadata.ticketsDeferred ?? 0) > 0 || (metadata.ticketOutcomes?.length ?? 0) > 0;
  if (!candidateSetUnknownOrNonEmpty) return false;
  const hasUnclassifiedCandidateOutcome = (metadata.ticketOutcomes ?? []).some(
    (outcome) => (outcome.outcome === "failed" || outcome.outcome === "deferred") && (outcome.reasonCode === void 0 || outcome.reasonCode === "unknown")
  );
  if (hasUnclassifiedCandidateOutcome) return true;
  return callbackContractDiagnostics(report).some(
    (diagnostic) => RETRY_BLOCKING_CALLBACK_DIAGNOSTICS.has(diagnostic.errorCode ?? "")
  );
}
__name(terminalApplyFailureNeedsHumanReconciliation, "terminalApplyFailureNeedsHumanReconciliation");
function enrichReportDiagnostics(report) {
  const extra = callbackContractDiagnostics(report);
  if (extra.length === 0) return report;
  return {
    ...report,
    metadata: {
      ...report.metadata ?? {},
      failureDiagnostics: [
        ...report.metadata?.failureDiagnostics ?? [],
        ...extra
      ].slice(0, 32)
    }
  };
}
__name(enrichReportDiagnostics, "enrichReportDiagnostics");
var SAFE_GRAPH_DIAGNOSTIC_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
function safeGraphDiagnostic(value) {
  return typeof value === "string" && SAFE_GRAPH_DIAGNOSTIC_PATTERN.test(value) ? value : void 0;
}
__name(safeGraphDiagnostic, "safeGraphDiagnostic");
function graphFailureHistoryDetails(error) {
  if (error instanceof GraphApiError) {
    const errorType2 = safeGraphDiagnostic(error.metadata.errorType) ?? error.name;
    const errorCode = safeGraphDiagnostic(error.metadata.errorCode);
    const upstreamRequestId = safeGraphDiagnostic(error.metadata.requestId);
    const failureDiagnostics = parseSafeFailureDiagnostics([{
      stage: "graph",
      errorType: errorType2,
      errorCode,
      httpStatus: error.status,
      message: error.metadata.errorMessage
    }]) ?? [];
    return {
      httpStatus: error.status,
      errorType: errorType2,
      ...errorCode === void 0 ? {} : { errorCode },
      ...upstreamRequestId === void 0 ? {} : { upstreamRequestId },
      failureDiagnostics
    };
  }
  if (error instanceof GraphConfigurationError) {
    return {
      errorType: error.name,
      errorCode: "missing_configuration",
      failureDiagnostics: [{
        stage: "graph",
        errorType: error.name,
        errorCode: "missing_configuration",
        message: "Microsoft Graph configuration is incomplete."
      }]
    };
  }
  const errorType = error instanceof Error ? error.name : "unknown";
  return {
    errorType,
    failureDiagnostics: parseSafeFailureDiagnostics([{
      stage: "graph",
      errorType,
      message: error instanceof Error ? error.message : void 0
    }]) ?? []
  };
}
__name(graphFailureHistoryDetails, "graphFailureHistoryDetails");
function transportRetryDelayMs(config, retryCount, retryAfterSeconds) {
  const fallback = retryCount >= config.resultMaxRetries ? 30 * 60 * 1e3 : retryDelayMs(retryCount);
  if (retryAfterSeconds === void 0) return fallback;
  return Math.min(
    Math.max(1e3, retryAfterSeconds * 1e3),
    config.resultMaxRetryAfterMs
  );
}
__name(transportRetryDelayMs, "transportRetryDelayMs");
function queuedDispatchWaitReason(state, queued) {
  if (!queued && state.pendingDispatchWaitReason === "reconciliation_hold") {
    return "reconciliation_hold";
  }
  if (!queued) return void 0;
  if (state.reconciliationHold !== null || state.pendingDispatchWaitReason === "reconciliation_hold") {
    return "reconciliation_hold";
  }
  return state.unavailableRetryWindow !== null || state.pendingDispatchWaitReason === "unavailable_retry" ? "unavailable_retry" : "active_agent_run";
}
__name(queuedDispatchWaitReason, "queuedDispatchWaitReason");
function recordNotificationRegistration(state, config, result, wasFrozen, now) {
  if (result.accepted <= 0) return;
  const queued = wasFrozen || !state.pending && state.queuedPending && state.queuedNotificationWindowStartedAt !== null;
  const nextAt = queued ? state.queuedDueAt : state.dueAt;
  recordDispatchHistory(state, now, {
    event: queued ? "notification_queued" : "notification_accepted",
    scopeMode: config.scopeMode,
    batchSequence: queued ? state.triggerSequence + 1 : void 0,
    notificationCount: result.accepted,
    nextAt: nextAt === null || nextAt === void 0 ? void 0 : new Date(nextAt).toISOString(),
    waitReason: queuedDispatchWaitReason(state, queued)
  });
}
__name(recordNotificationRegistration, "recordNotificationRegistration");
function createPendingTriggerScope(state, config, now) {
  if (config.scopeMode === "new-email-tickets") {
    if (state.pendingReason !== "new_message" || state.pendingNotificationWindowStartedAt === null) {
      return null;
    }
    const windowStart = state.pendingNotificationWindowStartedAt;
    if (config.fastTargetedModeEnabled) {
      state.pendingNotificationWindowEndedAt = Math.max(
        windowStart,
        Math.min(state.pendingNotificationWindowEndedAt ?? now, now)
      );
    } else {
      state.pendingNotificationWindowEndedAt ??= windowStart + config.debounceMs + config.cooldownMs + config.maxDebounceMs;
    }
    return {
      mode: "new-email-tickets",
      createdFrom: new Date(Math.max(
        0,
        windowStart - (state.pendingNotificationLookbackMs ?? config.newEmailLookbackMs)
      )).toISOString(),
      createdTo: new Date(state.pendingNotificationWindowEndedAt).toISOString(),
      source: "EMAIL"
    };
  }
  return {
    mode: "full-new-calls",
    reason: state.pendingReason === "lifecycle" ? "lifecycle-recovery" : "configured"
  };
}
__name(createPendingTriggerScope, "createPendingTriggerScope");
function effectiveResultDeadlineAt(state, config, now) {
  const persistedDeadline = state.resultDeadlineAt ?? state.dueAt;
  if (state.acceptedRunLeaseUnknown) return state.dueAt ?? persistedDeadline;
  const acceptedAt = state.lastAcceptedTrigger?.acceptedAt;
  if (!acceptedAt) return persistedDeadline;
  const acceptedTime = Date.parse(acceptedAt);
  if (!Number.isFinite(acceptedTime)) return persistedDeadline;
  const configuredDeadlines = [acceptedTime + config.resultWatchdogMs];
  if (config.staleRunRecoveryEnabled) {
    configuredDeadlines.push(acceptedTime + config.acceptedRunMaxAgeMs);
  }
  const configuredDeadline = Math.min(...configuredDeadlines);
  if (persistedDeadline === null) return configuredDeadline;
  const pollingScheduleActive = state.resultDeadlineAt !== null && state.dueAt !== null && state.dueAt !== state.resultDeadlineAt;
  if (config.resultPollDueGatingEnabled && now !== void 0 && pollingScheduleActive && state.dueAt > now && configuredDeadline <= now) {
    return state.dueAt;
  }
  return Math.min(persistedDeadline, configuredDeadline);
}
__name(effectiveResultDeadlineAt, "effectiveResultDeadlineAt");
function acceptedRunAgeMs(state, now) {
  const acceptedAt = state.lastAcceptedTrigger?.acceptedAt;
  if (!acceptedAt) return null;
  const acceptedTime = Date.parse(acceptedAt);
  if (!Number.isFinite(acceptedTime)) return null;
  return Math.max(0, now - acceptedTime);
}
__name(acceptedRunAgeMs, "acceptedRunAgeMs");
function staleAcceptedRunFailureDiagnostics(diagnostics, config) {
  return [
    ...agentRunFailureDiagnostics(diagnostics),
    {
      stage: "agent_run_status",
      errorType: "stale_run",
      errorCode: "accepted_run_max_age_exceeded",
      message: `Accepted Agent run exceeded the ${Math.floor(config.acceptedRunMaxAgeMs / 1e3)} second maximum age.`,
      ...diagnostics.httpStatus === void 0 ? {} : { httpStatus: diagnostics.httpStatus }
    }
  ].slice(0, 32);
}
__name(staleAcceptedRunFailureDiagnostics, "staleAcceptedRunFailureDiagnostics");
function keepUnknownAcceptedLease(state, config, now) {
  const nextAt = Math.max(now + config.resultWatchdogMs, state.cooldownUntil);
  state.acceptedRunLeaseUnknown = true;
  state.resultDeadlineAt = nextAt;
  state.dueAt = nextAt;
  markFailure(state, "ambiguous", now, nextAt);
  recordDispatchHistory(state, now, {
    event: "active_run_wait",
    attempt: state.dispatchAttempt > 0 ? state.dispatchAttempt : void 0,
    retryCount: state.retryCount,
    agentRunIdPresent: false,
    nextAt: new Date(nextAt).toISOString(),
    waitMs: nextAt - now,
    waitReason: "result_watchdog"
  }, state.pendingTriggerScope);
}
__name(keepUnknownAcceptedLease, "keepUnknownAcceptedLease");
function widenTargetedEmailScopeForRecovery(state, config) {
  if (!config.fastTargetedModeEnabled || state.pendingTriggerScope?.mode !== "new-email-tickets" || state.pendingNotificationWindowStartedAt === null) {
    return;
  }
  const widenedCreatedFrom = new Date(Math.max(
    0,
    state.pendingNotificationWindowStartedAt - config.newEmailLookbackMs
  )).toISOString();
  const currentCreatedFrom = Date.parse(state.pendingTriggerScope.createdFrom);
  const widenedTime = Date.parse(widenedCreatedFrom);
  if (!Number.isFinite(currentCreatedFrom) || widenedTime < currentCreatedFrom) {
    state.pendingTriggerScope.createdFrom = widenedCreatedFrom;
  }
  state.pendingNotificationLookbackMs = Math.max(
    state.pendingNotificationLookbackMs ?? 0,
    config.newEmailLookbackMs
  );
}
__name(widenTargetedEmailScopeForRecovery, "widenTargetedEmailScopeForRecovery");
function recoverStaleBroadScope(state, config, now) {
  if (config.scopeMode !== "new-email-tickets" || !state.pending || state.executionPhase === "awaiting_result" || state.pendingTriggerScope?.mode !== "full-new-calls") {
    return;
  }
  if (state.pendingNotificationWindowStartedAt !== null) {
    recordDispatchHistory(state, now, {
      event: "orphan_recovered",
      failureKind: "ambiguous",
      attempt: state.dispatchAttempt > 0 ? state.dispatchAttempt : void 0,
      retryCount: state.retryCount,
      waitReason: "bounded_recovery"
    }, state.pendingTriggerScope);
    state.pendingReason = "new_message";
    state.pendingNotificationWindowEndedAt ??= state.pendingNotificationWindowStartedAt + config.debounceMs + config.cooldownMs + config.maxDebounceMs;
    state.pendingTriggerScope = null;
    state.executionPhase = "pending_dispatch";
    state.dispatchAttempt = 0;
    state.resultDeadlineAt = null;
    state.retryCount = 0;
    state.dueAt = now;
    return;
  }
  recordDispatchHistory(state, now, {
    event: "orphan_recovered",
    failureKind: "ambiguous",
    attempt: state.dispatchAttempt > 0 ? state.dispatchAttempt : void 0,
    retryCount: state.retryCount,
    waitReason: "bounded_recovery"
  }, state.pendingTriggerScope);
  resetPendingDispatch(state);
  promoteQueuedDispatchSafely(state, now, config);
}
__name(recoverStaleBroadScope, "recoverStaleBroadScope");
function queueCurrentEmailWindow(state, now) {
  if (state.pendingNotificationWindowStartedAt === null) return false;
  const currentStart = state.pendingNotificationWindowStartedAt;
  const currentEnd = state.pendingNotificationWindowEndedAt ?? currentStart;
  const currentLastNotification = state.lastNotificationAt ?? currentStart;
  const currentDebounceStart = state.debounceWindowStartedAt ?? currentStart;
  if (state.queuedPending && state.queuedNotificationWindowStartedAt !== null) {
    state.queuedNotificationWindowStartedAt = Math.min(
      state.queuedNotificationWindowStartedAt,
      currentStart
    );
    state.queuedNotificationWindowEndedAt = Math.max(
      state.queuedNotificationWindowEndedAt ?? currentEnd,
      currentEnd
    );
    state.queuedLastNotificationAt = Math.max(
      state.queuedLastNotificationAt ?? currentLastNotification,
      currentLastNotification
    );
    state.queuedDebounceWindowStartedAt = Math.min(
      state.queuedDebounceWindowStartedAt ?? currentDebounceStart,
      currentDebounceStart
    );
    state.queuedNotificationLookbackMs = Math.max(
      state.queuedNotificationLookbackMs ?? 0,
      state.pendingNotificationLookbackMs ?? 0
    );
  } else {
    state.queuedPending = true;
    state.queuedReason = "new_message";
    state.queuedNotificationWindowStartedAt = currentStart;
    state.queuedNotificationWindowEndedAt = currentEnd;
    state.queuedLastNotificationAt = currentLastNotification;
    state.queuedDebounceWindowStartedAt = currentDebounceStart;
    state.queuedNotificationLookbackMs = state.pendingNotificationLookbackMs;
  }
  state.queuedReason = "new_message";
  state.queuedDueAt = now;
  return true;
}
__name(queueCurrentEmailWindow, "queueCurrentEmailWindow");
function nextDeferredAt(state, config) {
  if (state.unavailableRetryWindow !== null) {
    return state.unavailableRetryWindow.dueAt;
  }
  const candidates = [
    state.reconciliationHold !== null ? state.reconciliationHold.dueAt : void 0,
    state.queuedPending && !(state.queuedBlockedByAttention && state.attentionBlockedWindow === null) && !(config !== void 0 && queuedOverlapsAttention(state, config)) && !(config !== void 0 && queuedOverlapsReconciliationHold(state, config)) && state.queuedDueAt !== null ? state.queuedDueAt : void 0
  ].filter((at) => at !== void 0 && Number.isFinite(at));
  return candidates.length === 0 ? void 0 : Math.min(...candidates);
}
__name(nextDeferredAt, "nextDeferredAt");
function nextScheduledAt(state, now = Date.now(), config) {
  const candidates = [state.dueAt, nextDeferredAt(state, config)].filter((at) => at !== null && at !== void 0 && Number.isFinite(at));
  const next = candidates.length === 0 ? void 0 : Math.min(...candidates);
  if (state.sharedRateLimitUntil !== null && state.sharedRateLimitUntil > now) {
    return next === void 0 ? state.sharedRateLimitUntil : Math.max(next, state.sharedRateLimitUntil);
  }
  return next;
}
__name(nextScheduledAt, "nextScheduledAt");
function canPromoteQueuedDispatch(state, now, config) {
  if (!state.queuedPending || state.queuedBlockedByAttention && state.attentionBlockedWindow === null) return false;
  if (sharedRateLimitActive(state, now)) return false;
  if (queuedOverlapsAttention(state, config)) {
    parkQueuedAttentionWindow(state);
    return false;
  }
  if (queuedOverlapsReconciliationHold(state, config)) return false;
  return true;
}
__name(canPromoteQueuedDispatch, "canPromoteQueuedDispatch");
function promoteQueuedDispatchSafely(state, now, config) {
  return canPromoteQueuedDispatch(state, now, config) && promoteQueuedDispatch(state, now, config);
}
__name(promoteQueuedDispatchSafely, "promoteQueuedDispatchSafely");
function promoteUnavailableRetryDispatchSafely(state, now, config) {
  if (sharedRateLimitActive(state, now)) return false;
  return promoteUnavailableRetryDispatch(state, now, config);
}
__name(promoteUnavailableRetryDispatchSafely, "promoteUnavailableRetryDispatchSafely");
function promoteDueDeferredDispatch(state, now, config, includeOrdinaryQueue = true) {
  if (sharedRateLimitActive(state, now)) return false;
  if (state.unavailableRetryWindow !== null) {
    if (state.unavailableRetryWindow.dueAt <= now) {
      return promoteUnavailableRetryDispatchSafely(state, now, config);
    }
    return false;
  }
  if (state.reconciliationHold !== null && state.reconciliationHold.dueAt <= now) {
    return promoteReconciliationHold(state, now);
  }
  if (!includeOrdinaryQueue && state.queuedUnavailableRetryCount <= 0) return false;
  if (state.queuedPending && (state.queuedDueAt === null || state.queuedDueAt <= now)) {
    return promoteQueuedDispatchSafely(state, now, config);
  }
  return false;
}
__name(promoteDueDeferredDispatch, "promoteDueDeferredDispatch");
function unavailableRetryWindowFromPending(state, retryCount, dueAt) {
  const scope = state.pendingTriggerScope;
  const windowStart = state.pendingNotificationWindowStartedAt;
  if (scope?.mode !== "new-email-tickets" || windowStart === null) return null;
  const scopeEnd = Date.parse(scope.createdTo);
  if (!Number.isFinite(scopeEnd)) return null;
  return {
    scope: { ...scope },
    notificationWindowStartedAt: windowStart,
    notificationWindowEndedAt: scopeEnd,
    notificationLookbackMs: state.pendingNotificationLookbackMs,
    lastNotificationAt: state.lastNotificationAt,
    debounceWindowStartedAt: state.debounceWindowStartedAt,
    retryCount,
    dueAt
  };
}
__name(unavailableRetryWindowFromPending, "unavailableRetryWindowFromPending");
function releaseUnavailableTargetedWindow(state, config, now, retryAfterSeconds) {
  const retryDelay = retryAfterSeconds === void 0 ? UNAVAILABLE_TRIGGER_RETRY_DELAY_MS : Math.min(
    Math.max(1e3, retryAfterSeconds * 1e3),
    config.resultMaxRetryAfterMs
  );
  const nextAt = now + retryDelay;
  const retryCount = Math.min(config.resultMaxRetries, state.retryCount + 1);
  const retryWindow = unavailableRetryWindowFromPending(state, retryCount, nextAt);
  if (retryWindow === null) return void 0;
  if (state.unavailableRetryWindow === null) {
    state.unavailableRetryWindow = retryWindow;
  } else {
    const existingQueuedDueAt = state.queuedDueAt;
    const existingQueuedRetryCount = state.queuedUnavailableRetryCount;
    if (!queueCurrentEmailWindow(state, now)) return void 0;
    state.queuedUnavailableRetryCount = Math.max(existingQueuedRetryCount, retryCount);
    state.queuedDueAt = existingQueuedRetryCount > 0 && existingQueuedDueAt !== null && existingQueuedDueAt > now ? existingQueuedDueAt : Math.max(existingQueuedDueAt ?? nextAt, nextAt);
  }
  resetPendingDispatch(state);
  const deferredAt = nextDeferredAt(state, config);
  markFailure(state, "configuration", now, deferredAt);
  return deferredAt;
}
__name(releaseUnavailableTargetedWindow, "releaseUnavailableTargetedWindow");
function recordUnavailableNeedsAttention(state, scope, now, retryCount, candidateFenceActive) {
  appendNeedsAttentionScope(state, scope);
  state.candidateAttentionFenceActive ||= candidateFenceActive;
  state.needsAttentionAt = now;
  state.needsAttentionRetryCount = retryCount;
  state.needsAttentionCount = Math.min(Number.MAX_SAFE_INTEGER, state.needsAttentionCount + 1);
  markFailure(state, "configuration", now);
  resetPendingDispatch(state);
}
__name(recordUnavailableNeedsAttention, "recordUnavailableNeedsAttention");
function appendNeedsAttentionScope(state, scope) {
  const protectedScope = scope.mode === "new-email-tickets" ? { ...scope } : { ...scope };
  if (!state.needsAttentionScopes.some((existing) => scopeIdentity(existing) === scopeIdentity(protectedScope))) {
    state.needsAttentionScopes = [...state.needsAttentionScopes, protectedScope].slice(-96);
  }
  state.needsAttentionScope = protectedScope;
  return protectedScope;
}
__name(appendNeedsAttentionScope, "appendNeedsAttentionScope");
function recordReconciliationNeedsAttention(state, scope, now, retryCount) {
  appendNeedsAttentionScope(state, scope);
  state.candidateAttentionFenceActive = true;
  state.needsAttentionAt = now;
  state.needsAttentionRetryCount = retryCount;
  state.needsAttentionCount = Math.min(Number.MAX_SAFE_INTEGER, state.needsAttentionCount + 1);
  markFailure(state, "ambiguous", now);
  resetPendingDispatch(state);
}
__name(recordReconciliationNeedsAttention, "recordReconciliationNeedsAttention");
function reconciliationHoldFromPending(state, now) {
  const scope = state.pendingTriggerScope;
  const triggerId = state.pendingTriggerId;
  const windowStartedAt = state.pendingNotificationWindowStartedAt;
  if (scope?.mode !== "new-email-tickets" || typeof triggerId !== "string" || windowStartedAt === null) return null;
  const scopeEnd = Date.parse(scope.createdTo);
  const windowEndedAt = state.pendingNotificationWindowEndedAt ?? scopeEnd;
  if (!Number.isFinite(scopeEnd) || windowEndedAt === null || !Number.isFinite(windowEndedAt)) return null;
  return {
    triggerId,
    scope: { ...scope },
    notificationWindowStartedAt: windowStartedAt,
    notificationWindowEndedAt: windowEndedAt,
    notificationLookbackMs: state.pendingNotificationLookbackMs,
    lastNotificationAt: state.lastNotificationAt,
    debounceWindowStartedAt: state.debounceWindowStartedAt,
    retryCount: state.retryCount,
    dispatchAttempt: state.dispatchAttempt,
    dueAt: state.dueAt ?? now
  };
}
__name(reconciliationHoldFromPending, "reconciliationHoldFromPending");
function promoteReconciliationHold(state, now) {
  const hold = state.reconciliationHold;
  if (hold === null || hold.dueAt > now || state.pending || sharedRateLimitActive(state, now)) return false;
  state.pending = true;
  state.pendingDispatchWasQueued = false;
  state.pendingDispatchWaitReason = "reconciliation_hold";
  state.pendingReason = "new_message";
  state.pendingTriggerId = hold.triggerId;
  state.pendingNotificationWindowStartedAt = hold.notificationWindowStartedAt;
  state.pendingNotificationWindowEndedAt = hold.notificationWindowEndedAt;
  state.pendingNotificationLookbackMs = hold.notificationLookbackMs;
  state.lastNotificationAt = hold.lastNotificationAt;
  state.debounceWindowStartedAt = hold.debounceWindowStartedAt;
  state.dueAt = now;
  state.pendingTriggerScope = { ...hold.scope };
  state.executionPhase = "pending_dispatch";
  state.dispatchAttempt = hold.dispatchAttempt;
  state.resultDeadlineAt = null;
  state.retryCount = hold.retryCount;
  state.emptyTargetedRecoveryPending = true;
  state.reconciliationHold = null;
  recordDispatchHistory(state, now, {
    event: "reconciliation_released",
    attempt: state.dispatchAttempt > 0 ? state.dispatchAttempt : void 0,
    retryCount: state.retryCount,
    waitReason: "reconciliation_hold",
    nextAt: new Date(now).toISOString()
  }, state.pendingTriggerScope);
  return true;
}
__name(promoteReconciliationHold, "promoteReconciliationHold");
function parkEmptyRecoveryForDisjointQueue(state, now, config) {
  if (!separationEnabled(config) || !state.pending || state.executionPhase !== "retry_wait" || !state.emptyTargetedRecoveryPending || state.pendingTriggerScope?.mode !== "new-email-tickets" || state.queuedPending === false || state.queuedNotificationWindowStartedAt === null || state.dueAt === null || state.dueAt <= now || state.reconciliationHold !== null || previousRetryRunNeedsDrain(state)) return false;
  const queuedScope = queuedEmailScope(state, config);
  const hold = reconciliationHoldFromPending(state, now);
  if (queuedScope === null || hold === null || !targetedScopesDisjoint(hold.scope, queuedScope)) return false;
  state.reconciliationHold = hold;
  recordDispatchHistory(state, now, {
    event: "reconciliation_parked",
    attempt: hold.dispatchAttempt > 0 ? hold.dispatchAttempt : void 0,
    retryCount: hold.retryCount,
    waitReason: "reconciliation_hold",
    nextAt: new Date(hold.dueAt).toISOString()
  }, hold.scope);
  resetPendingDispatch(state);
  return promoteQueuedDispatchSafely(state, now, config);
}
__name(parkEmptyRecoveryForDisjointQueue, "parkEmptyRecoveryForDisjointQueue");
function recoverStaleAcceptedRun(state, config, now, diagnostics) {
  if (!config.staleRunRecoveryEnabled || !state.pending || state.executionPhase !== "awaiting_result" && state.executionPhase !== "retry_wait" || typeof state.lastAcceptedTrigger?.runId !== "string") {
    return false;
  }
  const ageMs = acceptedRunAgeMs(state, now);
  if (ageMs === null || ageMs < config.acceptedRunMaxAgeMs) return false;
  if (separationEnabled(config) && (diagnostics.status === "queued" || diagnostics.status === "in_progress" || diagnostics.status === "suspended" || diagnostics.status === "unavailable")) return false;
  const scope = state.pendingTriggerScope;
  const failureDiagnostics = staleAcceptedRunFailureDiagnostics(diagnostics, config);
  recordDispatchHistory(state, now, {
    event: "stale_run_recovered",
    failureKind: "ambiguous",
    attempt: state.dispatchAttempt > 0 ? state.dispatchAttempt : void 0,
    retryCount: state.retryCount,
    agentRunIdPresent: true,
    agentRunStatus: diagnostics.status,
    httpStatus: diagnostics.httpStatus,
    errorType: diagnostics.errorType,
    errorCode: diagnostics.errorCode,
    upstreamRequestId: diagnostics.requestId,
    waitReason: "bounded_recovery",
    waitMs: Math.min(ageMs, 1e9),
    failureDiagnostics
  }, scope);
  if (scope?.mode === "new-email-tickets") {
    if (separationEnabled(config)) {
      recordReconciliationNeedsAttention(state, scope, now, state.retryCount);
      refreshQueuedAttentionBlock(state, config);
      promoteQueuedDispatchSafely(state, now, config);
      return true;
    }
    queueCurrentEmailWindow(state, now);
  }
  markFailure(state, "ambiguous", now);
  resetPendingDispatch(state);
  promoteQueuedDispatchSafely(state, now, config);
  return true;
}
__name(recoverStaleAcceptedRun, "recoverStaleAcceptedRun");
function recoverOrphanedAwaitingResult(state, config, now) {
  if (config.scopeMode !== "new-email-tickets" || !state.pending || state.executionPhase !== "awaiting_result" || typeof state.pendingTriggerId !== "string" || typeof state.lastAcceptedTrigger?.runId === "string") {
    return false;
  }
  if (state.acceptedRunLeaseUnknown) return false;
  const deadline = effectiveResultDeadlineAt(state, config, now);
  if (deadline === null || deadline > now) return false;
  if (state.pendingTriggerScope?.mode === "full-new-calls") {
    recordDispatchHistory(state, now, {
      event: "orphan_recovered",
      failureKind: "ambiguous",
      attempt: state.dispatchAttempt > 0 ? state.dispatchAttempt : void 0,
      retryCount: state.retryCount,
      agentRunIdPresent: false,
      failureDiagnostics: missingCallbackDiagnostics("agent_run_id_missing"),
      waitReason: "result_watchdog"
    }, state.pendingTriggerScope);
    markFailure(state, "ambiguous", now);
    resetPendingDispatch(state);
    return promoteQueuedDispatchSafely(state, now, config);
  }
  if (state.pendingTriggerScope?.mode !== "new-email-tickets" || state.pendingNotificationWindowStartedAt === null) {
    return false;
  }
  recordDispatchHistory(state, now, {
    event: "orphan_recovered",
    failureKind: "ambiguous",
    attempt: state.dispatchAttempt > 0 ? state.dispatchAttempt : void 0,
    retryCount: state.retryCount,
    agentRunIdPresent: false,
    failureDiagnostics: missingCallbackDiagnostics("agent_run_id_missing"),
    waitReason: "result_watchdog"
  }, state.pendingTriggerScope);
  const scope = state.pendingTriggerScope;
  if (scope?.mode === "new-email-tickets" && separationEnabled(config)) {
    keepUnknownAcceptedLease(state, config, now);
    return false;
  }
  queueCurrentEmailWindow(state, now);
  markFailure(state, "ambiguous", now);
  resetPendingDispatch(state);
  return promoteQueuedDispatchSafely(state, now, config);
}
__name(recoverOrphanedAwaitingResult, "recoverOrphanedAwaitingResult");
function recoverStaleRetryState(state, config, now) {
  if (!state.pending || state.executionPhase !== "retry_wait" || state.retryCount <= config.resultMaxRetries) {
    return null;
  }
  const previousRetryCount = state.retryCount;
  recordDispatchHistory(state, now, {
    event: "orphan_recovered",
    failureKind: "ambiguous",
    attempt: state.dispatchAttempt > 0 ? state.dispatchAttempt : void 0,
    retryCount: previousRetryCount,
    waitReason: "bounded_recovery"
  }, state.pendingTriggerScope);
  const scope = state.pendingTriggerScope;
  if (scope?.mode === "new-email-tickets" && separationEnabled(config)) {
    recordReconciliationNeedsAttention(state, scope, now, previousRetryCount);
    refreshQueuedAttentionBlock(state, config);
    return previousRetryCount;
  }
  if (state.pendingNotificationWindowStartedAt !== null) {
    queueCurrentEmailWindow(state, now);
  }
  markFailure(state, "ambiguous", now);
  resetPendingDispatch(state);
  return previousRetryCount;
}
__name(recoverStaleRetryState, "recoverStaleRetryState");
var TERMINAL_OPERATION_STATES = /* @__PURE__ */ new Set([
  "CompletedWithFailures",
  "Failed",
  "Cancelled"
]);
var PENDING_OPERATION_STATES = /* @__PURE__ */ new Set([
  "Running",
  "ContinuationRequired",
  "Rescheduled"
]);
function operationContinuationDisposition(report) {
  const metadata = report.metadata;
  if (metadata?.failureStage !== "operation_continuation") return "not_applicable";
  const hasCorrelation = metadata.operationId !== void 0 || metadata.resultReference !== void 0;
  const operation = metadata.operationStatus;
  if (!hasCorrelation || operation === void 0) return "human_reconciliation";
  const unsafeAmbiguity = operation.humanReconciliationRequired === true || (operation.ambiguousWriteCount ?? 0) > 0;
  if (unsafeAmbiguity) return "human_reconciliation";
  const terminal = TERMINAL_OPERATION_STATES.has(operation.state);
  const pending = PENDING_OPERATION_STATES.has(operation.state);
  if (report.status === "complete") {
    if (terminal || operation.continuationRequired === false && operation.pendingCount !== void 0 && operation.pendingCount > 0) {
      return operation.replaySafe === true ? "replayable_failure" : "human_reconciliation";
    }
    if (pending || operation.continuationRequired === true) return "handoff";
    if (operation.state === "Completed" && (operation.failedCount ?? 0) === 0 && (operation.partialWriteCount ?? 0) === 0 && (operation.waitingForRateLimitCount ?? 0) === 0) {
      return "final_success";
    }
    return operation.replaySafe === true ? "replayable_failure" : "human_reconciliation";
  }
  if (report.status !== "terminal_failure") return "human_reconciliation";
  if (terminal && operation.replaySafe === true) return "replayable_failure";
  return "human_reconciliation";
}
__name(operationContinuationDisposition, "operationContinuationDisposition");
function completionReportIsConsistent(report) {
  if (report.status !== "complete" || !report.metadata) return true;
  const metadata = report.metadata;
  const ticketOutcomes = metadata.ticketOutcomes;
  if (ticketOutcomes !== void 0 && ticketOutcomes.length > 0) {
    if (metadata.ticketsConsidered === void 0 || metadata.ticketsCompleted === void 0 || metadata.ticketsDeferred === void 0 || metadata.ticketsConsidered !== ticketOutcomes.length || metadata.ticketsCompleted + metadata.ticketsDeferred !== metadata.ticketsConsidered) return false;
    if (metadata.mcpExecution === void 0 && ticketOutcomes.some((item) => item.outcome === "skipped" && item.reasonCode === "already_handled")) return false;
  }
  const continuationDisposition = operationContinuationDisposition(report);
  if (metadata.failureStage === "operation_continuation") {
    return continuationDisposition === "handoff" || continuationDisposition === "final_success";
  }
  if (isProvenAlreadyHandledCompletion(report)) return true;
  const successfulApply = metadata.failureStage === "triage_apply" && metadata.ticketsConsidered !== void 0 && metadata.ticketsConsidered > 0 && metadata.ticketsCompleted !== void 0 && metadata.ticketsDeferred !== void 0 && metadata.ticketsCompleted + metadata.ticketsDeferred === metadata.ticketsConsidered && metadata.ticketsDeferred === 0;
  if (successfulApply) return true;
  if (metadata.failureStage !== void 0) {
    return false;
  }
  if ((metadata.ticketsDeferred ?? 0) > 0) return false;
  if (metadata.ticketsConsidered !== void 0 && (metadata.ticketsCompleted ?? 0) < metadata.ticketsConsidered) {
    return false;
  }
  return true;
}
__name(completionReportIsConsistent, "completionReportIsConsistent");
function isEmptyTargetedQueryCompletion(report) {
  const ticketOutcomes = report.metadata?.ticketOutcomes;
  if (report.status !== "complete" || report.metadata?.failureStage !== "bounded_query" || report.metadata.ticketsConsidered !== 0 || report.metadata.ticketsCompleted !== 0 || (report.metadata.ticketsDeferred ?? 0) !== 0) return false;
  if (ticketOutcomes !== void 0 && ticketOutcomes.length > 0) return false;
  return true;
}
__name(isEmptyTargetedQueryCompletion, "isEmptyTargetedQueryCompletion");
function hasUnfinishedTargetedWork(report) {
  if (!report.metadata) return false;
  const continuationDisposition = operationContinuationDisposition(report);
  if (continuationDisposition === "human_reconciliation") return false;
  if (continuationDisposition === "replayable_failure") {
    return report.status === "terminal_failure" && ((report.metadata.ticketsConsidered ?? 0) > 0 || (report.metadata.operationStatus?.failedCount ?? 0) > 0);
  }
  if (report.status !== "terminal_failure") return false;
  const metadata = report.metadata;
  if (metadata.failureStage !== "bounded_query" && metadata.failureStage !== "evidence_recovery" && metadata.failureStage !== "triage_apply" && metadata.failureStage !== "operation_continuation") return false;
  const considered = metadata.ticketsConsidered;
  const completed = metadata.ticketsCompleted;
  const deferred = metadata.ticketsDeferred;
  if (considered === void 0 || completed === void 0 || deferred === void 0) {
    return true;
  }
  if (considered <= 0) return false;
  if (completed === considered && deferred === 0) return false;
  return completed < considered || deferred > 0;
}
__name(hasUnfinishedTargetedWork, "hasUnfinishedTargetedWork");
function targetedReconciliationRetryAt(state, config, now) {
  const report = state.lastResultReport;
  if (config.scopeMode !== "new-email-tickets" || state.pendingTriggerScope?.mode !== "new-email-tickets" || state.executionPhase !== "retry_wait" || state.retryCount <= 0 || report?.status !== "terminal_failure" || report.metadata?.failureStage === void 0 || !["bounded_query", "evidence_recovery", "triage_apply", "operation_continuation"].includes(
    report.metadata.failureStage
  )) return void 0;
  return now + targetedReconciliationRetryDelayMs(state.retryCount);
}
__name(targetedReconciliationRetryAt, "targetedReconciliationRetryAt");
function previousRetryRunNeedsDrain(state) {
  const report = state.lastResultReport;
  const accepted = state.lastAcceptedTrigger;
  return state.pendingDispatchWaitReason !== "unavailable_retry" && state.executionPhase === "retry_wait" && report !== null && report.status !== "complete" && accepted !== null && typeof accepted.runId === "string" && report.triggerId === accepted.triggerId && report.attempt === state.dispatchAttempt;
}
__name(previousRetryRunNeedsDrain, "previousRetryRunNeedsDrain");
var CoordinatorEngine = class {
  constructor(deps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }
  deps;
  static {
    __name(this, "CoordinatorEngine");
  }
  now;
  async accept(collection) {
    const now = this.now();
    const state = normalizeState(await this.deps.store.load());
    migrateLegacyAttentionBlockedQueue(state);
    clearExpiredSharedRateLimit(state, now);
    recoverOrphanedAwaitingResult(state, this.deps.config, now);
    recoverStaleRetryState(state, this.deps.config, now);
    if (!state.pending) {
      promoteDueDeferredDispatch(state, now, this.deps.config, false);
    }
    const wasFrozen = currentBatchIsFrozen(state);
    const result = registerNotifications(
      state,
      collection,
      this.deps.config.graphWebhookClientState,
      this.deps.config,
      now,
      this.deps.config.fastTargetedModeEnabled ? this.deps.config.fastNewEmailLookbackMs : this.deps.config.newEmailLookbackMs
    );
    blockPendingIfAttentionOverlaps(state, this.deps.config, now);
    refreshQueuedAttentionBlock(state, this.deps.config);
    recordNotificationRegistration(state, this.deps.config, result, wasFrozen, now);
    refreshQueuedAttentionBlock(state, this.deps.config);
    await this.deps.store.save(state);
    const nextAt = nextScheduledAt(state, now, this.deps.config);
    if (nextAt !== void 0) await this.deps.store.setAlarm(nextAt);
    this.deps.logger?.info("coordinator_notification_state", {
      phase: state.executionPhase,
      queuedPending: state.queuedPending,
      dispatchAttempt: state.dispatchAttempt,
      retryCount: state.retryCount,
      nextAt: nextScheduledAt(state, now, this.deps.config) === void 0 ? null : new Date(nextScheduledAt(state, now, this.deps.config)).toISOString(),
      notificationReceivedAt: state.pendingNotificationWindowStartedAt === null ? null : new Date(state.pendingNotificationWindowStartedAt).toISOString(),
      queuedNotificationReceivedAt: state.queuedNotificationWindowStartedAt === null ? null : new Date(state.queuedNotificationWindowStartedAt).toISOString(),
      notificationAgeMs: state.pendingNotificationWindowStartedAt === null ? null : Math.max(0, now - state.pendingNotificationWindowStartedAt),
      queuedNotificationAgeMs: state.queuedNotificationWindowStartedAt === null ? null : Math.max(0, now - state.queuedNotificationWindowStartedAt),
      acceptedNotificationCount: state.acceptedNotificationCount,
      rejectedNotificationCount: state.rejectedNotificationCount,
      duplicateNotificationCount: state.duplicateNotificationCount
    });
    return result;
  }
  async sweepRecentMessages() {
    const empty = {
      discovered: 0,
      accepted: 0,
      duplicates: 0,
      rejected: 0,
      partial: false
    };
    if (!this.deps.config.enabled || !this.deps.config.graphSweepEnabled) {
      return { status: "disabled", ...empty };
    }
    if (!this.deps.graph || missingGraphConfiguration(this.deps.config).length > 0) {
      return { status: "not_configured", ...empty };
    }
    const now = this.now();
    const state = normalizeState(await this.deps.store.load());
    migrateLegacyAttentionBlockedQueue(state);
    clearExpiredSharedRateLimit(state, now);
    const overlapMs = Math.max(
      12e4,
      this.deps.config.debounceMs + this.deps.config.fastIngestionGraceMs
    );
    const since = state.lastGraphSweepAt === null ? Math.max(0, now - this.deps.config.graphSweepLookbackMs) : Math.max(0, state.lastGraphSweepAt - overlapMs);
    try {
      const sweep = await this.deps.graph.listRecentEmailNotifications(
        since,
        this.deps.config.graphSweepMaxMessages
      );
      recoverOrphanedAwaitingResult(state, this.deps.config, now);
      recoverStaleRetryState(state, this.deps.config, now);
      if (!state.pending) {
        promoteDueDeferredDispatch(state, now, this.deps.config, false);
      }
      const wasFrozen = currentBatchIsFrozen(state);
      const result = registerNotifications(
        state,
        { value: sweep.notifications },
        this.deps.config.graphWebhookClientState,
        this.deps.config,
        now,
        this.deps.config.newEmailLookbackMs
      );
      blockPendingIfAttentionOverlaps(state, this.deps.config, now);
      refreshQueuedAttentionBlock(state, this.deps.config);
      recordNotificationRegistration(state, this.deps.config, result, wasFrozen, now);
      refreshQueuedAttentionBlock(state, this.deps.config);
      state.lastGraphSweepAt = now;
      state.lastGraphSweepMessageCount = sweep.notifications.length;
      state.lastGraphSweepErrorAt = null;
      await this.deps.store.save(state);
      const scheduledAt = nextScheduledAt(state, now, this.deps.config);
      if (scheduledAt !== void 0) await this.deps.store.setAlarm(scheduledAt);
      this.deps.logger?.info("graph_message_sweep_completed", {
        discovered: sweep.notifications.length,
        partial: sweep.partial,
        accepted: result.accepted,
        duplicates: result.duplicates,
        rejected: result.rejected,
        scheduledAtPresent: scheduledAt !== void 0
      });
      return {
        status: "updated",
        discovered: sweep.notifications.length,
        accepted: result.accepted,
        duplicates: result.duplicates,
        rejected: result.rejected,
        partial: sweep.partial
      };
    } catch (error) {
      state.lastGraphSweepErrorAt = now;
      markFailure(state, "subscription", now);
      await this.deps.store.save(state);
      this.deps.logger?.warn("graph_message_sweep_failed", {
        reason: error instanceof GraphApiError ? "request" : "unknown",
        status: error instanceof GraphApiError ? error.status : null
      });
      return { status: "failed", ...empty, ...graphFailureHistoryDetails(error) };
    }
  }
  async maintainSubscription() {
    if (!this.deps.config.enabled) return { status: "disabled" };
    if (!this.deps.graph || missingGraphConfiguration(this.deps.config).length > 0) {
      return { status: "not_configured" };
    }
    const now = this.now();
    const state = normalizeState(await this.deps.store.load());
    try {
      state.subscription = await this.deps.graph.ensure(state.subscription, now);
      state.lastFailure = null;
      state.lifecycleRecoveryRequested = false;
      await this.deps.store.save(state);
      return { status: "updated" };
    } catch (error) {
      markFailure(state, "subscription", now);
      await this.deps.store.save(state);
      this.deps.logger?.warn("graph_subscription_maintenance_failed", {
        reason: error instanceof GraphConfigurationError ? "configuration" : "request",
        ...error instanceof GraphApiError ? { operation: error.operation, status: error.status, ...error.metadata } : {}
      });
      return { status: "failed", ...graphFailureHistoryDetails(error) };
    }
  }
  async processAlarm() {
    const now = this.now();
    const state = normalizeState(await this.deps.store.load());
    migrateLegacyAttentionBlockedQueue(state);
    clearExpiredSharedRateLimit(state, now);
    const scheduledAt = nextScheduledAt(state, now, this.deps.config);
    recoverOrphanedAwaitingResult(state, this.deps.config, now);
    const staleRetryCount = recoverStaleRetryState(state, this.deps.config, now);
    parkEmptyRecoveryForDisjointQueue(state, now, this.deps.config);
    if (staleRetryCount !== null) {
      this.deps.logger?.warn("stale_retry_state_recovered", {
        previousRetryCount: staleRetryCount,
        retryCount: state.retryCount,
        pending: state.pending,
        queuedPending: state.queuedPending
      });
    }
    this.deps.logger?.info("coordinator_state_checked", {
      pending: state.pending,
      phase: state.executionPhase,
      scopeMode: state.pendingTriggerScope?.mode ?? null,
      acceptedRunIdPresent: state.executionPhase === "awaiting_result" && typeof state.lastAcceptedTrigger?.runId === "string",
      resultDeadlineExpired: (effectiveResultDeadlineAt(state, this.deps.config, now) ?? Number.POSITIVE_INFINITY) <= now,
      queuedPending: state.queuedPending,
      notificationReceivedAt: state.pendingNotificationWindowStartedAt === null ? null : new Date(state.pendingNotificationWindowStartedAt).toISOString(),
      queuedNotificationReceivedAt: state.queuedNotificationWindowStartedAt === null ? null : new Date(state.queuedNotificationWindowStartedAt).toISOString(),
      nextAt: nextScheduledAt(state, now, this.deps.config) === void 0 ? null : new Date(nextScheduledAt(state, now, this.deps.config)).toISOString(),
      notificationAgeMs: state.pendingNotificationWindowStartedAt === null ? null : Math.max(0, now - state.pendingNotificationWindowStartedAt),
      queuedNotificationAgeMs: state.queuedNotificationWindowStartedAt === null ? null : Math.max(0, now - state.queuedNotificationWindowStartedAt),
      staleRetryRecovered: staleRetryCount !== null,
      pendingDispatchWaitReason: state.pendingDispatchWaitReason
    });
    if (!state.pending) {
      if (!promoteDueDeferredDispatch(state, now, this.deps.config)) {
        const nextAt = nextScheduledAt(state, now, this.deps.config);
        if (nextAt !== void 0) {
          await this.deps.store.save(state);
          await this.deps.store.setAlarm(nextAt);
          return { status: "retry_scheduled", nextAt };
        }
      }
    }
    recoverStaleBroadScope(state, this.deps.config, now);
    if (!state.pending) {
      await this.deps.store.save(state);
      return { status: "idle" };
    }
    if (!this.deps.config.enabled) {
      await this.deps.store.save(state);
      return { status: "disabled" };
    }
    if (sharedRateLimitActive(state, now) && state.executionPhase !== "awaiting_result") {
      const nextAt = nextScheduledAt(state, now, this.deps.config);
      await this.deps.store.save(state);
      if (nextAt !== void 0) await this.deps.store.setAlarm(nextAt);
      return { status: "retry_scheduled", nextAt };
    }
    if (state.executionPhase === "retry_wait" && state.retryCount > 0 && !state.emptyTargetedRecoveryPending && this.deps.config.scopeMode === "new-email-tickets" && state.pendingTriggerScope?.mode === "new-email-tickets" && state.lastResultReport !== null && isEmptyTargetedQueryCompletion(state.lastResultReport)) {
      recordDispatchHistory(state, now, {
        event: "batch_completed",
        ...resultHistoryDetails(state.lastResultReport)
      }, state.pendingTriggerScope);
      const nextAt = this.finishCurrent(state, now);
      await this.deps.store.save(state);
      if (nextAt !== void 0) await this.deps.store.setAlarm(nextAt);
      return {
        status: "complete",
        triggerId: state.lastResultReport.triggerId,
        nextAt
      };
    }
    if (state.executionPhase === "awaiting_result") {
      const deadline = effectiveResultDeadlineAt(state, this.deps.config, now);
      if (deadline !== null && deadline > now) {
        recordDispatchHistory(state, now, {
          event: "active_run_wait",
          attempt: state.dispatchAttempt > 0 ? state.dispatchAttempt : void 0,
          retryCount: state.retryCount,
          agentRunIdPresent: typeof state.lastAcceptedTrigger?.runId === "string",
          nextAt: new Date(deadline).toISOString(),
          waitMs: deadline - now,
          waitReason: "result_watchdog"
        }, state.pendingTriggerScope);
        await this.deps.store.save(state);
        await this.deps.store.setAlarm(deadline);
        return {
          status: "awaiting_result",
          nextAt: deadline,
          triggerId: state.pendingTriggerId ?? void 0
        };
      }
      if (state.lastAcceptedTrigger?.runId) {
        const statusPollStartedAt = this.deps.config.agentTimingTelemetryEnabled ? this.now() : void 0;
        const diagnostics = await this.deps.agent.getRunDiagnostics(state.lastAcceptedTrigger.runId);
        const runStatus = diagnostics.status;
        const statusPollDurationMs = statusPollStartedAt === void 0 ? void 0 : boundedAgentTimingMs(this.now() - statusPollStartedAt);
        const statusPollNumber = statusPollStartedAt === void 0 ? void 0 : agentStatusPollCount(
          state,
          state.pendingTriggerId,
          state.dispatchAttempt
        ) + 1;
        recordDispatchHistory(state, now, {
          event: "agent_run_status_checked",
          attempt: state.dispatchAttempt > 0 ? state.dispatchAttempt : void 0,
          retryCount: state.retryCount,
          agentRunIdPresent: true,
          agentRunStatus: runStatus,
          httpStatus: diagnostics.httpStatus,
          errorType: diagnostics.errorType,
          errorCode: diagnostics.errorCode,
          upstreamRequestId: diagnostics.requestId,
          failureDiagnostics: agentRunFailureDiagnostics(diagnostics),
          ...statusPollNumber === void 0 ? {} : { agentStatusPollCount: statusPollNumber },
          ...statusPollDurationMs === void 0 ? {} : { agentStatusPollDurationMs: statusPollDurationMs }
        }, state.pendingTriggerScope);
        this.deps.logger?.info("agent_run_status_checked", { status: runStatus });
        if (runStatus === "completed" || runStatus === "failed") {
          recordDispatchHistory(state, now, {
            event: "orphan_recovered",
            failureKind: "ambiguous",
            attempt: state.dispatchAttempt > 0 ? state.dispatchAttempt : void 0,
            retryCount: state.retryCount,
            agentRunIdPresent: true,
            agentRunStatus: runStatus,
            failureDiagnostics: missingCallbackDiagnostics("result_callback_missing"),
            waitReason: "result_watchdog"
          }, state.pendingTriggerScope);
          const terminalScope = state.pendingTriggerScope;
          if (terminalScope?.mode === "new-email-tickets" && separationEnabled(this.deps.config)) {
            recordReconciliationNeedsAttention(state, terminalScope, now, state.retryCount);
            refreshQueuedAttentionBlock(state, this.deps.config);
          } else {
            if (terminalScope?.mode === "new-email-tickets") {
              queueCurrentEmailWindow(state, now);
            }
            markFailure(state, "ambiguous", now);
          }
          const nextAt3 = this.finishCurrent(state, now);
          await this.deps.store.save(state);
          if (nextAt3 !== void 0) await this.deps.store.setAlarm(nextAt3);
          return {
            status: nextAt3 === void 0 ? "permanent_failure" : "retry_scheduled",
            nextAt: nextAt3
          };
        }
        const acceptedRunAge = acceptedRunAgeMs(state, now);
        if (recoverStaleAcceptedRun(state, this.deps.config, now, diagnostics)) {
          const nextAt3 = state.pending ? Math.max(state.dueAt ?? now, state.cooldownUntil) : void 0;
          await this.deps.store.save(state);
          if (nextAt3 !== void 0) await this.deps.store.setAlarm(nextAt3);
          this.deps.logger?.warn("stale_agent_run_recovered", {
            status: runStatus,
            ageMs: acceptedRunAge ?? null,
            maxAgeMs: this.deps.config.acceptedRunMaxAgeMs,
            queuedPending: state.queuedPending
          });
          return {
            status: nextAt3 === void 0 ? "permanent_failure" : "retry_scheduled",
            nextAt: nextAt3,
            triggerId: state.pendingTriggerId ?? void 0
          };
        }
        const nextAt2 = now + this.deps.config.resultWatchdogMs;
        recordDispatchHistory(state, now, {
          event: "active_run_wait",
          attempt: state.dispatchAttempt > 0 ? state.dispatchAttempt : void 0,
          retryCount: state.retryCount,
          agentRunIdPresent: true,
          agentRunStatus: runStatus,
          httpStatus: diagnostics.httpStatus,
          errorType: diagnostics.errorType,
          errorCode: diagnostics.errorCode,
          upstreamRequestId: diagnostics.requestId,
          nextAt: new Date(nextAt2).toISOString(),
          waitMs: nextAt2 - now,
          waitReason: "result_watchdog"
        }, state.pendingTriggerScope);
        state.dueAt = nextAt2;
        if (runStatus !== "queued" && runStatus !== "in_progress") {
          markFailure(state, "ambiguous", now, nextAt2);
        }
        await this.deps.store.save(state);
        await this.deps.store.setAlarm(nextAt2);
        return {
          status: "result_overdue",
          nextAt: nextAt2,
          triggerId: state.pendingTriggerId ?? void 0
        };
      }
      const nextAt = now + this.deps.config.resultWatchdogMs;
      recordDispatchHistory(state, now, {
        event: "active_run_wait",
        attempt: state.dispatchAttempt > 0 ? state.dispatchAttempt : void 0,
        retryCount: state.retryCount,
        agentRunIdPresent: false,
        nextAt: new Date(nextAt).toISOString(),
        waitMs: nextAt - now,
        waitReason: "result_watchdog"
      }, state.pendingTriggerScope);
      state.dueAt = nextAt;
      markFailure(state, "ambiguous", now, nextAt);
      await this.deps.store.save(state);
      await this.deps.store.setAlarm(nextAt);
      return {
        status: "result_overdue",
        nextAt,
        triggerId: state.pendingTriggerId ?? void 0
      };
    }
    const acceleratedRetryAt = targetedReconciliationRetryAt(state, this.deps.config, now);
    if (acceleratedRetryAt !== void 0 && (state.dueAt === null || state.dueAt > acceleratedRetryAt)) {
      state.dueAt = acceleratedRetryAt;
      markFailure(state, "transient", now, acceleratedRetryAt);
      recordDispatchHistory(state, now, {
        event: "retry_scheduled",
        attempt: state.dispatchAttempt > 0 ? state.dispatchAttempt : void 0,
        retryCount: state.retryCount,
        failureKind: "transient",
        failureStage: state.lastResultReport?.metadata?.failureStage,
        nextAt: new Date(acceleratedRetryAt).toISOString(),
        waitMs: acceleratedRetryAt - now,
        waitReason: "bounded_recovery"
      }, state.pendingTriggerScope);
      await this.deps.store.save(state);
      await this.deps.store.setAlarm(acceleratedRetryAt);
      this.deps.logger?.info("targeted_retry_accelerated", {
        retryCount: state.retryCount,
        failureStage: state.lastResultReport?.metadata?.failureStage ?? null,
        nextAt: new Date(acceleratedRetryAt).toISOString()
      });
      return {
        status: "retry_scheduled",
        nextAt: acceleratedRetryAt,
        triggerId: state.pendingTriggerId ?? void 0
      };
    }
    const dueAt = state.dueAt;
    if (dueAt !== null && dueAt > now) {
      await this.deps.store.save(state);
      await this.deps.store.setAlarm(dueAt);
      return {
        status: state.executionPhase === "retry_wait" ? "retry_scheduled" : "cooldown",
        nextAt: dueAt,
        triggerId: state.pendingTriggerId ?? void 0
      };
    }
    if (previousRetryRunNeedsDrain(state)) {
      const statusPollStartedAt = this.deps.config.agentTimingTelemetryEnabled ? this.now() : void 0;
      const diagnostics = await this.deps.agent.getRunDiagnostics(state.lastAcceptedTrigger.runId);
      const statusPollDurationMs = statusPollStartedAt === void 0 ? void 0 : boundedAgentTimingMs(this.now() - statusPollStartedAt);
      const statusPollNumber = statusPollStartedAt === void 0 ? void 0 : agentStatusPollCount(
        state,
        state.pendingTriggerId,
        state.dispatchAttempt
      ) + 1;
      recordDispatchHistory(state, now, {
        event: "agent_run_status_checked",
        attempt: state.dispatchAttempt > 0 ? state.dispatchAttempt : void 0,
        retryCount: state.retryCount,
        agentRunIdPresent: true,
        agentRunStatus: diagnostics.status,
        httpStatus: diagnostics.httpStatus,
        errorType: diagnostics.errorType,
        errorCode: diagnostics.errorCode,
        upstreamRequestId: diagnostics.requestId,
        failureDiagnostics: agentRunFailureDiagnostics(diagnostics),
        ...statusPollNumber === void 0 ? {} : { agentStatusPollCount: statusPollNumber },
        ...statusPollDurationMs === void 0 ? {} : { agentStatusPollDurationMs: statusPollDurationMs }
      }, state.pendingTriggerScope);
      const acceptedRunAge = acceptedRunAgeMs(state, now);
      // This branch is entered only for a correlated, recorded retry callback.
      // Once its run is terminal, continue the already-approved same-window
      // retry; it is neither a missing callback nor a stale ambiguous run.
      // Active/unknown runs must still drain before any new dispatch.
      const retryRunTerminal = diagnostics.status === "completed" || diagnostics.status === "failed";
      if (!retryRunTerminal && !exhaustedZeroWorkConfiguration(state, this.deps.config) && recoverStaleAcceptedRun(state, this.deps.config, now, diagnostics)) {
        const nextAt = state.pending ? Math.max(state.dueAt ?? now, state.cooldownUntil) : void 0;
        await this.deps.store.save(state);
        if (nextAt !== void 0) await this.deps.store.setAlarm(nextAt);
        this.deps.logger?.warn("stale_agent_run_recovered", {
          status: diagnostics.status,
          ageMs: acceptedRunAge ?? null,
          maxAgeMs: this.deps.config.acceptedRunMaxAgeMs,
          queuedPending: state.queuedPending
        });
        return {
          status: nextAt === void 0 ? "permanent_failure" : "retry_scheduled",
          nextAt,
          triggerId: state.pendingTriggerId ?? void 0
        };
      }
      if (diagnostics.status !== "completed" && diagnostics.status !== "failed") {
        const nextAt = now + 15e3;
        recordDispatchHistory(state, now, {
          event: "active_run_wait",
          attempt: state.dispatchAttempt > 0 ? state.dispatchAttempt : void 0,
          retryCount: state.retryCount,
          agentRunIdPresent: true,
          agentRunStatus: diagnostics.status,
          httpStatus: diagnostics.httpStatus,
          errorType: diagnostics.errorType,
          errorCode: diagnostics.errorCode,
          upstreamRequestId: diagnostics.requestId,
          nextAt: new Date(nextAt).toISOString(),
          waitMs: nextAt - now,
          waitReason: "active_agent_run"
        }, state.pendingTriggerScope);
        state.dueAt = nextAt;
        if (diagnostics.status !== "queued" && diagnostics.status !== "in_progress") {
          markFailure(state, "ambiguous", now, nextAt);
        }
        await this.deps.store.save(state);
        await this.deps.store.setAlarm(nextAt);
        this.deps.logger?.warn("previous_agent_run_still_active", {
          status: diagnostics.status,
          nextAt: new Date(nextAt).toISOString(),
          retryCount: state.retryCount
        });
        return {
          status: "retry_scheduled",
          nextAt,
          triggerId: state.pendingTriggerId ?? void 0
        };
      }
    }
    if (exhaustedZeroWorkConfiguration(state, this.deps.config)) {
      const scope2 = state.pendingTriggerScope;
      recordDispatchHistory(state, now, {
        event: "batch_failed",
        ...resultHistoryDetails(state.lastResultReport),
        failureKind: "configuration",
        errorCode: "configuration_retry_exhausted",
        retryCount: state.retryCount
      }, scope2);
      appendNeedsAttentionScope(state, scope2);
      state.needsAttentionAt = now;
      state.needsAttentionRetryCount = state.retryCount;
      state.needsAttentionCount = Math.min(Number.MAX_SAFE_INTEGER, state.needsAttentionCount + 1);
      markFailure(state, "configuration", now);
      const nextAt = this.finishCurrent(state, now);
      await this.deps.store.save(state);
      if (nextAt !== void 0) await this.deps.store.setAlarm(nextAt);
      return { status: "permanent_failure", nextAt };
    }
    makeDueForDispatch(state, now);
    if (state.cooldownUntil > now) {
      await this.deps.store.save(state);
      await this.deps.store.setAlarm(state.cooldownUntil);
      return { status: "cooldown", nextAt: state.cooldownUntil };
    }
    if (state.lifecycleRecoveryRequested && this.deps.graph && missingGraphConfiguration(this.deps.config).length === 0) {
      try {
        state.subscription = await this.deps.graph.recoverLifecycle(
          state.subscription,
          state.lastLifecycleEvent ?? "missed",
          now
        );
        state.lifecycleRecoveryRequested = false;
      } catch {
        markFailure(state, "subscription", now);
      }
    }
    const triggerId = state.pendingTriggerId;
    if (!triggerId) {
      resetPendingDispatch(state);
      await this.deps.store.save(state);
      return { status: "idle" };
    }
    if (!state.pendingTriggerScope) {
      state.pendingTriggerScope = createPendingTriggerScope(state, this.deps.config, now);
      if (!state.pendingTriggerScope) {
        resetPendingDispatch(state);
        await this.deps.store.save(state);
        return { status: "idle" };
      }
      await this.deps.store.save(state);
    }
    const scope = state.pendingTriggerScope;
    const dispatchAttempt = state.dispatchAttempt + 1;
    const dispatchWasQueued = state.pendingDispatchWasQueued === true;
    const dispatchWaitReason = queuedDispatchWaitReason(state, dispatchWasQueued);
    recordDispatchHistory(state, now, {
      event: "dispatch_started",
      attempt: dispatchAttempt,
      retryCount: state.retryCount,
      waitMs: state.pendingNotificationWindowStartedAt === null ? void 0 : Math.max(0, now - state.pendingNotificationWindowStartedAt),
      scheduledAt: scheduledAt === void 0 ? void 0 : new Date(scheduledAt).toISOString(),
      alarmLatenessMs: scheduledAt === void 0 ? void 0 : Math.max(0, now - scheduledAt),
      waitReason: dispatchWaitReason
    }, scope);
    state.pendingDispatchWasQueued = false;
    state.pendingDispatchWaitReason = null;
    await this.deps.store.save(state);
    this.deps.logger?.info("triage_dispatch_started", {
      scopeMode: scope.mode,
      dispatchAttempt,
      notificationToDispatchMs: state.pendingNotificationWindowStartedAt === null ? null : Math.max(0, now - state.pendingNotificationWindowStartedAt),
      queuedNotificationToDispatchMs: state.queuedNotificationWindowStartedAt === null ? null : Math.max(0, now - state.queuedNotificationWindowStartedAt),
      createdFrom: scope.mode === "new-email-tickets" ? scope.createdFrom : null,
      createdTo: scope.mode === "new-email-tickets" ? scope.createdTo : null
    });
    const attempt = await this.deps.agent.trigger(
      triggerId,
      scope,
      dispatchAttempt,
      this.deps.config.resultCallbackEnabled
    );
    return this.recordAttempt(state, attempt, triggerId, scope, dispatchAttempt, now);
  }
  async reportResult(report) {
    if (!this.deps.config.resultCallbackEnabled) return { status: "callback_disabled" };
    const now = this.now();
    const state = normalizeState(await this.deps.store.load());
    const last = state.lastResultReport;
    if (last?.triggerId === report.triggerId && last.attempt === report.attempt && last.status === report.status) {
      return {
        status: "duplicate",
        triggerId: report.triggerId,
        nextAt: state.dueAt ?? void 0
      };
    }
    if (!state.pending || state.executionPhase !== "awaiting_result" || state.pendingTriggerId !== report.triggerId || state.dispatchAttempt !== report.attempt) {
      return { status: "stale_or_unauthorized" };
    }
    let effectiveReport = report;
    if (report.status === "terminal_failure" && state.lastAcceptedTrigger?.runId) {
      const diagnostics = await this.deps.agent.getRunDiagnostics(state.lastAcceptedTrigger.runId);
      const runFailureDiagnostics = agentRunFailureDiagnostics(diagnostics);
      if (runFailureDiagnostics.length > 0) {
        effectiveReport = {
          ...report,
          metadata: {
            ...report.metadata ?? {},
            failureDiagnostics: [
              ...report.metadata?.failureDiagnostics ?? [],
              ...runFailureDiagnostics
            ].slice(0, 32)
          }
        };
      }
      this.deps.logger?.info("agent_callback_run_diagnostics", {
        status: diagnostics.status,
        errorType: diagnostics.errorType ?? null,
        errorCode: diagnostics.errorCode ?? null,
        errorMessagePresent: diagnostics.errorMessage !== void 0,
        requestIdPresent: diagnostics.requestId !== void 0
      });
    }
    effectiveReport = enrichReportDiagnostics(effectiveReport);
    if (effectiveReport.metadata?.ticketOutcomes !== void 0) {
      state.pendingTicketOutcomes = effectiveReport.metadata.ticketOutcomes;
    }
    const agentResultTiming = agentResultTimingHistoryDetails(
      state,
      this.deps.config,
      report.triggerId,
      report.attempt,
      now
    );
    state.lastResultReport = {
      ...effectiveReport,
      recordedAt: new Date(now).toISOString()
    };
    recordDispatchHistory(state, now, {
      event: "result_callback_received",
      ...resultHistoryDetails(effectiveReport),
      ...agentResultTiming
    }, state.pendingTriggerScope);
    const staleBroadScope = this.deps.config.scopeMode === "new-email-tickets" && state.pendingTriggerScope?.mode === "full-new-calls";
    const firstEmptyTargetedQuery = !state.emptyTargetedRecoveryPending && this.deps.config.fastTargetedModeEnabled && state.pendingTriggerScope?.mode === "new-email-tickets" && isEmptyTargetedQueryCompletion(report);
    const settledEmptyTargetedRetry = !firstEmptyTargetedQuery && state.retryCount > 0 && this.deps.config.scopeMode === "new-email-tickets" && state.pendingTriggerScope?.mode === "new-email-tickets" && isEmptyTargetedQueryCompletion(report);
    const continuationDisposition = operationContinuationDisposition(effectiveReport);
    if (report.status === "complete" && continuationDisposition === "human_reconciliation") {
      recordDispatchHistory(state, now, {
        event: "batch_failed",
        ...resultHistoryDetails(effectiveReport),
        failureKind: "ambiguous"
      }, state.pendingTriggerScope);
      markFailure(state, "ambiguous", now);
      const nextAt2 = this.finishCurrent(state, now);
      await this.deps.store.save(state);
      if (nextAt2 !== void 0) await this.deps.store.setAlarm(nextAt2);
      return { status: "terminal_failure", triggerId: report.triggerId, nextAt: nextAt2 };
    }
    if (report.status === "complete" && (firstEmptyTargetedQuery || !completionReportIsConsistent(report)) && !settledEmptyTargetedRetry) {
      if (firstEmptyTargetedQuery) {
        const targetedScope = state.pendingTriggerScope;
        if (targetedScope?.mode === "new-email-tickets") {
          const currentEnd = Date.parse(targetedScope.createdTo);
          if (Number.isFinite(currentEnd) && currentEnd <= now) {
            const extendedEnd = now + this.deps.config.fastIngestionGraceMs;
            targetedScope.createdTo = new Date(
              Math.max(currentEnd, extendedEnd)
            ).toISOString();
            state.pendingNotificationWindowEndedAt = Math.max(
              state.pendingNotificationWindowEndedAt ?? currentEnd,
              extendedEnd
            );
          }
        }
        widenTargetedEmailScopeForRecovery(state, this.deps.config);
      }
      if (state.retryCount >= this.deps.config.resultMaxRetries) {
        recordDispatchHistory(state, now, {
          event: "batch_failed",
          ...resultHistoryDetails(effectiveReport),
          failureKind: "permanent"
        }, state.pendingTriggerScope);
        markFailure(state, "permanent", now);
        const nextAt3 = this.finishCurrent(state, now);
        await this.deps.store.save(state);
        if (nextAt3 !== void 0) await this.deps.store.setAlarm(nextAt3);
        return { status: "terminal_failure", triggerId: report.triggerId, nextAt: nextAt3 };
      }
      if (firstEmptyTargetedQuery) {
        state.emptyTargetedRecoveryPending = true;
      }
      state.retryCount += 1;
      const nextAt2 = now + retryDelayMs(state.retryCount);
      state.executionPhase = "retry_wait";
      state.resultDeadlineAt = null;
      state.dueAt = nextAt2;
      markFailure(state, "transient", now, nextAt2);
      recordDispatchHistory(state, now, {
        event: "retry_scheduled",
        ...resultHistoryDetails(effectiveReport),
        failureKind: "transient",
        nextAt: new Date(nextAt2).toISOString(),
        waitMs: nextAt2 - now,
        waitReason: "bounded_recovery"
      }, state.pendingTriggerScope);
      await this.deps.store.save(state);
      await this.deps.store.setAlarm(nextAt2);
      return { status: "retry_scheduled", triggerId: report.triggerId, nextAt: nextAt2 };
    }
    if (report.status === "complete") {
      recordDispatchHistory(state, now, {
        event: "batch_completed",
        ...resultHistoryDetails(effectiveReport),
        ...agentResultTiming
      }, state.pendingTriggerScope);
      const nextAt2 = this.finishCurrent(state, now);
      await this.deps.store.save(state);
      if (nextAt2 !== void 0) await this.deps.store.setAlarm(nextAt2);
      return { status: "complete", triggerId: report.triggerId, nextAt: nextAt2 };
    }
    if (terminalApplyFailureNeedsHumanReconciliation(report)) {
      recordDispatchHistory(state, now, {
        event: "batch_failed",
        ...resultHistoryDetails(effectiveReport),
        failureKind: "ambiguous"
      }, state.pendingTriggerScope);
      markFailure(state, "ambiguous", now);
      const nextAt2 = this.finishCurrent(state, now);
      await this.deps.store.save(state);
      if (nextAt2 !== void 0) await this.deps.store.setAlarm(nextAt2);
      return { status: "terminal_failure", triggerId: report.triggerId, nextAt: nextAt2 };
    }
    const retryableTargetedConfiguration = report.status === "terminal_failure" && this.deps.config.scopeMode === "new-email-tickets" && state.pendingTriggerScope?.mode === "new-email-tickets" && report.metadata?.failureStage === "configuration";
    if (retryableTargetedConfiguration) {
      if (state.retryCount < this.deps.config.resultMaxRetries) {
        state.retryCount += 1;
      }
      const nextAt2 = now + targetedConfigurationRetryDelayMs(state.retryCount);
      state.executionPhase = "retry_wait";
      state.resultDeadlineAt = null;
      state.dueAt = nextAt2;
      markFailure(state, "transient", now, nextAt2);
      recordDispatchHistory(state, now, {
        event: "retry_scheduled",
        ...resultHistoryDetails(effectiveReport),
        failureKind: "transient",
        nextAt: new Date(nextAt2).toISOString(),
        waitMs: nextAt2 - now,
        waitReason: "callback_retry"
      }, state.pendingTriggerScope);
      await this.deps.store.save(state);
      await this.deps.store.setAlarm(nextAt2);
      if (state.retryCount >= this.deps.config.resultMaxRetries) {
        this.deps.logger?.warn("targeted_configuration_retry_cap_reached", {
          retryCount: state.retryCount,
          nextAt: new Date(nextAt2).toISOString(),
          queuedPending: state.queuedPending
        });
      }
      return { status: "retry_scheduled", triggerId: report.triggerId, nextAt: nextAt2 };
    }
    const retryableEmptyTargetedQuery = report.status === "terminal_failure" && !state.emptyTargetedRecoveryPending && this.deps.config.fastTargetedModeEnabled && state.pendingTriggerScope?.mode === "new-email-tickets" && report.metadata?.failureStage === "bounded_query" && (report.metadata.ticketsConsidered ?? 0) === 0 && (report.metadata.ticketsCompleted ?? 0) === 0 && (report.metadata.ticketsDeferred ?? 0) === 0;
    if (retryableEmptyTargetedQuery) {
      widenTargetedEmailScopeForRecovery(state, this.deps.config);
      state.emptyTargetedRecoveryPending = true;
      state.retryCount += 1;
      const nextAt2 = now + retryDelayMs(state.retryCount);
      state.executionPhase = "retry_wait";
      state.resultDeadlineAt = null;
      state.dueAt = nextAt2;
      markFailure(state, "transient", now, nextAt2);
      recordDispatchHistory(state, now, {
        event: "retry_scheduled",
        ...resultHistoryDetails(effectiveReport),
        failureKind: "transient",
        nextAt: new Date(nextAt2).toISOString(),
        waitMs: nextAt2 - now,
        waitReason: "bounded_recovery"
      }, state.pendingTriggerScope);
      await this.deps.store.save(state);
      await this.deps.store.setAlarm(nextAt2);
      return { status: "retry_scheduled", triggerId: report.triggerId, nextAt: nextAt2 };
    }
    const unfinishedTargetedWork = hasUnfinishedTargetedWork(report);
    if (unfinishedTargetedWork) {
      if (state.retryCount < this.deps.config.resultMaxRetries) {
        state.retryCount += 1;
      }
      const retryDelay = this.deps.config.scopeMode === "new-email-tickets" && state.pendingTriggerScope?.mode === "new-email-tickets" ? targetedReconciliationRetryDelayMs(Math.max(1, state.retryCount)) : retryDelayMs(Math.max(1, state.retryCount));
      const nextAt2 = now + retryDelay;
      state.executionPhase = "retry_wait";
      state.resultDeadlineAt = null;
      state.dueAt = nextAt2;
      markFailure(state, "transient", now, nextAt2);
      recordDispatchHistory(state, now, {
        event: "retry_scheduled",
        ...resultHistoryDetails(effectiveReport),
        failureKind: "transient",
        nextAt: new Date(nextAt2).toISOString(),
        waitMs: nextAt2 - now,
        waitReason: "bounded_recovery"
      }, state.pendingTriggerScope);
      await this.deps.store.save(state);
      await this.deps.store.setAlarm(nextAt2);
      if (state.retryCount >= this.deps.config.resultMaxRetries) {
        this.deps.logger?.warn("targeted_incomplete_retry_cap_reached", {
          retryCount: state.retryCount,
          nextAt: new Date(nextAt2).toISOString(),
          failureStage: report.metadata?.failureStage ?? null,
          queuedPending: state.queuedPending
        });
      }
      return { status: "retry_scheduled", triggerId: report.triggerId, nextAt: nextAt2 };
    }
    if (report.status === "terminal_failure") {
      recordDispatchHistory(state, now, {
        event: "batch_failed",
        ...resultHistoryDetails(effectiveReport),
        failureKind: continuationDisposition === "human_reconciliation" ? "ambiguous" : "permanent"
      }, state.pendingTriggerScope);
      const failureKind = continuationDisposition === "human_reconciliation" ? "ambiguous" : "permanent";
      markFailure(state, failureKind, now);
      const nextAt2 = this.finishCurrent(state, now);
      await this.deps.store.save(state);
      if (nextAt2 !== void 0) await this.deps.store.setAlarm(nextAt2);
      return { status: "terminal_failure", triggerId: report.triggerId, nextAt: nextAt2 };
    }
    if (staleBroadScope) {
      recordDispatchHistory(state, now, {
        event: "batch_failed",
        ...resultHistoryDetails(effectiveReport),
        failureKind: "transient"
      }, state.pendingTriggerScope);
      markFailure(state, "transient", now);
      const nextAt2 = this.finishCurrent(state, now);
      await this.deps.store.save(state);
      if (nextAt2 !== void 0) await this.deps.store.setAlarm(nextAt2);
      return {
        status: nextAt2 === void 0 ? "terminal_failure" : "retry_scheduled",
        triggerId: report.triggerId,
        nextAt: nextAt2
      };
    }
    if (state.retryCount >= this.deps.config.resultMaxRetries) {
      if (report.status === "retryable_rate_limit" && this.deps.config.scopeMode === "new-email-tickets" && state.pendingTriggerScope?.mode === "new-email-tickets") {
        const requestedRetryMs2 = report.retryAfterSeconds === void 0 ? void 0 : Math.max(1e3, report.retryAfterSeconds * 1e3);
        const delayMs2 = requestedRetryMs2 === void 0 ? retryDelayMs(this.deps.config.resultMaxRetries) : Math.min(requestedRetryMs2, this.deps.config.resultMaxRetryAfterMs);
        setSharedRateLimitGate(state, this.deps.config, effectiveReport, now, delayMs2);
        const nextAt3 = Math.max(now + delayMs2, state.sharedRateLimitUntil ?? 0);
        state.executionPhase = "retry_wait";
        state.resultDeadlineAt = null;
        state.dueAt = nextAt3;
        markFailure(state, "transient", now, nextAt3);
        recordDispatchHistory(state, now, {
          event: "retry_scheduled",
          ...resultHistoryDetails(effectiveReport),
          failureKind: "transient",
          nextAt: new Date(nextAt3).toISOString(),
          waitMs: nextAt3 - now,
          waitReason: "callback_retry"
        }, state.pendingTriggerScope);
        await this.deps.store.save(state);
        await this.deps.store.setAlarm(nextAt3);
        this.deps.logger?.warn("targeted_rate_limit_retry_cap_reached", {
          retryCount: state.retryCount,
          nextAt: new Date(nextAt3).toISOString(),
          queuedPending: state.queuedPending,
          retryAfterSeconds: report.retryAfterSeconds ?? null
        });
        return { status: "retry_scheduled", triggerId: report.triggerId, nextAt: nextAt3 };
      }
      recordDispatchHistory(state, now, {
        event: "batch_failed",
        ...resultHistoryDetails(effectiveReport),
        failureKind: "permanent"
      }, state.pendingTriggerScope);
      markFailure(state, "permanent", now);
      const nextAt2 = this.finishCurrent(state, now);
      await this.deps.store.save(state);
      if (nextAt2 !== void 0) await this.deps.store.setAlarm(nextAt2);
      return { status: "terminal_failure", triggerId: report.triggerId, nextAt: nextAt2 };
    }
    state.retryCount += 1;
    const requestedRetryMs = report.retryAfterSeconds === void 0 ? void 0 : Math.max(1e3, report.retryAfterSeconds * 1e3);
    const delayMs = requestedRetryMs === void 0 ? retryDelayMs(state.retryCount) : Math.min(requestedRetryMs, this.deps.config.resultMaxRetryAfterMs);
    setSharedRateLimitGate(state, this.deps.config, effectiveReport, now, delayMs);
    const nextAt = Math.max(now + delayMs, state.sharedRateLimitUntil ?? 0);
    state.executionPhase = "retry_wait";
    state.resultDeadlineAt = null;
    state.dueAt = nextAt;
    markFailure(state, "transient", now, nextAt);
    recordDispatchHistory(state, now, {
      event: "retry_scheduled",
      ...resultHistoryDetails(effectiveReport),
      failureKind: "transient",
      nextAt: new Date(nextAt).toISOString(),
      waitMs: nextAt - now,
      waitReason: "callback_retry"
    }, state.pendingTriggerScope);
    await this.deps.store.save(state);
    await this.deps.store.setAlarm(nextAt);
    return { status: "retry_scheduled", triggerId: report.triggerId, nextAt };
  }
  finishCurrent(state, now) {
    resetPendingDispatch(state);
    clearExpiredSharedRateLimit(state, now);
    if (sharedRateLimitActive(state, now)) {
      return nextScheduledAt(state, now, this.deps.config);
    }
    const unavailableDueAt = state.unavailableRetryWindow?.dueAt ?? null;
    if (unavailableDueAt !== null && unavailableDueAt <= now) {
      promoteUnavailableRetryDispatchSafely(state, now, this.deps.config);
    } else if (unavailableDueAt !== null) {
      return nextScheduledAt(state, now, this.deps.config);
    } else if (state.reconciliationHold !== null && state.reconciliationHold.dueAt <= now) {
      promoteReconciliationHold(state, now);
    } else if (state.queuedPending) {
      if (!promoteQueuedDispatchSafely(state, now, this.deps.config)) {
        return nextScheduledAt(state, now, this.deps.config);
      }
    } else {
      return nextScheduledAt(state, now, this.deps.config);
    }
    const nextAt = Math.max(state.dueAt ?? now, state.cooldownUntil);
    state.dueAt = nextAt;
    return nextAt;
  }
  async recordAttempt(state, attempt, triggerId, scope, dispatchAttempt, now) {
    if (attempt.kind === "accepted") {
      recordDispatchHistory(state, now, {
        event: "agent_accepted",
        batchSequence: batchSequenceFromTriggerId(triggerId),
        scopeMode: scope.mode,
        attempt: dispatchAttempt,
        retryCount: state.retryCount,
        agentRunIdPresent: attempt.runId !== void 0
      }, scope);
      let nextAt2;
      if (this.deps.config.resultCallbackEnabled) {
        nextAt2 = markAcceptedAwaitingResult(
          state,
          now,
          { triggerId, attempt: dispatchAttempt, scopeMode: scope.mode, ...attempt },
          this.deps.config.cooldownMs,
          this.deps.config.resultWatchdogMs
        );
      } else {
        markAccepted(
          state,
          now,
          { triggerId, scopeMode: scope.mode, ...attempt },
          this.deps.config.cooldownMs
        );
      }
      await this.deps.store.save(state);
      if (nextAt2 !== void 0) await this.deps.store.setAlarm(nextAt2);
      return { status: "accepted", triggerId, nextAt: nextAt2 };
    }
    if (attempt.kind === "configuration" && attempt.channelUnavailable && scope.mode === "new-email-tickets") {
      const failureDiagnostics = agentTriggerFailureDiagnostics(attempt);
      recordDispatchHistory(state, now, {
        event: "agent_trigger_failed",
        batchSequence: batchSequenceFromTriggerId(triggerId),
        scopeMode: scope.mode,
        attempt: dispatchAttempt,
        retryCount: state.retryCount,
        failureKind: "configuration",
        httpStatus: attempt.httpStatus,
        errorType: attempt.errorType,
        errorCode: attempt.errorCode,
        retryAfterSeconds: attempt.retryAfterSeconds,
        upstreamRequestId: attempt.requestId,
        failureDiagnostics
      }, scope);
      const priorRetryCount = state.retryCount;
      const nextUnavailableRetryCount = Math.min(
        this.deps.config.resultMaxRetries,
        priorRetryCount + 1
      );
      if (nextUnavailableRetryCount >= this.deps.config.resultMaxRetries && state.pendingNotificationWindowStartedAt !== null) {
        recordUnavailableNeedsAttention(
          state,
          scope,
          now,
          nextUnavailableRetryCount,
          separationEnabled(this.deps.config)
        );
        recordDispatchHistory(state, now, {
          event: "batch_failed",
          batchSequence: batchSequenceFromTriggerId(triggerId),
          scopeMode: scope.mode,
          attempt: dispatchAttempt,
          retryCount: nextUnavailableRetryCount,
          failureKind: "configuration",
          httpStatus: attempt.httpStatus,
          errorType: attempt.errorType,
          errorCode: attempt.errorCode,
          retryAfterSeconds: attempt.retryAfterSeconds,
          upstreamRequestId: attempt.requestId,
          failureDiagnostics
        }, scope);
        const nextAt3 = nextDeferredAt(state, this.deps.config);
        await this.deps.store.save(state);
        if (nextAt3 !== void 0) await this.deps.store.setAlarm(nextAt3);
        this.deps.logger?.warn("agent_trigger_channel_unavailable_needs_attention", {
          retryCount: nextUnavailableRetryCount,
          queuedPending: state.queuedPending,
          unavailableRetryPending: state.unavailableRetryWindow !== null,
          nextAt: nextAt3 === void 0 ? null : new Date(nextAt3).toISOString()
        });
        return { status: "configuration", triggerId, nextAt: nextAt3 };
      }
      const nextAt2 = releaseUnavailableTargetedWindow(
        state,
        this.deps.config,
        now,
        attempt.retryAfterSeconds
      );
      if (nextAt2 !== void 0) {
        recordDispatchHistory(state, now, {
          event: "retry_scheduled",
          batchSequence: batchSequenceFromTriggerId(triggerId),
          scopeMode: scope.mode,
          attempt: dispatchAttempt,
          retryCount: nextUnavailableRetryCount,
          failureKind: "configuration",
          retryAfterSeconds: attempt.retryAfterSeconds,
          nextAt: new Date(nextAt2).toISOString(),
          waitMs: nextAt2 - now,
          waitReason: "transport_retry",
          failureDiagnostics
        }, scope);
        await this.deps.store.save(state);
        await this.deps.store.setAlarm(nextAt2);
        this.deps.logger?.warn("agent_trigger_channel_unavailable_requeued", {
          nextAt: new Date(nextAt2).toISOString(),
          queuedPending: state.queuedPending,
          unavailableRetryPending: state.unavailableRetryWindow !== null
        });
        return { status: "configuration", triggerId, nextAt: nextAt2 };
      }
    }
    if (attempt.kind === "authentication" || attempt.kind === "configuration") {
      const nextAt2 = now + 15 * 60 * 1e3;
      recordDispatchHistory(state, now, {
        event: "agent_trigger_failed",
        batchSequence: batchSequenceFromTriggerId(triggerId),
        scopeMode: scope.mode,
        attempt: dispatchAttempt,
        retryCount: state.retryCount,
        failureKind: attempt.kind,
        httpStatus: attempt.httpStatus,
        errorType: attempt.errorType,
        errorCode: attempt.errorCode,
        retryAfterSeconds: attempt.retryAfterSeconds,
        upstreamRequestId: attempt.requestId,
        failureDiagnostics: agentTriggerFailureDiagnostics(attempt)
      }, scope);
      state.executionPhase = "retry_wait";
      state.resultDeadlineAt = null;
      state.dueAt = nextAt2;
      markFailure(state, attempt.kind, now, nextAt2);
      recordDispatchHistory(state, now, {
        event: "retry_scheduled",
        batchSequence: batchSequenceFromTriggerId(triggerId),
        scopeMode: scope.mode,
        attempt: dispatchAttempt,
        retryCount: state.retryCount,
        failureKind: attempt.kind,
        nextAt: new Date(nextAt2).toISOString(),
        waitMs: nextAt2 - now,
        waitReason: "transport_retry",
        failureDiagnostics: agentTriggerFailureDiagnostics(attempt)
      }, scope);
      await this.deps.store.save(state);
      await this.deps.store.setAlarm(nextAt2);
      return {
        status: attempt.kind === "authentication" ? "authentication_required" : "configuration",
        triggerId,
        nextAt: nextAt2
      };
    }
    if (attempt.kind === "transient" || attempt.kind === "ambiguous") {
      const nextRetryCount = Math.min(
        this.deps.config.resultMaxRetries,
        state.retryCount + 1
      );
      state.retryCount = nextRetryCount;
      const nextAt2 = now + transportRetryDelayMs(
        this.deps.config,
        state.retryCount,
        attempt.retryAfterSeconds
      );
      recordDispatchHistory(state, now, {
        event: "agent_trigger_failed",
        batchSequence: batchSequenceFromTriggerId(triggerId),
        scopeMode: scope.mode,
        attempt: dispatchAttempt,
        retryCount: state.retryCount,
        failureKind: attempt.kind,
        httpStatus: attempt.httpStatus,
        errorType: attempt.errorType,
        errorCode: attempt.errorCode,
        retryAfterSeconds: attempt.retryAfterSeconds,
        upstreamRequestId: attempt.requestId,
        failureDiagnostics: agentTriggerFailureDiagnostics(attempt)
      }, scope);
      state.executionPhase = "retry_wait";
      state.dueAt = nextAt2;
      markFailure(state, attempt.kind, now, nextAt2);
      recordDispatchHistory(state, now, {
        event: "retry_scheduled",
        batchSequence: batchSequenceFromTriggerId(triggerId),
        scopeMode: scope.mode,
        attempt: dispatchAttempt,
        retryCount: state.retryCount,
        failureKind: attempt.kind,
        retryAfterSeconds: attempt.retryAfterSeconds,
        nextAt: new Date(nextAt2).toISOString(),
        waitMs: nextAt2 - now,
        waitReason: "transport_retry",
        failureDiagnostics: agentTriggerFailureDiagnostics(attempt)
      }, scope);
      await this.deps.store.save(state);
      await this.deps.store.setAlarm(nextAt2);
      return { status: "retry_scheduled", nextAt: nextAt2, triggerId };
    }
    recordDispatchHistory(state, now, {
      event: "agent_trigger_failed",
      batchSequence: batchSequenceFromTriggerId(triggerId),
      scopeMode: scope.mode,
      attempt: dispatchAttempt,
      retryCount: state.retryCount,
      failureKind: "permanent",
      httpStatus: attempt.httpStatus,
      errorType: attempt.errorType,
      errorCode: attempt.errorCode,
      upstreamRequestId: attempt.requestId,
      failureDiagnostics: agentTriggerFailureDiagnostics(attempt)
    }, scope);
    recordDispatchHistory(state, now, {
      event: "batch_failed",
      batchSequence: batchSequenceFromTriggerId(triggerId),
      scopeMode: scope.mode,
      attempt: dispatchAttempt,
      retryCount: state.retryCount,
      failureKind: "permanent",
      failureDiagnostics: agentTriggerFailureDiagnostics(attempt)
    }, scope);
    markFailure(state, "permanent", now);
    const nextAt = this.finishCurrent(state, now);
    await this.deps.store.save(state);
    if (nextAt !== void 0) await this.deps.store.setAlarm(nextAt);
    return { status: "permanent_failure", triggerId, nextAt };
  }
};

// src/mcp.ts
var MCP_PROTOCOL_VERSION = "2025-06-18";
var TOOL_NAME = "triage_result_report";
var TRIGGER_ID_PATTERN = /^triage-\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var SAFE_REFERENCE_PATTERN2 = /^[A-Za-z0-9._:-]{1,128}$/;
var RESULT_STATUSES = /* @__PURE__ */ new Set([
  "complete",
  "retryable_rate_limit",
  "terminal_failure"
]);
var FAILURE_STAGES = /* @__PURE__ */ new Set([
  "bounded_query",
  "evidence_recovery",
  "triage_apply",
  "operation_continuation",
  "configuration"
]);
function isRecord5(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isRecord5, "isRecord");
function validId(value) {
  return value === null || typeof value === "string" || typeof value === "number";
}
__name(validId, "validId");
function rpcResult(id, result) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
__name(rpcResult, "rpcResult");
function rpcError(id, code, message, status = 200) {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message }
  }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
__name(rpcError, "rpcError");
function keysAreBounded2(value, allowed) {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}
__name(keysAreBounded2, "keysAreBounded");
function parseSafeInteger(value, maximum) {
  if (value === void 0) return void 0;
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= maximum ? Number(value) : null;
}
__name(parseSafeInteger, "parseSafeInteger");
function parseSafeMetadata(value) {
  if (value === void 0) return void 0;
  if (!isRecord5(value)) return null;
  if (!keysAreBounded2(value, [
    "operationId",
    "resultReference",
    "operationStatus",
    "failureStage",
    "ticketsConsidered",
    "ticketsCompleted",
    "ticketsDeferred",
    "superopsAttempts",
    "superopsRetries",
    "runDurationMs",
    "ticketOutcomes",
    "failureDiagnostics",
    "mcpExecution"
  ])) return null;
  const metadata = {};
  for (const key of ["operationId", "resultReference"]) {
    const item = value[key];
    if (item === void 0) continue;
    if (typeof item !== "string" || !SAFE_REFERENCE_PATTERN2.test(item)) return null;
    metadata[key] = item;
  }
  const operationStatus = parseSafeOperationStatus(value.operationStatus);
  if (operationStatus === null) return null;
  if (operationStatus !== void 0) metadata.operationStatus = operationStatus;
  if (value.failureStage !== void 0) {
    if (typeof value.failureStage !== "string" || !FAILURE_STAGES.has(value.failureStage)) return null;
    metadata.failureStage = value.failureStage;
  }
  for (const key of ["ticketsConsidered", "ticketsCompleted", "ticketsDeferred"]) {
    const count = parseSafeInteger(value[key], 1e3);
    if (count === null) return null;
    if (count !== void 0) metadata[key] = count;
  }
  for (const key of ["superopsAttempts", "superopsRetries"]) {
    const count = parseSafeInteger(value[key], 1e3);
    if (count === null) return null;
    if (count !== void 0) metadata[key] = count;
  }
  const duration = parseSafeInteger(value.runDurationMs, 864e5);
  if (duration === null) return null;
  if (duration !== void 0) metadata.runDurationMs = duration;
  const ticketOutcomes = parseSafeTicketOutcomes(value.ticketOutcomes);
  if (ticketOutcomes === null) return null;
  if (ticketOutcomes !== void 0) metadata.ticketOutcomes = ticketOutcomes;
  const failureDiagnostics = parseSafeFailureDiagnostics(value.failureDiagnostics);
  if (failureDiagnostics === null) return null;
  if (failureDiagnostics !== void 0) metadata.failureDiagnostics = failureDiagnostics;
  const mcpExecution = parseSafeMcpExecution(value.mcpExecution);
  if (mcpExecution === null) return null;
  if (mcpExecution !== void 0) metadata.mcpExecution = mcpExecution;
  return metadata;
}
__name(parseSafeMetadata, "parseSafeMetadata");
function parseTriageResultReport(value) {
  if (!isRecord5(value)) return null;
  if (!keysAreBounded2(value, ["triggerId", "attempt", "status", "retryAfterSeconds", "metadata"])) {
    return null;
  }
  if (typeof value.triggerId !== "string" || !TRIGGER_ID_PATTERN.test(value.triggerId)) return null;
  if (!Number.isInteger(value.attempt) || Number(value.attempt) < 1 || Number(value.attempt) > 100) {
    return null;
  }
  if (typeof value.status !== "string" || !RESULT_STATUSES.has(value.status)) {
    return null;
  }
  if (value.retryAfterSeconds !== void 0 && (!Number.isInteger(value.retryAfterSeconds) || Number(value.retryAfterSeconds) < 1 || Number(value.retryAfterSeconds) > 86400)) return null;
  if (value.status !== "retryable_rate_limit" && value.retryAfterSeconds !== void 0) return null;
  const metadata = parseSafeMetadata(value.metadata);
  if (metadata === null) return null;
  return {
    triggerId: value.triggerId,
    attempt: Number(value.attempt),
    status: value.status,
    retryAfterSeconds: value.retryAfterSeconds === void 0 ? void 0 : Number(value.retryAfterSeconds),
    metadata
  };
}
__name(parseTriageResultReport, "parseTriageResultReport");
function toolDefinition() {
  const failureDiagnosticsSchema = {
    type: "array",
    maxItems: 32,
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        stage: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_.:-]{0,63}$" },
        errorType: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
        errorCode: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
        httpStatus: { type: "integer", minimum: 100, maximum: 599 },
        message: { type: "string", maxLength: 512 },
        requestIndex: { type: "integer", minimum: 1, maximum: 1e3 },
        operationName: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,96}$" },
        itemKey: { type: "string", pattern: "^[A-Za-z0-9._:#-]{1,128}$" }
      }
    }
  };
  return {
    name: TOOL_NAME,
    title: "Report targeted triage result",
    description: "Report the terminal or retryable outcome of the current capability-authenticated targeted triage run. The trigger ID is a single-use credential. Safe display ticket numbers may appear only in bounded ticketOutcomes metadata; never include ticket, email, note, or customer content.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["triggerId", "attempt", "status"],
      properties: {
        triggerId: {
          type: "string",
          pattern: "^triage-[0-9]+-[0-9a-fA-F-]{36}$",
          description: "The exact opaque Trigger ID supplied by the trusted trigger input."
        },
        attempt: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "The exact dispatch attempt supplied by the trusted trigger input."
        },
        status: {
          type: "string",
          enum: ["complete", "retryable_rate_limit", "terminal_failure"]
        },
        retryAfterSeconds: {
          type: "integer",
          minimum: 1,
          maximum: 86400,
          description: "Use only for retryable_rate_limit and only when SuperOps supplied Retry-After."
        },
        metadata: {
          type: "object",
          additionalProperties: false,
          properties: {
            operationId: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
            resultReference: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
            operationStatus: {
              type: "object",
              additionalProperties: false,
              required: ["state"],
              properties: {
                state: {
                  type: "string",
                  enum: [
                    "Running",
                    "ContinuationRequired",
                    "Rescheduled",
                    "Completed",
                    "CompletedWithFailures",
                    "Failed",
                    "Cancelled"
                  ]
                },
                continuationRequired: { type: "boolean" },
                pendingCount: { type: "integer", minimum: 0, maximum: 1e3 },
                failedCount: { type: "integer", minimum: 0, maximum: 1e3 },
                partialWriteCount: { type: "integer", minimum: 0, maximum: 1e3 },
                ambiguousWriteCount: { type: "integer", minimum: 0, maximum: 1e3 },
                waitingForRateLimitCount: { type: "integer", minimum: 0, maximum: 1e3 },
                continuationCount: { type: "integer", minimum: 0, maximum: 1e3 },
                terminalFailureClass: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
                replaySafe: { type: "boolean" },
                humanReconciliationRequired: { type: "boolean" },
                ticketNumbers: {
                  type: "array",
                  maxItems: 500,
                  items: { type: "string", pattern: "^#?[0-9]{1,40}$" }
                }
              }
            },
            failureStage: {
              type: "string",
              enum: [
                "bounded_query",
                "evidence_recovery",
                "triage_apply",
                "operation_continuation",
                "configuration"
              ]
            },
            ticketsConsidered: { type: "integer", minimum: 0, maximum: 1e3 },
            ticketsCompleted: { type: "integer", minimum: 0, maximum: 1e3 },
            ticketsDeferred: { type: "integer", minimum: 0, maximum: 1e3 },
            superopsAttempts: { type: "integer", minimum: 0, maximum: 1e3 },
            superopsRetries: { type: "integer", minimum: 0, maximum: 1e3 },
            runDurationMs: { type: "integer", minimum: 0, maximum: 864e5 },
            failureDiagnostics: failureDiagnosticsSchema,
            ticketOutcomes: {
              type: "array",
              maxItems: 500,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["ticketNumber", "outcome"],
                properties: {
                  ticketNumber: { type: "string", pattern: "^#?[0-9]{1,40}$" },
                  outcome: {
                    type: "string",
                    enum: ["completed", "skipped", "deferred", "failed", "not_attempted"]
                  },
                  stage: {
                    type: "string",
                    enum: [
                      "bounded_query",
                      "evidence_recovery",
                      "triage_apply",
                      "operation_continuation",
                      "verification",
                      "configuration",
                      "unknown"
                    ]
                  },
                  reasonCode: {
                    type: "string",
                    enum: [
                      "already_handled",
                      "no_action",
                      "rate_limit",
                      "unavailable",
                      "stale",
                      "validation",
                      "partial_write",
                      "not_attempted",
                      "unknown"
                    ]
                  }
                }
              }
            },
            mcpExecution: {
              type: "object",
              additionalProperties: false,
              properties: {
                executionTraceId: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
                invocationId: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
                operationId: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
                toolName: { type: "string", pattern: "^superops_[A-Za-z0-9_]{1,96}$" },
                durationMs: { type: "integer", minimum: 0, maximum: 864e5 },
                subrequestsUsed: { type: "integer", minimum: 0, maximum: 1e3 },
                subrequestBudget: { type: "integer", minimum: 0, maximum: 1e3 },
                subrequestSafetyMargin: { type: "integer", minimum: 0, maximum: 1e3 },
                retryCount: { type: "integer", minimum: 0, maximum: 1e3 },
                requestTraceTruncated: { type: "boolean" },
                requestsByType: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    initialRead: { type: "integer", minimum: 0, maximum: 1e3 },
                    paginationRead: { type: "integer", minimum: 0, maximum: 1e3 },
                    metadataValidation: { type: "integer", minimum: 0, maximum: 1e3 },
                    duplicateNoteCheck: { type: "integer", minimum: 0, maximum: 1e3 },
                    write: { type: "integer", minimum: 0, maximum: 1e3 },
                    fallbackWrite: { type: "integer", minimum: 0, maximum: 1e3 },
                    verificationRead: { type: "integer", minimum: 0, maximum: 1e3 },
                    retry: { type: "integer", minimum: 0, maximum: 1e3 },
                    custom: { type: "integer", minimum: 0, maximum: 1e3 }
                  }
                },
                requestTrace: {
                  type: "array",
                  maxItems: 128,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["index", "type"],
                    properties: {
                      index: { type: "integer", minimum: 1, maximum: 1e3 },
                      type: {
                        type: "string",
                        enum: [
                          "initialRead",
                          "paginationRead",
                          "metadataValidation",
                          "duplicateNoteCheck",
                          "write",
                          "fallbackWrite",
                          "verificationRead",
                          "retry",
                          "custom"
                        ]
                      },
                      operationType: {
                        type: "string",
                        enum: ["query", "mutation", "subscription", "serviceBinding", "durableObject", "workflow"]
                      },
                      operationName: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,96}$" },
                      itemKey: { type: "string", pattern: "^[A-Za-z0-9._:#-]{1,128}$" },
                      status: {
                        oneOf: [
                          { type: "integer", minimum: 100, maximum: 599 },
                          { type: "string", enum: ["networkError", "requestTimeout"] }
                        ]
                      },
                      retryCount: { type: "integer", minimum: 0, maximum: 100 },
                      durationMs: { type: "integer", minimum: 0, maximum: 864e5 },
                      ok: { type: "boolean" }
                    }
                  }
                },
                retryTrace: {
                  type: "array",
                  maxItems: 128,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: [
                      "attempt",
                      "source",
                      "retryAfterSupplied",
                      "parsedDelayMs",
                      "cappedDelayMs",
                      "actualDelayMs"
                    ],
                    properties: {
                      attempt: { type: "integer", minimum: 1, maximum: 100 },
                      source: { type: "string", enum: ["retry-after", "backoff"] },
                      retryAfterSupplied: { type: "boolean" },
                      suppliedDelayMs: { type: "integer", minimum: 0, maximum: 864e5 },
                      parsedDelayMs: { type: "integer", minimum: 0, maximum: 864e5 },
                      cappedDelayMs: { type: "integer", minimum: 0, maximum: 864e5 },
                      actualDelayMs: { type: "integer", minimum: 0, maximum: 864e5 },
                      operationName: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,96}$" },
                      itemKey: { type: "string", pattern: "^[A-Za-z0-9._:#-]{1,128}$" }
                    }
                  }
                },
                failureDiagnostics: failureDiagnosticsSchema
              }
            }
          }
        }
      }
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  };
}
__name(toolDefinition, "toolDefinition");
function toolCallResult(outcome) {
  const text = JSON.stringify({
    status: outcome.status,
    triggerId: outcome.triggerId,
    nextAt: outcome.nextAt === void 0 ? void 0 : new Date(outcome.nextAt).toISOString()
  });
  return {
    content: [{ type: "text", text }],
    structuredContent: JSON.parse(text),
    isError: outcome.status === "callback_disabled" || outcome.status === "stale_or_unauthorized"
  };
}
__name(toolCallResult, "toolCallResult");
async function handleTriageResultMcp(request, sink) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "POST" }
    });
  }
  let parsedBody;
  try {
    parsedBody = await request.json();
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }
  if (!isRecord5(parsedBody)) return rpcError(null, -32600, "Invalid Request", 400);
  const body = parsedBody;
  const id = validId(body.id) ? body.id : null;
  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return rpcError(id, -32600, "Invalid Request", 400);
  }
  if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (body.method === "initialize") {
    return rpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "support-triage-result", version: "1.0.0" }
    });
  }
  if (body.method === "tools/list") {
    return rpcResult(id, { tools: [toolDefinition()] });
  }
  if (body.method !== "tools/call" || !isRecord5(body.params)) {
    return rpcError(id, -32601, "Method not found");
  }
  if (body.params.name !== TOOL_NAME) return rpcError(id, -32601, "Tool not found");
  const report = parseTriageResultReport(body.params.arguments);
  if (!report) {
    return rpcResult(id, {
      content: [{ type: "text", text: JSON.stringify({ error: "invalid_safe_report" }) }],
      isError: true
    });
  }
  return rpcResult(id, toolCallResult(await sink.report(report)));
}
__name(handleTriageResultMcp, "handleTriageResultMcp");

// src/history-query.ts
var RELEVANT_HISTORY_FILTER = "relevant";
var MAX_RELEVANT_HISTORY_PAGE_SIZE = 100;
var RELEVANT_HISTORY_PARAMETERS = /* @__PURE__ */ new Set([
  "filter",
  "limit",
  "afterEventId",
  "throughEventId"
]);
function getSingleParameter(searchParams, parameter) {
  const values = searchParams.getAll(parameter);
  if (values.length > 1) {
    return {
      ok: false,
      error: {
        error: "unsupported_history_parameter",
        parameter,
        expected: "at most one value"
      }
    };
  }
  return { ok: true, value: values[0] ?? null };
}
__name(getSingleParameter, "getSingleParameter");
function invalidCursor(parameter, expected = "a safe non-negative integer") {
  return {
    ok: false,
    error: {
      error: "invalid_history_cursor",
      parameter,
      expected
    }
  };
}
__name(invalidCursor, "invalidCursor");
function parseCursor(value, parameter, allowZero) {
  if (value === null) return { ok: true, value: void 0 };
  const minimum = allowZero ? 0 : 1;
  if (!/^\d+$/.test(value)) return invalidCursor(parameter);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) return invalidCursor(parameter);
  return { ok: true, value: parsed };
}
__name(parseCursor, "parseCursor");
function invalidLimit(parameter = "limit") {
  return {
    ok: false,
    error: {
      error: "invalid_history_limit",
      parameter,
      expected: `an integer between 1 and ${MAX_RELEVANT_HISTORY_PAGE_SIZE}`
    }
  };
}
__name(invalidLimit, "invalidLimit");
function parseHistoryQuery(searchParams) {
  if (searchParams.has("beforeEventId")) {
    return {
      ok: false,
      error: {
        error: "unsupported_history_cursor_parameter",
        parameter: "beforeEventId",
        expected: "before"
      }
    };
  }
  const rawBefore = searchParams.get("before");
  if (rawBefore === null) return { ok: true };
  if (!/^[1-9]\d*$/.test(rawBefore)) {
    return {
      ok: false,
      error: {
        error: "invalid_history_cursor",
        parameter: "before"
      }
    };
  }
  const beforeEventId = Number(rawBefore);
  if (!Number.isSafeInteger(beforeEventId) || beforeEventId <= 0) {
    return {
      ok: false,
      error: {
        error: "invalid_history_cursor",
        parameter: "before"
      }
    };
  }
  return { ok: true, beforeEventId };
}
__name(parseHistoryQuery, "parseHistoryQuery");
function parseRelevantHistoryQuery(searchParams) {
  if (searchParams.has("beforeEventId")) {
    return {
      ok: false,
      error: {
        error: "unsupported_history_cursor_parameter",
        parameter: "beforeEventId",
        expected: "afterEventId"
      }
    };
  }
  for (const parameter of searchParams.keys()) {
    if (!RELEVANT_HISTORY_PARAMETERS.has(parameter)) {
      return {
        ok: false,
        error: {
          error: "unsupported_history_parameter",
          parameter,
          expected: "filter, limit, afterEventId, or throughEventId"
        }
      };
    }
  }
  const filter = getSingleParameter(searchParams, "filter");
  if (!filter.ok) return filter;
  if (filter.value !== RELEVANT_HISTORY_FILTER) {
    return {
      ok: false,
      error: {
        error: "invalid_history_filter",
        parameter: "filter",
        expected: RELEVANT_HISTORY_FILTER
      }
    };
  }
  const limitParameter = getSingleParameter(searchParams, "limit");
  if (!limitParameter.ok) return limitParameter;
  const limit = limitParameter.value === null ? MAX_RELEVANT_HISTORY_PAGE_SIZE : /^\d+$/.test(limitParameter.value) ? Number(limitParameter.value) : Number.NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RELEVANT_HISTORY_PAGE_SIZE) {
    return invalidLimit();
  }
  const afterParameter = getSingleParameter(searchParams, "afterEventId");
  if (!afterParameter.ok) return afterParameter;
  const after = parseCursor(afterParameter.value, "afterEventId", true);
  if (!after.ok) return after;
  const afterEventId = after.value ?? 0;
  const throughParameter = getSingleParameter(searchParams, "throughEventId");
  if (!throughParameter.ok) return throughParameter;
  const through = parseCursor(throughParameter.value, "throughEventId", true);
  if (!through.ok) return through;
  if (through.value !== void 0 && through.value < afterEventId) {
    return invalidCursor("throughEventId", "greater than or equal to afterEventId");
  }
  return {
    ok: true,
    filter: RELEVANT_HISTORY_FILTER,
    limit,
    afterEventId,
    ...through.value === void 0 ? {} : { throughEventId: through.value }
  };
}
__name(parseRelevantHistoryQuery, "parseRelevantHistoryQuery");

// src/dispatch-history.ts
var DISPATCH_HISTORY_TABLE = "triage_dispatch_history";
var DISPATCH_HISTORY_PLACEHOLDERS = Array.from({ length: 49 }, () => "?").join(", ");
var MAX_DISPATCH_HISTORY_PAGE_SIZE = 100;
var ROUTINE_RELEVANT_HISTORY_EXCLUSION = `
  NOT COALESCE((
    (
      event_name = 'maintenance_started'
      AND failure_kind IS NULL
      AND error_type IS NULL
      AND error_code IS NULL
      AND failure_diagnostics_json IS NULL
    )
    OR (
      event_name = 'maintenance_completed'
      AND phase_status = 'complete'
      AND failure_kind IS NULL
      AND error_type IS NULL
      AND error_code IS NULL
      AND failure_diagnostics_json IS NULL
    )
    OR (
      event_name = 'subscription_maintenance_completed'
      AND phase_status = 'updated'
      AND failure_kind IS NULL
      AND error_type IS NULL
      AND error_code IS NULL
      AND failure_diagnostics_json IS NULL
    )
    OR (
      event_name = 'graph_sweep_completed'
      AND phase_status = 'updated'
      AND partial = 0
      AND discovered_count = 0
      AND accepted_count = 0
      AND duplicate_count = 0
      AND rejected_count = 0
      AND failure_kind IS NULL
      AND error_type IS NULL
      AND error_code IS NULL
      AND failure_diagnostics_json IS NULL
    )
    OR (
      event_name = 'alarm_started'
      AND failure_kind IS NULL
      AND error_type IS NULL
      AND error_code IS NULL
      AND failure_diagnostics_json IS NULL
    )
    OR (
      event_name = 'alarm_completed'
      AND phase_status = 'idle'
      AND failure_kind IS NULL
      AND error_type IS NULL
      AND error_code IS NULL
      AND failure_diagnostics_json IS NULL
    )
  ), 0)
`;
function ensureDispatchHistoryTable(storage) {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS ${DISPATCH_HISTORY_TABLE} (
      event_id INTEGER PRIMARY KEY,
      occurred_at TEXT NOT NULL,
      batch_sequence INTEGER,
      event_name TEXT NOT NULL,
      scope_mode TEXT,
      scope_created_from TEXT,
      scope_created_to TEXT,
      attempt INTEGER,
      retry_count INTEGER,
      http_status INTEGER,
      failure_kind TEXT,
      error_type TEXT,
      error_code TEXT,
      retry_after_seconds INTEGER,
      upstream_request_id TEXT,
      next_at TEXT,
      wait_ms INTEGER,
      wait_reason TEXT,
      agent_run_status TEXT,
      agent_run_id_present INTEGER,
      agent_status_poll_count INTEGER,
      agent_status_poll_duration_ms INTEGER,
      agent_accepted_to_callback_ms INTEGER,
      result_status TEXT,
      failure_stage TEXT,
      tickets_considered INTEGER,
      tickets_completed INTEGER,
      tickets_deferred INTEGER,
      superops_attempts INTEGER,
      superops_retries INTEGER,
      run_duration_ms INTEGER,
      notification_count INTEGER,
      discovered_count INTEGER,
      accepted_count INTEGER,
      duplicate_count INTEGER,
      rejected_count INTEGER,
      partial INTEGER,
      scheduled_at TEXT,
      alarm_lateness_ms INTEGER,
      duration_ms INTEGER,
      source TEXT,
      phase_status TEXT,
      subscription_expiration_at TEXT,
      operation_id TEXT,
      result_reference TEXT,
      ticket_outcomes_json TEXT,
      failure_diagnostics_json TEXT,
      mcp_execution_json TEXT,
      operation_status_json TEXT
    )
  `);
  const columns = new Set(
    storage.sql.exec(`PRAGMA table_info(${DISPATCH_HISTORY_TABLE})`).toArray().map((row) => row.name)
  );
  const additions = [
    ["discovered_count", "INTEGER"],
    ["accepted_count", "INTEGER"],
    ["duplicate_count", "INTEGER"],
    ["rejected_count", "INTEGER"],
    ["partial", "INTEGER"],
    ["scheduled_at", "TEXT"],
    ["alarm_lateness_ms", "INTEGER"],
    ["duration_ms", "INTEGER"],
    ["source", "TEXT"],
    ["phase_status", "TEXT"],
    ["subscription_expiration_at", "TEXT"],
    ["operation_id", "TEXT"],
    ["result_reference", "TEXT"],
    ["ticket_outcomes_json", "TEXT"],
    ["failure_diagnostics_json", "TEXT"],
    ["mcp_execution_json", "TEXT"],
    ["operation_status_json", "TEXT"],
    ["upstream_request_id", "TEXT"],
    ["scope_created_from", "TEXT"],
    ["scope_created_to", "TEXT"],
    ["agent_status_poll_count", "INTEGER"],
    ["agent_status_poll_duration_ms", "INTEGER"],
    ["agent_accepted_to_callback_ms", "INTEGER"]
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      storage.sql.exec(`ALTER TABLE ${DISPATCH_HISTORY_TABLE} ADD COLUMN ${name} ${definition}`);
    }
  }
  storage.sql.exec(`
    CREATE INDEX IF NOT EXISTS triage_dispatch_history_at_idx
    ON ${DISPATCH_HISTORY_TABLE} (occurred_at, event_id)
  `);
  storage.sql.exec(`
    CREATE INDEX IF NOT EXISTS triage_dispatch_history_batch_idx
    ON ${DISPATCH_HISTORY_TABLE} (batch_sequence, event_id)
  `);
}
__name(ensureDispatchHistoryTable, "ensureDispatchHistoryTable");
function optionalNumber(value) {
  return value ?? null;
}
__name(optionalNumber, "optionalNumber");
function optionalString(value) {
  return value ?? null;
}
__name(optionalString, "optionalString");
function optionalBoolean(value) {
  return value === void 0 ? null : value ? 1 : 0;
}
__name(optionalBoolean, "optionalBoolean");
function optionalJson(value) {
  return value === void 0 ? null : JSON.stringify(value);
}
__name(optionalJson, "optionalJson");
function persistDispatchHistory(storage, entries) {
  if (entries.length === 0) return;
  ensureDispatchHistoryTable(storage);
  const latest = storage.sql.exec(
    `SELECT COALESCE(MAX(event_id), 0) AS event_id FROM ${DISPATCH_HISTORY_TABLE}`
  ).one().event_id;
  for (const entry of entries) {
    if (entry.eventId <= latest) continue;
    storage.sql.exec(
      `INSERT OR IGNORE INTO ${DISPATCH_HISTORY_TABLE} (
        event_id, occurred_at, batch_sequence, event_name, scope_mode,
        scope_created_from, scope_created_to, attempt, retry_count, http_status,
        failure_kind, error_type, error_code,
        retry_after_seconds, upstream_request_id, next_at, wait_ms, wait_reason, agent_run_status,
        agent_run_id_present, agent_status_poll_count, agent_status_poll_duration_ms,
        agent_accepted_to_callback_ms, result_status, failure_stage, tickets_considered,
        tickets_completed, tickets_deferred, superops_attempts, superops_retries,
        run_duration_ms, notification_count, discovered_count, accepted_count,
        duplicate_count, rejected_count, partial, scheduled_at, alarm_lateness_ms,
        duration_ms, source, phase_status, subscription_expiration_at, operation_id, result_reference, ticket_outcomes_json,
        failure_diagnostics_json, mcp_execution_json, operation_status_json
      ) VALUES (${DISPATCH_HISTORY_PLACEHOLDERS})
      `,
      entry.eventId,
      entry.at,
      optionalNumber(entry.batchSequence ?? void 0),
      entry.event,
      optionalString(entry.scopeMode ?? void 0),
      optionalString(entry.scopeCreatedFrom),
      optionalString(entry.scopeCreatedTo),
      optionalNumber(entry.attempt),
      optionalNumber(entry.retryCount),
      optionalNumber(entry.httpStatus),
      optionalString(entry.failureKind),
      optionalString(entry.errorType),
      optionalString(entry.errorCode),
      optionalNumber(entry.retryAfterSeconds),
      optionalString(entry.upstreamRequestId),
      optionalString(entry.nextAt),
      optionalNumber(entry.waitMs),
      optionalString(entry.waitReason),
      optionalString(entry.agentRunStatus),
      optionalBoolean(entry.agentRunIdPresent),
      optionalNumber(entry.agentStatusPollCount),
      optionalNumber(entry.agentStatusPollDurationMs),
      optionalNumber(entry.agentAcceptedToCallbackMs),
      optionalString(entry.resultStatus),
      optionalString(entry.failureStage),
      optionalNumber(entry.ticketsConsidered),
      optionalNumber(entry.ticketsCompleted),
      optionalNumber(entry.ticketsDeferred),
      optionalNumber(entry.superopsAttempts),
      optionalNumber(entry.superopsRetries),
      optionalNumber(entry.runDurationMs),
      optionalNumber(entry.notificationCount),
      optionalNumber(entry.discoveredCount),
      optionalNumber(entry.acceptedCount),
      optionalNumber(entry.duplicateCount),
      optionalNumber(entry.rejectedCount),
      optionalBoolean(entry.partial),
      optionalString(entry.scheduledAt),
      optionalNumber(entry.alarmLatenessMs),
      optionalNumber(entry.durationMs),
      optionalString(entry.source),
      optionalString(entry.phaseStatus),
      optionalString(entry.subscriptionExpirationAt),
      optionalString(entry.operationId),
      optionalString(entry.resultReference),
      optionalJson(entry.ticketOutcomes),
      optionalJson(entry.failureDiagnostics),
      optionalJson(entry.mcpExecution),
      optionalJson(entry.operationStatus)
    );
  }
}
__name(persistDispatchHistory, "persistDispatchHistory");
function asScopeMode(value) {
  return value === "new-email-tickets" || value === "full-new-calls" ? value : null;
}
__name(asScopeMode, "asScopeMode");
function asResultStatus(value) {
  return value === "complete" || value === "retryable_rate_limit" || value === "terminal_failure" ? value : void 0;
}
__name(asResultStatus, "asResultStatus");
function asOptionalNumber(value) {
  return value === null ? void 0 : value;
}
__name(asOptionalNumber, "asOptionalNumber");
function asOptionalJson(value) {
  if (value === null) return void 0;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
__name(asOptionalJson, "asOptionalJson");
function rowToEntry(row) {
  const resultStatus = asResultStatus(row.result_status);
  return {
    eventId: row.event_id,
    at: row.occurred_at,
    batchSequence: row.batch_sequence,
    event: row.event_name,
    scopeMode: asScopeMode(row.scope_mode),
    ...row.scope_created_from === null ? {} : { scopeCreatedFrom: row.scope_created_from },
    ...row.scope_created_to === null ? {} : { scopeCreatedTo: row.scope_created_to },
    ...asOptionalNumber(row.attempt) === void 0 ? {} : { attempt: row.attempt },
    ...asOptionalNumber(row.retry_count) === void 0 ? {} : { retryCount: row.retry_count },
    ...asOptionalNumber(row.http_status) === void 0 ? {} : { httpStatus: row.http_status },
    ...row.failure_kind === null ? {} : { failureKind: row.failure_kind },
    ...row.error_type === null ? {} : { errorType: row.error_type },
    ...row.error_code === null ? {} : { errorCode: row.error_code },
    ...asOptionalNumber(row.retry_after_seconds) === void 0 ? {} : { retryAfterSeconds: row.retry_after_seconds },
    ...row.upstream_request_id === null ? {} : { upstreamRequestId: row.upstream_request_id },
    ...row.next_at === null ? {} : { nextAt: row.next_at },
    ...asOptionalNumber(row.wait_ms) === void 0 ? {} : { waitMs: row.wait_ms },
    ...row.wait_reason === null ? {} : { waitReason: row.wait_reason },
    ...row.agent_run_status === null ? {} : { agentRunStatus: row.agent_run_status },
    ...row.agent_run_id_present === null ? {} : { agentRunIdPresent: row.agent_run_id_present === 1 },
    ...asOptionalNumber(row.agent_status_poll_count) === void 0 ? {} : { agentStatusPollCount: row.agent_status_poll_count },
    ...asOptionalNumber(row.agent_status_poll_duration_ms) === void 0 ? {} : { agentStatusPollDurationMs: row.agent_status_poll_duration_ms },
    ...asOptionalNumber(row.agent_accepted_to_callback_ms) === void 0 ? {} : { agentAcceptedToCallbackMs: row.agent_accepted_to_callback_ms },
    ...resultStatus === void 0 ? {} : { resultStatus },
    ...row.failure_stage === null ? {} : { failureStage: row.failure_stage },
    ...asOptionalNumber(row.tickets_considered) === void 0 ? {} : { ticketsConsidered: row.tickets_considered },
    ...asOptionalNumber(row.tickets_completed) === void 0 ? {} : { ticketsCompleted: row.tickets_completed },
    ...asOptionalNumber(row.tickets_deferred) === void 0 ? {} : { ticketsDeferred: row.tickets_deferred },
    ...asOptionalNumber(row.superops_attempts) === void 0 ? {} : { superopsAttempts: row.superops_attempts },
    ...asOptionalNumber(row.superops_retries) === void 0 ? {} : { superopsRetries: row.superops_retries },
    ...asOptionalNumber(row.run_duration_ms) === void 0 ? {} : { runDurationMs: row.run_duration_ms },
    ...asOptionalNumber(row.notification_count) === void 0 ? {} : { notificationCount: row.notification_count },
    ...asOptionalNumber(row.discovered_count) === void 0 ? {} : { discoveredCount: row.discovered_count },
    ...asOptionalNumber(row.accepted_count) === void 0 ? {} : { acceptedCount: row.accepted_count },
    ...asOptionalNumber(row.duplicate_count) === void 0 ? {} : { duplicateCount: row.duplicate_count },
    ...asOptionalNumber(row.rejected_count) === void 0 ? {} : { rejectedCount: row.rejected_count },
    ...row.partial === null ? {} : { partial: row.partial === 1 },
    ...row.scheduled_at === null ? {} : { scheduledAt: row.scheduled_at },
    ...asOptionalNumber(row.alarm_lateness_ms) === void 0 ? {} : { alarmLatenessMs: row.alarm_lateness_ms },
    ...asOptionalNumber(row.duration_ms) === void 0 ? {} : { durationMs: row.duration_ms },
    ...row.source === null ? {} : { source: row.source },
    ...row.phase_status === null ? {} : { phaseStatus: row.phase_status },
    ...row.subscription_expiration_at === null ? {} : { subscriptionExpirationAt: row.subscription_expiration_at },
    ...row.operation_id === null ? {} : { operationId: row.operation_id },
    ...row.result_reference === null ? {} : { resultReference: row.result_reference },
    ...(() => {
      const outcomes = parseSafeTicketOutcomes(asOptionalJson(row.ticket_outcomes_json));
      return outcomes === void 0 || outcomes === null ? {} : { ticketOutcomes: outcomes };
    })(),
    ...(() => {
      const diagnostics = parseSafeFailureDiagnostics(asOptionalJson(row.failure_diagnostics_json));
      return diagnostics === void 0 || diagnostics === null ? {} : { failureDiagnostics: diagnostics };
    })(),
    ...(() => {
      const execution = parseSafeMcpExecution(asOptionalJson(row.mcp_execution_json));
      return execution === void 0 || execution === null ? {} : { mcpExecution: execution };
    })(),
    ...(() => {
      const operationStatus = parseSafeOperationStatus(asOptionalJson(row.operation_status_json));
      return operationStatus === void 0 || operationStatus === null ? {} : { operationStatus };
    })()
  };
}
__name(rowToEntry, "rowToEntry");
function listDispatchHistory(storage, limit = 96, beforeEventId) {
  ensureDispatchHistoryTable(storage);
  const safeLimit = Math.min(MAX_DISPATCH_HISTORY_PAGE_SIZE, Math.max(1, Math.floor(limit)));
  const rows = beforeEventId === void 0 ? storage.sql.exec(
    `SELECT * FROM ${DISPATCH_HISTORY_TABLE} ORDER BY event_id DESC LIMIT ?`,
    safeLimit + 1
  ).toArray() : storage.sql.exec(
    `SELECT * FROM ${DISPATCH_HISTORY_TABLE} WHERE event_id < ? ORDER BY event_id DESC LIMIT ?`,
    beforeEventId,
    safeLimit + 1
  ).toArray();
  const hasMore = rows.length > safeLimit;
  const selected = rows.slice(0, safeLimit).map(rowToEntry).reverse();
  return {
    events: selected,
    hasMore,
    nextBeforeEventId: hasMore ? selected[0]?.eventId ?? null : null
  };
}
__name(listDispatchHistory, "listDispatchHistory");
function listRelevantDispatchHistory(storage, afterEventId, limit = MAX_RELEVANT_HISTORY_PAGE_SIZE, throughEventId) {
  ensureDispatchHistoryTable(storage);
  const safeAfterEventId = Math.max(0, Math.floor(afterEventId));
  const safeLimit = Math.min(
    MAX_RELEVANT_HISTORY_PAGE_SIZE,
    Math.max(1, Math.floor(limit))
  );
  const bounds = storage.sql.exec(
    `SELECT MIN(event_id) AS oldest_event_id, MAX(event_id) AS newest_event_id
       FROM ${DISPATCH_HISTORY_TABLE}`
  ).one();
  const archiveNewestEventId = bounds.newest_event_id ?? 0;
  const effectiveThroughEventId = throughEventId === void 0 ? archiveNewestEventId : Math.min(Math.max(0, Math.floor(throughEventId)), archiveNewestEventId);
  const rows = storage.sql.exec(
    `SELECT * FROM ${DISPATCH_HISTORY_TABLE}
       WHERE event_id > ?
         AND event_id <= ?
         AND ${ROUTINE_RELEVANT_HISTORY_EXCLUSION}
       ORDER BY event_id ASC
       LIMIT ?`,
    safeAfterEventId,
    effectiveThroughEventId,
    safeLimit + 1
  ).toArray();
  const hasMore = rows.length > safeLimit;
  const selected = rows.slice(0, safeLimit).map(rowToEntry);
  const nextAfterEventId = hasMore ? selected.at(-1)?.eventId ?? null : null;
  if (hasMore && (nextAfterEventId === null || nextAfterEventId <= safeAfterEventId)) {
    throw new Error("relevant_history_cursor_did_not_advance");
  }
  const archiveCoverageStartsAtCheckpoint = bounds.oldest_event_id === null || safeAfterEventId >= bounds.oldest_event_id - 1;
  const complete = !hasMore && archiveCoverageStartsAtCheckpoint;
  return {
    filter: "relevant",
    events: selected,
    hasMore,
    nextAfterEventId,
    coverage: {
      afterEventId: safeAfterEventId,
      throughEventId: effectiveThroughEventId,
      archiveOldestEventId: bounds.oldest_event_id,
      archiveNewestEventId: bounds.newest_event_id,
      returned: selected.length,
      complete,
      truncated: !complete
    }
  };
}
__name(listRelevantDispatchHistory, "listRelevantDispatchHistory");
function pruneDispatchHistory(storage, retentionDays, maxRows, now = Date.now()) {
  ensureDispatchHistoryTable(storage);
  const safeRetentionDays = Math.min(365, Math.max(1, Math.floor(retentionDays)));
  const safeMaxRows = Math.min(1e5, Math.max(1, Math.floor(maxRows)));
  const cutoff = new Date(now - safeRetentionDays * 24 * 60 * 60 * 1e3).toISOString();
  const expiredRows = storage.sql.exec(
    `DELETE FROM ${DISPATCH_HISTORY_TABLE}
       WHERE occurred_at < ?
       RETURNING event_id`,
    cutoff
  ).toArray();
  const boundary = storage.sql.exec(
    `SELECT event_id FROM ${DISPATCH_HISTORY_TABLE}
       ORDER BY event_id DESC
       LIMIT 1 OFFSET ?`,
    safeMaxRows - 1
  ).toArray()[0]?.event_id;
  const cappedRows = boundary === void 0 ? [] : storage.sql.exec(
    `DELETE FROM ${DISPATCH_HISTORY_TABLE}
         WHERE event_id < ?
         RETURNING event_id`,
    boundary
  ).toArray();
  return {
    deletedByAge: expiredRows.length,
    deletedByCap: cappedRows.length,
    totalDeleted: expiredRows.length + cappedRows.length
  };
}
__name(pruneDispatchHistory, "pruneDispatchHistory");
function clearDispatchHistory(storage) {
  ensureDispatchHistoryTable(storage);
  return storage.sql.exec(
    `DELETE FROM ${DISPATCH_HISTORY_TABLE} RETURNING event_id`
  ).toArray().length;
}
__name(clearDispatchHistory, "clearDispatchHistory");

// src/safe-log.ts
function redactLogFields(fields) {
  return JSON.parse(JSON.stringify(fields ?? {}).replace(
    /triage-(\d+)-[0-9a-f-]{36}/gi,
    "triage-$1-[redacted]"
  ));
}
__name(redactLogFields, "redactLogFields");
function createSafeLogger() {
  return {
    info(event, fields) {
      console.log(JSON.stringify({ event, ...redactLogFields(fields) }));
    },
    warn(event, fields) {
      console.warn(JSON.stringify({ event, ...redactLogFields(fields) }));
    }
  };
}
__name(createSafeLogger, "createSafeLogger");

// src/durable-object.ts
var STATE_KEY = "coordinator-state";
var MAX_LOGGED_TICKET_NUMBER_CHARS = 4096;
var HISTORY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1e3;
function loggedTicketNumbers(ticketOutcomes) {
  const numbers = Array.isArray(ticketOutcomes) ? ticketOutcomes.map((outcome) => outcome.ticketNumber) : [];
  const joined = numbers.join(",");
  if (joined.length === 0) return { ticketNumbers: null, ticketNumbersTruncated: false };
  return {
    ticketNumbers: joined.slice(0, MAX_LOGGED_TICKET_NUMBER_CHARS),
    ticketNumbersTruncated: joined.length > MAX_LOGGED_TICKET_NUMBER_CHARS
  };
}
__name(loggedTicketNumbers, "loggedTicketNumbers");
function loggedBatchSequence(triggerId) {
  const value = triggerId?.match(/^triage-(\d+)-/)?.[1];
  if (!value) return null;
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}
__name(loggedBatchSequence, "loggedBatchSequence");
async function tryRecordHistory(store, details, now = Date.now()) {
  try {
    const state = normalizeState(await store.load());
    appendDispatchHistory(state, details, now);
    await store.save(state);
  } catch (error) {
    console.warn("triage_dispatch_history_event_failed", {
      event: details.event,
      reason: error instanceof Error ? error.name : "unknown"
    });
  }
}
__name(tryRecordHistory, "tryRecordHistory");
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
__name(json, "json");
function logger() {
  return createSafeLogger();
}
__name(logger, "logger");
function safeCoordinatorNextAt(state) {
  const deferredCandidates = [
    state.unavailableRetryWindow?.dueAt,
    state.reconciliationHold?.dueAt,
    state.queuedPending && state.queuedNotificationWindowStartedAt !== null && !(state.queuedBlockedByAttention && state.attentionBlockedWindow === null) ? state.queuedDueAt : null
  ].filter((at) => at !== null && at !== void 0 && Number.isFinite(at));
  const deferredAt = deferredCandidates.length === 0 ? null : Math.min(...deferredCandidates);
  const candidates = [
    state.dueAt,
    deferredAt
  ].filter((at) => at !== null && Number.isFinite(at));
  const next = candidates.length === 0 ? null : Math.min(...candidates);
  if (state.sharedRateLimitUntil !== null && state.sharedRateLimitUntil > Date.now()) {
    return next === null ? state.sharedRateLimitUntil : Math.max(next, state.sharedRateLimitUntil);
  }
  return next;
}
__name(safeCoordinatorNextAt, "safeCoordinatorNextAt");
function safeCoordinatorStateFields(state, now) {
  const nextAt = safeCoordinatorNextAt(state);
  return {
    ...coordinatorProgressFields(state),
    pending: state.pending,
    phase: state.executionPhase,
    scopeMode: state.pendingTriggerScope?.mode ?? null,
    acceptedRunIdPresent: state.executionPhase === "awaiting_result" && typeof state.lastAcceptedTrigger?.runId === "string",
    acceptedRunLeaseUnknown: state.acceptedRunLeaseUnknown,
    resultDeadlineExpired: state.resultDeadlineAt !== null && state.resultDeadlineAt <= now,
    queuedPending: state.queuedPending,
    pendingDispatchWaitReason: state.pendingDispatchWaitReason,
    reconciliationHoldPending: state.reconciliationHold !== null,
    reconciliationHoldDueAt: state.reconciliationHold === null ? null : new Date(state.reconciliationHold.dueAt).toISOString(),
    sharedRateLimitUntil: state.sharedRateLimitUntil === null ? null : new Date(state.sharedRateLimitUntil).toISOString(),
    queuedBlockedByAttention: state.queuedBlockedByAttention,
    attentionBlockedPending: state.attentionBlockedWindow !== null,
    attentionBlockedWindowStartedAt: state.attentionBlockedWindow === null ? null : new Date(state.attentionBlockedWindow.notificationWindowStartedAt).toISOString(),
    attentionBlockedWindowEndedAt: state.attentionBlockedWindow?.notificationWindowEndedAt === null || state.attentionBlockedWindow === null ? null : new Date(state.attentionBlockedWindow.notificationWindowEndedAt).toISOString(),
    notificationReceivedAt: state.pendingNotificationWindowStartedAt === null ? null : new Date(state.pendingNotificationWindowStartedAt).toISOString(),
    queuedNotificationReceivedAt: state.queuedNotificationWindowStartedAt === null ? null : new Date(state.queuedNotificationWindowStartedAt).toISOString(),
    nextAt: nextAt === null ? null : new Date(nextAt).toISOString(),
    queuedDueAt: state.queuedDueAt === null ? null : new Date(state.queuedDueAt).toISOString(),
    queuedUnavailableRetryCount: state.queuedUnavailableRetryCount,
    unavailableRetryPending: state.unavailableRetryWindow !== null,
    unavailableRetryCount: state.unavailableRetryWindow?.retryCount ?? 0,
    unavailableRetryDueAt: state.unavailableRetryWindow === null ? null : new Date(state.unavailableRetryWindow.dueAt).toISOString(),
    unavailableRetryScopeCreatedFrom: state.unavailableRetryWindow?.scope.createdFrom ?? null,
    unavailableRetryScopeCreatedTo: state.unavailableRetryWindow?.scope.createdTo ?? null,
    needsAttention: state.needsAttentionScope !== null,
    needsAttentionCount: state.needsAttentionCount,
    needsAttentionScopeCount: state.needsAttentionScopes.length,
    needsAttentionAt: state.needsAttentionAt === null ? null : new Date(state.needsAttentionAt).toISOString(),
    needsAttentionScopeCreatedFrom: state.needsAttentionScope?.mode === "new-email-tickets" ? state.needsAttentionScope.createdFrom : null,
    needsAttentionScopeCreatedTo: state.needsAttentionScope?.mode === "new-email-tickets" ? state.needsAttentionScope.createdTo : null,
    notificationAgeMs: state.pendingNotificationWindowStartedAt === null ? null : Math.max(0, now - state.pendingNotificationWindowStartedAt),
    queuedNotificationAgeMs: state.queuedNotificationWindowStartedAt === null ? null : Math.max(0, now - state.queuedNotificationWindowStartedAt),
    retryCount: state.retryCount,
    lastFailureKind: state.lastFailure?.kind ?? null,
    lastFailureAt: state.lastFailure?.recordedAt ?? null,
    lastNotificationBatchAt: state.lastNotificationBatchAt === null ? null : new Date(state.lastNotificationBatchAt).toISOString(),
    lastAcceptedNotificationAt: state.lastAcceptedNotificationAt === null ? null : new Date(state.lastAcceptedNotificationAt).toISOString(),
    lastRejectedNotificationAt: state.lastRejectedNotificationAt === null ? null : new Date(state.lastRejectedNotificationAt).toISOString(),
    lastDuplicateNotificationAt: state.lastDuplicateNotificationAt === null ? null : new Date(state.lastDuplicateNotificationAt).toISOString(),
    acceptedNotificationCount: state.acceptedNotificationCount,
    rejectedNotificationCount: state.rejectedNotificationCount,
    duplicateNotificationCount: state.duplicateNotificationCount,
    lastGraphSweepAt: state.lastGraphSweepAt === null ? null : new Date(state.lastGraphSweepAt).toISOString(),
    lastGraphSweepMessageCount: state.lastGraphSweepMessageCount,
    lastGraphSweepErrorAt: state.lastGraphSweepErrorAt === null ? null : new Date(state.lastGraphSweepErrorAt).toISOString(),
    lastHistoryPrunedAt: state.lastHistoryPrunedAt === null ? null : new Date(state.lastHistoryPrunedAt).toISOString()
  };
}
__name(safeCoordinatorStateFields, "safeCoordinatorStateFields");
function safeCoordinatorStatus(state, now, dispatchHistory = state.dispatchHistory.slice(-MAX_DISPATCH_HISTORY), dispatchHistoryCount = state.dispatchHistory.length) {
  const lastResultTiming = [...dispatchHistory].reverse().find((entry) => entry.event === "result_callback_received");
  return {
    ...safeCoordinatorStateFields(state, now),
    pendingReason: state.pendingReason,
    dueAt: state.dueAt === null ? null : new Date(state.dueAt).toISOString(),
    queuedDueAt: state.queuedDueAt === null ? null : new Date(state.queuedDueAt).toISOString(),
    queuedUnavailableRetryCount: state.queuedUnavailableRetryCount,
    unavailableRetryPending: state.unavailableRetryWindow !== null,
    unavailableRetryCount: state.unavailableRetryWindow?.retryCount ?? 0,
    unavailableRetryDueAt: state.unavailableRetryWindow === null ? null : new Date(state.unavailableRetryWindow.dueAt).toISOString(),
    unavailableRetryScope: state.unavailableRetryWindow === null ? null : {
      createdFrom: state.unavailableRetryWindow.scope.createdFrom,
      createdTo: state.unavailableRetryWindow.scope.createdTo,
      source: state.unavailableRetryWindow.scope.source
    },
    needsAttention: state.needsAttentionScope !== null,
    needsAttentionCount: state.needsAttentionCount,
    needsAttentionRetryCount: state.needsAttentionRetryCount,
    needsAttentionScope: state.needsAttentionScope?.mode === "new-email-tickets" ? {
      createdFrom: state.needsAttentionScope.createdFrom,
      createdTo: state.needsAttentionScope.createdTo,
      source: state.needsAttentionScope.source
    } : null,
    reconciliationHoldPending: state.reconciliationHold !== null,
    reconciliationHoldDueAt: state.reconciliationHold === null ? null : new Date(state.reconciliationHold.dueAt).toISOString(),
    reconciliationHoldScope: state.reconciliationHold === null ? null : {
      createdFrom: state.reconciliationHold.scope.createdFrom,
      createdTo: state.reconciliationHold.scope.createdTo,
      source: state.reconciliationHold.scope.source
    },
    sharedRateLimitUntil: state.sharedRateLimitUntil === null ? null : new Date(state.sharedRateLimitUntil).toISOString(),
    queuedBlockedByAttention: state.queuedBlockedByAttention,
    resultDeadlineAt: state.resultDeadlineAt === null ? null : new Date(state.resultDeadlineAt).toISOString(),
    dispatchAttempt: state.dispatchAttempt,
    retryCount: state.retryCount,
    lastFailureKind: state.lastFailure?.kind ?? null,
    lastFailureAt: state.lastFailure?.recordedAt ?? null,
    lastAcceptedAt: state.lastAcceptedTrigger?.acceptedAt ?? null,
    lastResultStatus: state.lastResultReport?.status ?? null,
    lastResultAt: state.lastResultReport?.recordedAt ?? null,
    lastResultFailureStage: state.lastResultReport?.metadata?.failureStage ?? null,
    lastResultOperationIdPresent: state.lastResultReport?.metadata?.operationId !== void 0,
    lastResultReferencePresent: state.lastResultReport?.metadata?.resultReference !== void 0,
    lastResultTicketsConsidered: state.lastResultReport?.metadata?.ticketsConsidered ?? null,
    lastResultTicketsCompleted: state.lastResultReport?.metadata?.ticketsCompleted ?? null,
    lastResultTicketsDeferred: state.lastResultReport?.metadata?.ticketsDeferred ?? null,
    lastResultSuperopsAttempts: state.lastResultReport?.metadata?.superopsAttempts ?? null,
    lastResultSuperopsRetries: state.lastResultReport?.metadata?.superopsRetries ?? null,
    lastResultRunDurationMs: state.lastResultReport?.metadata?.runDurationMs ?? null,
    lastResultAgentStatusPollCount: lastResultTiming?.agentStatusPollCount ?? null,
    lastResultAgentAcceptedToCallbackMs: lastResultTiming?.agentAcceptedToCallbackMs ?? null,
    dispatchHistoryCount,
    dispatchHistorySequence: state.dispatchHistorySequence,
    dispatchHistory,
    lastNotificationBatchAt: state.lastNotificationBatchAt === null ? null : new Date(state.lastNotificationBatchAt).toISOString(),
    lastAcceptedNotificationAt: state.lastAcceptedNotificationAt === null ? null : new Date(state.lastAcceptedNotificationAt).toISOString(),
    lastRejectedNotificationAt: state.lastRejectedNotificationAt === null ? null : new Date(state.lastRejectedNotificationAt).toISOString(),
    lastDuplicateNotificationAt: state.lastDuplicateNotificationAt === null ? null : new Date(state.lastDuplicateNotificationAt).toISOString(),
    acceptedNotificationCount: state.acceptedNotificationCount,
    rejectedNotificationCount: state.rejectedNotificationCount,
    duplicateNotificationCount: state.duplicateNotificationCount,
    lastGraphSweepAt: state.lastGraphSweepAt === null ? null : new Date(state.lastGraphSweepAt).toISOString(),
    lastGraphSweepMessageCount: state.lastGraphSweepMessageCount,
    lastGraphSweepErrorAt: state.lastGraphSweepErrorAt === null ? null : new Date(state.lastGraphSweepErrorAt).toISOString(),
    subscription: state.subscription === null ? null : {
      idPresent: state.subscription.id.length > 0,
      expirationDateTime: state.subscription.expirationDateTime
    },
    now: new Date(now).toISOString()
  };
}
__name(safeCoordinatorStatus, "safeCoordinatorStatus");
var DurableObjectStore = class {
  constructor(storage) {
    this.storage = storage;
  }
  storage;
  static {
    __name(this, "DurableObjectStore");
  }
  async load() {
    return normalizeState(await this.storage.get(STATE_KEY));
  }
  async save(state) {
    try {
      persistDispatchHistory(this.storage, state.dispatchHistory);
    } catch (error) {
      console.warn("triage_dispatch_history_persist_failed", {
        reason: error instanceof Error ? error.name : "unknown"
      });
    }
    await this.storage.put(STATE_KEY, state);
  }
  async setAlarm(at) {
    await this.storage.setAlarm(at);
  }
  listDispatchHistory(limit, beforeEventId) {
    return listDispatchHistory(this.storage, limit, beforeEventId);
  }
  listRelevantDispatchHistory(afterEventId, limit, throughEventId) {
    return listRelevantDispatchHistory(this.storage, afterEventId, limit, throughEventId);
  }
  clearDispatchHistory() {
    return clearDispatchHistory(this.storage);
  }
  pruneDispatchHistory(retentionDays, maxRows, now) {
    return pruneDispatchHistory(this.storage, retentionDays, maxRows, now);
  }
};
var TriageCoordinator = class {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  state;
  env;
  static {
    __name(this, "TriageCoordinator");
  }
  lock = Promise.resolve();
  async fetch(request) {
    return this.exclusive(() => this.handleFetch(request));
  }
  async exclusive(work) {
    const previous = this.lock;
    let release;
    this.lock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
  async rearmAlarm(fallbackAt) {
    const now = Date.now();
    let nextAt = fallbackAt;
    try {
      const state = normalizeState(await this.state.storage.get(STATE_KEY));
      const stateNextAt = safeCoordinatorNextAt(state);
      if (stateNextAt !== null && stateNextAt > now) nextAt = Math.min(nextAt, stateNextAt);
    } catch {
    }
    try {
      await this.state.storage.setAlarm(nextAt);
    } catch {
    }
    return nextAt;
  }
  async maybePruneDispatchHistory(config, store) {
    try {
      const state = await store.load();
      const now = Date.now();
      if (state.lastHistoryPrunedAt !== null && now - state.lastHistoryPrunedAt < HISTORY_PRUNE_INTERVAL_MS) {
        return;
      }
      const result = store.pruneDispatchHistory(
        config.historyRetentionDays,
        config.historyMaxRows,
        now
      );
      state.lastHistoryPrunedAt = now;
      await store.save(state);
      logger().info("triage_dispatch_history_pruned", {
        deletedByAge: result.deletedByAge,
        deletedByCap: result.deletedByCap,
        totalDeleted: result.totalDeleted,
        retentionDays: config.historyRetentionDays,
        maxRows: config.historyMaxRows
      });
    } catch (error) {
      logger().warn("triage_dispatch_history_prune_failed", {
        reason: error instanceof Error ? error.name : "unknown"
      });
    }
  }
  async handleFetch(request) {
    const path = new URL(request.url).pathname;
    const config = loadConfig(this.env);
    const store = new DurableObjectStore(this.state.storage);
    const graph = new GraphSubscriptionManager(config, boundWorkerFetch, logger());
    const engine = new CoordinatorEngine({
      config,
      store,
      graph,
      agent: new WorkspaceAgentTriggerClient(config, boundWorkerFetch, logger()),
      logger: logger()
    });
    if (request.method === "POST" && path === "/internal/history/reset") {
      const state = normalizeState(await store.load());
      let resetRunStatus = null;
      if (state.pending && state.executionPhase !== "retry_wait") {
        return json({
          error: "history_reset_requires_idle",
          pending: state.pending,
          queuedPending: state.queuedPending,
          phase: state.executionPhase
        }, 409);
      }
      if (state.pending && state.lastAcceptedTrigger?.runId) {
        const diagnostics = await new WorkspaceAgentTriggerClient(
          config,
          boundWorkerFetch,
          logger()
        ).getRunDiagnostics(state.lastAcceptedTrigger.runId);
        resetRunStatus = diagnostics.status;
        if (diagnostics.status !== "completed" && diagnostics.status !== "failed") {
          return json({
            error: "history_reset_requires_idle",
            pending: state.pending,
            queuedPending: state.queuedPending,
            phase: state.executionPhase,
            agentRunStatus: diagnostics.status
          }, 409);
        }
      }
      try {
        const clearedEventCount = store.clearDispatchHistory();
        const preservedPending = state.pending || state.queuedPending || state.unavailableRetryWindow !== null;
        const preservedNotificationFingerprints = state.seenNotificationFingerprints.length;
        const preservedSubscription = state.subscription !== null;
        state.dispatchHistory = [];
        state.dispatchHistorySequence = 0;
        state.lastAcceptedTrigger = null;
        state.lastResultReport = null;
        state.lastFailure = null;
        state.lastLifecycleEvent = null;
        state.lifecycleRecoveryRequested = false;
        state.lastHistoryPrunedAt = Date.now();
        state.lastNotificationBatchAt = null;
        state.lastAcceptedNotificationAt = null;
        state.lastRejectedNotificationAt = null;
        state.lastDuplicateNotificationAt = null;
        state.acceptedNotificationCount = 0;
        state.rejectedNotificationCount = 0;
        state.duplicateNotificationCount = 0;
        state.lastGraphSweepMessageCount = 0;
        state.lastGraphSweepErrorAt = null;
        if (!preservedPending) state.pendingTicketOutcomes = null;
        await store.save(state);
        if (preservedPending) {
          const nextAt = safeCoordinatorNextAt(state);
          await store.setAlarm(nextAt === null ? Date.now() : Math.max(Date.now(), nextAt));
        }
        logger().info("triage_dispatch_history_reset", {
          clearedEventCount,
          preservedPending,
          resetRunStatus,
          preservedNotificationFingerprints,
          preservedSubscription,
          lastGraphSweepAt: state.lastGraphSweepAt === null ? null : new Date(state.lastGraphSweepAt).toISOString()
        });
        return json({
          ok: true,
          clearedEventCount,
          clearedAt: (/* @__PURE__ */ new Date()).toISOString(),
          dispatchHistoryCount: 0,
          preservedPending,
          resetRunStatus,
          preservedNotificationFingerprints,
          preservedSubscription,
          preservedLastGraphSweepAt: state.lastGraphSweepAt === null ? null : new Date(state.lastGraphSweepAt).toISOString()
        });
      } catch (error) {
        logger().warn("triage_dispatch_history_reset_failed", {
          reason: error instanceof Error ? error.name : "unknown"
        });
        return json({ error: "history_reset_failed" }, 503);
      }
    }
    if (request.method === "POST" && path === "/internal/notifications") {
      let collection;
      try {
        collection = await request.json();
      } catch {
        return json({ error: "invalid_payload" }, 400);
      }
      const startedAt = Date.now();
      const result = await engine.accept(collection);
      const notificationCount = Array.isArray(collection.value) ? collection.value.length : 0;
      await tryRecordHistory(store, {
        event: "notification_batch_processed",
        batchSequence: null,
        scopeMode: config.scopeMode,
        notificationCount: notificationCount > 0 ? notificationCount : void 0,
        discoveredCount: notificationCount,
        acceptedCount: result.accepted,
        duplicateCount: result.duplicates,
        rejectedCount: result.rejected,
        scheduledAt: result.scheduledAt === null ? void 0 : new Date(result.scheduledAt).toISOString(),
        durationMs: Math.max(0, Date.now() - startedAt),
        phaseStatus: result.accepted > 0 ? "updated" : "idle"
      });
      logger().info("graph_notifications_registered", {
        accepted: result.accepted,
        duplicates: result.duplicates,
        rejected: result.rejected,
        lifecycleEvents: result.lifecycleEvents.length,
        scheduledAtPresent: result.scheduledAt !== null
      });
      return json(result, 202);
    }
    if (request.method === "GET" && path === "/internal/status") {
      const state = await store.load();
      return json(safeCoordinatorStatus(
        state,
        Date.now(),
        state.dispatchHistory.slice(-MAX_DISPATCH_HISTORY),
        state.dispatchHistory.length
      ));
    }
    if (request.method === "GET" && path === "/internal/history") {
      const url = new URL(request.url);
      if (url.searchParams.has("filter")) {
        const relevantHistoryQuery = parseRelevantHistoryQuery(url.searchParams);
        if (!relevantHistoryQuery.ok) return json(relevantHistoryQuery.error, 400);
        try {
          return json(store.listRelevantDispatchHistory(
            relevantHistoryQuery.afterEventId,
            relevantHistoryQuery.limit,
            relevantHistoryQuery.throughEventId
          ));
        } catch (error) {
          console.warn("triage_relevant_history_read_failed", {
            reason: error instanceof Error ? error.name : "unknown"
          });
          return json({ error: "history_unavailable" }, 503);
        }
      }
      const historyQuery = parseHistoryQuery(url.searchParams);
      if (!historyQuery.ok) return json(historyQuery.error, 400);
      const requestedLimit = Number(url.searchParams.get("limit") ?? "96");
      const limit = Number.isInteger(requestedLimit) ? Math.min(MAX_DISPATCH_HISTORY_PAGE_SIZE, Math.max(1, requestedLimit)) : 96;
      const beforeEventId = historyQuery.beforeEventId;
      try {
        const page = store.listDispatchHistory(limit, beforeEventId);
        if (page.events.length > 0 || beforeEventId !== void 0) return json(page);
        const state = await store.load();
        return json({
          events: state.dispatchHistory.slice(-limit),
          hasMore: false,
          nextBeforeEventId: null
        });
      } catch (error) {
        console.warn("triage_dispatch_history_read_failed", {
          reason: error instanceof Error ? error.name : "unknown"
        });
        return json({ error: "history_unavailable" }, 503);
      }
    }
    if (request.method === "POST" && path === "/internal/maintenance") {
      const maintenanceStartedAt = Date.now();
      await tryRecordHistory(store, {
        event: "maintenance_started",
        batchSequence: null,
        scopeMode: config.scopeMode,
        source: "cron_maintenance"
      }, maintenanceStartedAt);
      await this.maybePruneDispatchHistory(config, store);
      try {
        const subscriptionStartedAt = Date.now();
        const subscription = await engine.maintainSubscription();
        const subscriptionState = await store.load();
        await tryRecordHistory(store, {
          event: subscription.status === "failed" ? "subscription_maintenance_failed" : "subscription_maintenance_completed",
          batchSequence: null,
          scopeMode: config.scopeMode,
          source: "cron_maintenance",
          phaseStatus: subscription.status,
          httpStatus: subscription.httpStatus,
          errorType: subscription.errorType,
          errorCode: subscription.errorCode,
          upstreamRequestId: subscription.upstreamRequestId,
          failureDiagnostics: subscription.failureDiagnostics,
          subscriptionExpirationAt: subscriptionState.subscription?.expirationDateTime,
          durationMs: Math.max(0, Date.now() - subscriptionStartedAt)
        });
        const sweepStartedAt = Date.now();
        const sweep = await engine.sweepRecentMessages();
        await tryRecordHistory(store, {
          event: sweep.status === "failed" ? "graph_sweep_failed" : "graph_sweep_completed",
          batchSequence: null,
          scopeMode: config.scopeMode,
          source: "cron_maintenance",
          phaseStatus: sweep.status,
          discoveredCount: sweep.discovered,
          acceptedCount: sweep.accepted,
          duplicateCount: sweep.duplicates,
          rejectedCount: sweep.rejected,
          partial: sweep.partial,
          httpStatus: sweep.httpStatus,
          errorType: sweep.errorType,
          errorCode: sweep.errorCode,
          upstreamRequestId: sweep.upstreamRequestId,
          failureDiagnostics: sweep.failureDiagnostics,
          durationMs: Math.max(0, Date.now() - sweepStartedAt)
        });
        const alarmStartedAt = Date.now();
        const alarmState = await store.load();
        await tryRecordHistory(store, {
          event: "alarm_started",
          batchSequence: null,
          scopeMode: config.scopeMode,
          source: "cron_maintenance",
          scheduledAt: safeCoordinatorNextAt(alarmState) === null ? void 0 : new Date(safeCoordinatorNextAt(alarmState)).toISOString(),
          alarmLatenessMs: safeCoordinatorNextAt(alarmState) === null ? void 0 : Math.max(0, alarmStartedAt - safeCoordinatorNextAt(alarmState))
        }, alarmStartedAt);
        let processed;
        try {
          processed = await engine.processAlarm();
        } catch (error) {
          const nextAt = await this.rearmAlarm(Date.now() + 6e4);
          await tryRecordHistory(store, {
            event: "alarm_failed",
            batchSequence: null,
            scopeMode: config.scopeMode,
            source: "cron_maintenance",
            phaseStatus: "failed",
            failureKind: "transient",
            errorType: error instanceof Error ? error.name : "unknown",
            nextAt: new Date(nextAt).toISOString(),
            durationMs: Math.max(0, Date.now() - alarmStartedAt)
          });
          logger().warn("coordinator_maintenance_processing_failed", {
            reason: error instanceof Error ? error.name : "unknown",
            nextAt: new Date(nextAt).toISOString()
          });
          processed = { status: "retry_scheduled", nextAt };
        }
        if (processed.status !== "retry_scheduled" || processed.triggerId !== void 0) {
          await tryRecordHistory(store, {
            event: "alarm_completed",
            batchSequence: null,
            scopeMode: config.scopeMode,
            source: "cron_maintenance",
            phaseStatus: processed.status,
            nextAt: processed.nextAt === void 0 ? void 0 : new Date(processed.nextAt).toISOString(),
            durationMs: Math.max(0, Date.now() - alarmStartedAt)
          });
        }
        if (subscription.status === "failed" || sweep.status === "failed") {
          await this.rearmAlarm(Date.now() + 6e4);
        }
        logger().info("coordinator_maintenance_state", safeCoordinatorStateFields(await store.load(), Date.now()));
        logger().info("coordinator_maintenance_sweep", {
          status: sweep.status,
          discovered: sweep.discovered,
          accepted: sweep.accepted,
          duplicates: sweep.duplicates,
          rejected: sweep.rejected,
          partial: sweep.partial
        });
        logger().info("coordinator_maintenance_processed", {
          status: processed.status,
          triggerId: processed.triggerId ?? null,
          nextAt: processed.nextAt === void 0 ? null : new Date(processed.nextAt).toISOString()
        });
        await tryRecordHistory(store, {
          event: "maintenance_completed",
          batchSequence: null,
          scopeMode: config.scopeMode,
          source: "cron_maintenance",
          phaseStatus: "complete",
          nextAt: processed.nextAt === void 0 ? void 0 : new Date(processed.nextAt).toISOString(),
          durationMs: Math.max(0, Date.now() - maintenanceStartedAt)
        });
        return json({ subscription, sweep, processed });
      } catch (error) {
        const nextAt = await this.rearmAlarm(Date.now() + 6e4);
        await tryRecordHistory(store, {
          event: "maintenance_failed",
          batchSequence: null,
          scopeMode: config.scopeMode,
          source: "cron_maintenance",
          phaseStatus: "failed",
          failureKind: "transient",
          errorType: error instanceof Error ? error.name : "unknown",
          nextAt: new Date(nextAt).toISOString(),
          durationMs: Math.max(0, Date.now() - maintenanceStartedAt)
        });
        logger().warn("coordinator_maintenance_processing_failed", {
          reason: error instanceof Error ? error.name : "unknown",
          nextAt: new Date(nextAt).toISOString()
        });
        return json({ error: "maintenance_failed", nextAt: new Date(nextAt).toISOString() }, 500);
      }
    }
    if (request.method === "POST" && path === "/internal/triage-result") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid_payload" }, 400);
      }
      const report = parseTriageResultReport(body);
      if (!report) return json({ error: "invalid_safe_report" }, 400);
      const result = await engine.reportResult(report);
      const metadata = report.metadata ?? {};
      const ticketNumberLog = loggedTicketNumbers(metadata.ticketOutcomes);
      logger().info("triage_result_recorded", {
        status: result.status,
        batchSequence: loggedBatchSequence(result.triggerId),
        nextAt: result.nextAt === void 0 ? null : new Date(result.nextAt).toISOString(),
        reportedStatus: report.status,
        retryAfterSeconds: report.retryAfterSeconds ?? null,
        failureStage: metadata.failureStage ?? null,
        operationIdPresent: metadata.operationId !== void 0,
        resultReferencePresent: metadata.resultReference !== void 0,
        ticketsConsidered: metadata.ticketsConsidered ?? null,
        ticketsCompleted: metadata.ticketsCompleted ?? null,
        ticketsDeferred: metadata.ticketsDeferred ?? null,
        ticketOutcomeCount: metadata.ticketOutcomes?.length ?? null,
        ticketNumbers: ticketNumberLog.ticketNumbers,
        ticketNumbersTruncated: ticketNumberLog.ticketNumbersTruncated,
        superopsAttempts: metadata.superopsAttempts ?? null,
        superopsRetries: metadata.superopsRetries ?? null,
        runDurationMs: metadata.runDurationMs ?? null,
        failureDiagnosticCount: metadata.failureDiagnostics?.length ?? 0,
        mcpExecutionPresent: metadata.mcpExecution !== void 0,
        mcpRequestCount: metadata.mcpExecution?.requestTrace?.length ?? null,
        mcpRetryCount: metadata.mcpExecution?.retryTrace?.length ?? null,
        mcpRequestTraceTruncated: metadata.mcpExecution?.requestTraceTruncated ?? null
      });
      return json(result);
    }
    return json({ error: "not_found" }, 404);
  }
  async alarm() {
    try {
      await this.exclusive(() => this.handleAlarm());
    } catch (error) {
      const nextAt = await this.rearmAlarm(Date.now() + 6e4);
      const config = loadConfig(this.env);
      const store = new DurableObjectStore(this.state.storage);
      await tryRecordHistory(store, {
        event: "alarm_failed",
        batchSequence: null,
        scopeMode: config.scopeMode,
        source: "cloudflare_alarm",
        phaseStatus: "failed",
        failureKind: "transient",
        errorType: error instanceof Error ? error.name : "unknown",
        nextAt: new Date(nextAt).toISOString()
      });
      logger().warn("coordinator_alarm_failed_rearmed", {
        reason: error instanceof Error ? error.name : "unknown",
        nextAt: new Date(nextAt).toISOString()
      });
    }
  }
  async handleAlarm() {
    const config = loadConfig(this.env);
    const store = new DurableObjectStore(this.state.storage);
    const graph = new GraphSubscriptionManager(config, boundWorkerFetch, logger());
    const engine = new CoordinatorEngine({
      config,
      store,
      graph,
      agent: new WorkspaceAgentTriggerClient(config, boundWorkerFetch, logger()),
      logger: logger()
    });
    const startedAt = Date.now();
    const before = await store.load();
    await tryRecordHistory(store, {
      event: "alarm_started",
      batchSequence: null,
      scopeMode: config.scopeMode,
      source: "cloudflare_alarm",
      scheduledAt: safeCoordinatorNextAt(before) === null ? void 0 : new Date(safeCoordinatorNextAt(before)).toISOString(),
      alarmLatenessMs: safeCoordinatorNextAt(before) === null ? void 0 : Math.max(0, startedAt - safeCoordinatorNextAt(before))
    }, startedAt);
    await this.maybePruneDispatchHistory(config, store);
    const processed = await engine.processAlarm();
    await tryRecordHistory(store, {
      event: "alarm_completed",
      batchSequence: null,
      scopeMode: config.scopeMode,
      source: "cloudflare_alarm",
      phaseStatus: processed.status,
      nextAt: processed.nextAt === void 0 ? void 0 : new Date(processed.nextAt).toISOString(),
      durationMs: Math.max(0, Date.now() - startedAt)
    });
    logger().info("coordinator_alarm_state", safeCoordinatorStateFields(await store.load(), Date.now()));
    logger().info("coordinator_alarm_processed", {
      status: processed.status,
      triggerId: processed.triggerId ?? null,
      nextAt: processed.nextAt === void 0 ? null : new Date(processed.nextAt).toISOString()
    });
  }
};

// src/http.ts
function validationTokenResponse(token) {
  return new Response(token, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}
__name(validationTokenResponse, "validationTokenResponse");
async function handleGraphWebhook(request, sink) {
  const url = new URL(request.url);
  const validationToken = url.searchParams.get("validationToken");
  if (validationToken !== null) return validationTokenResponse(validationToken);
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid notification payload", { status: 400 });
  }
  const collection = selectNotificationCollection(body);
  if (!collection) return new Response("Invalid notification payload", { status: 400 });
  return sink.enqueue(collection);
}
__name(handleGraphWebhook, "handleGraphWebhook");

// src/index.ts
function json2(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
__name(json2, "json");
function coordinator(env) {
  const id = env.TRIAGE_COORDINATOR.idFromName("supportdesk-global");
  return env.TRIAGE_COORDINATOR.get(id);
}
__name(coordinator, "coordinator");
function constantTimeEqual(expected, actual) {
  if (actual === void 0 || expected.length !== actual.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  }
  return difference === 0;
}
__name(constantTimeEqual, "constantTimeEqual");
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const config = loadConfig(env);
    if (url.pathname === "/health" && request.method === "GET") {
      const coordinatorResponse = await coordinator(env).fetch(
        new Request("https://coordinator.internal/internal/status")
      );
      const coordinatorStatus = coordinatorResponse.ok ? await coordinatorResponse.json() : { statusAvailable: false };
      return json2({
        ok: true,
        automatedTriageTriggerEnabled: config.enabled,
        triageScopeMode: config.scopeMode,
        triageFastTargetedModeEnabled: config.fastTargetedModeEnabled,
        triageFastDebounceMs: config.debounceMs,
        triageFastIngestionGraceMs: config.fastIngestionGraceMs,
        triageNewEmailLookbackMs: config.newEmailLookbackMs,
        triageFastNewEmailLookbackMs: config.fastNewEmailLookbackMs,
        triageResultCallbackEnabled: config.resultCallbackEnabled,
        triageResultWatchdogMs: config.resultWatchdogMs,
        triageResultPollDueGatingEnabled: config.resultPollDueGatingEnabled,
        triageAgentTimingTelemetryEnabled: config.agentTimingTelemetryEnabled,
        triageStaleRunRecoveryEnabled: config.staleRunRecoveryEnabled,
        triageAcceptedRunMaxAgeMs: config.acceptedRunMaxAgeMs,
        triageConfigurationRetryExitEnabled: config.configurationRetryExitEnabled,
        triageGraphSweepEnabled: config.graphSweepEnabled,
        triageGraphSweepLookbackMs: config.graphSweepLookbackMs,
        triageGraphSweepMaxMessages: config.graphSweepMaxMessages,
        triageHistoryRetentionDays: config.historyRetentionDays,
        triageHistoryMaxRows: config.historyMaxRows,
        consumesEmailBodies: false,
        callsSuperOpsDirectly: false,
        coordinator: coordinatorStatus
      });
    }
    if (url.pathname === "/history" && request.method === "GET") {
      if (url.searchParams.has("filter")) {
        const relevantHistoryQuery = parseRelevantHistoryQuery(url.searchParams);
        if (!relevantHistoryQuery.ok) return json2(relevantHistoryQuery.error, 400);
      }
      const historyQuery = parseHistoryQuery(url.searchParams);
      if (!url.searchParams.has("filter") && !historyQuery.ok) {
        return json2(historyQuery.error, 400);
      }
      const coordinatorResponse = await coordinator(env).fetch(
        new Request(`https://coordinator.internal/internal/history${url.search}`)
      );
      if (!coordinatorResponse.ok) {
        return json2({ error: "history_unavailable" }, 503);
      }
      return coordinatorResponse;
    }
    if (url.pathname === "/admin/history/reset" && request.method === "POST") {
      const authorization = request.headers.get("Authorization");
      const actualToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
      if (!config.historyResetToken || !constantTimeEqual(config.historyResetToken, actualToken)) {
        return json2({ error: "unauthorized" }, 401);
      }
      return coordinator(env).fetch(
        new Request("https://coordinator.internal/internal/history/reset", { method: "POST" })
      );
    }
    if (url.pathname === "/mcp" && request.method === "POST") {
      return handleTriageResultMcp(request, {
        async report(report) {
          const response = await coordinator(env).fetch(
            new Request("https://coordinator.internal/internal/triage-result", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(report)
            })
          );
          if (!response.ok) return { status: "stale_or_unauthorized" };
          return response.json();
        }
      });
    }
    if ((url.pathname === "/graph/notifications" || url.pathname === "/graph/lifecycle") && request.method === "POST") {
      return handleGraphWebhook(request, {
        async enqueue(collection) {
          return coordinator(env).fetch(
            new Request("https://coordinator.internal/internal/notifications", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(collection)
            })
          );
        }
      });
    }
    return json2({ error: "not_found" }, 404);
  },
  async scheduled(_controller, env, ctx) {
    if (!loadConfig(env).enabled) return;
    ctx.waitUntil(
      coordinator(env).fetch(
        new Request("https://coordinator.internal/internal/maintenance", { method: "POST" })
      )
    );
  }
};
export {
  TriageCoordinator,
  index_default as default
};
//# sourceMappingURL=index.js.map
