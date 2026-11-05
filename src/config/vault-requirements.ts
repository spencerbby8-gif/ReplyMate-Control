/**
 * What the owner must provision before ReplyMate Control can manage Supabase
 * Edge Function secrets directly.
 *
 * This file is the single source of truth rendered on the AI key vault page and
 * documented in docs/task-summaries/TASK-012.md. It exists as code rather than
 * prose so the UI cannot drift from the actual requirement.
 *
 * Sources: the Supabase Management API reference (per-endpoint OAuth scopes and
 * fine-grained permissions) and the live verification in TASK-002, which proved
 * that a project secret key is rejected by `api.supabase.com` with
 * `401 {"message":"JWT could not be decoded"}`.
 */

export type RequiredPermission = {
  /** Fine-grained token permission name. */
  name: string;
  /** The endpoint it unlocks. */
  endpoint: string;
  /** What Control uses it for. */
  usedFor: string;
  /** True when a read-only status view is impossible without it. */
  required: boolean;
};

export const MANAGEMENT_PERMISSIONS: RequiredPermission[] = [
  {
    name: "edge_functions_secrets_read",
    endpoint: "GET /v1/projects/{ref}/secrets",
    usedFor: "Listing which master-key secrets exist, so the vault can show presence, drift and rotation state. Returns names and digests only — Supabase does not return values.",
    required: true,
  },
  {
    name: "edge_functions_secrets_write",
    endpoint: "POST /v1/projects/{ref}/secrets",
    usedFor: "Adding and replacing a provider master key, and maintaining GATEWAY_ROTATING_PROVIDERS.",
    required: true,
  },
  {
    name: "edge_functions_secrets_write",
    endpoint: "DELETE /v1/projects/{ref}/secrets",
    usedFor: "Deleting a key slot, and removing the _NEXT slot after a rotation is promoted.",
    required: true,
  },
  {
    name: "edge_functions_read",
    endpoint: "GET /v1/projects/{ref}/functions",
    usedFor: "Reporting whether replymate-ai is deployed, and its status and version. Without it the vault cannot say whether a written key is live or inert.",
    required: true,
  },
  {
    name: "edge_functions_write",
    endpoint: "POST /v1/projects/{ref}/functions",
    usedFor: "Deploying replymate-ai through scripts/deploy-edge-function.ts. Only needed for the deployment step, not for routine key rotation — it can be granted on a separate token if you prefer to keep deploy rights apart from key rights.",
    required: false,
  },
];

/** Legacy OAuth scopes, for a token that is not fine-grained. */
export const MANAGEMENT_SCOPES = [
  "secrets:read",
  "secrets:write",
  "edge_functions:read",
  "edge_functions:write (deployment only)",
] as const;

/** Permissions deliberately NOT requested. */
export const PERMISSIONS_NOT_REQUESTED = [
  { name: "projects:write", reason: "Can pause, restart or recreate the project. Not needed to rotate a key." },
  { name: "database:write", reason: "Can run arbitrary SQL against production. Control's database access is already read-only by construction." },
  { name: "storage:read / storage:write", reason: "The vault does not touch object storage." },
  { name: "api_gateway_keys_read / _write / _secret_read", reason: "Would expose or rotate the project's own API keys. Control never needs them." },
  { name: "auth_signing_keys_read / _write", reason: "Could rotate the JWT signing key and invalidate every user session." },
  { name: "organization_*", reason: "Account-level access beyond this project." },
  { name: "project_admin_write", reason: "Broad admin; the four permissions above are sufficient and narrower." },
] as const;

export type BootstrapVariable = {
  name: string;
  required: boolean;
  /** Set once at bootstrap; never changes during routine operation. */
  oneTime: boolean;
  purpose: string;
  /** Where the value comes from. */
  source: string;
};

/**
 * Every one-time variable the hosting environment needs.
 *
 * After these are set, routine provider-key management happens entirely through
 * ReplyMate Control: adding, replacing, rotating, disabling and probing a key
 * never requires opening the Supabase dashboard.
 */
