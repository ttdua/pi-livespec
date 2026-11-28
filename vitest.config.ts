import { defineConfig } from "vitest/config";

export default defineConfig({
	// Git and e2e tests spawn real processes; at load average 100+ a 7 s test can take over 30 s (#76).
	test: { include: ["tests/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 120_000 },
});
