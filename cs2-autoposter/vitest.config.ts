import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";
export default defineWorkersConfig(async () => ({
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: ["./tests/setup.ts"],
    poolOptions: {
      workers: {
        isolatedStorage: false,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            ADMIN_TOKEN: "test-admin-token-with-32-characters",
            RUNNER_TOKEN: "test-runner-token-with-32-characters",
            PROVIDER_WEBHOOK_TOKEN: "test-provider-token-with-32-characters",
            TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          },
        },
      },
    },
  },
}));
