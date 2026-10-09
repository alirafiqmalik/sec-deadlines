import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: {
    bindings: { SUBMISSIONS_ENABLED: "true", TURNSTILE_SITE_KEY: "test-site-key", TURNSTILE_SECRET: "test-turnstile-secret", GITHUB_DISPATCH_TOKEN: "test-dispatch-token", SUBMISSION_SIGNING_KEY: "test-signing-key-for-unit-tests-only" },
  } })],
  test: { fileParallelism: false, include: ["test/**/*.test.js"] },
});
