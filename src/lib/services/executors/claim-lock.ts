/**
 * Shared claim/lock conventions for work items processed by the workerless pipeline
 * (EmailDelivery, EmailCampaignRecipient, EmailEvent, BackgroundJob).
 *
 * - A claim is a conditional updateMany that sets status=PROCESSING and lockedBy=<token>.
 * - A lock older than STALE_LOCK_MS is considered abandoned and may be reclaimed.
 * - Immediately before an external provider send, the owner rewrites lockedBy to
 *   `<token>${SEND_IN_FLIGHT_SUFFIX}`. A row that is found stale while carrying this marker
 *   may already have been accepted by the provider, so it must NOT be re-sent automatically;
 *   reconciliation moves it to FAILED with SEND_OUTCOME_UNKNOWN instead.
 */

export const STALE_LOCK_MS = 10 * 60 * 1000;

export const SEND_IN_FLIGHT_SUFFIX = ":sending";

export const SEND_OUTCOME_UNKNOWN = "SEND_OUTCOME_UNKNOWN";

export const MAX_EVENT_ATTEMPTS = 5;

export function staleLockCutoff(now = Date.now()): Date {
  return new Date(now - STALE_LOCK_MS);
}

export function newClaimToken(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function sendInFlightToken(claimToken: string): string {
  return `${claimToken}${SEND_IN_FLIGHT_SUFFIX}`;
}

export function isSendInFlight(lockedBy: string | null | undefined): boolean {
  return Boolean(lockedBy && lockedBy.endsWith(SEND_IN_FLIGHT_SUFFIX));
}

/**
 * Prisma filter matching rows whose lock is NOT an in-flight send marker.
 * (NOT LIKE alone excludes NULL in SQL, so NULL is matched explicitly.)
 */
export const notSendInFlight = {
  OR: [{ lockedBy: null }, { NOT: { lockedBy: { endsWith: SEND_IN_FLIGHT_SUFFIX } } }],
};
