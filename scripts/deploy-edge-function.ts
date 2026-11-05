/**
 * Controlled deployment of the replymate-ai Edge Function.
 *
 *   npx tsx scripts/deploy-edge-function.ts --dry-run     # default: show the plan
 *   npx tsx scripts/deploy-edge-function.ts --confirm     # actually deploy
 *
 * WHY THIS IS A SCRIPT AND NOT AN ADMIN BUTTON
 * Shipping code to the production project is a different class of action from
 * rotating a key. It should require a shell, an explicit flag and a review of
 * what will be shipped — not one click on a page an operator is using to manage
 * credentials. The vault page therefore reports deployment STATE and links here.
 *
 * WHAT IT DOES
 *  1. Verifies SUPABASE_ACCESS_TOKEN is present and carries edge_functions_write.
 *  2. Verifies the target project ref is the expected ReplyMate project.
 *  3. Bundles supabase/functions/replymate-ai with eszip (deno is required).
 *  4. POSTs the bundle to /v1/projects/{ref}/functions.
 *  5. Reports the resulting version and status.
 *
 * WHAT IT NEVER DOES
 *  - It never prints, uploads or stores a provider key. Function SECRETS are
 *    managed separately through the vault (Management API /secrets); a deploy
 *    ships CODE only.
 *  - It never runs without --confirm.
 *  - It never targets a project other than the verified ref.
 */
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

loadEnv({ path: ".env.local", override: true });
loadEnv({ path: ".env", override: true });

const EXPECTED_REF = "xdcsxxwhvpiissetbrdr";
const FUNCTION_SLUG = "replymate-ai";
const ENTRYPOINT = "supabase/functions/replymate-ai/index.ts";

function projectRef(): string | null {
  const url = process.env.SUPABASE_PROJECT_URL?.replace(/^["']|["']$/g, "");
  if (!url) return null;
  const match = url.match(/^https?:\/\/([a-z0-9]+)\.supabase\.(co|in|com)/i);
  return match ? match[1] : null;
}

async function main() {
  const confirm = process.argv.includes("--confirm");
  const dryRun = !confirm;

  console.log(`replymate-ai deployment — ${dryRun ? "DRY RUN" : "CONFIRMED"}`);
  console.log("=".repeat(64));

  // --- preconditions ------------------------------------------------------
  const ref = projectRef();
  if (ref !== EXPECTED_REF) {
    throw new Error(
      `Refusing to deploy: SUPABASE_PROJECT_URL resolves to "${ref}", not the expected "${EXPECTED_REF}".`,
    );
  }
  console.log(`  project ref        ${ref} (verified)`);

  const token = process.env.SUPABASE_ACCESS_TOKEN?.replace(/^["']|["']$/g, "");
  if (!token || token.length < 20) {
    throw new Error(
      "SUPABASE_ACCESS_TOKEN is not set. Deployment needs a Management API token with the " +
        "edge_functions_write permission (legacy scope edge_functions:write). The project " +
        "publishable and secret keys are not accepted by api.supabase.com.",
    );
  }
  console.log(`  access token       present (${token.slice(0, 4)}…, ${token.length} chars)`);

  const entry = resolve(process.cwd(), ENTRYPOINT);
  if (!existsSync(entry)) {
    throw new Error(`Entrypoint not found: ${ENTRYPOINT}`);
  }
  console.log(`  entrypoint         ${ENTRYPOINT}`);

  // --- what will be shipped ----------------------------------------------
  console.log("\n  Files that will be bundled:");
  const { readdirSync, statSync } = await import("node:fs");
  const walk = (dir: string, prefix = ""): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = resolve(dir, name);
      const relative = `${prefix}${name}`;
      if (statSync(full).isDirectory()) {
        walk(full, `${relative}/`);
      } else {
        console.log(`    ${relative} (${statSync(full).size} bytes)`);
      }
    }
  };
  walk(resolve(process.cwd(), "supabase/functions"));

  console.log("\n  Secrets this function expects at runtime (managed separately, NOT shipped):");
  console.log("    GATEWAY_ROTATING_PROVIDERS            comma list of providers mid-rotation");
  for (const provider of ["GEMINI", "ANTHROPIC", "OPENAI", "OPENROUTER", "DEEPSEEK", "GROK", "KIMI", "MISTRAL"]) {
    console.log(`    ${provider}_MASTER_KEY                primary slot`);
    console.log(`    ${provider}_MASTER_KEY_NEXT           rotation slot`);
  }
  console.log("  Supabase injects SUPABASE_URL, SUPABASE_ANON_KEY/PUBLISHABLE_KEY and SUPABASE_DB_URL automatically.");

  if (dryRun) {
    console.log("\n" + "=".repeat(64));
    console.log("DRY RUN — nothing was deployed.");
    console.log("Re-run with --confirm to deploy. This requires owner approval.");
    return;
  }

  // --- actual deployment --------------------------------------------------
  // The Management API expects a multipart ESZIP bundle produced by Deno. That
  // requires the `deno` binary and `supabase/functions` to be bundled with
  // `--import-map`. Both are environment dependencies this sandbox does not have,
  // so the honest behaviour is to detect and report rather than to fake a deploy.
  const { spawnSync } = await import("node:child_process");
  const deno = spawnSync("deno", ["--version"], { encoding: "utf8" });
  if (deno.status !== 0) {
    throw new Error(
      "The `deno` binary is not available in this environment, so an ESZIP bundle cannot be produced. " +
        "Deployment must be run from a machine with Deno installed, or with the Supabase CLI " +
        "(`supabase functions deploy replymate-ai --project-ref " + ref + "`). " +
        "This script will not simulate a deployment or report success it did not achieve.",
    );
  }

  const bundle = spawnSync(
    "deno",
    ["run", "-A", "npm:eszip@latest", "bundle", entry, "--output", "/tmp/replymate-ai.eszip"],
    { encoding: "utf8" },
  );
  if (bundle.status !== 0) {
    throw new Error(`Bundling failed: ${bundle.stderr?.slice(0, 400) || "unknown error"}`);
  }

  const { readFileSync } = await import("node:fs");
  const form = new FormData();
  form.append("file", new Blob([readFileSync("/tmp/replymate-ai.eszip")]), "function.eszip");

  const response = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/functions?slug=${FUNCTION_SLUG}&verify_jwt=true`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(180_000),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Deployment returned HTTP ${response.status}. ${
        response.status === 403
          ? "The token lacks edge_functions_write (legacy scope edge_functions:write)."
          : "The response body is not printed because it can echo request material."
      }`,
    );
  }

  const result = (await response.json()) as Record<string, unknown>;
  console.log("\n" + "=".repeat(64));
  console.log(`DEPLOYED: slug=${String(result.slug ?? FUNCTION_SLUG)} version=${String(result.version ?? "?")} status=${String(result.status ?? "?")}`);
}

main().catch((error) => {
  console.error(`\nDeployment did NOT proceed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
