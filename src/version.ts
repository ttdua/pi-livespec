import { readFileSync } from "node:fs";

const defaultPackageJson = new URL("../package.json", import.meta.url);

export function readVersion(packageJsonPath: URL | string = defaultPackageJson): string {
	const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
	if (typeof pkg.version !== "string") throw new Error("package.json has no version");
	return pkg.version;
}
