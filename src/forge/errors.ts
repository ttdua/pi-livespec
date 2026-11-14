export type ForgeErrorCode = "unreachable" | "auth" | "http" | "readonly" | "unsupported";

export interface ForgeErrorInit {
	code: ForgeErrorCode;
	operation: string;
	message: string;
	status?: number;
}

/** Thrown for transport, auth and HTTP failures. Conflicts are not errors; see WriteResult. */
export class ForgeError extends Error {
	readonly code: ForgeErrorCode;
	readonly operation: string;
	readonly status?: number;

	constructor(init: ForgeErrorInit) {
		super(init.message);
		this.name = "ForgeError";
		this.code = init.code;
		this.operation = init.operation;
		this.status = init.status;
	}
}
