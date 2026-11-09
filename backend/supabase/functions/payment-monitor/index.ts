import {
  boolValue,
  commitFirestoreWrites,
  documentFields,
  findFirestoreDocuments,
  nullValue,
  numberField,
  numberValue,
  patchFirestoreDocument,
  readFirestoreDocument,
  stringField,
  stringValue,
  type FirestoreCommitWrite,
  type FirebaseIdentity,
  verifyFirebaseIdToken,
  writeFirestoreDocument,
} from '../_shared/firebase.ts';
import { getBearerToken } from '../_shared/http.ts';

const MONITOR_EMAIL = 'payment-monitor@albab.delivery';
const WALLET_NUMBER = '01017001654';
const MAX_EVENT_ID_LENGTH = 128;

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function normalizeDigits(value: string): string {
  return value
    .replaceAll('٠', '0')
    .replaceAll('١', '1')
    .replaceAll('٢', '2')
    .replaceAll('٣', '3')
    .replaceAll('٤', '4')
    .replaceAll('٥', '5')
    .replaceAll('٦', '6')
    .replaceAll('٧', '7')
    .replaceAll('٨', '8')
    .replaceAll('٩', '9');
}

function normalizePhone(value: string | null): string {
  if (!value) return '';
  let normalized = normalizeDigits(value).replaceAll(/\D/g, '');
  if (normalized.startsWith('0020')) normalized = normalized.slice(4);
  if (normalized.startsWith('20') && normalized.length === 12) {
    normalized = normalized.slice(2);
  }
  if (normalized.length === 10 && normalized.startsWith('1')) {
    normalized = `0${normalized}`;
  }
  return normalized;
}

function validEventId(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_EVENT_ID_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value);
}

export type ParsedEvent = {
  id: string;
  sender: string;
  receivedAt: string;
  amount: number | null;
  senderPhone: string | null;
  senderName: string | null;
  walletNumber: string | null;
  reference: string | null;
  transactionAt: string | null;
};

