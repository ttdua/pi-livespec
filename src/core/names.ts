const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isKebabName(s: string): boolean {
	return KEBAB.test(s);
}
