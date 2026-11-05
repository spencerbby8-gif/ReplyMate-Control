import { z } from "zod";

/**
 * Single place where environment is read.
 *
 * SECURITY RULE: nothing in this module ever logs, returns or renders a secret
 * value. `envReport()` yields presence booleans and non-secret identifiers only,
 * and it is what the UI and /api/health are allowed to consume.
 */

/**
 * Treats an empty or whitespace-only environment variable as ABSENT.
 *
 * Two reasons this matters. (1) A deployment that sets `SUPABASE_SECRET_KEY=""`
 * means "not configured", not "configured with an empty credential" — and the
 * difference decides whether the bridge fails closed or open. (2) Test runners
 * and container orchestrators routinely inject empty placeholders, which must
 * not fail `z.string().url()` and take the whole process down at import time.
 */
const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);
const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().url().optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),

  // Control-plane crypto + session
  CONTROL_ENC_KEY: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().min(32).optional(),
  ),
  SESSION_COOKIE_NAME: z.string().min(1).default("rmctl_session"),
  /** Idle expiry. Extended by activity, but never past the absolute ceiling. */
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(8),
  /** Absolute ceiling on a session's life regardless of activity. */
  SESSION_ABSOLUTE_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(72),
  /**
   * Public base URL of this deployment, used to validate the Origin header for
   * CSRF defence. Optional: when absent, the request's own Host is the only
   * accepted origin.
   */
  CONTROL_PUBLIC_URL: optionalUrl,

  // Bootstrap (used once by scripts/bootstrap.ts, never by request handlers)
  BOOTSTRAP_OWNER_EMAIL: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().email().optional(),
  ),
  BOOTSTRAP_OWNER_PASSWORD: optionalString.pipe(z.string().min(12)).optional(),

  // Auth mode. `local` = control-plane credentials in Postgres.
  // `supabase` = Supabase Auth is the identity provider for admins.
  AUTH_PROVIDER: z.enum(["local", "supabase"]).default("local"),

  // ---------------------------------------------------------------------
  // Supabase — the ReplyMate app data plane. READ ONLY, allow-listed.
  //
  // The names actually provisioned in this environment are the new-format ones
  // (SUPABASE_PROJECT_URL / PUBLISHABLE_KEY / SECRET_KEY / TRANSACTION_POOLER).
  // The legacy NEXT_PUBLIC_* and SERVICE_ROLE names are still accepted so an
  // existing deployment does not break, but they are NOT what this project uses.
  //
  // SECURITY: the publishable key is client-safe by design, yet it is
  // deliberately NOT declared with a NEXT_PUBLIC_ prefix here, so it never enters
  // a browser bundle. The control plane is a server-rendered admin console: it
  // has no need to talk to Supabase from the browser, and giving it one would
  // only widen the surface. The secret key and the pooler URL are server-only.
  // ---------------------------------------------------------------------
  SUPABASE_PROJECT_URL: optionalUrl,
  SUPABASE_PUBLISHABLE_KEY: optionalString,
  SUPABASE_SECRET_KEY: optionalString,
  SUPABASE_TRANSACTION_POOLER: optionalString,
  /** Minutes between in-process maintenance passes. 0 (default) disables it.
   *  An in-process interval is NOT a durable scheduler; see src/instrumentation.ts. */
  MAINTENANCE_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(1440).default(0),

  /** Optional session-mode pooler, for operations the transaction pooler rejects. */
  SUPABASE_SESSION_POOLER: optionalString,

  // Legacy names, accepted for compatibility only.
  NEXT_PUBLIC_SUPABASE_URL: optionalUrl,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: optionalString,
  SUPABASE_SERVICE_ROLE_KEY: optionalString,
  SUPABASE_DB_URL: optionalString,

  // AI operations assistant — optional. Without it the assistant runs its
  // deterministic runbook engine (real tool execution, no LLM).
  AIOPS_PROVIDER: z.enum(["none", "gemini", "openai", "anthropic"]).default("none"),
  AIOPS_API_KEY: optionalString,
  AIOPS_MODEL: optionalString,
  AIOPS_BASE_URL: optionalUrl,

  // ReplyMate source repository (read-only integration for the Releases page)
  REPLYMATE_REPO: z.string().min(1).default("spencerbby8-gif/ReplyMate"),
  GITHUB_READ_TOKEN: optionalString,
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Deliberately does not echo submitted values.
  const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  throw new Error(`Invalid environment configuration:\n- ${issues.join("\n- ")}`);
}

