import {
  evidenceDecision,
  evidenceDocumentId,
  hasExactlyOneActiveApprovedDevice,
  manualReviewMessage,
  redactedEvidenceFields,
  submitReviewEvidence,
  type ParsedEvent,
} from './index.ts';

const exactLookingEvent: ParsedEvent = {
  id: 'rt-sms-event-001',
  sender: 'VF-Cash',
  receivedAt: '2026-01-01T10:00:00.000Z',
  amount: 8,
  senderPhone: '01000000001',
  senderName: 'Synthetic Payer',
  walletNumber: '01000000002',
  reference: 'rt-reference-0001',
  transactionAt: '2026-01-01T09:59:00.000Z',
};

Deno.test('an exact-looking synthetic SMS remains manual review evidence', () => {
  if (evidenceDecision(exactLookingEvent) !== 'review') {
    throw new Error('SMS evidence must not authorize a payment.');
  }
});

Deno.test('duplicate evidence message does not claim a financial effect', () => {
  const message = manualReviewMessage();
  if (!message.includes('يدوية') || !message.includes('لا يتم اعتماد')) {
    throw new Error('The response must communicate manual review only.');
  }
});

Deno.test('stored evidence omits raw phone and sender name', () => {
  const fields = redactedEvidenceFields(
    exactLookingEvent,
    'rt-monitor-approved-001',
    'rt-monitor-device-001',
    manualReviewMessage(),
    new Date('2026-01-01T10:00:01.000Z'),
  );
  const names = Object.keys(fields);
  if (names.includes('senderName') || names.includes('senderPhone') ||
      names.includes('walletNumber')) {
    throw new Error('Full payer details must not be stored.');
  }
  if (fields.rawMessageRetained?.booleanValue !== false ||
      fields.decision?.stringValue !== 'review') {
    throw new Error('Evidence must be redacted and manual-review only.');
  }
});

Deno.test('event identity is stable across retries and isolated by device', async () => {
  const original = await evidenceDocumentId(
    'rt-monitor-approved-001',
    'rt-monitor-device-001',
    'rt-sms-event-001',
  );
  const retry = await evidenceDocumentId(
    'rt-monitor-approved-001',
    'rt-monitor-device-001',
    'rt-sms-event-001',
  );
  const anotherDevice = await evidenceDocumentId(
    'rt-monitor-approved-001',
    'rt-monitor-device-002',
    'rt-sms-event-001',
  );
  if (original !== retry || original === anotherDevice) {
    throw new Error('Event idempotency identity is not stable and scoped.');
  }
});

Deno.test('pending, rejected, and revoked monitor devices cannot submit evidence', () => {
  for (const status of ['pending', 'rejected', 'revoked']) {
    if (hasExactlyOneActiveApprovedDevice([
      { id: 'rt-monitor-device-001', status },
    ], 'rt-monitor-device-001')) {
      throw new Error(`A ${status} device was accepted.`);
    }
  }
});

Deno.test('monitor evidence replay and reference reuse have no financial writes', async () => {
  const documents = new Map<string, Record<string, unknown>>();
  const store = {
    read: async (path: string) => documents.get(path) ?? null,
    commit: async (writes: Array<{
      mode: 'create' | 'update';
      documentPath: string;
      fields: Record<string, Record<string, unknown>>;
    }>) => {
      if (writes.some((write) => documents.has(write.documentPath))) {
        throw new Error('already exists');
      }
      for (const write of writes) {
        documents.set(write.documentPath, {
          name: write.documentPath,
          fields: write.fields,
        });
      }
    },
  };
  const first = await submitReviewEvidence(
    exactLookingEvent,
    'rt-monitor-approved-001',
    'rt-monitor-device-001',
    manualReviewMessage(),
    store,
  );
  const replay = await submitReviewEvidence(
    exactLookingEvent,
    'rt-monitor-approved-001',
    'rt-monitor-device-001',
    manualReviewMessage(),
    store,
  );
  const repeatedReference = await submitReviewEvidence(
    { ...exactLookingEvent, id: 'rt-sms-event-002' },
    'rt-monitor-approved-001',
    'rt-monitor-device-001',
    manualReviewMessage(),
    store,
  );
  if (first.outcome !== 'created' || replay.outcome !== 'duplicate_event' ||
      repeatedReference.outcome !== 'duplicate_reference') {
    throw new Error('Replay or duplicate reference handling failed.');
  }
  if ([...documents.keys()].some((path) =>
    !path.startsWith('paymentMonitorEvents/') &&
    !path.startsWith('paymentMonitorReferenceLocks/'))) {
    throw new Error('SMS evidence attempted a financial document write.');
  }
  if (documents.size !== 2) throw new Error('Replay created an extra evidence record.');
});
