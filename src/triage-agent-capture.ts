export const TRIAGE_AGENT_CAPTURE_CONTEXT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["triggerId", "attempt"],
  properties: {
    triggerId: {
      type: "string",
      pattern: "^triage-[0-9]+-[0-9a-fA-F-]{36}$",
      description: "The exact Trigger ID supplied for this targeted Agent run.",
    },
    attempt: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description: "The exact dispatch attempt supplied for this Agent run.",
    },
  },
} as const;

const TRIGGER_ID_PATTERN = /^triage-\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TriageAgentCaptureContext {
  triggerId: string;
  attempt: number;
}

export interface TriageAgentMcpCapture {
  captureId: string;
  triggerId: string;
  attempt: number;
  mcpRequestId?: string | number;
  toolName: string;
  startedAt: string;
  completedAt: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}

export function parseTriageAgentCaptureContext(value: unknown): TriageAgentCaptureContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => key !== "triggerId" && key !== "attempt")) return undefined;
  if (typeof candidate.triggerId !== "string" || !TRIGGER_ID_PATTERN.test(candidate.triggerId)) return undefined;
  if (!Number.isInteger(candidate.attempt) || Number(candidate.attempt) < 1 || Number(candidate.attempt) > 100) return undefined;
  return { triggerId: candidate.triggerId, attempt: Number(candidate.attempt) };
}

export function stripTriageAgentCaptureContext(args: Record<string, unknown>): Record<string, unknown> {
  const { triageCapture: _triageCapture, ...toolArgs } = args;
  return toolArgs;
}
