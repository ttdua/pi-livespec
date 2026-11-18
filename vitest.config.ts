import { defineConfig } from "vitest/config";

export default defineConfig({
	// Git and e2e tests spawn real processes; the 5 s default is flaky on a loaded machine.
	test: { include: ["tests/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 30_000 },
});
