import type { ChangeState } from "./state-types.ts";

const STARTED_ITEM = /^(.+) is started$/;

/** The text of an `incomplete` item for a started unit; the one owner of the format. */
export function startedItem(unit: string): string {
	return `${unit} is started`;
}

/** Recorded items minus started-unit items whose unit is no longer started; every other item is kept. */
export function reconcileIncomplete(items: readonly string[], started: Readonly<Record<string, unknown>>): string[] {
	return items.filter((item) => {
		const unit = STARTED_ITEM.exec(item)?.[1];
		return unit === undefined || Object.hasOwn(started, unit);
	});
}

/** The `Incomplete` line title: labelled when the state it was read from may be out of date. */
export function incompleteTitle(state: Pick<ChangeState, "stale" | "readOnly">): string {
	return state.stale || state.readOnly ? "Incomplete (may be stale)" : "Incomplete";
}
