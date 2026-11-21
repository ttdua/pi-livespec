// Who may speak for the change on the forge (design D7): `write` or `admin` permission, read once per author per call.

export const WRITERS = new Set(["write", "admin"]);

/** `permission` once per author; a failed read rejects, so the caller chooses how to fail. */
export function writerLookup(permission: (login: string) => Promise<string>): (author: string) => Promise<boolean> {
	const memo = new Map<string, Promise<boolean>>();
	return (author) => {
		let found = memo.get(author);
		if (found === undefined) {
			found = permission(author).then((p) => WRITERS.has(p));
			memo.set(author, found);
		}
		return found;
	};
}
