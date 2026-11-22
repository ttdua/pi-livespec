// Dependency facts shared by the readiness reads and the change state.

export type DepState = "merged" | "open" | "abandoned";
export type DepFact = { number: number; title: string; state: DepState };
export type ParkedUnit = { unit: string; branch?: string; head?: string; lane: boolean };
