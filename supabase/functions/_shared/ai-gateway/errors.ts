/**
 * Error classification.
 *
 * Mirrors the taxonomy the Android app already uses (P-provider-audit, 0.7.0), so
 * a gateway error and an on-device error read the same way to a user and to a
 * support ticket. The rule from that phase is preserved: **never call a 429
 * "exhausted" when the provider said the model is unavailable, and never invent a
 * cause the provider did not state.**
 */

export type ErrorClass =
  | "auth"
  | "quota"
  | "rate_limit"
  | "model_unavailable"
  | "model_deprecated"
  | "bad_request"
  | "server_error"
  | "network"
  | "timeout"
  | "truncated_response"
  | "empty_response"
  | "not_configured"
  | "budget"
  | "unknown";

export type ClassifiedError = {
  class: ErrorClass;
  /** HTTP status the gateway should return to the client. */
  status: number;
  /** Whether the client should retry. */
  retryable: boolean;
  /** What the provider actually said — the class, never a raw body. */
  providerSaid: string;
  /** Actionable guidance, matching the app's Diagnostics block shape. */
  suggestedFix: string;
};

const MAX_PROVIDER_MESSAGE = 200;

/**
 * Classifies a provider failure.
 *
 * Only `status` and a short extracted message are used. The raw body is NOT
 * echoed: provider error bodies can reflect request material, which for this
 * product means fragments of a user's conversation.
 */
export function classifyError(input: {
  providerKey: string;
  status: number | null;
  body?: unknown;
  transportError?: string;
}): ClassifiedError {
  const { providerKey, status, body, transportError } = input;
  const said = extractMessage(body, transportError);

  if (transportError) {
    const timedOut = /timeout|aborted|AbortError/i.test(transportError);
    return {
      class: timedOut ? "timeout" : "network",
      status: timedOut ? 504 : 502,
      retryable: true,
      providerSaid: said,
      suggestedFix: timedOut ? "retry_later" : "check_network",
    };
  }

  if (status === null) {
    return { class: "unknown", status: 502, retryable: false, providerSaid: said, suggestedFix: "retry_later" };
  }

  if (status === 401 || status === 403) {
    return {
      class: "auth",
      status: 502,
      retryable: false,
      providerSaid: said,
      // The platform's own master key is at fault, never the user's.
      suggestedFix: "platform_key_invalid",
    };
  }

  if (status === 429) {
    // The 0.7.0 finding, preserved: Gemini returns 429 with limit:0 to mean
    // "model unavailable", which must never be retried and never be called
    // "quota exhausted".
    const modelUnavailable = /limit.*0|model.*not.*available|unsupported/i.test(said);
    if (providerKey === "gemini" && modelUnavailable) {
      return {
        class: "model_unavailable",
        status: 422,
        retryable: false,
        providerSaid: said,
        suggestedFix: "switch_model",
      };
    }
    const billing = /billing|payment|credit|invoice/i.test(said);
    return {
      class: billing ? "quota" : "rate_limit",
      status: 429,
      retryable: !billing,
      providerSaid: said,
      suggestedFix: billing ? "billing_required" : "retry_later",
    };
  }

  if (status === 404) {
    const deprecated = /deprecat|phasing|sunset|retired/i.test(said);
    return {
      class: deprecated ? "model_deprecated" : "model_unavailable",
      status: 422,
      retryable: false,
      providerSaid: said,
      suggestedFix: "switch_model",
    };
  }

  if (status === 400 || status === 422) {
    // xAI returns a string error, Mistral a `detail` envelope, OpenAI a numeric
    // code — all three shapes are handled by extractMessage.
    const unsupportedParam = /reasoning|thinking|search|parameter|unsupported field/i.test(said);
    return {
      class: "bad_request",
      status: 400,
      retryable: false,
      providerSaid: said,
      suggestedFix: unsupportedParam ? "strip_unsupported_param" : "check_request",
    };
  }

  if (status >= 500) {
    return { class: "server_error", status: 502, retryable: true, providerSaid: said, suggestedFix: "retry_later" };
  }

  return { class: "unknown", status: 502, retryable: false, providerSaid: said, suggestedFix: "check_request" };
}

/** Extracts a short provider message from every envelope shape the app speaks. */
export function extractMessage(body: unknown, transportError?: string): string {
  if (transportError) return truncate(transportError);
  if (typeof body === "string") return truncate(body);
  if (!body || typeof body !== "object") return "(no body)";
  const record = body as Record<string, unknown>;

  // xAI: { error: "string" }
  if (typeof record.error === "string") return truncate(record.error);
  // OpenAI / Gemini: { error: { message } }
  if (record.error && typeof record.error === "object") {
    const inner = record.error as Record<string, unknown>;
    if (typeof inner.message === "string") return truncate(inner.message);
  }
  // Mistral: { detail: "string" | [{ msg }] }
  if (typeof record.detail === "string") return truncate(record.detail);
  if (Array.isArray(record.detail)) {
    const first = record.detail[0] as Record<string, unknown> | undefined;
    if (first && typeof first.msg === "string") return truncate(first.msg);
  }
  // Anthropic: { message }
  if (typeof record.message === "string") return truncate(record.message);

  return "(unrecognised error shape)";
}

function truncate(value: string): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > MAX_PROVIDER_MESSAGE ? `${single.slice(0, MAX_PROVIDER_MESSAGE)}…` : single;
}

/** A reply that arrived but is unusable is an error, not a success. */
export function classifyReplyProblem(input: { text: string; truncated: boolean }): ClassifiedError | null {
  if (input.truncated) {
    return {
      class: "truncated_response",
      status: 502,
      retryable: false,
      providerSaid: "provider stopped at the output cap",
      // Saving half a draft is exactly what 0.9.0 made an explicit error.
      suggestedFix: "raise_output_cap",
    };
  }
  if (input.text.trim().length === 0) {
    return {
      class: "empty_response",
      status: 502,
      retryable: true,
      providerSaid: "provider returned no text",
      suggestedFix: "retry_later",
    };
  }
  return null;
}
