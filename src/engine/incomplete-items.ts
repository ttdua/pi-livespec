const STARTED_ITEM = /^(.+) is started$/;

/** The text of an `incomplete` item for a started unit; the one owner of the format. */
export function startedItem(unit: string): string {
	return `${unit} is started`;
}

/** Recorded items minus started-unit items whose unit is no longer started; every other item is kept. */
export function reconcileIncomplete(items: readonly string[], started: Readonly<Record<string, unknown>>): string[] {
	return items.filter((item) => {
		const unit = STARTED_ITEM.exec(item)?.[1];
		return unit === undefined || unit in started;
	});
}
