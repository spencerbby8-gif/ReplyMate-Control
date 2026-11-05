import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { draftDrift, publishRelease, recordRevision } from "@/lib/config/versioning";
import {
  ctlAdmin,
  ctlAiProvider,
  ctlConfigItem,
  ctlDevice,
  ctlDeviceToken,
  ctlFeatureFlag,
  ctlInvite,
  ctlModelRoute,
  ctlMonitorProbe,
  ctlRelease,
  ctlSession,
  ctlSupportTicket,
  adminRole,
  adminStatus,
  flagStatus,
  providerStatus,
  releaseStatus,
  routeTask,
  thinkingLevel,
  ticketStatus,
  type AdminRole,
} from "@/db/schema";
import type { Capability } from "@/config/nav";
import { env } from "@/config/env";
import { PROVIDER_CATALOGUE, effectiveOutputCap } from "@/config/catalog";
import { auditActions, recordAudit, type AuditAction } from "@/lib/audit/logger";
import { generateToken, digestToken } from "@/lib/auth/crypto";
import { revokeAllSessionsForAdmin, revokeSessionById } from "@/lib/auth/session";
import { authorizeAdminChange } from "@/lib/authz/escalation";
import { identityProvider } from "@/lib/auth/identity";
import { PrivacyViolation } from "@/lib/privacy/guard";
import { fetchReleaseLedger, syncReleases } from "@/lib/integrations/github";
import { runProbeSuite } from "@/lib/monitoring/probes";
import { runAssistant } from "@/lib/aiops/engine";

/**
 * Control-plane mutation registry.
 *
 * One dispatcher (`/api/control`) instead of a dozen near-identical routes. Each
 * entry declares the capability it requires, a zod schema for its payload, and an
 * executor that performs the write and returns an audit-friendly summary. The
 * dispatcher authenticates, authorizes, executes and audits — in that order, and
 * never the other way round.
 */

const uuid = z.string().uuid();

/**
 * A plain union rather than a discriminated union: several resources carry more
 * than one operation (invite:create / invite:revoke), and Zod rejects duplicate
 * discriminator values. The inferred type is the same, so `Extract<>` narrowing
 * in `narrowAction` is unaffected, and `flattenZodError` below turns the union
 * failure into a readable message.
 */
export const controlActionSchema = z.union([
  // ---- invitations -------------------------------------------------------
  z.object({
    resource: z.literal("invite"),
    operation: z.literal("create"),
    values: z.object({
      email: z.string().email().max(254),
      role: z.enum(adminRole),
      mfaRequired: z.boolean().default(true),
      expiresInHours: z.number().int().min(1).max(168).default(72),
    }),
  }),
  z.object({
    resource: z.literal("invite"),
    operation: z.literal("revoke"),
    values: z.object({ id: uuid }),
  }),

  // ---- administrators ----------------------------------------------------
  z.object({
    resource: z.literal("admin"),
    operation: z.literal("update"),
    values: z.object({
      id: uuid,
      role: z.enum(adminRole).optional(),
      status: z.enum(adminStatus).optional(),
      mfaRequired: z.boolean().optional(),
    }),
  }),
  z.object({
    resource: z.literal("admin"),
    operation: z.literal("resetMfa"),
    values: z.object({ id: uuid }),
  }),

  // ---- sessions ----------------------------------------------------------
  z.object({
    resource: z.literal("session"),
    operation: z.literal("revoke"),
    values: z.object({ id: uuid, allForAdmin: z.boolean().default(false) }),
  }),

  // ---- feature flags -----------------------------------------------------
  z.object({
    resource: z.literal("flag"),
    operation: z.literal("upsert"),
    values: z.object({
      id: uuid.optional(),
      key: z
        .string()
        .min(2)
        .max(64)
        .regex(/^[a-z0-9_]+$/, "Lowercase letters, digits and underscores only."),
      name: z.string().min(2).max(120),
      description: z.string().max(2000).optional(),
      status: z.enum(flagStatus),
      rolloutPercent: z.number().int().min(0).max(100),
      clientWired: z.boolean().default(false),
      minAppVersion: z.string().max(32).nullish(),
    }),
  }),
  z.object({
    resource: z.literal("flag"),
    operation: z.literal("remove"),
    values: z.object({ id: uuid }),
  }),

  // ---- model routing -----------------------------------------------------
  z.object({
    resource: z.literal("route"),
    operation: z.literal("upsert"),
    values: z.object({
      id: uuid.optional(),
      task: z.enum(routeTask),
      providerKey: z.string().min(1).max(64),
      modelId: z.string().min(1).max(128),
      priority: z.number().int().min(0).max(9999).default(100),
      thinking: z.enum(thinkingLevel).default("none"),
      maxOutputTokens: z.number().int().min(1).max(32768).optional(),
      enabled: z.boolean().default(false),
      minAppVersion: z.string().max(32).nullish(),
      notes: z.string().max(1000).nullish(),
    }),
  }),
  z.object({
    resource: z.literal("route"),
    operation: z.literal("remove"),
    values: z.object({ id: uuid }),
  }),

  // ---- providers ---------------------------------------------------------
  z.object({
    resource: z.literal("provider"),
    operation: z.literal("update"),
    values: z.object({
      id: uuid,
      status: z.enum(providerStatus),
      notes: z.string().max(2000).nullish(),
      minAppVersion: z.string().max(32).nullish(),
    }),
  }),
  z.object({
    resource: z.literal("provider"),
    operation: z.literal("resyncCatalogue"),
    values: z.object({}),
  }),

  // ---- releases ----------------------------------------------------------
  z.object({
    resource: z.literal("release"),
    operation: z.literal("syncFromSource"),
    values: z.object({}),
  }),
  z.object({
    resource: z.literal("release"),
    operation: z.literal("update"),
    values: z.object({ id: uuid, status: z.enum(releaseStatus), channel: z.enum(["internal", "beta", "production"]).optional() }),
  }),

  // ---- configuration -----------------------------------------------------
  z.object({
    resource: z.literal("config"),
    operation: z.literal("update"),
    values: z.object({ id: uuid, value: z.unknown(), changeNote: z.string().max(500).nullish() }),
  }),
  z.object({
    resource: z.literal("config"),
    operation: z.literal("publish"),
    values: z.object({
      changeNote: z.string().max(500).nullish(),
      minAppVersion: z.string().max(32).nullish(),
    }),
  }),

  // ---- support -----------------------------------------------------------
  z.object({
    resource: z.literal("ticket"),
    operation: z.literal("create"),
    values: z.object({
      subject: z.string().min(3).max(200),
      body: z.string().max(8000).optional(),
      requesterEmail: z.string().email().max(254).optional(),
      appVersion: z.string().max(32).optional(),
      priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
    }),
  }),
  z.object({
    resource: z.literal("ticket"),
    operation: z.literal("update"),
    values: z.object({
      id: uuid,
      status: z.enum(ticketStatus).optional(),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    }),
  }),

  // ---- monitoring --------------------------------------------------------
  z.object({
    resource: z.literal("device"),
    operation: z.literal("register"),
    values: z.object({
      label: z.string().min(1).max(80),
      appVersion: z.string().max(24).nullish(),
      androidApiLevel: z.number().int().min(1).max(99).nullish(),
      deviceModel: z.string().max(64).nullish(),
      consentRecordedAt: z.string().datetime(),
      notes: z.string().max(500).nullish(),
      expiresInDays: z.number().int().min(1).max(365).default(90),
    }),
  }),
  z.object({
    resource: z.literal("device"),
    operation: z.literal("revoke"),
    values: z.object({ id: uuid, reason: z.string().max(200).nullish() }),
  }),
  z.object({
    resource: z.literal("probe"),
    operation: z.literal("run"),
    values: z.object({ targets: z.array(z.string().min(1)).max(24).optional() }),
  }),

  // ---- AI operations assistant -------------------------------------------
  z.object({
    resource: z.literal("aiops"),
    operation: z.literal("run"),
    values: z.object({ prompt: z.string().min(2).max(2000), sessionId: uuid.optional() }),
  }),
]);