export const env: Env = parsed.data;

export const isProduction = env.NODE_ENV === "production";

/**
 * Resolved Supabase coordinates.
 *
 * New-format names win; legacy names are the fallback. Both are normalised into
 * one shape so the rest of the codebase never has to know which generation of
 * key a deployment is using.
 */
export const supabase = {
  /** Public by design — ReplyMate's own docs publish it; RLS guards the data. */
  url: env.SUPABASE_PROJECT_URL ?? env.NEXT_PUBLIC_SUPABASE_URL ?? null,
  /** anon-equivalent. Client-safe, but still never sent to a browser here. */
  publishableKey: env.SUPABASE_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? null,
  /** service_role-equivalent. SERVER ONLY. Never rendered, logged or returned. */
  secretKey: env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? null,
  transactionPooler: env.SUPABASE_TRANSACTION_POOLER ?? env.SUPABASE_DB_URL ?? null,
  sessionPooler: env.SUPABASE_SESSION_POOLER ?? null,
  /** Which key generation was detected, for honest reporting in the UI. */
  keyFormat: env.SUPABASE_PUBLISHABLE_KEY
    ? ("new-publishable" as const)
    : env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      ? ("legacy-jwt" as const)
      : ("none" as const),
} as const;

/** Project ref extracted from the URL. Public information, safe to display. */
export function supabaseProjectRef(): string | null {
  if (!supabase.url) return null;
  try {
    return new URL(supabase.url).host.split(".")[0] ?? null;
  } catch {
    return null;
  }
}

/** True only when every credential needed for a live Supabase bridge is present. */
export const supabaseBridgeConfigured = Boolean(
  supabase.url && supabase.publishableKey && supabase.secretKey,
);

export const aiOpsLlmConfigured =
  env.AIOPS_PROVIDER !== "none" && Boolean(env.AIOPS_API_KEY);

/**
 * Presence-only report. Safe to send to the browser and to logs.
 * Never contains a secret value — only booleans and non-secret identifiers.
 */
export function envReport() {
  return {
    nodeEnv: env.NODE_ENV,
    authProvider: env.AUTH_PROVIDER,
    supabase: {
      configured: supabaseBridgeConfigured,
      projectUrl: supabase.url,
      projectRef: supabaseProjectRef(),
      keyFormat: supabase.keyFormat,
      hasPublishableKey: Boolean(supabase.publishableKey),
      hasSecretKey: Boolean(supabase.secretKey),
      hasTransactionPooler: Boolean(supabase.transactionPooler),
      hasSessionPooler: Boolean(supabase.sessionPooler),
      /**
       * Present so a misconfiguration is visible: a secret key declared with a
       * NEXT_PUBLIC_ prefix would be shipped to browsers.
       */
      secretExposedViaNextPublic: Boolean(
        process.env.NEXT_PUBLIC_SUPABASE_SECRET_KEY ?? process.env.NEXT_PUBLIC_SERVICE_ROLE_KEY,
      ),
    },
    controlPlane: {
      hasEncryptionKey: Boolean(env.CONTROL_ENC_KEY),
      sessionTtlHours: env.SESSION_TTL_HOURS,
      cookieName: env.SESSION_COOKIE_NAME,
    },
    aiOps: {
      provider: env.AIOPS_PROVIDER,
      hasApiKey: Boolean(env.AIOPS_API_KEY),
      model: env.AIOPS_MODEL ?? null,
      llmActive: aiOpsLlmConfigured,
    },
    replymate: {
      repo: env.REPLYMATE_REPO,
      hasReadToken: Boolean(env.GITHUB_READ_TOKEN),
    },
  } as const;
}

export type EnvReport = ReturnType<typeof envReport>;
