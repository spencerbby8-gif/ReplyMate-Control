/**
 * Audit payload redaction.
 *
 * Every value that reaches `ctl_audit_log.detail` passes through this module.
 * The rule is deny-by-default for anything that could be a credential, and
 * content-shaped fields are dropped because the control plane has no business
 * recording ReplyMate end-user content in the first place.
 */

const SECRET_KEY =
  /(password|passwd|pwd|secret|token|apikey|api_key|key|credential|otp|mfa|totp|pin|session|cookie|authorization|bearer|private|signature|salt|hash|enc)/i;

const CONTENT_KEY = /(body|message|reply|draft|summary|fact|sample|notes_free_text|prompt)/i;

const ALLOWED_KEY_OVERRIDE = new Set([
  "key", // feature-flag key / config key — an identifier, not a credential
  "providerKey",
  "planKey",
  "taskKey",
  "routeKey",
  "flagKey",
  "configKey",
  "entityId",
]);

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^sk-[A-Za-z0-9_-]{8,}$/, // openai / anthropic style
  /^AIza[0-9A-Za-z_-]{20,}$/, // google api key
  /^gh[pousr]_[A-Za-z0-9]{20,}$/, // github tokens
  /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // jwt
  /^xox[baprs]-/, // slack
  /^[A-Z2-7]{16,}={0,6}$/, // base32 (totp secret)
  /^postgres(ql)?:\/\//i, // connection string
];

const MAX_DEPTH = 6;
const MAX_STRING = 240;

export const REDACTED = "[redacted]";
export const CONTENT_REMOVED = "[content-omitted]";

export function isSecretLikeKey(key: string): boolean {
  if (ALLOWED_KEY_OVERRIDE.has(key)) return false;
  return SECRET_KEY.test(key);
}

export function isSecretLikeValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((re) => re.test(value.trim()));
}

export function redactValue<T>(input: T, depth = 0): T | string | null {
  if (depth > MAX_DEPTH) return "[truncated-depth]";
  if (input === null || input === undefined) return input as null;

  if (typeof input === "string") {
    if (isSecretLikeValue(input)) return REDACTED;
    return input.length > MAX_STRING ? `${input.slice(0, MAX_STRING)}…` : input;
  }

  if (typeof input === "number" || typeof input === "boolean") return input;

  if (input instanceof Date) return input.toISOString() as unknown as T;

  if (Array.isArray(input)) {
    return input.slice(0, 50).map((item) => redactValue(item, depth + 1)) as unknown as T;
  }

  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (isSecretLikeKey(key)) {
        out[key] = REDACTED;
        continue;
      }
      if (CONTENT_KEY.test(key) && typeof value === "string") {
        out[key] = CONTENT_REMOVED;
        continue;
      }
      out[key] = redactValue(value, depth + 1);
    }
    return out as unknown as T;
  }

  return null;
}

/**
 * Builds a diff for audit entries. Only the CHANGED keys are recorded and both
 * sides are redacted, so an update to a provider row cannot smuggle a secret or
 * content field into the log.
 */
export function diffForAudit(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): Record<string, { from: unknown; to: unknown }> {
  if (!before || !after) return {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    if (["createdAt", "updatedAt", "created_at", "updated_at"].includes(key)) continue;
    const a = before[key];
    const b = after[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      const secret = isSecretLikeKey(key);
      const content = CONTENT_KEY.test(key);
      changes[key] = {
        from: secret ? REDACTED : content && typeof a === "string" ? CONTENT_REMOVED : redactValue(a),
        to: secret ? REDACTED : content && typeof b === "string" ? CONTENT_REMOVED : redactValue(b),
      };
    }
  }
  return changes;
}
