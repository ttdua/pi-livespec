export type Result = {
	code: string;
	severity: "error" | "warning";
	file?: string;
	section?: string;
	line?: number;
	message: string;
};
