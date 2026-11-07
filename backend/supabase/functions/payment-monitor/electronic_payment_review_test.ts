import {
  evidenceDecision,
  submitReviewEvidence,
  type ParsedEvent,
} from './index.ts';

const baseEvent: ParsedEvent = {
  id: 'review-event-before-reference',
  sender: 'VF-Cash',
  receivedAt: '2026-01-01T10:00:00.000Z',
  amount: 100,
  senderPhone: '01000000001',
  senderName: 'Synthetic payer',
  walletNumber: '01017001654',
  reference: null,
  transactionAt: '2026-01-01T09:59:00.000Z',
};

Deno.test('evidence before a user reference remains unlinked and review-only', async () => {
  const documents = new Map<string, Record<string, unknown>>();
  const store = {
    read: async (path: string) => documents.get(path) ?? null,
    commit: async (writes: Array<{
      mode: 'create' | 'update';
      documentPath: string;
      fields: Record<string, Record<string, unknown>>;
    }>) => {
      for (const write of writes) {
        if (documents.has(write.documentPath)) throw new Error('already exists');
        documents.set(write.documentPath, { fields: write.fields });
      }
    },
  };
  const result = await submitReviewEvidence(
    baseEvent,
    'monitor-001',
    'device-001',
    'مراجعة يدوية',
    store,
  );
  if (result.outcome !== 'created' || evidenceDecision(baseEvent) !== 'review') {
    throw new Error('Evidence was not stored as review-only.');
  }
  const fields = (result.document?.fields ?? {}) as Record<string, unknown>;
  if ('linkedOperationId' in fields || 'linkedAttemptId' in fields ||
      [...documents.keys()].some((path) => path.includes('financial'))) {
    throw new Error('Monitor evidence linked or wrote a financial record by itself.');
  }
});

Deno.test('replayed evidence and references remain idempotent without money writes', async () => {
  const documents = new Map<string, Record<string, unknown>>();
  const store = {
    read: async (path: string) => documents.get(path) ?? null,
    commit: async (writes: Array<{
      mode: 'create' | 'update';
      documentPath: string;
      fields: Record<string, Record<string, unknown>>;
    }>) => {
      for (const write of writes) {
        if (documents.has(write.documentPath)) throw new Error('already exists');
        documents.set(write.documentPath, { fields: write.fields });
      }
    },
  };
  const event = { ...baseEvent, id: 'review-event-reference', reference: 'REF-100' };
  const first = await submitReviewEvidence(event, 'monitor-001', 'device-001', 'مراجعة يدوية', store);
  const replay = await submitReviewEvidence(event, 'monitor-001', 'device-001', 'مراجعة يدوية', store);
  const otherEvent = await submitReviewEvidence({ ...event, id: 'review-event-reference-2' }, 'monitor-001', 'device-001', 'مراجعة يدوية', store);
  if (first.outcome !== 'created' || replay.outcome !== 'duplicate_event' ||
      otherEvent.outcome !== 'duplicate_reference' || documents.size !== 2) {
    throw new Error('Evidence replay/reference lock was not stable.');
  }
});
