/**
 * Runs one maintenance pass and prints what it actually pruned.
 *
 *   npx tsx scripts/run-maintenance.ts [trigger]
 *
 * This is the executable half of the scheduling story: an external cron (system
 * crontab, GitHub Actions schedule, or a platform job) calls this, and the audit
 * log records that it ran. See docs/task-summaries/TASK-007.md for why an
 * in-process interval alone is not claimed to be a scheduler.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

async function main() {
  const maintenance = await import("../src/lib/maintenance/runner");
  const arg = process.argv[2] ?? "manual";
  const allowed = ["manual", "interval", "startup", "api"] as const;
  const trigger = (allowed as readonly string[]).includes(arg)
    ? (arg as (typeof allowed)[number])
    : "manual";
  const report = await maintenance.runMaintenance(trigger);
  console.log(`trigger      : ${report.trigger}`);
  console.log(`ran at       : ${report.ranAt}`);
  console.log(`duration     : ${report.durationMs}ms`);
  console.log(`pruned total : ${maintenance.totalPruned(report)}`);
  for (const [key, value] of Object.entries(report.pruned)) {
    console.log(`  ${key.padEnd(24)} ${value}`);
  }
  if (report.errors.length > 0) {
    console.log(`errors       : ${report.errors.join("; ")}`);
    process.exit(1);
  }
  console.log("errors       : none");
}

main().catch((error) => {
  console.error(`maintenance failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
