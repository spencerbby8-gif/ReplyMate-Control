import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Unit tests run against pure logic only. Nothing here touches the network and
 * nothing writes to a database — the suites below cover the guardrails that must
 * hold regardless of environment.
 *
 * The env block supplies non-secret local defaults so `src/config/env.ts` can be
 * imported. CONTROL_ENC_KEY here is a test fixture, not a credential.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/app_db",
      CONTROL_ENC_KEY: "vitest-only-fixture-key-not-a-real-secret-0000",
      SESSION_COOKIE_NAME: "rmctl_session",
      AUTH_PROVIDER: "local",
      AIOPS_PROVIDER: "none",
      REPLYMATE_REPO: "spencerbby8-gif/ReplyMate",
    },
  },
});
