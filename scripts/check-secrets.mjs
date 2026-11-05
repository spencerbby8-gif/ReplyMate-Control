#!/usr/bin/env node
/**
 * Pre-commit secret scanner.
 *
 * Usage:  node scripts/check-secrets.mjs [--staged|--all]
 *
 * Scans tracked file contents for credential-shaped strings and exits non-zero
 * on any hit. The GitHub PAT and the Supabase service-role key must never reach
 * a commit, a log line or a bundle.
 *
 * This script intentionally prints the FILE and LINE of a finding plus the rule
 * name — never the matched secret itself.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const RULES = [
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: "openai-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "supabase-service-role", pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: "connection-string-with-password", pattern: /\bpostgres(?:ql)?:\/\/[^:\s/]+:[^@\s]+@[^\s]+/g },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "private-key-block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: "bearer-literal", pattern: /\bBearer\s+[A-Za-z0-9._-]{24,}\b/g },
];

/**
 * Files that legitimately discuss or synthesise credential-shaped strings
 * without containing a real credential.
 *
 * `tests/audit-redaction.test.ts` is listed because its fixtures MUST look like
 * real secrets — that is the entire point of the suite: it proves the redactor
 * catches GitHub, OpenAI, Google, Slack, JWT and connection-string shapes. Every
 * value there is a synthetic `FIXTURE…NOTREAL` placeholder. If a real credential
 * ever lands in that file, this allowlist is what would hide it, so any change to
 * it must be reviewed.
 */
const ALLOWLIST = new Set([
  "scripts/check-secrets.mjs",
  "tests/audit-redaction.test.ts",
  ".env.example",
  "docs/PRIVACY.md",
  "docs/SECURITY.md",
  "README.md",
]);

/** Placeholder values that must not trip the scanner. */
const PLACEHOLDERS = [
  "postgresql://postgres:postgres@127.0.0.1:5432/app_db",
  "postgresql://user:password@host:5432/db",
];

function listFiles(mode) {
  if (mode === "--staged") {
    const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACM"], {
      encoding: "utf8",
    });
    return out.split("\n").map((line) => line.trim()).filter(Boolean);
  }
  const out = execFileSync("git", ["ls-files"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\n").map((line) => line.trim()).filter(Boolean);
}

function main() {
  const mode = process.argv[2] ?? "--all";
  const files = listFiles(mode);
  const findings = [];

  for (const file of files) {
    if (ALLOWLIST.has(file)) continue;
    if (/\.(png|jpg|jpeg|gif|webp|ico|apk|zip|gz|woff2?|ttf|pdf)$/i.test(file)) continue;

    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue; // deleted or unreadable — nothing to scan
    }

    const lines = content.split("\n");
    lines.forEach((line, index) => {
      if (PLACEHOLDERS.some((placeholder) => line.includes(placeholder))) return;
      for (const rule of RULES) {
        rule.pattern.lastIndex = 0;
        if (rule.pattern.test(line)) {
          findings.push({ file, line: index + 1, rule: rule.name });
        }
      }
    });
  }

  if (findings.length === 0) {
    console.log(`[check-secrets] scanned ${files.length} file(s) — no credentials found.`);
    return;
  }

  console.error(`[check-secrets] ${findings.length} finding(s):`);
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}  rule=${finding.rule}`);
  }
  console.error(
    "\nRefusing to proceed. Remove the credential, move it to the environment, rotate it, and re-run.",
  );
  process.exit(1);
}

main();
