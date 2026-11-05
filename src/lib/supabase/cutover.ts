/**
 * Supabase Auth cutover preflight.
 *
 * `AUTH_PROVIDER=supabase` is implemented and fails closed, but switching it on is
 * not a one-line change: several preconditions live in the Supabase **project
 * configuration**, which this platform can read but must never alter. Without a
 * preflight the failure mode is bad — an operator flips the variable, and either
 * nobody can sign in, or self-service sign-up is open on a project meant for
 * invitation-only administration.
 *
 * This module separates the two halves deliberately:
 *
 *   `gatherCutoverFacts()` — performs live READ-ONLY calls and collects facts.
 *   `evaluateCutover()`    — a PURE function turning facts into a verdict.
 *
 * The split exists so the decision logic is exhaustively testable without network
 * access, and so the live half cannot accidentally embed a policy judgement that
 * the tests never see.
 *
 * NOTHING HERE WRITES. No setting is changed, no user created, no invitation sent.
 * Fixing a failed check is an owner action in the Supabase dashboard.
 */

export type CheckStatus = "pass" | "fail" | "warn" | "unknown";

export type CutoverFacts = {
  /** Credentials and target. */
  hasUrl: boolean;
  hasPublishableKey: boolean;
  hasSecretKey: boolean;
  projectRef: string | null;
  expectedProjectRef: string | null;
  /** Live project configuration, or null when it could not be read. */
  settingsReadable: boolean;
  disableSignup: boolean | null;
  mfaTotpEnrollEnabled: boolean | null;
  mfaTotpVerifyEnabled: boolean | null;
  emailSignInEnabled: boolean | null;
  anonymousSignInEnabled: boolean | null;
  googleOAuthEnabled: boolean | null;
  /** Live auth population, aggregate counts only — never identities. */
  authUsersReadable: boolean;
  totalAuthUsers: number | null;
  anonymousAuthUsers: number | null;
  emailConfirmedUsers: number | null;
  /** Control-plane side. */
  adminRows: number;
  adminRowsWithSupabaseUserId: number;
  ownerRows: number;
  activeAdminRows: number;
  controlDatabaseSeparate: boolean;
  encryptionKeyAvailable: boolean;
  adminInvitePermitted: boolean;
  currentProvider: "local" | "supabase";
};

export type CutoverCheck = {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  /** What the owner must do. Empty for a pass. */
  action: string;
};

export type CutoverVerdict = {
  ready: boolean;
  checks: CutoverCheck[];
  blocking: CutoverCheck[];
  warnings: CutoverCheck[];
  summary: string;
};

const EXPECTED_REF_DEFAULT = "xdcsxxwhvpiissetbrdr";

/**
 * Pure evaluation. Every branch is total: an unreadable fact yields `unknown`
 * with an explicit action, never a silent pass.
 */