function parseEvent(value: unknown): ParsedEvent | null {
  if (value == null || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  if (!validEventId(event.id)) return null;
  if (typeof event.sender !== 'string' || event.sender.trim().length === 0 ||
      event.sender.length > 48 || typeof event.receivedAt !== 'string' ||
      event.receivedAt.length > 64 || !Number.isFinite(Date.parse(event.receivedAt))) {
    return null;
  }
  const amount = typeof event.amount === 'number'
    ? event.amount
    : typeof event.amount === 'string'
    ? Number(event.amount)
    : null;
  return {
    id: event.id,
    sender: event.sender,
    receivedAt: event.receivedAt,
    amount: amount != null && Number.isFinite(amount) ? amount : null,
    senderPhone: typeof event.senderPhone === 'string' ? event.senderPhone : null,
    senderName: typeof event.senderName === 'string' ? event.senderName : null,
    walletNumber: typeof event.walletNumber === 'string' ? event.walletNumber : null,
    reference: typeof event.reference === 'string' &&
        event.reference.trim().length > 0 && event.reference.length <= 128 &&
        /^[A-Za-z0-9._-]+$/.test(event.reference.trim())
      ? event.reference.trim()
      : null,
    transactionAt: typeof event.transactionAt === 'string'
      ? event.transactionAt
      : null,
  };
}

type MonitorAuthenticationResult =
  | { ok: true; identity: FirebaseIdentity }
  | { ok: false; response: Response };

async function authenticatedMonitor(
  request: Request,
): Promise<MonitorAuthenticationResult> {
  const token = getBearerToken(request);
  if (!token) {
    return { ok: false, response: jsonResponse({ message: 'سجّل الدخول أولًا.' }, 401) };
  }
  const identity = await verifyFirebaseIdToken(token);
  if (!identity) {
    return { ok: false, response: jsonResponse({ message: 'جلسة الدخول غير صالحة.' }, 401) };
  }
  if (identity.email?.toLowerCase() !== MONITOR_EMAIL) {
    return { ok: false, response: jsonResponse({ message: 'هذا الحساب ليس حساب مراقبة الدفع.' }, 403) };
  }
  return { ok: true, identity };
}

type DeviceAccess = 'pending' | 'approved' | 'rejected' | 'revoked';

function deviceAccessMessage(access: DeviceAccess): string {
  switch (access) {
    case 'approved':
      return 'تمت الموافقة على الجهاز.';
    case 'rejected':
      return 'تم رفض طلب ربط الجهاز من مسؤول النظام.';
    case 'revoked':
      return 'تم إلغاء ربط هذا الجهاز من مسؤول النظام.';
    default:
      return 'تم إرسال طلب ربط الجهاز إلى مسؤول النظام. انتظر الموافقة قبل بدء المراقبة.';
  }
}

function boundedText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

async function resolveDeviceAccess(
  uid: string,
  deviceId: string,
  walletNumber: string,
  options: {
    createPending: boolean;
    deviceName?: string;
    androidVersion?: string;
    appVersion?: string;
  },
): Promise<{ access: DeviceAccess; message: string } | Response> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(deviceId)) {
    return jsonResponse({ message: 'معرّف الجهاز غير صالح.' }, 400);
  }
  if (normalizePhone(walletNumber) !== WALLET_NUMBER) {
    return jsonResponse({ message: 'رقم المحفظة غير مطابق لإعدادات المراقبة.' }, 400);
  }

  const devicePath = `paymentMonitorDevices/${deviceId}`;
  const registeredDevice = await readFirestoreDocument(devicePath);
  if (registeredDevice != null) {
    const registeredFields = documentFields(registeredDevice);
    if (stringField(registeredFields, 'uid') !== uid) {
      return jsonResponse({ message: 'الجهاز مرتبط بحساب مراقبة آخر.' }, 403);
    }
    const access = stringField(registeredFields, 'status') as DeviceAccess | null;
    if (access === 'approved' || access === 'rejected' || access === 'revoked') {
      return { access, message: deviceAccessMessage(access) };
    }
    return { access: 'pending', message: deviceAccessMessage('pending') };
  }

  if (!options.createPending) {
    return { access: 'pending', message: deviceAccessMessage('pending') };
  }

  const now = new Date().toISOString();
  await writeFirestoreDocument(devicePath, {
    uid: stringValue(uid),
    deviceId: stringValue(deviceId),
    status: stringValue('pending'),
    deviceName: stringValue(options.deviceName ?? ''),
    androidVersion: stringValue(options.androidVersion ?? ''),
    appVersion: stringValue(options.appVersion ?? ''),
    createdAt: stringValue(now),
    lastSeenAt: stringValue(now),
    updatedAt: stringValue(now),
  });
  return { access: 'pending', message: deviceAccessMessage('pending') };
}

async function ensureDevice(
  uid: string,
  deviceId: string,
  walletNumber: string,
): Promise<Response | null> {
  const access = await resolveDeviceAccess(uid, deviceId, walletNumber, {
    createPending: false,
  });
  if (access instanceof Response) return access;
  if (access.access !== 'approved') {
    return jsonResponse({ message: access.message }, 403);
  }

  const current = await readFirestoreDocument(`paymentMonitors/${uid}`);
  if (current == null) {
    return jsonResponse({ message: 'لم يتم تفعيل الجهاز بعد.' }, 403);
  }
  const fields = documentFields(current);
  if (stringField(fields, 'role') !== 'paymentVerifier' ||
      boolFieldOrDefault(fields, 'enabled', true) !== true) {
    return jsonResponse({ message: 'حساب المراقبة غير مفعّل.' }, 403);
  }
  if (stringField(fields, 'deviceId') !== deviceId) {
    return jsonResponse({
      message: 'تم اعتماد جهاز آخر لهذا الحساب. اطلب تفعيل هذا الجهاز من مسؤول النظام.',
    }, 409);
  }
  const registeredDevices = await findFirestoreDocuments(
    'paymentMonitorDevices',
    'uid',
    stringValue(uid),
  );
  const deviceStates = registeredDevices.map((document) => ({
    id: typeof document.name === 'string'
      ? document.name.split('/').pop() ?? ''
      : '',
    status: stringField(documentFields(document), 'status') ?? '',
  }));
  if (!hasExactlyOneActiveApprovedDevice(deviceStates, deviceId)) {
    return jsonResponse({
      message: 'يجب وجود جهاز واحد معتمد ونشط فقط قبل إرسال دليل التحويل.',
    }, 403);
  }
  return null;
}

