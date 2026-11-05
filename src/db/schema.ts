import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * ReplyMate Control — CONTROL PLANE schema.
 *
 * Hard rules (see docs/PRIVACY.md):
 *  1. This schema is the admin platform's own data. It never stores ReplyMate
 *     end-user message bodies, memory facts, contact names, drafts, summaries,
 *     style samples or provider API keys.
 *  2. No table here mirrors a ReplyMate cloud table. Cross-database reads go
 *     through `src/lib/privacy/guard.ts`, which is allow-list only.
 *  3. Secrets are stored as hashes (passwords, invite tokens, session tokens)
 *     or not at all (TOTP secret is encrypted with CONTROL_ENC_KEY).
 */

// ---------------------------------------------------------------------------
// Identity & access
// ---------------------------------------------------------------------------

export const adminRole = [
  "owner",
  "admin",
  "operator",
  "support",
  "viewer",
] as const;
export type AdminRole = (typeof adminRole)[number];

export const adminStatus = ["invited", "active", "suspended"] as const;
export type AdminStatus = (typeof adminStatus)[number];

export const ctlAdmin = pgTable(
  "ctl_admin",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    role: text("role", { enum: adminRole }).notNull().default("viewer"),
    status: text("status", { enum: adminStatus }).notNull().default("invited"),
    /** scrypt(password, salt, 64) hex; salt is prefixed. See lib/auth/password.ts */
    passwordHash: text("password_hash"),
    /** AES-256-GCM ciphertext of the TOTP shared secret. Null until enrolled. */
    mfaSecretEnc: text("mfa_secret_enc"),
    mfaEnrolledAt: timestamp("mfa_enrolled_at", { withTimezone: true }),
    mfaRequired: boolean("mfa_required").notNull().default(false),
    /** Last accepted TOTP step — makes codes single-use (replay protection). */
    mfaLastStep: bigint("mfa_last_step", { mode: "number" }),
    /** Links to Supabase Auth user when AUTH_PROVIDER=supabase. */
    supabaseUserId: uuid("supabase_user_id"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    lastLoginIp: text("last_login_ip"),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ctl_admin_email_uidx").on(t.email),
    uniqueIndex("ctl_admin_supabase_uidx").on(t.supabaseUserId),
  ],
);

export const ctlSession = pgTable(
  "ctl_session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adminId: uuid("admin_id")
      .notNull()
      .references(() => ctlAdmin.id, { onDelete: "cascade" }),
    /** SHA-256 of the opaque cookie value. The raw token is never stored. */
    tokenHash: text("token_hash").notNull(),
    mfaVerified: boolean("mfa_verified").notNull().default(false),
    ip: text("ip"),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ctl_session_token_uidx").on(t.tokenHash),
    index("ctl_session_admin_idx").on(t.adminId),
    index("ctl_session_expires_idx").on(t.expiresAt),
  ],
);

export const ctlInvite = pgTable(
  "ctl_invite",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    role: text("role", { enum: adminRole }).notNull().default("viewer"),
    /** SHA-256 of the single-use accept token. */
    tokenHash: text("token_hash").notNull(),
    invitedBy: uuid("invited_by").references(() => ctlAdmin.id, { onDelete: "set null" }),
    mfaRequired: boolean("mfa_required").notNull().default(true),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ctl_invite_token_uidx").on(t.tokenHash),
    index("ctl_invite_email_idx").on(t.email),
  ],
);

// ---------------------------------------------------------------------------
// Audit (append-only — there is deliberately no UPDATE/DELETE surface)
// ---------------------------------------------------------------------------

export const auditOutcome = ["success", "denied", "error"] as const;
export type AuditOutcome = (typeof auditOutcome)[number];

export const ctlAuditLog = pgTable(
  "ctl_audit_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    actorAdminId: uuid("actor_admin_id"),
    actorEmail: text("actor_email"),
    actorRole: text("actor_role"),
    action: text("action").notNull(),
    entity: text("entity"),
    entityId: text("entity_id"),
    outcome: text("outcome", { enum: auditOutcome }).notNull().default("success"),
    /** Redacted before write. See lib/audit/redact.ts */
    detail: jsonb("detail"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    requestId: text("request_id"),
  },
  (t) => [index("ctl_audit_ts_idx").on(t.ts), index("ctl_audit_actor_idx").on(t.actorAdminId)],
);

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

export const flagStatus = ["off", "shadow", "canary", "on"] as const;
export type FlagStatus = (typeof flagStatus)[number];

