import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readVersion } from "./version.ts";

export default function extension(pi: ExtensionAPI): void {
	pi.registerCommand("livespec", {
		description: "Show the pi-livespec version",
		handler: async () => {
			pi.sendMessage({
				customType: "livespec-version",
				content: `pi-livespec ${readVersion()}`,
				display: true,
			});
		},
	});
}