async function activateDevice(
  uid: string,
  deviceId: string,
  walletNumber: string,
): Promise<Response> {
  if (normalizePhone(walletNumber) !== WALLET_NUMBER) {
    return jsonResponse({ message: 'رقم المحفظة غير مطابق لإعدادات المراقبة.' }, 400);
  }
  const devicePath = `paymentMonitorDevices/${deviceId}`;
  const device = await readFirestoreDocument(devicePath);
  if (device == null) {
    return jsonResponse({ message: 'لم يتم العثور على طلب الجهاز.' }, 404);
  }
  const deviceFields = documentFields(device);
  if (stringField(deviceFields, 'uid') !== uid) {
    return jsonResponse({ message: 'الجهاز مرتبط بحساب مراقبة آخر.' }, 403);
  }
  if (stringField(deviceFields, 'status') !== 'approved') {
    return jsonResponse({
      message: deviceAccessMessage(
        (stringField(deviceFields, 'status') as DeviceAccess | null) ?? 'pending',
      ),
    }, 409);
  }

  const now = new Date().toISOString();
  const monitorPath = `paymentMonitors/${uid}`;
  const current = await readFirestoreDocument(monitorPath);
  if (current != null) {
    const currentFields = documentFields(current);
    const previousDeviceId = stringField(currentFields, 'deviceId');
    if (previousDeviceId != null && previousDeviceId !== deviceId) {
      const previousPath = `paymentMonitorDevices/${previousDeviceId}`;
      const previous = await readFirestoreDocument(previousPath);
      if (previous != null && previous.updateTime) {
        await patchFirestoreDocument(previousPath, {
          status: stringValue('revoked'),
          updatedAt: stringValue(now),
          revokedAt: stringValue(now),
          revokedBy: stringValue('system'),
          revokedReason: stringValue('تم تفعيل جهاز جديد للحساب.'),
        }, previous.updateTime as string);
      }
    }
    if (!current.updateTime) {
      return jsonResponse({ message: 'تعذر تحديث ربط الجهاز الآن.' }, 409);
    }
    await patchFirestoreDocument(monitorPath, {
      uid: stringValue(uid),
      role: stringValue('paymentVerifier'),
      walletNumber: stringValue(WALLET_NUMBER),
      deviceId: stringValue(deviceId),
      enabled: boolValue(true),
      lastSeenAt: stringValue(now),
      updatedAt: stringValue(now),
    }, current.updateTime as string);
  } else {
    await writeFirestoreDocument(monitorPath, {
      uid: stringValue(uid),
      role: stringValue('paymentVerifier'),
      walletNumber: stringValue(WALLET_NUMBER),
      deviceId: stringValue(deviceId),
      enabled: boolValue(true),
      createdAt: stringValue(now),
      lastSeenAt: stringValue(now),
      updatedAt: stringValue(now),
    });
  }

  if (device.updateTime) {
    await patchFirestoreDocument(devicePath, {
      lastSeenAt: stringValue(now),
      activatedAt: stringValue(now),
      updatedAt: stringValue(now),
    }, device.updateTime as string);
  }
  return jsonResponse({ activated: true, access: 'approved' });
}

function boolFieldOrDefault(
  fields: Record<string, unknown>,
  name: string,
  fallback: boolean,
): boolean {
  const value = fields[name] as { booleanValue?: unknown } | undefined;
  return typeof value?.booleanValue === 'boolean' ? value.booleanValue : fallback;
}

function redactPhone(value: string | null): string | null {
  const digits = normalizePhone(value);
  return digits.length < 4 ? null : `***${digits.slice(-4)}`;
}