export const ctlFeatureFlag = pgTable(
  "ctl_feature_flag",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status", { enum: flagStatus }).notNull().default("off"),
    rolloutPercent: integer("rollout_percent").notNull().default(0),
    /** Extra targeting rules evaluated by lib/flags/evaluate.ts */
    rules: jsonb("rules").notNull().default([]),
    /** Whether the Android client is known to read this flag yet. */
    clientWired: boolean("client_wired").notNull().default(false),
    minAppVersion: text("min_app_version"),
    updatedBy: uuid("updated_by").references(() => ctlAdmin.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ctl_flag_key_uidx").on(t.key)],
);

// ---------------------------------------------------------------------------
// AI providers & model routing (metadata only — never credentials)
// ---------------------------------------------------------------------------

export const providerStatus = [
  "available",
  "degraded",
  "disabled",
  "unconfigured",
] as const;
export type ProviderStatus = (typeof providerStatus)[number];

export const supportLevel = ["native", "family_split", "fallback", "none"] as const;
export type SupportLevel = (typeof supportLevel)[number];

export const ctlAiProvider = pgTable(
  "ctl_ai_provider",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Matches the Android ProviderType enum, e.g. `gemini`, `openai_compat`. */
    key: text("key").notNull(),
    displayName: text("display_name").notNull(),
    /** Wire dialect the app speaks for this provider. */
    dialect: text("dialect").notNull(),
    defaultBaseUrl: text("default_base_url"),
    status: text("status", { enum: providerStatus }).notNull().default("unconfigured"),
    searchSupport: text("search_support", { enum: supportLevel }).notNull().default("none"),
    reasoningSupport: text("reasoning_support", { enum: supportLevel }).notNull().default("none"),
    /** Keys stay on-device (BYOK). This records whether the app supports it. */
    byokOnly: boolean("byok_only").notNull().default(true),
    minAppVersion: text("min_app_version"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ctl_provider_key_uidx").on(t.key)],
);

export const routeTask = [
  "reply",
  "summary",
  "extract",
  "style",
  "background",
  "assistant",
] as const;
export type RouteTask = (typeof routeTask)[number];

export const thinkingLevel = ["none", "low", "high"] as const;
export type ThinkingLevel = (typeof thinkingLevel)[number];

export const ctlModelRoute = pgTable(
  "ctl_model_route",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    task: text("task", { enum: routeTask }).notNull(),
    providerKey: text("provider_key").notNull(),
    modelId: text("model_id").notNull(),
    priority: integer("priority").notNull().default(100),
    thinking: text("thinking", { enum: thinkingLevel }).notNull().default("none"),
    maxOutputTokens: integer("max_output_tokens").notNull().default(220),
    enabled: boolean("enabled").notNull().default(false),
    minAppVersion: text("min_app_version"),
    notes: text("notes"),
    updatedBy: uuid("updated_by").references(() => ctlAdmin.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ctl_route_task_idx").on(t.task),
    uniqueIndex("ctl_route_task_provider_model_uidx").on(t.task, t.providerKey, t.modelId),
  ],
);

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

export const releaseStatus = [
  "draft",
  "building",
  "published",
  "paused",
  "broken",
] as const;
export type ReleaseStatus = (typeof releaseStatus)[number];

export const releaseChannel = ["internal", "beta", "production"] as const;
export type ReleaseChannel = (typeof releaseChannel)[number];

export const ctlRelease = pgTable(
  "ctl_release",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionName: text("version_name").notNull(),
    versionCode: integer("version_code").notNull(),
    channel: text("channel", { enum: releaseChannel }).notNull().default("internal"),
    status: text("status", { enum: releaseStatus }).notNull().default("draft"),
    apkSha256: text("apk_sha256"),
    apkSizeBytes: bigint("apk_size_bytes", { mode: "number" }),
    gitSha: text("git_sha"),
    notes: text("notes"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ctl_release_version_uidx").on(t.versionName),
    index("ctl_release_status_idx").on(t.status),
  ],
);

// ---------------------------------------------------------------------------
// Devices — opt-in diagnostics only. No channel reports here yet, so this stays
// empty by design (see the Devices page contract).
// ---------------------------------------------------------------------------

export const ctlDevice = pgTable(
  "ctl_device",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    label: text("label"),
    appVersion: text("app_version"),
    androidApiLevel: integer("android_api_level"),
    deviceModel: text("device_model"),
    listenerGranted: text("listener_granted", {
      enum: ["granted", "denied", "unknown"],
    })
      .notNull()
      .default("unknown"),
    /** Explicit user consent is a precondition for any row existing here. */
    consentRecordedAt: timestamp("consent_recorded_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ctl_device_seen_idx").on(t.lastSeenAt)],
);

// ---------------------------------------------------------------------------
// Subscriptions — plan catalogue is configuration; billing is not wired.
// ---------------------------------------------------------------------------

export const ctlPlan = pgTable(
  "ctl_plan",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    priceMinor: integer("price_minor").notNull().default(0),
    currency: text("currency").notNull().default("NGN"),
    interval: text("interval", { enum: ["month", "year", "once"] })
      .notNull()
      .default("month"),
    features: jsonb("features").notNull().default([]),
    active: boolean("active").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ctl_plan_key_uidx").on(t.key)],
);

export const subscriptionStatus = [
  "trialing",
  "active",
  "past_due",
  "cancelled",
  "expired",
] as const;

export const ctlSubscription = pgTable(
  "ctl_subscription",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Opaque ReplyMate end-user id (Supabase auth uuid). Never an email. */
    endUserId: uuid("end_user_id").notNull(),
    planKey: text("plan_key").notNull(),
    status: text("status", { enum: subscriptionStatus }).notNull().default("trialing"),
    billingProvider: text("billing_provider"),
    providerReference: text("provider_reference"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ctl_subscription_user_idx").on(t.endUserId)],
);

// ---------------------------------------------------------------------------
// Remote configuration
// ---------------------------------------------------------------------------

export const ctlConfigItem = pgTable(
  "ctl_config_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    category: text("category").notNull().default("general"),
    valueType: text("value_type", { enum: ["string", "number", "boolean", "json"] })
      .notNull()
      .default("string"),
    value: jsonb("value"),
    description: text("description"),
    /** Locked items are pinned by the Android app contract and read-only here. */
    locked: boolean("locked").notNull().default(false),
    /** Guards against ever storing a secret through this table. */
    sensitive: boolean("sensitive").notNull().default(false),
    updatedBy: uuid("updated_by").references(() => ctlAdmin.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ctl_config_key_uidx").on(t.key)],
);

// ---------------------------------------------------------------------------
// Monitoring probes
// ---------------------------------------------------------------------------

export const ctlMonitorProbe = pgTable(
  "ctl_monitor_probe",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    target: text("target").notNull(),
    kind: text("kind", { enum: ["http", "database", "supabase", "queue"] })
      .notNull()
      .default("http"),
    status: text("status", { enum: ["ok", "degraded", "down", "unknown"] })
      .notNull()
      .default("unknown"),
    latencyMs: integer("latency_ms"),
    httpStatus: integer("http_status"),
    /** Provider messages are redacted before they reach this column. */
    message: text("message"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ctl_probe_target_idx").on(t.target, t.checkedAt)],
);

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

export const ticketStatus = [
  "open",
  "triaged",
  "waiting",
  "resolved",
  "closed",
] as const;
export type TicketStatus = (typeof ticketStatus)[number];

export const ctlSupportTicket = pgTable(
  "ctl_support_ticket",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reference: text("reference").notNull(),
    subject: text("subject").notNull(),
    /** Free-text from a user. Redaction runs before render; never indexed for search. */
    body: text("body"),
    requesterEmail: text("requester_email"),
    appVersion: text("app_version"),
    status: text("status", { enum: ticketStatus }).notNull().default("open"),
    priority: text("priority", { enum: ["low", "normal", "high", "urgent"] })
      .notNull()
      .default("normal"),
    assigneeAdminId: uuid("assignee_admin_id").references(() => ctlAdmin.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ctl_ticket_ref_uidx").on(t.reference),
    index("ctl_ticket_status_idx").on(t.status),
  ],
);

// ---------------------------------------------------------------------------
// AI operations assistant — real tool execution over the control plane.
// ---------------------------------------------------------------------------

export const ctlAiopsSession = pgTable(
  "ctl_aiops_session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adminId: uuid("admin_id")
      .notNull()
      .references(() => ctlAdmin.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New session"),
    mode: text("mode", { enum: ["deterministic", "llm"] }).notNull().default("deterministic"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ctl_aiops_session_admin_idx").on(t.adminId)],
);

export const ctlAiopsMessage = pgTable(
  "ctl_aiops_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => ctlAiopsSession.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant", "tool"] }).notNull(),
    content: text("content").notNull(),
    toolName: text("tool_name"),
    toolResult: jsonb("tool_result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ctl_aiops_msg_session_idx").on(t.sessionId, t.createdAt)],
);

export type CtlAdmin = typeof ctlAdmin.$inferSelect;
export type CtlSession = typeof ctlSession.$inferSelect;
export type CtlInvite = typeof ctlInvite.$inferSelect;
export type CtlAuditLog = typeof ctlAuditLog.$inferSelect;
export type CtlFeatureFlag = typeof ctlFeatureFlag.$inferSelect;
export type CtlAiProvider = typeof ctlAiProvider.$inferSelect;
export type CtlModelRoute = typeof ctlModelRoute.$inferSelect;
export type CtlRelease = typeof ctlRelease.$inferSelect;
export type CtlDevice = typeof ctlDevice.$inferSelect;
export type CtlPlan = typeof ctlPlan.$inferSelect;
export type CtlSubscription = typeof ctlSubscription.$inferSelect;
export type CtlConfigItem = typeof ctlConfigItem.$inferSelect;
export type CtlMonitorProbe = typeof ctlMonitorProbe.$inferSelect;
export type CtlSupportTicket = typeof ctlSupportTicket.$inferSelect;
export type CtlAiopsSession = typeof ctlAiopsSession.$inferSelect;
export type CtlAiopsMessage = typeof ctlAiopsMessage.$inferSelect;
