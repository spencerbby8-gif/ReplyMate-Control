import type { AdminRole } from "@/db/schema";

/**
 * Supabase identity → control-plane role mapping.
 *
 * THE RULE: **a role is never derived from anything Supabase returns.**
 *
 * The live project audit (TASK-002) established two facts that make this
 * non-negotiable:
 *
 *   1. `disable_signup` is **false**, so anyone can create an auth user.
 *   2. `anonymous_users` is **enabled**, and 3 of the 4 existing users are
 *      anonymous with no email at all.
 *
 * A Supabase user is therefore evidence that *somebody authenticated*, and
 * nothing more. It carries no authorization. Trusting `app_metadata.role`,
 * `user_metadata`, the `aud` claim or any other IdP field would let an
 * end-user of the Android app — or an anonymous signup — mint themselves an
 * administrator by writing their own metadata.
 *
 * So: Supabase verifies the password; `ctl_admin` decides the role. No
 * `ctl_admin` row means no access, regardless of how valid the Supabase session
 * is. That is what `requireRoleRow()` expresses, and it is checked on every
 * request, not just at sign-in.
 */

/** Claims Supabase returns that must NEVER be treated as authorization. */
export const UNTRUSTED_CLAIMS = [
  "role",
  "aud",
  "app_metadata.role",
  "app_metadata.admin",
  "user_metadata.role",
  "user_metadata.admin",
  "is_anonymous",
] as const;

export type RoleMappingDecision =
  | {
      allowed: true;
      role: AdminRole;
      source: "control-plane-database";
      supabaseUserId: string;
    }
  | {
      allowed: false;
      code: "no_admin_row" | "not_active" | "anonymous_identity" | "no_supabase_user";
      reason: string;
    };

/**
 * Decides whether a verified Supabase identity may act as an administrator.
 *
 * Pure and total: every branch is covered by tests, and there is no path that
 * returns `allowed: true` without a matching `ctl_admin` row.
 */
export function requireRoleRow(input: {
  supabaseUserId: string | null;
  isAnonymous: boolean;
  adminRow: { role: AdminRole; status: "invited" | "active" | "suspended" } | null;
}): RoleMappingDecision {
  if (!input.supabaseUserId) {
    return {
      allowed: false,
      code: "no_supabase_user",
      reason: "Supabase did not return a user id; the verification result cannot be trusted.",
    };
  }

  if (input.isAnonymous) {
    return {
      allowed: false,
      code: "anonymous_identity",
      reason:
        "Anonymous sign-in is enabled on this project and is used by the Android app. An anonymous identity is never an administrator.",
    };
  }

  if (!input.adminRow) {
    return {
      allowed: false,
      code: "no_admin_row",
      reason:
        "This identity has no ctl_admin row. A valid Supabase session proves authentication, not authorization: roles live in the control-plane database only.",
    };
  }

  if (input.adminRow.status !== "active") {
    return {
      allowed: false,
      code: "not_active",
      reason: `The administrator row is '${input.adminRow.status}', not 'active'.`,
    };
  }

  return {
    allowed: true,
    role: input.adminRow.role,
    source: "control-plane-database",
    supabaseUserId: input.supabaseUserId,
  };
}

/** True when a Supabase user object represents an anonymous sign-in. */
export function isAnonymousIdentity(user: {
  is_anonymous?: boolean;
  email?: string | null;
  app_metadata?: { provider?: string } | null;
}): boolean {
  if (user.is_anonymous === true) return true;
  if (user.app_metadata?.provider === "anonymous") return true;
  // The live project has users with an empty-string email and no provider; treat
  // those as anonymous rather than guessing.
  return !user.email || user.email.trim() === "";
}

export const ROLE_MAPPING_POLICY = [
  "Supabase verifies the password. It does not decide the role.",
  "Roles come only from ctl_admin in the control-plane database.",
  "No ctl_admin row means no access, however valid the Supabase session is.",
  "Anonymous identities are refused outright — the app enables anonymous sign-in.",
  "No Supabase claim (role, aud, app_metadata, user_metadata) is ever read as authorization.",
] as const;