export const BOOTSTRAP_VARIABLES: BootstrapVariable[] = [
  {
    name: "SUPABASE_ACCESS_TOKEN",
    required: true,
    oneTime: true,
    purpose:
      "Management API access token. The only new credential TASK-012 needs. Must carry the four required permissions above. Project-scoped to xdcsxxwhvpiissetbrdr if your account supports scoping a token to one project.",
    source: "Supabase dashboard → Account → Access tokens → Generate new token.",
  },
  {
    name: "SUPABASE_PROJECT_URL",
    required: true,
    oneTime: true,
    purpose: "Project API base. Already present. Used to derive the project ref for Management API paths.",
    source: "Already configured.",
  },
  {
    name: "SUPABASE_PUBLISHABLE_KEY",
    required: true,
    oneTime: true,
    purpose:
      "Data-plane publishable key. Already present. Used for Supabase Auth password verification and public reads. Cannot manage secrets.",
    source: "Already configured.",
  },
  {
    name: "SUPABASE_SECRET_KEY",
    required: true,
    oneTime: true,
    purpose:
      "Data-plane secret key. Already present. Used for admin reads and the allow-listed bridge. Cannot manage secrets — verified live with a 401.",
    source: "Already configured.",
  },
  {
    name: "SUPABASE_TRANSACTION_POOLER",
    required: true,
    oneTime: true,
    purpose: "Read-only SQL audit of the app data plane. Already present.",
    source: "Already configured.",
  },
  {
    name: "CONTROL_ENC_KEY",
    required: true,
    oneTime: true,
    purpose:
      "Derives the AES-256-GCM key for TOTP secrets and the HMAC key for session, invitation, device-token and vault-fingerprint digests. Minimum 32 characters. Falls back to a durable 0600 keyfile at .keys/control-enc.key when absent — but set it explicitly in production so a redeploy cannot rotate it.",
    source: "Generate: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"",
  },
  {
    name: "AUTH_PROVIDER",
    required: false,
    oneTime: true,
    purpose:
      "'local' (default, fully functional) or 'supabase'. Leave as local until the cutover preflight passes: the project currently has self-service sign-up enabled, MFA disabled, and no email-confirmed identity to map to an admin.",
    source: "Your choice. See /security for the live preflight.",
  },
  {
    name: "SUPABASE_ALLOW_ADMIN_INVITE",
    required: false,
    oneTime: true,
    purpose:
      "Set to 'true' to let Control send admin invitations through Supabase Auth. Fails closed when unset, so no email is ever sent accidentally. Enable only after self-service sign-up is disabled on the project.",
    source: "Your choice.",
  },
  {
    name: "CONTROL_PUBLIC_URL",
    required: false,
    oneTime: true,
    purpose:
      "Public base URL of this deployment. Used to validate the Origin header for CSRF defence and to build invitation redirect URLs.",
    source: "The preview or production hostname.",
  },
  {
    name: "TRUST_PROXY",
    required: false,
    oneTime: true,
    purpose:
      "'overwrite' (default, matches this platform: the proxy replaces X-Forwarded-For), 'append' (take the entry our proxy wrote) or 'none' (ignore the header). Determines how the login throttle identifies a source.",
    source: "Depends on what sits in front of the app.",
  },
  {
    name: "MAINTENANCE_INTERVAL_MINUTES",
    required: false,
    oneTime: true,
    purpose:
      "Opt-in in-process maintenance interval. Does not survive a restart and does not coordinate across instances. Prefer an external cron calling scripts/run-maintenance.ts.",
    source: "Your choice. 0 = off.",
  },
  {
    name: "AIOPS_PROVIDER / AIOPS_API_KEY / AIOPS_MODEL",
    required: false,
    oneTime: true,
    purpose:
      "Optional. Without them the AI operations assistant runs its deterministic tool engine, which is real and complete. With them it also drives a model over its native dialect.",
    source: "Your provider.",
  },
  {
    name: "GATEWAY_PUBLIC_URL",
    required: false,
    oneTime: true,
    purpose:
      "Deployed URL of the replymate-ai Edge Function, e.g. https://<ref>.supabase.co/functions/v1/replymate-ai. Needed only for key probes, which must be performed by the gateway because Control never holds a key value.",
    source: "Known once the function is deployed.",
  },
];

/** Convenience: what is missing right now, for the vault page and the docs. */
export function missingBootstrapVariables(present: Record<string, boolean>): BootstrapVariable[] {
  return BOOTSTRAP_VARIABLES.filter((variable) => variable.required && !present[variable.name]);
}
