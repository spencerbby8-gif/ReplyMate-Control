/**
 * First-owner bootstrap + reference-catalogue seed.
 *
 * Run ONCE on the server:  npx tsx scripts/bootstrap.ts
 *
 * It reads BOOTSTRAP_OWNER_EMAIL / BOOTSTRAP_OWNER_PASSWORD from the
 * environment and creates the initial owner account. Credentials are never
 * accepted over HTTP, never printed, and never written to a file.
 *
 * It also upserts the domain catalogue (providers, plans, configuration keys,
 * feature flags) from src/config/catalog.ts and src/lib/seed/reference.ts —
 * transcribed from the ReplyMate Android repository, so this is reference
 * configuration, not sample data.
 *
 * IMPORTANT: this script only ever touches the CONTROL-PLANE database in
 * DATABASE_URL. It never connects to the ReplyMate production Supabase project
 * and never applies a migration there.
 */
import { config as loadEnv } from "dotenv";

// Next.js precedence: .env.local overrides .env. dotenv does not overwrite a
// variable that is already set, so the more specific file is loaded first.
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

async function main() {
  // Dynamic imports: every module below validates the environment at import
  // time, and static imports would be hoisted above the loadEnv() calls.
  const { db } = await import("../src/db");
  const { eq } = await import("drizzle-orm");
  const { ctlAdmin, ctlAiProvider } = await import("../src/db/schema");
  const { PROVIDER_CATALOGUE } = await import("../src/config/catalog");
  const { hashPassword } = await import("../src/lib/auth/crypto");
  const { seedConfiguration, seedFeatureFlags, seedPlans } = await import("../src/lib/seed/reference");

  const email = process.env.BOOTSTRAP_OWNER_EMAIL?.toLowerCase().trim().replace(/^"|"$/g, "");
  const password = process.env.BOOTSTRAP_OWNER_PASSWORD?.replace(/^"|"$/g, "");

  // 1. Owner account -------------------------------------------------------
  if (!email || !password) {
    console.log(
      "[bootstrap] BOOTSTRAP_OWNER_EMAIL / BOOTSTRAP_OWNER_PASSWORD not set — skipping owner creation.",
    );
  } else if (password.length < 12) {
    throw new Error("[bootstrap] BOOTSTRAP_OWNER_PASSWORD must be at least 12 characters.");
  } else {
    const [found] = await db.select({ id: ctlAdmin.id }).from(ctlAdmin).where(eq(ctlAdmin.email, email));
    if (found) {
      console.log(`[bootstrap] Owner ${email} already exists — left untouched.`);
    } else {
      await db.insert(ctlAdmin).values({
        email,
        displayName: "Owner",
        role: "owner",
        status: "active",
        passwordHash: await hashPassword(password),
        // mfaRequired stays false so the first sign-in succeeds; the console
        // banner and /security both push TOTP enrolment immediately afterwards.
        mfaRequired: false,
      });
      console.log(`[bootstrap] Created owner account for ${email}. Enrol TOTP MFA from Security.`);
    }
  }

  // 2. Provider catalogue --------------------------------------------------
  for (const provider of PROVIDER_CATALOGUE) {
    await db
      .insert(ctlAiProvider)
      .values({
        key: provider.key,
        displayName: provider.displayName,
        dialect: provider.dialects.join(" + "),
        defaultBaseUrl: provider.defaultBaseUrl || null,
        status: provider.needsKey ? "unconfigured" : "available",
        searchSupport: provider.searchSupport,
        reasoningSupport: provider.reasoningSupport,
        byokOnly: true,
        minAppVersion: null,
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
  }
  console.log(`[bootstrap] Upserted ${PROVIDER_CATALOGUE.length} provider catalogue rows.`);

  // 3. Reference configuration, flags and plans ---------------------------
  const flagCount = await seedFeatureFlags();
  const configCount = await seedConfiguration();
  const planCount = await seedPlans();
  console.log(
    `[bootstrap] Seeded ${configCount} config keys, ${flagCount} flags, ${planCount} plans.`,
  );

  console.log("[bootstrap] Done. No migration was applied to the ReplyMate production database.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`[bootstrap] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