export type ControlAction = z.infer<typeof controlActionSchema>;

type LeafIssue = { path: Array<string | number>; message: string };

/** Collects every leaf issue, walking through nested union branches. */
function collectBranches(issues: unknown, depth = 0): LeafIssue[][] {
  if (depth > 6 || !Array.isArray(issues)) return [];
  const branches: LeafIssue[][] = [];
  for (const issue of issues as Array<Record<string, unknown>>) {
    const nested = issue?.errors;
    if (Array.isArray(nested)) {
      for (const branch of nested) {
        branches.push(...collectBranches(branch, depth + 1));
      }
    } else {
      branches.push([
        {
          path: Array.isArray(issue?.path) ? (issue.path as Array<string | number>) : [],
          message: typeof issue?.message === "string" ? issue.message : "invalid input",
        },
      ]);
    }
  }
  return branches;
}

/**
 * Turns a union validation failure into one readable sentence.
 *
 * A union reports an error per branch, which is noise for a caller who sent one
 * payload. The branch that actually matched `resource` and `operation` is the
 * useful one — its remaining issues all sit under `values` — so that branch wins.
 */
export function flattenZodError(error: z.ZodError): string {
  const branches = collectBranches(error.issues);
  if (branches.length === 0) return "Invalid request payload.";

  const matched = branches.filter(
    (branch) => branch.length > 0 && branch.every((issue) => String(issue.path[0] ?? "") === "values"),
  );
  const best =
    (matched.length > 0
      ? matched.sort((a, b) => a.length - b.length)[0]
      : branches.sort((a, b) => a.length - b.length)[0]) ?? branches[0];

  const parts = best.map((issue) => `${issue.path.slice(1).join(".") || issue.path.join(".") || "payload"}: ${issue.message}`);
  return parts.length > 0 ? parts.join("; ") : "Invalid request payload.";
}

const CAPABILITY: Record<string, Capability> = {
  "invite:create": "users:manage",
  "invite:revoke": "users:manage",
  "admin:update": "users:manage",
  "admin:resetMfa": "security:manage",
  "session:revoke": "security:manage",
  "flag:upsert": "flags:manage",
  "flag:remove": "flags:manage",
  "route:upsert": "routing:manage",
  "route:remove": "routing:manage",
  "provider:update": "providers:manage",
  "provider:resyncCatalogue": "providers:manage",
  "release:syncFromSource": "releases:manage",
  "release:update": "releases:manage",
  "config:update": "config:manage",
  "config:publish": "config:manage",
  "device:register": "devices:manage",
  "device:revoke": "devices:manage",
  "ticket:create": "support:manage",
  "ticket:update": "support:manage",
  "probe:run": "monitoring:run",
  "aiops:run": "aiops:use",
};