export function manualReviewMessage(): string {
  return 'تم استلام دليل التحويل للمراجعة اليدوية؛ لا يتم اعتماد أي رصيد تلقائيًا.';
}

/** SMS and customer-entered references are untrusted evidence, never decisions. */
export function evidenceDecision(_event: ParsedEvent): 'review' {
  return 'review';
}

export function hasExactlyOneActiveApprovedDevice(
  devices: Array<{ id: string; status: string }>,
  requestedId: string,
): boolean {
  const approved = devices.filter((device) => device.status === 'approved');
  return approved.length === 1 && approved[0].id === requestedId;
}

export function redactedEvidenceFields(
  event: ParsedEvent,
  monitorUid: string,
  deviceId: string,
  message: string,
  processedAt = new Date(),
): Record<string, Record<string, unknown>> {
  return {
    id: stringValue(event.id),
    sender: stringValue(event.sender.trim().toLowerCase().slice(0, 48)),
    receivedAt: stringValue(event.receivedAt),
    amount: event.amount == null ? nullValue() : numberValue(event.amount),
    senderPhone: event.senderPhone == null
      ? nullValue()
      : stringValue(normalizePhone(event.senderPhone)),
    senderName: event.senderName == null
      ? nullValue()
      : stringValue(event.senderName.trim().slice(0, 120)),
    walletNumber: event.walletNumber == null
      ? nullValue()
      : stringValue(normalizePhone(event.walletNumber)),
    reference: event.reference == null
      ? nullValue()
      : stringValue(event.reference.slice(0, 128)),
    normalizedReference: event.reference == null
      ? nullValue()
      : stringValue(normalizeDigits(event.reference.trim()).replaceAll(/\s+/g, ' ').toUpperCase()),
    transactionAt: event.transactionAt == null
      ? nullValue()
      : stringValue(event.transactionAt),
    decision: stringValue(evidenceDecision(event)),
    message: stringValue(message),
    monitorUid: stringValue(monitorUid),
    deviceId: stringValue(deviceId),
    source: stringValue('untrusted_sms_observation'),
    rawMessageRetained: boolValue(false),
    rawMessageStatus: stringValue('not_uploaded'),
    rawMessageDeleted: boolValue(true),
    processedAt: stringValue(processedAt.toISOString()),
  };
}

