import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        // tests use the mock AI and mock transcripts, so never open a remote session
        remoteBindings: false,
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, DEV_AUTH: "1", AI_MOCK: "1", TRANSCRIPT_MOCK: "1", GOOGLE_CLIENT_ID: "test-client", LIMIT_AI_CALLS_PER_DAY: "40" },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"], include: ["test/**/*.test.ts"] },
  };
});
