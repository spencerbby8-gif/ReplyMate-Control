import { adminRole, type AdminRole } from "@/db/schema";
import { outranks } from "./permissions";

/**
 * Administrator-change authorization, as a pure function.
 *
 * This used to live inline in the `admin:update` executor, which meant the most
 * security-sensitive decision in the product could only be tested by standing up
 * a database and a session. Extracting it makes the escalation matrix
 * table-testable, and guarantees the API and the tests evaluate the same code.
 *
 * Rules, in order:
 *  1. You may not suspend, delete or demote yourself — a locked-out owner is an
 *     unrecoverable outage, and self-demotion is how an account loses the ability
 *     to undo its own mistake.
 *  2. You may only modify an account strictly below your own rank.
 *  3. You may only grant a role strictly below your own rank.
 *  4. Only an owner may touch an owner account (rule 2 already implies this for
 *     everyone else; rule 4 also stops a second owner from editing the first).
 *  5. Only an owner may grant `owner`.
 */

export type AdminChangeRequest = {
  role?: AdminRole;
  status?: "invited" | "active" | "suspended";
  mfaRequired?: boolean;
};

export type AdminChangeSubject = {
  id: string;
  role: AdminRole;
  status: "invited" | "active" | "suspended";
};

export type EscalationDecision =
  | { allowed: true; reason: string; selfAction: boolean; touchesOwner: boolean }
  | {
      allowed: false;
      reason: string;
      code: "self_action" | "rank" | "owner_only" | "no_change";
      selfAction: boolean;
      touchesOwner: boolean;
    };

export function authorizeAdminChange(
  actor: { id: string; role: AdminRole },
  target: AdminChangeSubject,
  change: AdminChangeRequest,
): EscalationDecision {
  const isSelf = actor.id === target.id;
  const touchesOwner = target.role === "owner";

  const deny = (code: "self_action" | "rank" | "owner_only" | "no_change", reason: string) => ({
    allowed: false as const,
    code,
    reason,
    selfAction: isSelf,
    touchesOwner,
  });

  // Rule 0 — nothing to do is a malformed request, not an authorized one.
  const hasChange =
    change.role !== undefined || change.status !== undefined || change.mfaRequired !== undefined;
  if (!hasChange) return deny("no_change", "No change was requested.");

  if (change.role !== undefined && !adminRole.includes(change.role)) {
    return deny("no_change", `Unknown role "${String(change.role)}".`);
  }

  // Rule 1 — self-protection. Suspending or re-roleing yourself is refused
  // outright: a self-suspension is an unrecoverable outage, and a self-demotion
  // can leave the platform with no owner at all.
  if (isSelf && change.status === "suspended") {
    return deny("self_action", "You cannot suspend your own account; that would lock out the ability to undo it.");
  }
  if (isSelf && change.role !== undefined && change.role !== target.role) {
    return deny("self_action", "You cannot change your own role. Another owner must do it, or restore from a backup owner account.");
  }

  // Rule 2 — owner accounts. Checked BEFORE the generic rank rule so the reason
  // is specific: "rank" would be true but useless to an operator trying to
  // understand why an owner-to-owner edit was refused.
  if (touchesOwner && !isSelf) {
    return deny(
      "owner_only",
      actor.role === "owner"
        ? "An owner account may not be modified by another owner. Use that person's own session."
        : "Only an owner may modify an owner account.",
    );
  }

  // Rule 3 — granting the owner role is owner-only, for the same reason.
  if (change.role === "owner" && actor.role !== "owner") {
    return deny("owner_only", "Only an owner may grant the owner role.");
  }

  // Rule 4 — rank over the target.
  if (!isSelf && !outranks(actor.role, target.role)) {
    return deny(
      "rank",
      `A ${actor.role} may only modify accounts strictly below their own rank; the target is ${target.role}.`,
    );
  }

  // Rule 5 — rank over the role being granted.
  if (change.role !== undefined && change.role !== target.role && !outranks(actor.role, change.role)) {
    return deny(
      "rank",
      `A ${actor.role} may not grant the ${change.role} role; the granted role must be strictly below your own.`,
    );
  }

  return {
    allowed: true,
    reason: "Change permitted by the escalation policy.",
    selfAction: isSelf,
    touchesOwner,
  };
}

/** Human-readable summary of the policy, for the Users page. */
export const ESCALATION_POLICY = [
  "You cannot suspend your own account, and you cannot change your own role at all.",
  "You may only modify an account strictly below your own rank.",
  "Owner accounts cannot be modified by anyone else — not even another owner.",
  "You may only grant a role strictly below your own rank.",
  "An owner account cannot be modified by another owner — use that person's own session.",
  "Only an owner may grant the owner role.",
  "Suspending an account revokes all of its sessions immediately.",
] as const;
