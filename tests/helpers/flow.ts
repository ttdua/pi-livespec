/** A project pack that keeps a human plan gate: for tests about the human gate itself, not its escalation. */
export const HUMAN_PLAN_FLOW_YAML = "extends: agent-skills\nphases:\n  - id: plan\n    gate: human\n";

/** `HUMAN_PLAN_FLOW_YAML` as harness `files`. */
export const HUMAN_PLAN_FLOW: Record<string, string> = { ".pi/livespec/flow.yaml": HUMAN_PLAN_FLOW_YAML };
