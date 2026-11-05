import { z } from "zod";

/**
 * Single place where environment is read.
 *
 * SECURITY RULE: nothing in this module ever logs, returns or renders a secret
 * value. `envReport()` yields presence booleans and non-secret identifiers only,
 * and it is what the UI and /api/health are allowed to consume.
 */

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),

  // Control-plane crypto + session
  CONTROL_ENC_KEY: z.string().min(32).optional(),
  SESSION_COOKIE_NAME: z.string().min(1).default("rmctl_session"),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(8),

  // Bootstrap (used once by scripts/bootstrap.ts, never by request handlers)
  BOOTSTRAP_OWNER_EMAIL: z.string().email().optional(),
  BOOTSTRAP_OWNER_PASSWORD: z.string().min(12).optional(),

  // Auth mode. `local` = control-plane credentials in Postgres.
  // `supabase` = Supabase Auth is the identity provider for admins.
  AUTH_PROVIDER: z.enum(["local", "supabase"]).default("local"),

  // Supabase — app data plane bridge (optional, read-only, allow-listed)
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_DB_URL: z.string().min(1).optional(),

  // AI operations assistant — optional. Without it the assistant runs its
  // deterministic runbook engine (real tool execution, no LLM).
  AIOPS_PROVIDER: z.enum(["none", "gemini", "openai", "anthropic"]).default("none"),
  AIOPS_API_KEY: z.string().min(1).optional(),
  AIOPS_MODEL: z.string().min(1).optional(),
  AIOPS_BASE_URL: z.string().url().optional(),

  // ReplyMate source repository (read-only integration for the Releases page)
  REPLYMATE_REPO: z.string().min(1).default("spencerbby8-gif/ReplyMate"),
  GITHUB_READ_TOKEN: z.string().min(1).optional(),
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

/** True only when every credential needed for a live Supabase bridge is present. */
export const supabaseBridgeConfigured = Boolean(
  env.NEXT_PUBLIC_SUPABASE_URL &&
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    env.SUPABASE_SERVICE_ROLE_KEY,
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
      projectUrl: env.NEXT_PUBLIC_SUPABASE_URL ?? null,
      hasAnonKey: Boolean(env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      hasServiceRoleKey: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
      hasDbUrl: Boolean(env.SUPABASE_DB_URL),
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
