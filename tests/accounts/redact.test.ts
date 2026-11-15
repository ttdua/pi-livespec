import { describe, expect, it } from "vitest";
import { redactTokens } from "../../src/accounts/redact.ts";

describe("redactTokens", () => {
	it("redacts every known token", () => {
		const text = "gh failed with tok-a, then tok-b (tok-a again); regex chars a.b*c too";

		expect(redactTokens(text, ["tok-a", "", "tok-b", "a.b*c"])).toBe("gh failed with ***, then *** (*** again); regex chars *** too");
	});

	it("a token that contains another is redacted whole", () => {
		expect(redactTokens("secret tok-abc", ["tok", "tok-abc"])).toBe("secret ***");
	});

	it("empty token list leaves text unchanged", () => {
		expect(redactTokens("nothing secret here", [])).toBe("nothing secret here");
		expect(redactTokens("nothing secret here", [""])).toBe("nothing secret here");
	});
});