export function evaluateCutover(facts: CutoverFacts): CutoverVerdict {
  const checks: CutoverCheck[] = [];

  // --- 1. credentials ---------------------------------------------------
  const credentialsOk = facts.hasUrl && facts.hasPublishableKey && facts.hasSecretKey;
  checks.push({
    id: "credentials",
    title: "Supabase credentials present",
    status: credentialsOk ? "pass" : "fail",
    detail: credentialsOk
      ? "URL, publishable key and secret key all resolve from the environment."
      : `Missing: ${[!facts.hasUrl && "SUPABASE_PROJECT_URL", !facts.hasPublishableKey && "SUPABASE_PUBLISHABLE_KEY", !facts.hasSecretKey && "SUPABASE_SECRET_KEY"].filter(Boolean).join(", ")}.`,
    action: credentialsOk ? "" : "Supply the missing values as server-side environment variables. Never as NEXT_PUBLIC_*.",
  });

  // --- 2. project identity ---------------------------------------------
  const refMatches =
    facts.projectRef !== null &&
    (facts.expectedProjectRef ?? EXPECTED_REF_DEFAULT) === facts.projectRef;
  checks.push({
    id: "project-ref",
    title: "Configured project is the intended ReplyMate project",
    status: !credentialsOk ? "unknown" : refMatches ? "pass" : "fail",
    detail: `Configured ref: ${facts.projectRef ?? "(unresolved)"} · expected: ${facts.expectedProjectRef ?? EXPECTED_REF_DEFAULT}.`,
    action: refMatches ? "" : "Refusing to proceed: pointing admin authentication at the wrong project would hand credentials to an unintended tenant.",
  });

  // --- 3. self-service sign-up ------------------------------------------
  // This is the highest-severity check. An invitation-only admin platform whose
  // identity provider accepts public sign-up is open to anyone.
  checks.push({
    id: "disable-signup",
    title: "Self-service sign-up disabled on the project",
    status: facts.disableSignup === true ? "pass" : facts.disableSignup === false ? "fail" : "unknown",
    detail:
      facts.disableSignup === null
        ? "Auth settings could not be read, so this is unknown rather than assumed safe."
        : facts.disableSignup
          ? "disable_signup = true. Only an administrator can create an identity."
          : "disable_signup = FALSE. Anyone who can reach the project can create an Auth identity.",
    action:
      facts.disableSignup === true
        ? ""
        : "In the Supabase dashboard: Authentication → Sign In / Up → disable 'Allow new users to sign up'. This platform cannot change it and will not try.",
  });

  // --- 4. MFA parity ----------------------------------------------------
  // Local mode provides TOTP MFA implemented in this repository. Supabase mode
  // delegates the second factor to Supabase, so if the project has MFA disabled
  // the cutover would SILENTLY REMOVE a control. That is a regression, not a
  // neutral difference, and is reported as blocking.
  const mfaOk = facts.mfaTotpEnrollEnabled === true && facts.mfaTotpVerifyEnabled === true;
  checks.push({
    id: "mfa-parity",
    title: "TOTP MFA available so the cutover does not lose a control",
    status: mfaOk ? "pass" : facts.mfaTotpEnrollEnabled === null ? "unknown" : "fail",
    detail: mfaOk
      ? "Project-level TOTP enrolment and verification are both enabled."
      : facts.mfaTotpEnrollEnabled === null
        ? "GoTrue omitted the mfa_totp_* keys, which means MFA is disabled project-wide."
        : "TOTP is not fully enabled at project level.",
    action: mfaOk
      ? ""
      : "Enable MFA (TOTP) for the project, or accept and document that administrators lose their second factor after cutover. Local mode currently enforces TOTP, so this is a downgrade, not a lateral move.",
  });

  // --- 5. someone can actually sign in ----------------------------------
  const usableIdentities =
    facts.emailConfirmedUsers !== null ? facts.emailConfirmedUsers : facts.totalAuthUsers;
  checks.push({
    id: "signable-identity",
    title: "At least one confirmed, non-anonymous identity exists to map to an admin",
    status: !facts.authUsersReadable ? "unknown" : (usableIdentities ?? 0) > 0 ? "pass" : "fail",
    detail: facts.authUsersReadable
      ? `${facts.totalAuthUsers ?? 0} auth user(s), ${facts.anonymousAuthUsers ?? 0} anonymous, ${facts.emailConfirmedUsers ?? 0} email-confirmed.`
      : "The auth user list could not be read with the configured secret key.",
    action:
      (usableIdentities ?? 0) > 0
        ? ""
        : "Create the administrator identity in Supabase Auth first (an invitation), then map it to a ctl_admin row. Anonymous identities are rejected by role mapping and cannot be used.",
  });

  // --- 6. role rows exist ------------------------------------------------
  // In supabase mode authorization stays in ctl_admin: a verified Supabase
  // identity with no role row is refused, deliberately, with the same 401 body as
  // a bad password so its existence is not disclosed.
  const mapped = facts.adminRowsWithSupabaseUserId;
  checks.push({
    id: "role-mapping",
    title: "Administrator role rows exist for the identities that will sign in",
    status: facts.activeAdminRows > 0 ? (mapped > 0 ? "pass" : "warn") : "fail",
    detail: `${facts.adminRows} ctl_admin row(s), ${facts.activeAdminRows} active, ${mapped} already linked to a Supabase user id, ${facts.ownerRows} owner(s).`,
    action:
      mapped > 0
        ? ""
        : "Linking happens automatically on the first verified sign-in, but only for an email that ALREADY has a ctl_admin row. Provision the row before cutover, or the real owner will be refused and cannot self-recover.",
  });

  // --- 7. owner continuity ----------------------------------------------
  // The failure mode this guards is a cutover that locks out the only owner.
  checks.push({
    id: "owner-continuity",
    title: "An owner will still exist after the cutover",
    status: facts.ownerRows > 0 ? "pass" : "fail",
    detail: `${facts.ownerRows} owner row(s) in the control plane.`,
    action:
      facts.ownerRows > 0
        ? ""
        : "Cutover with no owner row would leave nobody able to administer administrators. Create one first.",
  });

  // --- 8. anonymous sign-in exposure ------------------------------------
  const anonymousPresent = facts.anonymousSignInEnabled === true && (facts.anonymousAuthUsers ?? 0) > 0;
  const anonymousStatus: CheckStatus =
    facts.anonymousSignInEnabled === null ? "unknown" : anonymousPresent ? "warn" : "pass";
  checks.push({
    id: "anonymous-signin",
    title: "Anonymous sign-in handled",
    status: anonymousStatus,
    detail:
      facts.anonymousSignInEnabled === null
        ? "The anonymous sign-in setting could not be read."
        : facts.anonymousSignInEnabled
          ? `Anonymous sign-in is ENABLED (ReplyMate guest mode) with ${facts.anonymousAuthUsers ?? 0} anonymous user(s). Role mapping rejects anonymous identities before any role lookup.`
          : "Anonymous sign-in is disabled on this project.",
    // A pass carries no action, so the "do not disable this" advisory lives in
    // detail above when the check passes and in action only when it warns.
    action: anonymousPresent
      ? "No change required, but do NOT disable anonymous sign-in to harden the admin side: that would break ReplyMate guest mode. Keep it enabled and rely on role mapping."
      : "",
  });

  // --- 9. invitation capability -----------------------------------------
  checks.push({
    id: "admin-invite",
    title: "Admin invitation capability",
    status: facts.adminInvitePermitted ? "pass" : "warn",
    detail: facts.adminInvitePermitted
      ? "SUPABASE_ALLOW_ADMIN_INVITE is set, so invitations may be sent through Supabase Auth."
      : "SUPABASE_ALLOW_ADMIN_INVITE is not set. supabaseIdentity.invite() fails closed rather than sending mail.",
    action: facts.adminInvitePermitted
      ? ""
      : "Set SUPABASE_ALLOW_ADMIN_INVITE=true only once disable-signup passes. Invitations send real email from the project.",
  });

  // --- 10. data-plane separation ----------------------------------------
  checks.push({
    id: "db-separation",
    title: "Control-plane database is separate from the Supabase project",
    status: facts.controlDatabaseSeparate ? "pass" : "fail",
    detail: facts.controlDatabaseSeparate
      ? "DATABASE_URL does not point at the Supabase project; ctl_* tables live in their own database."
      : "DATABASE_URL appears to point at the Supabase project.",
    action: facts.controlDatabaseSeparate
      ? ""
      : "Point DATABASE_URL at a separate database. Control data must never share a schema with ReplyMate end-user data.",
  });

  // --- 11. encryption key -----------------------------------------------
  checks.push({
    id: "encryption-key",
    title: "Encryption key available for session and token digests",
    status: facts.encryptionKeyAvailable ? "pass" : "fail",
    detail: facts.encryptionKeyAvailable
      ? "A key resolved from the environment or the durable keyfile."
      : "No CONTROL_ENC_KEY and no readable keyfile, so token digests are unkeyed and TOTP enrolment is refused.",
    action: facts.encryptionKeyAvailable ? "" : "Set CONTROL_ENC_KEY (min 32 chars) or ensure .keys/control-enc.key is writable.",
  });

  const blocking = checks.filter((c) => c.status === "fail");
  const warnings = checks.filter((c) => c.status === "warn");
  const unknowns = checks.filter((c) => c.status === "unknown");
  const ready = blocking.length === 0 && unknowns.length === 0;

  const summary = !credentialsOk
    ? "Cannot evaluate: Supabase credentials are not configured."
    : ready && warnings.length === 0
      ? `Ready to switch AUTH_PROVIDER to supabase. All ${checks.length} checks pass.`
      : ready
        ? `Switchable, with ${warnings.length} warning(s) to review first.`
        : `NOT ready: ${blocking.length} blocking check(s)${unknowns.length > 0 ? ` and ${unknowns.length} that could not be evaluated` : ""}.`;

  return { ready, checks, blocking, warnings, summary };
}
