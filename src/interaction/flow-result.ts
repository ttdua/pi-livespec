// Result types shared by the in-session flows and the dialog.

import type { Answered } from "./approver.ts";

/** Returned when the human cancels any dialog; the request turns into `dismissed`. */
export const CANCELLED = Symbol("cancelled");
export type Cancelled = typeof CANCELLED;

/** The answer fields a flow decides; `by`, `at` and `adapter` are added by the adapter. */
export type Verdict = Omit<Answered, "status" | "by" | "at" | "adapter">;
