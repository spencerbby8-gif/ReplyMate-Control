import { and, count, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { ctlAdmin } from "@/db/schema";
import { env, supabase, supabaseProjectRef } from "@/config/env";
import { encryptionAvailable } from "@/lib/auth/crypto";
import type { CutoverFacts } from "./cutover";

/**
 * Live fact-gathering half of the cutover preflight.
 *
 * READ-ONLY. It performs two GET requests against Supabase Auth and four COUNT
 * queries against the control-plane database. It changes no project setting,
 * creates no user, sends no invitation and writes no row.
 *
 * Deliberately separated from `evaluateCutover()` so the policy is pure and
 * testable and this half cannot smuggle a judgement the tests never see.
 */

const TIMEOUT_MS = 15_000;

function unconfiguredFacts(reason: string): CutoverFacts {
  return {
    hasUrl: Boolean(supabase.url),
    hasPublishableKey: Boolean(supabase.publishableKey),
    hasSecretKey: Boolean(supabase.secretKey),
    projectRef: supabaseProjectRef(),
    expectedProjectRef: null,
    settingsReadable: false,
    disableSignup: null,
    mfaTotpEnrollEnabled: null,
    mfaTotpVerifyEnabled: null,
    emailSignInEnabled: null,
    anonymousSignInEnabled: null,
    googleOAuthEnabled: null,
    authUsersReadable: false,
    totalAuthUsers: null,
    anonymousAuthUsers: null,
    emailConfirmedUsers: null,
    adminRows: 0,
    adminRowsWithSupabaseUserId: 0,
    ownerRows: 0,
    activeAdminRows: 0,
    controlDatabaseSeparate: true,
    encryptionKeyAvailable: encryptionAvailable(),
    adminInvitePermitted: process.env.SUPABASE_ALLOW_ADMIN_INVITE === "true",
    currentProvider: env.AUTH_PROVIDER,
    // reason is carried in the returned facts' readable flags; the caller can
    // surface it separately.
    ...(reason ? {} : {}),
  };
}

export type GatherResult = { facts: CutoverFacts; notes: string[] };

export async function gatherCutoverFacts(expectedProjectRef?: string): Promise<GatherResult> {
  const notes: string[] = [];
  const base = (supabase.url ?? "").replace(/\/$/, "");
  const publishable = supabase.publishableKey;
  const secret = supabase.secretKey;

  if (!base || !publishable || !secret) {
    notes.push("Supabase credentials are incomplete; live checks were skipped rather than guessed.");
    return { facts: unconfiguredFacts("incomplete"), notes };
  }

  const facts: CutoverFacts = {
    ...unconfiguredFacts(""),
    hasUrl: true,
    hasPublishableKey: true,
    hasSecretKey: true,
    projectRef: supabaseProjectRef(),
    expectedProjectRef: expectedProjectRef ?? null,
  };

  // --- Auth settings (publishable key is sufficient; the document is public) ---
  try {
    const response = await fetch(`${base}/auth/v1/settings`, {
      headers: { apikey: publishable },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) {
      const settings = (await response.json()) as Record<string, unknown>;
      const external = (settings.external ?? {}) as Record<string, boolean>;
      facts.settingsReadable = true;
      facts.disableSignup = settings.disable_signup === true;
      // GoTrue OMITS the mfa_totp_* keys entirely when MFA is disabled
      // project-wide, rather than returning false. Verified against the live
      // project in TASK-002. Absent therefore means disabled.
      facts.mfaTotpEnrollEnabled = settings.mfa_totp_enroll_enabled === true;
      facts.mfaTotpVerifyEnabled = settings.mfa_totp_verify_enabled === true;
      facts.emailSignInEnabled = external.email === true;
      facts.anonymousSignInEnabled = external.anonymous_users === true;
      facts.googleOAuthEnabled = external.google === true;
    } else {
      notes.push(`Auth settings returned HTTP ${response.status}.`);
    }
  } catch (error) {
    notes.push(`Auth settings unreadable: ${error instanceof Error ? error.name : "unknown"}.`);
  }

  // --- Auth population: aggregate counts only, never identities ------------
  try {
    const response = await fetch(`${base}/auth/v1/admin/users?per_page=1000`, {
      headers: { apikey: secret, authorization: `Bearer ${secret}` },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) {
      const body = (await response.json()) as { users?: Array<Record<string, unknown>> };
      const users = body.users ?? [];
      facts.authUsersReadable = true;
      facts.totalAuthUsers = users.length;
      // Counted, not returned. No email, id or metadata leaves this function.
      facts.anonymousAuthUsers = users.filter(
        (u) => u.is_anonymous === true || !u.email || u.email === "",
      ).length;
      facts.emailConfirmedUsers = users.filter((u) => u.email_confirmed_at).length;
    } else {
      notes.push(`Auth user list returned HTTP ${response.status}.`);
    }
  } catch (error) {
    notes.push(`Auth user list unreadable: ${error instanceof Error ? error.name : "unknown"}.`);
  }

  // --- Control-plane side --------------------------------------------------
  const [allAdmins] = await db.select({ value: count() }).from(ctlAdmin);
  const [activeAdmins] = await db.select({ value: count() }).from(ctlAdmin).where(eq(ctlAdmin.status, "active"));
  const [owners] = await db
    .select({ value: count() })
    .from(ctlAdmin)
    .where(and(eq(ctlAdmin.role, "owner"), ne(ctlAdmin.status, "suspended")));
  const [linked] = await db
    .select({ value: count() })
    .from(ctlAdmin)
    .where(and(eq(ctlAdmin.status, "active"), ne(ctlAdmin.supabaseUserId, null as never)));

  facts.adminRows = allAdmins?.value ?? 0;
  facts.activeAdminRows = activeAdmins?.value ?? 0;
  facts.ownerRows = owners?.value ?? 0;
  facts.adminRowsWithSupabaseUserId = linked?.value ?? 0;

  // Separation: the control-plane DATABASE_URL must not be the Supabase project.
  const dbHost = new URL(env.DATABASE_URL).host;
  facts.controlDatabaseSeparate = !/supabase\.(co|com|in|net|cloud)$/i.test(dbHost) && !dbHost.includes("pooler.supabase");

  return { facts, notes };
}