export async function evidenceDocumentId(
  monitorUid: string,
  deviceId: string,
  eventId: string,
): Promise<string> {
  const input = new TextEncoder().encode(`${monitorUid}:${deviceId}:${eventId}`);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export type ReviewEvidenceStore = {
  read(path: string): Promise<Record<string, unknown> | null>;
  commit(writes: FirestoreCommitWrite[]): Promise<void>;
};

export type ReviewEvidenceResult =
  | { outcome: 'created'; document: Record<string, unknown> | null }
  | { outcome: 'duplicate_event'; document: Record<string, unknown> }
  | { outcome: 'duplicate_reference' };

export async function submitReviewEvidence(
  event: ParsedEvent,
  monitorUid: string,
  deviceId: string,
  message: string,
  store: ReviewEvidenceStore = {
    read: readFirestoreDocument,
    commit: commitFirestoreWrites,
  },
): Promise<ReviewEvidenceResult> {
  const id = await evidenceDocumentId(monitorUid, deviceId, event.id);
  const documentPath = `paymentMonitorEvents/${id}`;
  const existing = await store.read(documentPath);
  if (existing != null) return { outcome: 'duplicate_event', document: existing };
  const normalizedReference = event.reference == null
    ? ''
    : normalizeDigits(event.reference.trim()).replaceAll(/\s+/g, ' ').toUpperCase();
  const referenceLockId = normalizedReference.length === 0
    ? null
    : await evidenceDocumentId(monitorUid, '', normalizedReference);
  const referenceLockPath = referenceLockId == null
    ? null
    : `paymentMonitorReferenceLocks/${referenceLockId}`;
  if (referenceLockPath != null && await store.read(referenceLockPath) != null) {
    return { outcome: 'duplicate_reference' };
  }
  try {
    await store.commit([
      {
        mode: 'create',
        documentPath,
        fields: {
          ...redactedEvidenceFields(event, monitorUid, deviceId, message),
          evidenceId: stringValue(id),
        },
      },
      ...(referenceLockId == null || referenceLockPath == null
        ? []
        : [{
          mode: 'create' as const,
          documentPath: referenceLockPath,
          fields: {
            id: stringValue(referenceLockId),
            referenceHash: stringValue(referenceLockId),
            evidenceId: stringValue(id),
            monitorUid: stringValue(monitorUid),
            createdAt: stringValue(new Date().toISOString()),
          },
        }]),
    ]);
    return { outcome: 'created', document: await store.read(documentPath) };
  } catch (error) {
    const existing = await store.read(documentPath);
    if (existing != null) {
      return { outcome: 'duplicate_event', document: existing };
    }
    if (referenceLockPath != null &&
        await store.read(referenceLockPath) != null) {
      return { outcome: 'duplicate_reference' };
    }
    throw error;
  }
}

async function monitorHistory(
  monitorUid: string,
): Promise<Record<string, unknown>[]> {
  const documents = await findFirestoreDocuments(
    'paymentMonitorEvents',
    'monitorUid',
    stringValue(monitorUid),
  );
  return documents.map((document) => {
    const fields = documentFields(document);
    const processedAt = stringField(fields, 'processedAt') ??
      new Date(0).toISOString();
    const receivedAt = stringField(fields, 'receivedAt') ?? processedAt;
    const senderPhone = stringField(fields, 'senderPhone');
    const walletNumber = stringField(fields, 'walletNumber');
    const event: ParsedEvent = {
      id: stringField(fields, 'id') ?? '',
      sender: stringField(fields, 'sender') ?? '',
      receivedAt,
      amount: numberField(fields, 'amount'),
      senderPhone,
      senderName: stringField(fields, 'senderName'),
      walletNumber,
      reference: stringField(fields, 'reference'),
      transactionAt: stringField(fields, 'transactionAt'),
    };
    return {
      event,
      evidenceId: stringField(fields, 'evidenceId') ?? stringField(fields, 'id'),
      decision: stringField(fields, 'decision') ?? 'review',
      message: stringField(fields, 'message') ?? manualReviewMessage(),
      processedAt,
      linkedOperationId: stringField(fields, 'linkedOperationId'),
      linkedAttemptId: stringField(fields, 'linkedAttemptId'),
      duplicate: false,
    };
  }).sort((left, right) =>
    String(right.processedAt).localeCompare(String(left.processedAt)));
}

async function processEvent(
  event: ParsedEvent,
  monitorUid: string,
  deviceId: string,
  request: Request,
): Promise<Record<string, unknown>> {
  const walletMatches = normalizePhone(event.walletNumber) === WALLET_NUMBER;
  if (event.sender.toLowerCase().replaceAll(' ', '') !== 'vf-cash' ||
      !walletMatches) {
    return {
      decision: 'ignored',
      message: 'الرسالة ليست إيصال Vodafone Cash للمحفظة المحددة.',
      reference: event.reference,
    };
  }

  const message = manualReviewMessage();
  const evidenceId = await evidenceDocumentId(monitorUid, deviceId, event.id);
  const saved = await submitReviewEvidence(
    event,
    monitorUid,
    deviceId,
    message,
  );
  if (saved.outcome === 'duplicate_reference') {
    return {
      decision: 'duplicate',
      message: 'الرقم المرجعي مسجل من قبل، وأي اعتماد له يتطلب مراجعة يدوية.',
      reference: event.reference,
      evidenceId,
      linkedOperationId: null,
      linkedAttemptId: null,
      duplicate: true,
    };
  }
  if (saved.outcome === 'duplicate_event') {
    const fields = documentFields(saved.document);
    const savedEvidenceId = stringField(fields, 'evidenceId') ?? evidenceId;
    const reconciliation = await reconcileWithSecureOperations(request, savedEvidenceId);
    const refreshed = await readFirestoreDocument(`paymentMonitorEvents/${savedEvidenceId}`);
    const refreshedFields = documentFields(refreshed);
    return {
      decision: stringField(fields, 'decision') ?? 'review',
      message: reconciliation?.linked === true
        ? 'تم ربط دليل التحويل بالعملية للمراجعة.'
        : stringField(fields, 'message') ?? message,
      reference: stringField(fields, 'reference') ?? event.reference,
      evidenceId: savedEvidenceId,
      linkedOperationId: stringField(refreshedFields, 'linkedOperationId'),
      linkedAttemptId: stringField(refreshedFields, 'linkedAttemptId'),
      duplicate: true,
    };
  }
  const createdFields = saved.document == null
    ? null
    : documentFields(saved.document);
  const savedEvidenceId = createdFields == null
    ? evidenceId
    : stringField(createdFields, 'evidenceId') ?? evidenceId;
  const reconciliation = await reconcileWithSecureOperations(request, savedEvidenceId);
  const refreshed = await readFirestoreDocument(`paymentMonitorEvents/${savedEvidenceId}`);
  const refreshedFields = documentFields(refreshed);
  return {
    decision: 'review',
    message: reconciliation?.linked === true
      ? 'تم ربط دليل التحويل بالعملية للمراجعة.'
      : message,
    reference: event.reference,
    evidenceId: savedEvidenceId,
    linkedOperationId: stringField(refreshedFields, 'linkedOperationId'),
    linkedAttemptId: stringField(refreshedFields, 'linkedAttemptId'),
    duplicate: false,
  };
}

async function reconcileWithSecureOperations(
  request: Request,
  evidenceId: string,
): Promise<Record<string, unknown> | null> {
  const authorization = request.headers.get('authorization');
  const apiKey = request.headers.get('apikey');
  if (!authorization || !apiKey) return null;
  const endpoint = new URL(request.url);
  endpoint.pathname = '/functions/v1/secure-operations';
  endpoint.search = '';
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization,
        apikey: apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'reconcilePaymentMonitorEvidence',
        evidenceId,
      }),
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body != null && typeof body === 'object'
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

