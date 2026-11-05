/**
 * Per-user limits, timeouts and spend control.
 *
 * Free-tier design constraint (TASK-002): the production Supabase project is
 * treated as Free, so the gateway must be cheap by construction — bounded
 * timeouts, hard daily caps, and no retries that multiply provider spend.
 */

export type LimitPolicy = {
  /** Requests per user per rolling minute. */
  requestsPerMinute: number;
  /** Output tokens per user per UTC day. */
  dailyOutputTokens: number;
  /** Total tokens per single request, input + output. */
  maxTokensPerRequest: number;
  /** Hard ceiling on a provider call. */
  timeoutMs: number;
  /** Retries allowed on a 429/5xx. Zero by default: see the note below. */
  maxRetries: number;
};

export const DEFAULT_LIMITS: LimitPolicy = {
  requestsPerMinute: 10,
  dailyOutputTokens: 20_000,
  maxTokensPerRequest: 10_000,
  timeoutMs: 20_000,
  // Deliberately 0. The ANDROID APP already implements exponential backoff with
  // jitter (SPEC §6) and treats 429 as normal backpressure. A gateway that also
  // retried would multiply provider spend and hide the backoff signal from the
  // client. Retrying here would be worse than not retrying.
  maxRetries: 0,
};

export type LimitDecision =
  | { allowed: true; remaining: { requestsThisMinute: number; outputTokensToday: number } }
  | { allowed: false; code: "rate_limited" | "daily_budget" | "request_too_large"; reason: string; retryAfterSeconds?: number };

/** Pure evaluation, so the arithmetic is testable without a database. */
export function evaluateLimits(input: {
  policy?: Partial<LimitPolicy>;
  requestsThisMinute: number;
  outputTokensToday: number;
  estimatedTokensThisRequest: number;
}): LimitDecision {
  const policy = { ...DEFAULT_LIMITS, ...(input.policy ?? {}) };

  if (input.estimatedTokensThisRequest > policy.maxTokensPerRequest) {
    return {
      allowed: false,
      code: "request_too_large",
      reason: `Request estimates ${input.estimatedTokensThisRequest} tokens; the per-request ceiling is ${policy.maxTokensPerRequest}.`,
    };
  }

  if (input.requestsThisMinute >= policy.requestsPerMinute) {
    return {
      allowed: false,
      code: "rate_limited",
      reason: `${input.requestsThisMinute} requests in the last minute; the limit is ${policy.requestsPerMinute}.`,
      retryAfterSeconds: 60,
    };
  }

  const projected = input.outputTokensToday + input.estimatedTokensThisRequest;
  if (projected > policy.dailyOutputTokens) {
    return {
      allowed: false,
      code: "daily_budget",
      reason: `Today's output-token budget is exhausted (${input.outputTokensToday} of ${policy.dailyOutputTokens} used; this request would need ${input.estimatedTokensThisRequest}).`,
      // Resets at UTC midnight, matching how the app's own free-tier guard works.
      retryAfterSeconds: secondsUntilUtcMidnight(),
    };
  }

  return {
    allowed: true,
    remaining: {
      requestsThisMinute: policy.requestsPerMinute - input.requestsThisMinute - 1,
      outputTokensToday: policy.dailyOutputTokens - projected,
    },
  };
}

export function secondsUntilUtcMidnight(now = new Date()): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.round((midnight - now.getTime()) / 1000));
}

/**
 * Character-based token estimate: chars / 4.
 *
 * The same estimator the Android app uses (SPEC §6), so the gateway's budget
 * accounting and the client's own budget guard agree rather than fighting.
 */
export function estimateTokens(text: string): number {
  return Math.ceil((text ?? "").length / 4);
}

/** Spend control: an approximate cost in micro-USD for attribution reporting. */
export function estimateMicroUsd(input: {
  providerKey: string;
  tokensIn: number;
  tokensOut: number;
  rates?: Record<string, { inPerMillion: number; outPerMillion: number }>;
}): number | null {
  const rates = input.rates ?? {};
  const rate = rates[input.providerKey];
  // No rate configured means "unknown", not "free". Returning null keeps an
  // unpriced provider from being reported as costing nothing.
  if (!rate) return null;
  return Math.round(
    (input.tokensIn / 1_000_000) * rate.inPerMillion + (input.tokensOut / 1_000_000) * rate.outPerMillion,
  );
}
