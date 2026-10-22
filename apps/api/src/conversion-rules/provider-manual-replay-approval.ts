/**
 * Operator approval written by the orchestrator on a provider-automation
 * execution when a manager manually reprocesses a callback received before
 * the rule/channel production activation (normalizedResult.manualReplayApproval).
 *
 * Shared by materialization (provider-conversion-production) and the send-time
 * CTWA context check (conversion-events) so both read the same approval the
 * same way. Only the activation-time gate may be relaxed by it; every other
 * gate (certification, scope, canonical channel, destination) stays in force.
 */
export function providerAutomationManualReplayApproved(
  normalizedResult: unknown,
): boolean {
  const normalized = jsonObject(normalizedResult);
  const approval = jsonObject(normalized?.manualReplayApproval);
  const approvedAt = approval?.approvedAt ?? approval?.attemptedAt;

  return Boolean(
    approval?.approved === true &&
    identifier(approval.actorUserId) &&
    typeof approvedAt === "string",
  );
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    !value.includes("\0")
  );
}