export function capabilityFor(resource: string, operation: string): Capability {
  const capability = CAPABILITY[`${resource}:${operation}`];
  if (!capability) throw new PrivacyViolation(`Unknown control action ${resource}:${operation}`);
  return capability;
}

/** Known `resource:operation` pairs, so the dispatcher can reject precisely. */
export function isKnownAction(resource: unknown, operation: unknown): boolean {
  if (typeof resource !== "string" || typeof operation !== "string") return false;
  return Object.hasOwn(CAPABILITY, `${resource}:${operation}`);
}

export function knownActions(): string[] {
  return Object.keys(CAPABILITY).sort();
}

const ACTION_FOR: Record<string, AuditAction> = {
  "invite:create": auditActions.inviteCreated,
  "invite:revoke": auditActions.inviteRevoked,
  "admin:update": auditActions.userRoleChanged,
  "admin:resetMfa": auditActions.authMfaEnrolled,
  "session:revoke": auditActions.authSessionRevoked,
  "flag:upsert": auditActions.flagUpdated,
  "flag:remove": auditActions.flagDeleted,
  "route:upsert": auditActions.routeUpdated,
  "route:remove": auditActions.routeDeleted,
  "provider:update": auditActions.providerUpdated,
  "provider:resyncCatalogue": auditActions.providerUpdated,
  "release:syncFromSource": auditActions.releaseUpdated,
  "release:update": auditActions.releaseUpdated,
  "config:update": auditActions.configUpdated,
  "config:publish": auditActions.configPublished,
  "device:register": auditActions.deviceRegistered,
  "device:revoke": auditActions.deviceRevoked,
  "ticket:create": auditActions.ticketCreated,
  "ticket:update": auditActions.ticketUpdated,
  "probe:run": auditActions.monitorProbeRun,
  "aiops:run": auditActions.aiopsInvoked,
};

export type Actor = {
  adminId: string;
  email: string;
  role: AdminRole;
  ip: string | null;
  userAgent: string | null;
  requestId: string;
};

export type ExecutionResult = {
  entity: string;
  entityId: string | null;
  detail: Record<string, unknown>;
  summary: string;
  /** Values that must reach the caller but must NEVER be written to the audit log. */
  responseOnly?: Record<string, unknown>;
  /** Populated by the AI operations assistant so the UI can render the trace. */
  assistant?: unknown;
};

/**
 * Narrows the discriminated union to one exact variant at runtime.
 *
 * The dispatcher switches on a composite `${resource}:${operation}` string, so
 * TypeScript cannot narrow on its own. This performs a real runtime check and
 * then hands back the precise variant type — no `any`, no unsafe cast on faith.
 */
function narrowAction<
  R extends ControlAction["resource"],
  O extends Extract<ControlAction, { resource: R }>["operation"],
>(input: ControlAction, resource: R, operation: O): Extract<ControlAction, { resource: R; operation: O }> {
  if (input.resource !== resource || input.operation !== operation) {
    throw new ConflictError(`Action mismatch: expected ${resource}:${operation}, received ${input.resource}:${input.operation}.`);
  }
  return input as Extract<ControlAction, { resource: R; operation: O }>;
}

