export const evidenceFixture = {
  monitorUid: "review-monitor-001",
  deviceId: "review-device-001",
  eventId: "review-event-001",
  reference: "REF-001",
  amount: 100,
  walletNumber: "01000000002",
};

export function parsedEvidence(overrides: Record<string, unknown> = {}) {
  return {
    id: evidenceFixture.eventId,
    sender: "VF-Cash",
    receivedAt: "2026-01-01T10:00:00.000Z",
    amount: evidenceFixture.amount,
    senderPhone: "01000000001",
    senderName: "Synthetic Payer",
    walletNumber: evidenceFixture.walletNumber,
    reference: evidenceFixture.reference,
    transactionAt: "2026-01-01T09:59:00.000Z",
    ...overrides,
  };
}