if (import.meta.main) {
Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ message: 'طريقة الطلب غير مدعومة.' }, 405);
  }

  try {
    const auth = await authenticatedMonitor(request);
    if (!auth.ok) return auth.response;
    const identity = auth.identity;
    const body = await request.json() as Record<string, unknown>;
    const action = body.action;
    const deviceId = body.deviceId;
    const walletNumber = body.walletNumber;
    if (typeof deviceId !== 'string' || typeof walletNumber !== 'string') {
      return jsonResponse({ message: 'بيانات الجهاز غير مكتملة.' }, 400);
    }

    if (action === 'requestDevice' || action === 'checkDevice') {
      const access = await resolveDeviceAccess(
        identity.uid,
        deviceId,
        walletNumber,
        {
          createPending: action === 'requestDevice',
          deviceName: boundedText(body.deviceName, 160),
          androidVersion: boundedText(body.androidVersion, 64),
          appVersion: boundedText(body.appVersion, 64),
        },
      );
      if (access instanceof Response) return access;
      return jsonResponse(access);
    }

    if (action === 'activateDevice') {
      return await activateDevice(identity.uid, deviceId, walletNumber);
    }

    const deviceError = await ensureDevice(identity.uid, deviceId, walletNumber);
    if (deviceError != null) return deviceError;

    if (action === 'registerDevice') {
      return jsonResponse({ registered: true, walletNumber: WALLET_NUMBER });
    }
    if (action === 'getHistory') {
      return jsonResponse({ history: await monitorHistory(identity.uid) });
    }
    if (action !== 'processSms') {
      return jsonResponse({ message: 'الإجراء غير معروف.' }, 400);
    }

    const event = parseEvent(body.event);
    if (event == null) {
      return jsonResponse({ message: 'بيانات رسالة التحويل غير صالحة.' }, 400);
    }
    const result = await processEvent(event, identity.uid, deviceId, request);
    return jsonResponse(result);
  } catch (error) {
    console.error('Payment monitor error:', error);
    return jsonResponse({ message: 'تعذر معالجة التحويل الآن.' }, 500);
  }
});
}