export async function executeControlAction(
  input: ControlAction,
  actor: Actor,
): Promise<ExecutionResult> {
  const key = `${input.resource}:${input.operation}`;

  switch (key) {
    // ---------------------------------------------------------------- invites
    case "invite:create": {
      const action = narrowAction(input, "invite", "create");
      const { email, role, mfaRequired, expiresInHours } = action.values;
      const normalized = email.toLowerCase();

      const [existingAdmin] = await db.select({ id: ctlAdmin.id, status: ctlAdmin.status }).from(ctlAdmin).where(eq(ctlAdmin.email, normalized));
      if (existingAdmin && existingAdmin.status === "active") {
        throw new ConflictError(`${normalized} already has an active administrator account.`);
      }
      if (role === "owner" && actor.role !== "owner") {
        throw new ForbiddenError("Only an owner may invite another owner.");
      }

      const expiresAt = new Date(Date.now() + expiresInHours * 3_600_000);
      const provider = identityProvider();

      // ---- Supabase Auth is the identity provider -------------------------
      // The invitation email and the password are Supabase's business, so this
      // app must NOT mint a local redemption link: that link would set a local
      // password nobody would ever use, and the operator would believe they had
      // invited a Supabase identity.
      if (provider.name === "supabase") {
        const invited = await provider.invite(normalized, {
          redirectTo: `${publicBaseUrl()}/login`,
        });
        if (!invited.ok) {
          if (invited.code === "already_exists") throw new ConflictError(invited.reason);
          throw new UpstreamError(invited.reason);
        }

        // Tracking row only. The token is generated and immediately discarded —
        // it is never returned, so it cannot be redeemed through this app.
        await db
          .insert(ctlInvite)
          .values({
            email: normalized,
            role,
            tokenHash: digestToken(generateToken()),
            invitedBy: actor.adminId,
            mfaRequired,
            expiresAt,
          })
          .onConflictDoNothing();

        // Provision the role holder now, so the account is visible in Users with
        // status `invited`. The login route activates it on first verified
        // Supabase sign-in and links the auth user id.
        await db
          .insert(ctlAdmin)
          .values({
            email: normalized,
            role,
            status: "invited",
            supabaseUserId: invited.externalUserId ? (invited.externalUserId as string) : null,
            mfaRequired,
          })
          .onConflictDoUpdate({
            target: ctlAdmin.email,
            set: { role, mfaRequired, updatedAt: new Date() },
          });

        return {
          entity: "invite",
          entityId: null,
          detail: { email: normalized, role, mfaRequired, transport: "supabase-email", externalUserId: invited.externalUserId },
          summary: `${invited.deliveryNote} Invitation sent to ${normalized} (${role}).`,
        };
      }

      // ---- Local identity provider ----------------------------------------
      const token = generateToken();
      const [invite] = await db
        .insert(ctlInvite)
        .values({
          email: normalized,
          role,
          tokenHash: digestToken(token),
          invitedBy: actor.adminId,
          mfaRequired,
          expiresAt,
        })
        .returning({ id: ctlInvite.id, expiresAt: ctlInvite.expiresAt });

      return {
        entity: "invite",
        entityId: invite.id,
        detail: { email: normalized, role, mfaRequired, expiresInHours, transport: "signed-link-from-this-app" },
        responseOnly: { inviteUrl: `/invite/${token}` },
        summary: `Invitation created for ${normalized} (${role}).`,
      };
    }

    case "invite:revoke": {

      const action = narrowAction(input, "invite", "revoke");
      const [revoked] = await db
        .update(ctlInvite)
        .set({ revokedAt: new Date() })
        .where(and(eq(ctlInvite.id, action.values.id), eq(ctlInvite.revokedAt, null as never)))
        .returning({ id: ctlInvite.id, email: ctlInvite.email });
      if (!revoked) throw new NotFoundError("Invitation not found or already revoked.");
      return {
        entity: "invite",
        entityId: revoked.id,
        detail: { email: revoked.email },
        summary: `Invitation for ${revoked.email} revoked.`,
      };
    }

    // ----------------------------------------------------------------- admins
    case "admin:update": {
      const action = narrowAction(input, "admin", "update");
      const { id, role, status, mfaRequired } = action.values;
      const [target] = await db.select().from(ctlAdmin).where(eq(ctlAdmin.id, id));
      if (!target) throw new NotFoundError("Administrator not found.");

      // Single source of truth for the escalation matrix — the same pure
      // function the regression tests exercise.
      const decision = authorizeAdminChange(
        { id: actor.adminId, role: actor.role },
        { id: target.id, role: target.role, status: target.status },
        { role, status, mfaRequired },
      );
      if (!decision.allowed) {
        switch (decision.code) {
          case "self_action":
            throw new ConflictError(decision.reason);
          case "no_change":
            throw new ConflictError(decision.reason);
          default:
            throw new ForbiddenError(decision.reason);
        }
      }

      const before = { role: target.role, status: target.status, mfaRequired: target.mfaRequired };
      const [updated] = await db
        .update(ctlAdmin)
        .set({
          ...(role ? { role } : {}),
          ...(status ? { status } : {}),
          ...(mfaRequired !== undefined ? { mfaRequired } : {}),
          updatedAt: new Date(),
        })
        .where(eq(ctlAdmin.id, id))
        .returning();

      if (status === "suspended") await revokeAllSessionsForAdmin(id);

      return {
        entity: "admin",
        entityId: id,
        detail: { email: target.email, before, after: { role: updated.role, status: updated.status, mfaRequired: updated.mfaRequired } },
        summary: `${target.email} updated (${before.role}/${before.status} → ${updated.role}/${updated.status}).`,
      };
    }

    case "admin:resetMfa": {

      const action = narrowAction(input, "admin", "resetMfa");
      const [target] = await db
        .select({ id: ctlAdmin.id, email: ctlAdmin.email, role: ctlAdmin.role, status: ctlAdmin.status })
        .from(ctlAdmin)
        .where(eq(ctlAdmin.id, action.values.id));
      if (!target) throw new NotFoundError("Administrator not found.");
      // MFA reset is a privilege change, so it goes through the same policy as a
      // role or status change rather than a bespoke rank comparison.
      const mfaDecision = authorizeAdminChange(
        { id: actor.adminId, role: actor.role },
        { id: target.id, role: target.role, status: target.status },
        { mfaRequired: false },
      );
      if (!mfaDecision.allowed) throw new ForbiddenError(mfaDecision.reason);
      await db
        .update(ctlAdmin)
        .set({ mfaSecretEnc: null, mfaEnrolledAt: null, mfaLastStep: null, updatedAt: new Date() })
        .where(eq(ctlAdmin.id, target.id));
      await revokeAllSessionsForAdmin(target.id);
      return {
        entity: "admin",
        entityId: target.id,
        detail: { email: target.email, sessionsRevoked: true },
        summary: `TOTP factor cleared for ${target.email}; all sessions revoked.`,
      };
    }

    // --------------------------------------------------------------- sessions
    case "session:revoke": {
      const action = narrowAction(input, "session", "revoke");
      if (action.values.allForAdmin) {
        await revokeAllSessionsForAdmin(action.values.id);
        return {
          entity: "session",
          entityId: action.values.id,
          detail: { scope: "all_for_admin" },
          summary: "All sessions revoked for that administrator.",
        };
      }
      const [revoked] = await db
        .update(ctlSession)
        .set({ revokedAt: new Date() })
        .where(eq(ctlSession.id, action.values.id))
        .returning({ id: ctlSession.id, adminId: ctlSession.adminId });
      if (!revoked) throw new NotFoundError("Session not found.");
      return {
        entity: "session",
        entityId: revoked.id,
        detail: { scope: "single", adminId: revoked.adminId },
        summary: "Session revoked.",
      };
    }

    // ------------------------------------------------------------------ flags
    case "flag:upsert": {
      const action = narrowAction(input, "flag", "upsert");
      const values = action.values;
      if (values.key === "message_sync" && values.status !== "off") {
        throw new PrivacyViolation(
          "message_sync must stay off. ReplyMate is local-first and this platform cannot enable message sync.",
        );
      }
      if (values.rolloutPercent > 0 && values.status === "off") {
        throw new ConflictError("A flag that is off cannot have a non-zero rollout percentage.");
      }
      if (values.status === "on" && values.rolloutPercent !== 100) {
        throw new ConflictError("Status 'on' means 100% rollout. Use 'canary' for a partial rollout.");
      }

      if (values.id) {
        const [existing] = await db.select().from(ctlFeatureFlag).where(eq(ctlFeatureFlag.id, values.id));
        if (!existing) throw new NotFoundError("Flag not found.");
        if (existing.key === "message_sync" && existing.status === "off" && values.status !== "off") {
          throw new PrivacyViolation("message_sync is pinned off by the local-first contract.");
        }
        const [updated] = await db
          .update(ctlFeatureFlag)
          .set({ ...values, id: undefined, updatedBy: actor.adminId, updatedAt: new Date() })
          .where(eq(ctlFeatureFlag.id, values.id))
          .returning();
        return {
          entity: "feature_flag",
          entityId: updated.id,
          detail: { key: updated.key, before: { status: existing.status, rolloutPercent: existing.rolloutPercent }, after: { status: updated.status, rolloutPercent: updated.rolloutPercent } },
          summary: `Flag ${updated.key} → ${updated.status} (${updated.rolloutPercent}%).`,
        };
      }

      const [created] = await db
        .insert(ctlFeatureFlag)
        .values({ ...values, minAppVersion: values.minAppVersion ?? null, updatedBy: actor.adminId })
        .returning();
      return {
        entity: "feature_flag",
        entityId: created.id,
        detail: { key: created.key, status: created.status, rolloutPercent: created.rolloutPercent },
        summary: `Flag ${created.key} created.`,
      };
    }

    case "flag:remove": {

      const action = narrowAction(input, "flag", "remove");
      const [existing] = await db.select().from(ctlFeatureFlag).where(eq(ctlFeatureFlag.id, action.values.id));
      if (!existing) throw new NotFoundError("Flag not found.");
      if (existing.key === "message_sync") {
        throw new PrivacyViolation("The message_sync prohibition flag cannot be deleted — its absence must stay visible.");
      }
      await db.delete(ctlFeatureFlag).where(eq(ctlFeatureFlag.id, existing.id));
      return {
        entity: "feature_flag",
        entityId: existing.id,
        detail: { key: existing.key },
        summary: `Flag ${existing.key} deleted.`,
      };
    }

    // ----------------------------------------------------------------- routes
    case "route:upsert": {
      const action = narrowAction(input, "route", "upsert");
      const values = action.values;
      if (!PROVIDER_CATALOGUE.some((p) => p.key === values.providerKey)) {
        throw new ConflictError(
          `Unknown provider "${values.providerKey}". The routing table may only reference providers the Android client implements.`,
        );
      }
      // Enforce the P-background-8 output-cap rule so a route can never starve
      // a background draft into an empty MAX_TOKENS reply.
      const minimumCap = effectiveOutputCap(values.thinking);
      const maxOutputTokens = values.maxOutputTokens ?? minimumCap;
      if (maxOutputTokens < minimumCap) {
        throw new ConflictError(
          `maxOutputTokens ${maxOutputTokens} is below the required ${minimumCap} for thinking="${values.thinking}" (thinking is counted inside the output cap).`,
        );
      }

      const payload = {
        task: values.task,
        providerKey: values.providerKey,
        modelId: values.modelId,
        priority: values.priority,
        thinking: values.thinking,
        maxOutputTokens,
        enabled: values.enabled,
        minAppVersion: values.minAppVersion ?? null,
        notes: values.notes ?? null,
        updatedBy: actor.adminId,
        updatedAt: new Date(),
      };

      if (values.id) {
        const [updated] = await db
          .update(ctlModelRoute)
          .set({ ...payload, task: undefined })
          .where(eq(ctlModelRoute.id, values.id))
          .returning();
        if (!updated) throw new NotFoundError("Route not found.");
        return {
          entity: "model_route",
          entityId: updated.id,
          detail: { task: updated.task, providerKey: updated.providerKey, modelId: updated.modelId, maxOutputTokens: updated.maxOutputTokens, thinking: updated.thinking },
          summary: `Route ${updated.task} → ${updated.providerKey}/${updated.modelId} updated.`,
        };
      }

      const [created] = await db.insert(ctlModelRoute).values(payload).returning();
      return {
        entity: "model_route",
        entityId: created.id,
        detail: { task: created.task, providerKey: created.providerKey, modelId: created.modelId, maxOutputTokens: created.maxOutputTokens, thinking: created.thinking },
        summary: `Route ${created.task} → ${created.providerKey}/${created.modelId} created.`,
      };
    }

    case "route:remove": {

      const action = narrowAction(input, "route", "remove");
      const [removed] = await db.delete(ctlModelRoute).where(eq(ctlModelRoute.id, action.values.id)).returning({ id: ctlModelRoute.id, task: ctlModelRoute.task });
      if (!removed) throw new NotFoundError("Route not found.");
      return { entity: "model_route", entityId: removed.id, detail: { task: removed.task }, summary: "Route deleted." };
    }

    // -------------------------------------------------------------- providers
    case "provider:update": {
      const action = narrowAction(input, "provider", "update");
      const [existing] = await db.select().from(ctlAiProvider).where(eq(ctlAiProvider.id, action.values.id));
      if (!existing) throw new NotFoundError("Provider not found.");
      const [updated] = await db
        .update(ctlAiProvider)
        .set({
          status: action.values.status,
          notes: action.values.notes ?? existing.notes,
          minAppVersion: action.values.minAppVersion ?? existing.minAppVersion,
          updatedAt: new Date(),
        })
        .where(eq(ctlAiProvider.id, existing.id))
        .returning();
      return {
        entity: "ai_provider",
        entityId: updated.id,
        detail: { key: updated.key, before: { status: existing.status }, after: { status: updated.status } },
        summary: `Provider ${updated.key} → ${updated.status}.`,
      };
    }

    case "provider:resyncCatalogue": {

      const action = narrowAction(input, "provider", "resyncCatalogue");
      let written = 0;
      for (const provider of PROVIDER_CATALOGUE) {
        await db
          .insert(ctlAiProvider)
          .values({
            key: provider.key,
            displayName: provider.displayName,
            dialect: provider.dialects.join(" + "),
            defaultBaseUrl: provider.defaultBaseUrl || null,
            status: provider.key === "ollama" ? "available" : "unconfigured",
            searchSupport: provider.searchSupport,
            reasoningSupport: provider.reasoningSupport,
            byokOnly: true,
            notes: provider.capabilityNote,
          })
          .onConflictDoUpdate({
            target: ctlAiProvider.key,
            set: {
              displayName: provider.displayName,
              dialect: provider.dialects.join(" + "),
              defaultBaseUrl: provider.defaultBaseUrl || null,
              searchSupport: provider.searchSupport,
              reasoningSupport: provider.reasoningSupport,
              notes: provider.capabilityNote,
              updatedAt: new Date(),
            },
          });
        written += 1;
      }
      return {
        entity: "ai_provider",
        entityId: null,
        detail: { written, source: "src/com/replymate/core/model/ProviderType.java + docs/provider-capability-map.md" },
        summary: `Provider catalogue re-synced from the ReplyMate source (${written} rows).`,
      };
    }

    // --------------------------------------------------------------- releases
    case "release:syncFromSource": {
      const action = narrowAction(input, "release", "syncFromSource");
      const ledger = await fetchReleaseLedger();
      if (!ledger.ok) {
        throw new UpstreamError(`Could not read releases/RELEASES.md from ${process.env.REPLYMATE_REPO ?? "the source repo"}: ${ledger.error}`);
      }
      const result = await syncReleases(ledger.releases);
      return {
        entity: "release",
        entityId: null,
        detail: { source: ledger.source, inserted: result.inserted, updated: result.updated, parsed: ledger.releases.length },
        summary: `Release ledger synced from ${ledger.source}: ${result.inserted} new, ${result.updated} updated.`,
      };
    }

    case "release:update": {

      const action = narrowAction(input, "release", "update");
      const [existing] = await db.select().from(ctlRelease).where(eq(ctlRelease.id, action.values.id));
      if (!existing) throw new NotFoundError("Release not found.");
      const [updated] = await db
        .update(ctlRelease)
        .set({
          status: action.values.status,
          ...(action.values.channel ? { channel: action.values.channel } : {}),
          publishedAt: action.values.status === "published" ? (existing.publishedAt ?? new Date()) : existing.publishedAt,
          updatedAt: new Date(),
        })
        .where(eq(ctlRelease.id, existing.id))
        .returning();
      return {
        entity: "release",
        entityId: updated.id,
        detail: { versionName: updated.versionName, before: { status: existing.status }, after: { status: updated.status } },
        summary: `Release ${updated.versionName} → ${updated.status}.`,
      };
    }

    // ------------------------------------------------------------ configuration
    case "config:update": {
      const action = narrowAction(input, "config", "update");
      const [existing] = await db.select().from(ctlConfigItem).where(eq(ctlConfigItem.id, action.values.id));
      if (!existing) throw new NotFoundError("Configuration key not found.");
      if (existing.locked) {
        throw new ForbiddenError(
          `${existing.key} is locked by the ReplyMate app contract and cannot be changed from this platform.`,
        );
      }
      if (existing.sensitive) {
        throw new PrivacyViolation("This key is marked sensitive; the control plane does not store secret values.");
      }

      const coerced = coerceConfigValue(existing.valueType, action.values.value);
      if (existing.key.startsWith("privacy.") && String(coerced) !== String(existing.value)) {
        throw new PrivacyViolation("Privacy invariants are not editable at runtime — change the code and ship it.");
      }

      const [updated] = await db
        .update(ctlConfigItem)
        .set({ value: coerced, updatedBy: actor.adminId, updatedAt: new Date() })
        .where(eq(ctlConfigItem.id, existing.id))
        .returning();

      // The draft changed, so an immutable revision is appended. Clients keep
      // receiving the last PUBLISHED release until someone publishes.
      const revision = await recordRevision({
        configItemId: updated.id,
        key: updated.key,
        valueType: updated.valueType as "string" | "number" | "boolean" | "json",
        value: coerced,
        changeNote: action.values.changeNote ?? null,
        changedBy: actor.adminId,
      });

      return {
        entity: "config",
        entityId: updated.id,
        detail: {
          key: updated.key,
          revision: revision.version,
          before: { value: existing.value },
          after: { value: updated.value },
        },
        summary: `${updated.key} updated to revision ${revision.version} (draft — not yet published to clients).`,
      };
    }

    case "config:publish": {

      const action = narrowAction(input, "config", "publish");
      const drift = await draftDrift();
      const release = await publishRelease({
        publishedBy: actor.adminId,
        changeNote: action.values.changeNote ?? null,
        minAppVersion: action.values.minAppVersion ?? null,
      });
      return {
        entity: "config_release",
        entityId: release.releaseId,
        detail: {
          version: release.version,
          keys: release.keys,
          excludedSensitive: release.excluded,
          previouslyUnpublished: drift.draftAhead,
          minAppVersion: action.values.minAppVersion ?? null,
        },
        summary: `Published configuration release v${release.version} (${release.keys} keys). ${
          release.excluded.length > 0 ? `${release.excluded.length} sensitive key(s) excluded from delivery.` : ""
        }`,
      };
    }

    // ----------------------------------------------------------------- devices
    case "device:register": {
      const action = narrowAction(input, "device", "register");
      const values = action.values;
      const consent = new Date(values.consentRecordedAt);
      if (Number.isNaN(consent.getTime()) || consent.getTime() > Date.now() + 60_000) {
        throw new ConflictError("consentRecordedAt must be a real timestamp that is not in the future.");
      }

      const [device] = await db
        .insert(ctlDevice)
        .values({
          label: values.label,
          appVersion: values.appVersion ?? null,
          androidApiLevel: values.androidApiLevel ?? null,
          deviceModel: values.deviceModel ?? null,
          consentRecordedAt: consent,
          status: "active",
          registeredBy: actor.adminId,
          notes: values.notes ?? null,
        })
        .returning();

      // Bearer credential, digest-only at rest, scoped to this one device.
      const token = generateToken();
      const expiresAt = new Date(Date.now() + values.expiresInDays * 86_400_000);
      await db.insert(ctlDeviceToken).values({
        deviceId: device.id,
        tokenDigest: digestToken(token),
        label: `${values.label} ingest key`,
        expiresAt,
      });

      return {
        entity: "device",
        entityId: device.id,
        detail: {
          label: device.label,
          appVersion: device.appVersion,
          consentRecordedAt: device.consentRecordedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        },
        responseOnly: { ingestKey: token, deviceId: device.id },
        summary: `Device "${device.label}" registered. The ingest key is shown once and stored only as a digest.`,
      };
    }

    case "device:revoke": {

      const action = narrowAction(input, "device", "revoke");
      const [device] = await db.select().from(ctlDevice).where(eq(ctlDevice.id, action.values.id));
      if (!device) throw new NotFoundError("Device not found.");

      await db
        .update(ctlDeviceToken)
        .set({ revokedAt: new Date() })
        .where(and(eq(ctlDeviceToken.deviceId, device.id), isNull(ctlDeviceToken.revokedAt)));
      const [updated] = await db
        .update(ctlDevice)
        .set({ status: "revoked", consentRevokedAt: new Date(), notes: action.values.reason ?? device.notes })
        .where(eq(ctlDevice.id, device.id))
        .returning();

      return {
        entity: "device",
        entityId: updated.id,
        detail: { label: updated.label, reason: action.values.reason ?? null },
        summary: `Device "${updated.label}" revoked; its ingest keys no longer authenticate and further telemetry is refused.`,
      };
    }

    // ---------------------------------------------------------------- support
    case "ticket:create": {
      const action = narrowAction(input, "ticket", "create");
      const values = action.values;
      const reference = `RM-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const [created] = await db
        .insert(ctlSupportTicket)
        .values({
          reference,
          subject: values.subject,
          body: values.body ?? null,
          requesterEmail: values.requesterEmail ?? null,
          appVersion: values.appVersion ?? null,
          priority: values.priority,
          status: "open",
        })
        .returning();
      return {
        entity: "ticket",
        entityId: created.id,
        detail: { reference, priority: created.priority },
        summary: `Ticket ${reference} opened.`,
      };
    }

    case "ticket:update": {

      const action = narrowAction(input, "ticket", "update");
      const [existing] = await db.select().from(ctlSupportTicket).where(eq(ctlSupportTicket.id, action.values.id));
      if (!existing) throw new NotFoundError("Ticket not found.");
      const status = action.values.status ?? existing.status;
      const [updated] = await db
        .update(ctlSupportTicket)
        .set({
          status,
          ...(action.values.priority ? { priority: action.values.priority } : {}),
          assigneeAdminId: status === "open" ? null : (existing.assigneeAdminId ?? actor.adminId),
          resolvedAt: status === "resolved" || status === "closed" ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(ctlSupportTicket.id, existing.id))
        .returning();
      return {
        entity: "ticket",
        entityId: updated.id,
        detail: { reference: updated.reference, before: { status: existing.status }, after: { status: updated.status } },
        summary: `Ticket ${updated.reference} → ${updated.status}.`,
      };
    }

    // ------------------------------------------------------------- monitoring
    case "probe:run": {
      const action = narrowAction(input, "probe", "run");
      const results = await runProbeSuite(action.values.targets);
      await db.insert(ctlMonitorProbe).values(
        results.map((result) => ({
          target: result.target,
          kind: result.kind,
          status: result.status,
          latencyMs: result.latencyMs,
          httpStatus: result.httpStatus,
          message: result.message,
          checkedAt: new Date(),
        })),
      );
      const healthy = results.filter((r) => r.status === "ok").length;
      return {
        entity: "probe",
        entityId: null,
        detail: { targets: results.length, healthy, results: results.map((r) => ({ target: r.target, status: r.status, latencyMs: r.latencyMs, httpStatus: r.httpStatus })) },
        summary: `${healthy}/${results.length} probe targets healthy.`,
      };
    }

    // ------------------------------------------------------------------ aiops
    case "aiops:run": {
      const action = narrowAction(input, "aiops", "run");
      const outcome = await runAssistant(action.values.prompt, {
        sessionId: action.values.sessionId ?? null,
        adminId: actor.adminId,
        role: actor.role,
      });
      return {
        entity: "aiops",
        entityId: outcome.sessionId,
        detail: { mode: outcome.mode, toolsInvoked: outcome.tools.map((t) => t.name), answered: outcome.answered },
        summary: outcome.answered
          ? `Assistant answered using ${outcome.tools.length} tool call(s) in ${outcome.mode} mode.`
          : `Assistant could not answer; ${outcome.tools.length} tool call(s) attempted.`,
        assistant: {
          answer: outcome.answer,
          mode: outcome.mode,
          sessionId: outcome.sessionId,
          tools: outcome.tools,
          honest: outcome.honest,
        },
      };
    }

    default:
      throw new NotFoundError(`Unsupported control action: ${key}`);
  }
}

/** Audit action for a given control action key. */
export function auditActionFor(resource: string, operation: string): AuditAction {
  const found = ACTION_FOR[`${resource}:${operation}`];
  return found ?? auditActions.accessDenied;
}

function coerceConfigValue(
  valueType: "string" | "number" | "boolean" | "json",
  raw: unknown,
): unknown {
  switch (valueType) {
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new ConflictError("Expected a boolean value.");
    }
    case "number": {
      const value = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(value)) throw new ConflictError("Expected a finite number.");
      return value;
    }
    case "json": {
      if (typeof raw === "string") {
        try {
          return JSON.parse(raw);
        } catch {
          throw new ConflictError("Expected valid JSON.");
        }
      }
      return raw;
    }
    default: {
      if (typeof raw !== "string") throw new ConflictError("Expected a string value.");
      if (raw.length > 4000) throw new ConflictError("Value too long (max 4000 characters).");
      return raw;
    }
  }
}

/**
 * Base URL for links this app hands to an external service. Derived from
 * CONTROL_PUBLIC_URL when set; otherwise null, in which case the caller must not
 * hand out a link at all.
 */
export function publicBaseUrl(): string {
  return (env.CONTROL_PUBLIC_URL ?? "").replace(/\/$/, "");
}

export class ConflictError extends Error {
  readonly status = 409;
  readonly code = "conflict";
}
export class NotFoundError extends Error {
  readonly status = 404;
  readonly code = "not_found";
}
export class ForbiddenError extends Error {
  readonly status = 403;
  readonly code = "forbidden";
}
export class UpstreamError extends Error {
  readonly status = 502;
  readonly code = "upstream_unavailable";
}

export function httpStatusFor(error: unknown): { status: number; code: string } {
  if (error instanceof PrivacyViolation) return { status: 451, code: "privacy_violation" };
  if (error instanceof ConflictError || error instanceof NotFoundError || error instanceof ForbiddenError || error instanceof UpstreamError) {
    return { status: error.status, code: error.code };
  }
  if (error instanceof z.ZodError) return { status: 400, code: "invalid_input" };
  return { status: 500, code: "internal_error" };
}
