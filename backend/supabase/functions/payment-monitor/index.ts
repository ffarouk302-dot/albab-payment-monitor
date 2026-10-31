import {
  boolValue,
  documentFields,
  findFirestoreDocuments,
  nullValue,
  numberField,
  numberValue,
  patchFirestoreDocument,
  readFirestoreDocument,
  stringField,
  stringValue,
  verifyFirebaseIdToken,
  writeFirestoreDocument,
} from '../_shared/firebase.ts';
import { getBearerToken } from '../_shared/http.ts';

const MONITOR_EMAIL = 'payment-monitor@albab.delivery';
const WALLET_NUMBER = '01017001654';
const PAYMENT_STATUSES = [
  'paymentReview',
  'awaitingPayment',
  'paymentUnderpaid',
  'paymentOverpaid',
];
const MATCH_WINDOW_MS = 10 * 60 * 1000;
const MAX_EVENT_ID_LENGTH = 128;
const EGYPT_TIME_ZONE = 'Africa/Cairo';

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

function normalizeText(value: string | null): string {
  return (value ?? '')
    .toLocaleLowerCase()
    .replaceAll(/[ًٌٍَُِّْـ]/g, '')
    .replaceAll(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function normalizeIsoTimestamp(value: string): string {
  // JavaScript Date parsing only needs millisecond precision. Trimming extra
  // fractional digits also keeps legacy and Dart-produced timestamps uniform.
  return value.trim().replace(/\.(\d{3})\d+/, '.$1');
}

function hasExplicitTimeZone(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

function egyptOffsetMinutes(utcMillis: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: EGYPT_TIME_ZONE,
    calendar: 'gregory',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMillis));
  const part = (type: string): string =>
    parts.find((item) => item.type === type)?.value ?? '';
  const wallMillis = Date.UTC(
    Number(part('year')),
    Number(part('month')) - 1,
    Number(part('day')),
    Number(part('hour')),
    Number(part('minute')),
    Number(part('second')),
  );
  return Math.round((wallMillis - utcMillis) / 60_000);
}

function offsetSuffix(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

function parseTimestamp(
  value: string | null,
  assumeEgyptLocalForLegacy: boolean,
): number {
  if (value == null || value.trim().length === 0) return NaN;
  const normalized = normalizeIsoTimestamp(value);
  if (hasExplicitTimeZone(normalized) || !assumeEgyptLocalForLegacy) {
    return Date.parse(normalized);
  }

  // Older orders were serialized from DateTime.now() without an offset. Treat
  // those values as Cairo wall-clock time instead of silently interpreting
  // them as UTC. The offset is calculated for the actual Egypt date so this
  // remains correct across Egypt's seasonal offset changes.
  const wallAsUtcMillis = Date.parse(`${normalized}Z`);
  if (!Number.isFinite(wallAsUtcMillis)) return NaN;
  let offset = egyptOffsetMinutes(wallAsUtcMillis);
  let parsed = Date.parse(`${normalized}${offsetSuffix(offset)}`);
  if (!Number.isFinite(parsed)) return NaN;
  const correctedOffset = egyptOffsetMinutes(parsed);
  if (correctedOffset !== offset) {
    offset = correctedOffset;
    parsed = Date.parse(`${normalized}${offsetSuffix(offset)}`);
  }
  return parsed;
}

function eventTime(event: ParsedEvent, fallback: Date): Date {
  const transactionMillis = parseTimestamp(event.transactionAt, true);
  if (Number.isFinite(transactionMillis)) return new Date(transactionMillis);
  const receivedMillis = parseTimestamp(event.receivedAt, true);
  if (Number.isFinite(receivedMillis)) return new Date(receivedMillis);
  return fallback;
}

function namesConflict(expected: string | null, received: string | null): boolean {
  const left = normalizeText(expected).split(' ').filter(Boolean);
  const right = normalizeText(received).split(' ').filter(Boolean);
  if (left.length === 0 || right.length === 0) return false;
  const leftFirst = left[0];
  const rightFirst = right[0];
  const leftArabic = /[\u0600-\u06ff]/u.test(leftFirst);
  const rightArabic = /[\u0600-\u06ff]/u.test(rightFirst);
  if (leftArabic !== rightArabic) return false;
  return leftFirst !== rightFirst;
}

function validEventId(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_EVENT_ID_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value);
}

function safeComplaintId(eventId: string): string {
  return `payment-monitor-${eventId}`.slice(0, 128);
}

function orderId(document: Record<string, unknown>): string {
  const name = document.name;
  return typeof name === 'string' ? name.split('/').pop() ?? '' : '';
}

function orderFields(document: Record<string, unknown>): Record<string, unknown> {
  return documentFields(document);
}

type ParsedEvent = {
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
  if (typeof event.sender !== 'string' || typeof event.receivedAt !== 'string') {
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
    reference: typeof event.reference === 'string' ? event.reference : null,
    transactionAt: typeof event.transactionAt === 'string'
      ? event.transactionAt
      : null,
  };
}

async function authenticatedMonitor(request: Request) {
  const token = getBearerToken(request);
  if (!token) return { response: jsonResponse({ message: 'سجّل الدخول أولًا.' }, 401) };
  const identity = await verifyFirebaseIdToken(token);
  if (!identity) {
    return { response: jsonResponse({ message: 'جلسة الدخول غير صالحة.' }, 401) };
  }
  if (identity.email?.toLowerCase() !== MONITOR_EMAIL) {
    return { response: jsonResponse({ message: 'هذا الحساب ليس حساب مراقبة الدفع.' }, 403) };
  }
  return { identity };
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
  if (!deviceId || deviceId.length > 128) {
    return jsonResponse({ message: 'معرّف الجهاز غير صالح.' }, 400);
  }
  if (normalizePhone(walletNumber) !== WALLET_NUMBER) {
    return jsonResponse({ message: 'رقم المحفظة غير مطابق لإعدادات المراقبة.' }, 400);
  }

  const devicePath = `paymentMonitorDevices/${deviceId}`;
  const registeredDevice = await readFirestoreDocument(devicePath);
  if (registeredDevice != null) {
    const registeredFields = documentFields(registeredDevice);
    const access = stringField(registeredFields, 'status') as DeviceAccess | null;
    if (access === 'approved' || access === 'rejected' || access === 'revoked') {
      return { access, message: deviceAccessMessage(access) };
    }
    return { access: 'pending', message: deviceAccessMessage('pending') };
  }

  const current = await readFirestoreDocument(`paymentMonitors/${uid}`);
  const currentFields = current == null ? null : documentFields(current);
  if (
    currentFields != null &&
    stringField(currentFields, 'deviceId') === deviceId &&
    boolFieldOrDefault(currentFields, 'enabled', true) === true
  ) {
    const now = new Date().toISOString();
    await writeFirestoreDocument(devicePath, {
      uid: stringValue(uid),
      deviceId: stringValue(deviceId),
      status: stringValue('approved'),
      deviceName: stringValue(options.deviceName ?? ''),
      androidVersion: stringValue(options.androidVersion ?? ''),
      appVersion: stringValue(options.appVersion ?? ''),
      createdAt: stringValue(stringField(currentFields, 'createdAt') ?? now),
      lastSeenAt: stringValue(now),
      updatedAt: stringValue(now),
      approvedAt: stringValue(now),
      approvedBy: stringValue('legacy-device'),
    });
    return { access: 'approved', message: deviceAccessMessage('approved') };
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

async function openOrders(): Promise<Record<string, unknown>[]> {
  const documents: Record<string, unknown>[] = [];
  for (const status of PAYMENT_STATUSES) {
    documents.push(
      ...await findFirestoreDocuments(
        'orders',
        'paymentStatus',
        stringValue(status),
      ),
    );
  }
  return documents;
}

async function openRiderDepositRequests(): Promise<Record<string, unknown>[]> {
  return findFirestoreDocuments(
    'riderDepositRequests',
    'status',
    stringValue('pending'),
  );
}

async function openWalletTopUpRequests(): Promise<Record<string, unknown>[]> {
  return findFirestoreDocuments(
    'walletTopUpRequests',
    'status',
    stringValue('pending'),
  );
}

type WalletTopUpMatchChecks = {
  amountMatches: boolean;
  phoneMatches: boolean;
  timeMatches: boolean;
  nameDoesNotConflict: boolean;
};

function matchWalletTopUpChecks(
  document: Record<string, unknown>,
  event: ParsedEvent,
  referenceTime: Date,
): WalletTopUpMatchChecks {
  const fields = documentFields(document);
  const requestedAt = stringField(fields, 'requestedAt');
  const requestedMillis = parseTimestamp(requestedAt, true);
  const elapsed = referenceTime.getTime() - requestedMillis;
  const requestedAmount = numberField(fields, 'amount');
  return {
    // A wallet top-up may arrive with a small/large difference; the actual
    // received amount is what is credited. Never accept a partial transfer as
    // a completed top-up.
    amountMatches: event.amount != null && requestedAmount != null &&
      event.amount + 0.01 >= requestedAmount,
    phoneMatches: normalizePhone(event.senderPhone) !== '' &&
      normalizePhone(stringField(fields, 'payerPhone')) !== '' &&
      normalizePhone(event.senderPhone) ===
        normalizePhone(stringField(fields, 'payerPhone')),
    timeMatches: Number.isFinite(requestedMillis) &&
      elapsed >= -60_000 && elapsed <= MATCH_WINDOW_MS,
    nameDoesNotConflict: !namesConflict(
      stringField(fields, 'payerName'),
      event.senderName,
    ),
  };
}

function candidateWalletTopUps(
  documents: Record<string, unknown>[],
  event: ParsedEvent,
  referenceTime: Date,
): Record<string, unknown>[] {
  return documents.filter((document) => {
    const checks = matchWalletTopUpChecks(document, event, referenceTime);
    return checks.amountMatches && checks.phoneMatches &&
      checks.timeMatches && checks.nameDoesNotConflict;
  });
}

function candidateWalletTopUpMismatches(
  documents: Record<string, unknown>[],
  event: ParsedEvent,
  referenceTime: Date,
): Record<string, unknown>[] {
  return documents.filter((document) => {
    const fields = documentFields(document);
    const requestedAmount = numberField(fields, 'amount');
    const checks = matchWalletTopUpChecks(document, event, referenceTime);
    return event.amount != null && requestedAmount != null &&
      event.amount + 0.01 < requestedAmount &&
      checks.phoneMatches && checks.timeMatches &&
      checks.nameDoesNotConflict;
  });
}

type RiderDepositMatchChecks = {
  amountMatches: boolean;
  phoneMatches: boolean;
  timeMatches: boolean;
  nameDoesNotConflict: boolean;
};

function matchRiderDepositChecks(
  document: Record<string, unknown>,
  event: ParsedEvent,
  referenceTime: Date,
): RiderDepositMatchChecks {
  const fields = documentFields(document);
  const requestedAt = stringField(fields, 'requestedAt');
  const requestedMillis = parseTimestamp(requestedAt, true);
  const elapsed = referenceTime.getTime() - requestedMillis;
  const requestedAmount = numberField(fields, 'amount');
  return {
    // A rider deposit credits the requested deposit and any excess to the
    // rider balance. A partial transfer remains underpaid and can be
    // completed by a linked continuation request.
    amountMatches: event.amount != null && requestedAmount != null &&
      event.amount + 0.01 >= requestedAmount,
    phoneMatches: normalizePhone(event.senderPhone) !== '' &&
      normalizePhone(stringField(fields, 'payerPhone')) !== '' &&
      normalizePhone(event.senderPhone) ===
        normalizePhone(stringField(fields, 'payerPhone')),
    timeMatches: Number.isFinite(requestedMillis) &&
      elapsed >= -60_000 && elapsed <= MATCH_WINDOW_MS,
    nameDoesNotConflict: !namesConflict(
      stringField(fields, 'payerName'),
      event.senderName,
    ),
  };
}

function candidateRiderDeposits(
  documents: Record<string, unknown>[],
  event: ParsedEvent,
  referenceTime: Date,
): Record<string, unknown>[] {
  return documents.filter((document) => {
    const checks = matchRiderDepositChecks(document, event, referenceTime);
    return checks.amountMatches && checks.phoneMatches &&
      checks.timeMatches && checks.nameDoesNotConflict;
  });
}

function candidateRiderDepositMismatches(
  documents: Record<string, unknown>[],
  event: ParsedEvent,
  referenceTime: Date,
): Record<string, unknown>[] {
  return documents.filter((document) => {
    const checks = matchRiderDepositChecks(document, event, referenceTime);
    return event.amount != null && !checks.amountMatches &&
      checks.phoneMatches && checks.timeMatches &&
      checks.nameDoesNotConflict;
  });
}

type OrderMatchChecks = {
  amountMatches: boolean;
  phoneMatches: boolean;
  timeMatches: boolean;
  hasNoPaymentReference: boolean;
  nameDoesNotConflict: boolean;
};

function matchChecks(
  document: Record<string, unknown>,
  event: ParsedEvent,
  referenceTime: Date,
): OrderMatchChecks {
  const fields = orderFields(document);
  const total = numberField(fields, 'total');
  const status = stringField(fields, 'paymentStatus');
  const previouslyReceived = numberField(fields, 'paymentAmountReceived') ?? 0;
  const expected = status === 'paymentUnderpaid'
    ? Math.max(0, (total ?? 0) - previouslyReceived)
    : total;
  const eventPhone = normalizePhone(event.senderPhone);
  const payerPhone = normalizePhone(stringField(fields, 'paymentPayerPhone'));
  const initiatedAt = stringField(fields, 'paymentInitiatedAt');
  const initiatedMillis = parseTimestamp(initiatedAt, true);
  const elapsed = referenceTime.getTime() - initiatedMillis;
  return {
    amountMatches: event.amount != null && expected != null &&
      event.amount + 0.01 >= expected,
    phoneMatches: eventPhone.length > 0 &&
      payerPhone.length > 0 && eventPhone === payerPhone,
    timeMatches: Number.isFinite(initiatedMillis) &&
      elapsed >= -60_000 && elapsed <= MATCH_WINDOW_MS,
    hasNoPaymentReference: event.reference == null ||
      stringField(fields, 'paymentTransactionId') != event.reference,
    nameDoesNotConflict: !namesConflict(
      stringField(fields, 'paymentPayerName'),
      event.senderName,
    ),
  };
}

function candidateOrderMismatches(
  documents: Record<string, unknown>[],
  event: ParsedEvent,
  referenceTime: Date,
): Record<string, unknown>[] {
  return documents.filter((document) => {
    const checks = matchChecks(document, event, referenceTime);
    return event.amount != null && !checks.amountMatches &&
      checks.phoneMatches && checks.timeMatches &&
      checks.hasNoPaymentReference && checks.nameDoesNotConflict;
  });
}

function candidateOrders(
  documents: Record<string, unknown>[],
  event: ParsedEvent,
  referenceTime: Date,
): Record<string, unknown>[] {
  return documents.filter((document) => {
    const checks = matchChecks(document, event, referenceTime);
    return checks.amountMatches && checks.phoneMatches &&
      checks.timeMatches && checks.hasNoPaymentReference &&
      checks.nameDoesNotConflict;
  });
}

function reviewReason(
  documents: Record<string, unknown>[],
  event: ParsedEvent,
  referenceTime: Date,
): string {
  if (event.amount == null) return 'المبلغ غير واضح في الرسالة.';
  if (event.senderPhone == null || normalizePhone(event.senderPhone).length === 0) {
    return 'رقم المحفظة المحول منها غير واضح في الرسالة.';
  }
  if (event.reference == null || event.reference.length === 0) {
    return 'رقم العملية غير موجود في الرسالة.';
  }
  if (documents.length === 0) return 'لا يوجد طلب دفع إلكتروني مفتوح للمطابقة.';
  const checks = documents.map(
    (document) => matchChecks(document, event, referenceTime),
  );
  if (!checks.some((item) => item.amountMatches)) {
    return 'المبلغ لا يطابق أي طلب دفع إلكتروني مفتوح.';
  }
  if (!checks.some((item) => item.amountMatches && item.phoneMatches)) {
    return 'رقم المحفظة المحول منها لا يطابق بيانات أي طلب مفتوح.';
  }
  if (!checks.some((item) =>
      item.amountMatches && item.phoneMatches && item.timeMatches)) {
    return 'وقت التحويل خارج نافذة المطابقة المحددة بعشر دقائق.';
  }
  if (!checks.some((item) =>
      item.amountMatches && item.phoneMatches && item.timeMatches &&
      item.hasNoPaymentReference)) {
    return 'الطلب أو رقم العملية مستخدم من قبل ويحتاج مراجعة.';
  }
  if (!checks.some((item) =>
      item.amountMatches && item.phoneMatches && item.timeMatches &&
      item.hasNoPaymentReference && item.nameDoesNotConflict)) {
    return 'الاسم الظاهر في الرسالة لا يطابق الاسم المدخل في الطلب.';
  }
  return 'لم يجد النظام طلبًا واحدًا مطابقًا للمبلغ والرقم والتوقيت.';
}

async function orderWithPaymentReference(
  reference: string | null,
): Promise<Record<string, unknown> | null> {
  if (!reference) return null;
  const matches = await findFirestoreDocuments(
    'orders',
    'paymentTransactionId',
    stringValue(reference),
  );
  return matches[0] ?? null;
}

async function riderDepositWithPaymentReference(
  reference: string | null,
): Promise<Record<string, unknown> | null> {
  if (!reference) return null;
  const matches = await findFirestoreDocuments(
    'riderDepositRequests',
    'paymentTransactionId',
    stringValue(reference),
  );
  return matches[0] ?? null;
}

async function walletTopUpWithPaymentReference(
  reference: string | null,
): Promise<Record<string, unknown> | null> {
  if (!reference) return null;
  const matches = await findFirestoreDocuments(
    'walletTopUpRequests',
    'paymentTransactionId',
    stringValue(reference),
  );
  return matches[0] ?? null;
}

function walletTopUpId(document: Record<string, unknown>): string {
  return orderId(document);
}

async function confirmWalletTopUp(
  document: Record<string, unknown>,
  event: ParsedEvent,
  monitorUid: string,
  now: Date,
): Promise<Record<string, unknown>> {
  const id = walletTopUpId(document);
  const fields = documentFields(document);
  const updateTime = document.updateTime;
  const userId = stringField(fields, 'userId');
  if (id.length === 0 || typeof updateTime !== 'string' || userId == null ||
      event.amount == null || event.reference == null) {
    throw new Error('Wallet top-up request is missing its identity.');
  }

  const parentRequestId = stringField(fields, 'parentRequestId');
  const rootDocument = parentRequestId == null
    ? document
    : await readFirestoreDocument(`walletTopUpRequests/${parentRequestId}`);
  if (rootDocument == null) {
    throw new Error('Wallet top-up parent request is missing.');
  }
  const rootFields = documentFields(rootDocument);
  const rootId = walletTopUpId(rootDocument);
  const rootUpdateTime = rootDocument.updateTime;
  const rootUserId = stringField(rootFields, 'userId');
  const rootStatus = stringField(rootFields, 'status');
  const requestedAmount = numberField(rootFields, 'amount') ??
    numberField(fields, 'amount');
  const previousReceived = numberField(rootFields, 'receivedAmount') ?? 0;
  if (rootId.length === 0 || typeof rootUpdateTime !== 'string' ||
      rootUserId == null || rootUserId != userId || requestedAmount == null) {
    throw new Error('Wallet top-up parent request is invalid.');
  }
  if (rootStatus == 'confirmed' || rootStatus == 'refunded') {
    // A replay must not add the same transfer to the balance again. The
    // deterministic wallet transaction below is still used to return the
    // existing result to the caller.
  } else if (rootStatus != 'pending' && rootStatus != 'underpaid') {
    throw new Error('Wallet top-up request is not open for confirmation.');
  }

  const receivedAmount = rootStatus == 'confirmed'
    ? previousReceived
    : previousReceived + event.amount;
  if (receivedAmount + 0.01 < requestedAmount) {
    throw new Error('Wallet top-up is still underpaid.');
  }
  const excess = Math.max(0, receivedAmount - requestedAmount);
  const transactionId = `topup-${rootId}`;
  const transactionPath = `walletTransactions/${transactionId}`;
  const existingTransaction = await readFirestoreDocument(transactionPath);

  const userDocument = await readFirestoreDocument(`users/${rootUserId}`);
  const userFields = documentFields(userDocument);
  const userUpdateTime = userDocument?.updateTime;
  if (typeof userUpdateTime !== 'string') {
    throw new Error('Customer wallet account is missing its version.');
  }
  const balance = numberField(userFields, 'walletBalance') ?? 0;
  const balanceAlreadyApplied =
    existingTransaction != null ||
    stringField(userFields, 'walletLastTransactionId') === transactionId;
  const note = excess > 0.01
    ? `تم شحن المحفظة بالمبلغ الفعلي ${receivedAmount} بدلًا من ${requestedAmount}، وتم تسجيل الزيادة ${excess}.`
    : parentRequestId != null
    ? 'تم استكمال شحن المحفظة بالمبلغ المتبقي واعتماد العملية كاملة.'
    : 'تم اعتماد تحويل شحن المحفظة.';

  if (rootStatus !== 'confirmed') {
    const rootUpdate: Record<string, Record<string, unknown>> = {
      status: stringValue('confirmed'),
      receivedAmount: numberValue(receivedAmount),
      paymentAmountDifference: numberValue(excess),
      confirmedAt: stringValue(now.toISOString()),
      confirmedBy: stringValue(monitorUid),
      note: stringValue(note),
    };
    if ((stringField(rootFields, 'paymentTransactionId') ?? '').isEmpty) {
      rootUpdate.paymentTransactionId = stringValue(event.reference);
    }
    await patchFirestoreDocument(
      `walletTopUpRequests/${rootId}`,
      rootUpdate,
      rootUpdateTime,
    );
  }
  if (parentRequestId != null && stringField(fields, 'status') != 'confirmed') {
    const childAmount = numberField(fields, 'amount') ?? event.amount;
    const childExcess = Math.max(0, event.amount - childAmount);
    await patchFirestoreDocument(`walletTopUpRequests/${id}`, {
      status: stringValue('confirmed'),
      paymentTransactionId: stringValue(event.reference),
      receivedAmount: numberValue(event.amount),
      paymentAmountDifference: numberValue(childExcess),
      confirmedAt: stringValue(now.toISOString()),
      confirmedBy: stringValue(monitorUid),
      note: stringValue(note),
    }, updateTime);
  }
  if (!balanceAlreadyApplied) {
    await patchFirestoreDocument(`users/${rootUserId}`, {
      walletBalance: numberValue(balance + receivedAmount),
      walletBalanceUpdatedAt: stringValue(now.toISOString()),
      walletLastTransactionId: stringValue(transactionId),
    }, userUpdateTime);
  }
  if (existingTransaction == null) {
    await writeFirestoreDocument(transactionPath, {
      id: stringValue(transactionId),
      userId: stringValue(rootUserId),
      amount: numberValue(receivedAmount),
      type: stringValue('topUp'),
      createdAt: stringValue(now.toISOString()),
      sourceId: stringValue(rootId),
      sourceLabel: stringValue('شحن المحفظة'),
      paymentTransactionId: stringValue(event.reference),
      note: stringValue(note),
    });
  }
  return {
    decision: 'matched',
    message: existingTransaction != null
      ? 'تم شحن محفظة العميل بالفعل.'
      : excess > 0.01
      ? 'تم شحن محفظة العميل بالمبلغ المحوّل وتسجيل الزيادة.'
      : 'تم شحن محفظة العميل بالمبلغ المحوّل.',
    walletTopUpId: id,
    rootWalletTopUpId: rootId,
    reference: event.reference,
    receivedAmount,
    requestedAmount,
    overpaymentCredited: excess,
  };
}

async function recordWalletTopUpMismatch(
  document: Record<string, unknown>,
  event: ParsedEvent,
  monitorUid: string,
  now: Date,
): Promise<Record<string, unknown>> {
  const id = walletTopUpId(document);
  const fields = documentFields(document);
  const updateTime = document.updateTime;
  const requested = numberField(fields, 'amount');
  if (id.length === 0 || typeof updateTime !== 'string' || requested == null ||
      event.amount == null || event.reference == null) {
    throw new Error('Wallet top-up mismatch is missing required data.');
  }
  const previouslyReceived = numberField(fields, 'receivedAmount') ?? 0;
  const received = previouslyReceived + event.amount;
  if (received + 0.01 >= requested) {
    throw new Error('Wallet top-up amount is no longer underpaid.');
  }
  const difference = requested - received;
  const message = `المبلغ المحوّل أقل من المطلوب. تم استلام ${received} من ${requested}، والمتبقي ${difference}.`;
  await patchFirestoreDocument(`walletTopUpRequests/${id}`, {
    status: stringValue('underpaid'),
    paymentTransactionId: stringValue(event.reference),
    receivedAmount: numberValue(received),
    paymentAmountDifference: numberValue(difference),
    note: stringValue(message),
  }, updateTime);
  return {
    decision: 'review',
    message,
    walletTopUpId: id,
    reference: event.reference,
    mismatchType: 'underpaid',
    expectedAmount: requested,
    receivedAmount: received,
    difference,
    remainingAmount: difference,
    monitorUid,
    detectedAt: now.toISOString(),
  };
}

function riderDepositId(document: Record<string, unknown>): string {
  return orderId(document);
}

async function confirmRiderDeposit(
  document: Record<string, unknown>,
  event: ParsedEvent,
  monitorUid: string,
  now: Date,
): Promise<Record<string, unknown>> {
  const id = riderDepositId(document);
  const fields = documentFields(document);
  const updateTime = document.updateTime;
  const riderId = stringField(fields, 'riderId');
  if (id.length === 0 || typeof updateTime !== 'string' || riderId == null) {
    throw new Error('Rider deposit request is missing its identity.');
  }
  const parentRequestId = stringField(fields, 'parentRequestId');
  const rootDocument = parentRequestId == null
    ? document
    : await readFirestoreDocument(`riderDepositRequests/${parentRequestId}`);
  if (rootDocument == null) {
    throw new Error('Rider deposit parent request is missing.');
  }
  const rootFields = documentFields(rootDocument);
  const rootId = riderDepositId(rootDocument);
  const rootUpdateTime = rootDocument.updateTime;
  const rootRiderId = stringField(rootFields, 'riderId');
  const rootStatus = stringField(rootFields, 'status');
  const requestedAmount = numberField(rootFields, 'amount') ??
    numberField(fields, 'amount');
  const previousReceived = numberField(rootFields, 'receivedAmount') ?? 0;
  if (rootId.length === 0 || typeof rootUpdateTime !== 'string' ||
      rootRiderId == null || rootRiderId != riderId ||
      requestedAmount == null) {
    throw new Error('Rider deposit parent request is invalid.');
  }
  if (rootStatus != 'pending' && rootStatus != 'underpaid') {
    throw new Error('Rider deposit request is not open for confirmation.');
  }
  const receivedAmount = previousReceived + event.amount!;
  if (receivedAmount + 0.01 < requestedAmount) {
    throw new Error('Rider deposit is still underpaid.');
  }
  const excess = Math.max(0, receivedAmount - requestedAmount);
  const childAmount = numberField(fields, 'amount') ?? event.amount!;
  const childExcess = Math.max(0, event.amount! - childAmount);
  const settlementNote = parentRequestId == null
    ? 'إيداع إلكتروني مؤكد من مراقب الدفع.'
    : 'إيداع إلكتروني مكتمل بعد استكمال المبلغ المتبقي.';
  const overpaymentNote =
    `تم إضافة الزيادة ${excess.toFixed(2)} إلى رصيد المندوب.`;

  const rootPaymentReference = stringField(rootFields, 'paymentTransactionId');
  const rootUpdate: Record<string, Record<string, unknown>> = {
    status: stringValue('confirmed'),
    receivedAmount: numberValue(receivedAmount),
    paymentAmountDifference: numberValue(excess),
    confirmedAt: stringValue(now.toISOString()),
    confirmedBy: stringValue(monitorUid),
    note: stringValue(excess > 0 ? overpaymentNote : settlementNote),
  };
  if (rootPaymentReference == null || rootPaymentReference.length === 0) {
    rootUpdate.paymentTransactionId = stringValue(event.reference!);
  }
  if (parentRequestId != null) {
    await patchFirestoreDocument(`riderDepositRequests/${id}`, {
      status: stringValue('confirmed'),
      paymentTransactionId: stringValue(event.reference!),
      receivedAmount: numberValue(event.amount!),
      paymentAmountDifference: numberValue(childExcess),
      confirmedAt: stringValue(now.toISOString()),
      confirmedBy: stringValue(monitorUid),
      note: stringValue(
        childExcess > 0 ? overpaymentNote : settlementNote,
      ),
    }, updateTime);
    await patchFirestoreDocument(
      `riderDepositRequests/${rootId}`,
      rootUpdate,
      rootUpdateTime,
    );
  } else {
    // The matched document is the root request in the normal flow.
    await patchFirestoreDocument(
      `riderDepositRequests/${rootId}`,
      rootUpdate,
      rootUpdateTime,
    );
  }

  const baseSettlementId = `rider-deposit-${rootId}`;
  await writeFirestoreDocument(`riderSettlements/${baseSettlementId}`, {
    id: stringValue(baseSettlementId),
    riderId: stringValue(rootRiderId),
    amount: numberValue(requestedAmount),
    type: stringValue('deposit'),
    paidAt: stringValue(now.toISOString()),
    paidBy: stringValue('payment-monitor'),
    paymentMethod: stringValue('grabPay'),
    paymentTransactionId: stringValue(event.reference!),
    recipientPhone: stringValue(''),
    requestId: stringValue(rootId),
    note: stringValue(settlementNote),
  });
  let overpaymentSettlementId: string | null = null;
  if (excess > 0.01) {
    overpaymentSettlementId = `rider-overpayment-${rootId}`;
    await writeFirestoreDocument(`riderSettlements/${overpaymentSettlementId}`, {
      id: stringValue(overpaymentSettlementId),
      riderId: stringValue(rootRiderId),
      amount: numberValue(excess),
      type: stringValue('deposit'),
      paidAt: stringValue(now.toISOString()),
      paidBy: stringValue('payment-monitor'),
      paymentMethod: stringValue('grabPay'),
      paymentTransactionId: stringValue(event.reference!),
      recipientPhone: stringValue(''),
      requestId: stringValue(rootId),
      note: stringValue(overpaymentNote),
    });
  }
  return {
    decision: 'matched',
    message: excess > 0.01
      ? 'تم تأكيد الإيداع وإضافة المبلغ الزائد إلى رصيد المندوب.'
      : 'تم تأكيد إيداع المندوب وتحديث رصيده.',
    depositId: id,
    rootDepositId: rootId,
    reference: event.reference,
    receivedAmount,
    requestedAmount,
    overpaymentCredited: excess,
    settlementId: baseSettlementId,
    overpaymentSettlementId,
  };
}

async function recordRiderDepositMismatch(
  document: Record<string, unknown>,
  event: ParsedEvent,
  monitorUid: string,
  now: Date,
): Promise<Record<string, unknown>> {
  const id = riderDepositId(document);
  const fields = documentFields(document);
  const updateTime = document.updateTime;
  const requested = numberField(fields, 'amount');
  if (id.length === 0 || typeof updateTime !== 'string' || requested == null ||
      event.amount == null || event.reference == null) {
    throw new Error('Rider deposit mismatch is missing required data.');
  }
  const underpaid = event.amount + 0.01 < requested;
  if (!underpaid) {
    throw new Error('Rider deposit amount is within the match tolerance.');
  }
  const difference = requested - event.amount;
  const status = 'underpaid';
  const message =
    'المبلغ المحوّل أقل من مبلغ إيداع المندوب، وتم فتح جلسة استكمال.';
  await patchFirestoreDocument(`riderDepositRequests/${id}`, {
    status: stringValue(status),
    paymentTransactionId: stringValue(event.reference),
    receivedAmount: numberValue(event.amount),
    paymentAmountDifference: numberValue(difference),
    confirmedAt: stringValue(now.toISOString()),
    confirmedBy: stringValue(monitorUid),
    note: stringValue(message),
  }, updateTime);
  return {
    decision: 'review',
    message,
    depositId: id,
    reference: event.reference,
    mismatchType: status,
    expectedAmount: requested,
    receivedAmount: event.amount,
    difference,
  };
}

async function recordOrderAmountMismatch(
  document: Record<string, unknown>,
  event: ParsedEvent,
  monitorUid: string,
  now: Date,
): Promise<Record<string, unknown>> {
  const id = orderId(document);
  const fields = orderFields(document);
  const updateTime = document.updateTime;
  const total = numberField(fields, 'total');
  if (id.length === 0 || typeof updateTime !== 'string' || total == null ||
      event.amount == null || event.reference == null) {
    throw new Error('Order amount mismatch is missing required data.');
  }
  const previouslyReceived = numberField(fields, 'paymentAmountReceived') ?? 0;
  const received = previouslyReceived + event.amount;
  const underpaid = received < total;
  if (!underpaid) {
    throw new Error('An overpaid order should be confirmed normally.');
  }
  const difference = Math.abs(total - received);
  const message = `المبلغ المحوّل أقل من المطلوب. تم استلام ${received} من ${total}، وتم فتح جلسة استكمال.`;
  await patchFirestoreDocument(`orders/${id}`, {
    paymentStatus: stringValue('paymentUnderpaid'),
    paymentTransactionId: stringValue(event.reference),
    paymentAmountReceived: numberValue(received),
    paymentAmountDifference: numberValue(difference),
    paymentInitiatedAt: stringValue(now.toISOString()),
    paymentVerificationSource: stringValue('vf_cash_sms_mismatch'),
    paymentVerifiedBy: stringValue(monitorUid),
  }, updateTime);
  return {
    decision: 'review',
    message,
    orderId: id,
    reference: event.reference,
    mismatchType: 'underpaid',
    expectedAmount: total,
    receivedAmount: received,
    difference,
  };
}

async function creditOrderOverpayment(
  document: Record<string, unknown>,
  receivedAmount: number,
  event: ParsedEvent,
  monitorUid: string,
  now: Date,
): Promise<number> {
  const id = orderId(document);
  const fields = orderFields(document);
  const total = numberField(fields, 'total');
  const userId = stringField(fields, 'userId');
  if (id.length === 0 || total == null || userId == null) {
    throw new Error('Order overpayment is missing its identity.');
  }
  const excess = receivedAmount - total;
  if (excess <= 0.01) return 0;

  const transactionId = `order-overpayment-${id}`;
  const transactionPath = `walletTransactions/${transactionId}`;
  const existingTransaction = await readFirestoreDocument(transactionPath);

  const userDocument = await readFirestoreDocument(`users/${userId}`);
  const userFields = documentFields(userDocument);
  const userUpdateTime = userDocument?.updateTime;
  if (typeof userUpdateTime !== 'string') {
    throw new Error('Customer wallet account is missing its version.');
  }
  const balance = numberField(userFields, 'walletBalance') ?? 0;
  const balanceAlreadyApplied =
    stringField(userFields, 'walletLastTransactionId') === transactionId;
  const note = `تمت إضافة الزيادة ${excess.toFixed(2)} إلى محفظتك بعد اعتماد الطلب.`;
  if (!balanceAlreadyApplied) {
    await patchFirestoreDocument(`users/${userId}`, {
      walletBalance: numberValue(balance + excess),
      walletBalanceUpdatedAt: stringValue(now.toISOString()),
      walletLastTransactionId: stringValue(transactionId),
    }, userUpdateTime);
  }
  if (existingTransaction == null) {
    await writeFirestoreDocument(transactionPath, {
      id: stringValue(transactionId),
      userId: stringValue(userId),
      amount: numberValue(excess),
      type: stringValue('overpayment'),
      createdAt: stringValue(now.toISOString()),
      sourceId: stringValue(id),
      sourceLabel: stringValue(stringField(fields, 'orderNumber') ?? id),
      paymentTransactionId: stringValue(event.reference ?? ''),
      note: stringValue(`${note} بواسطة ${monitorUid}.`),
    });
  }
  return excess;
}

async function confirmOrderPayment(
  document: Record<string, unknown>,
  event: ParsedEvent,
  monitorUid: string,
  now: Date,
): Promise<Record<string, unknown>> {
  const id = orderId(document);
  const fields = orderFields(document);
  const updateTime = document.updateTime;
  const total = numberField(fields, 'total');
  if (id.length === 0 || typeof updateTime !== 'string' || total == null ||
      event.amount == null || event.reference == null) {
    throw new Error('Order payment match is missing required data.');
  }
  const previouslyReceived = numberField(fields, 'paymentAmountReceived') ?? 0;
  const received = previouslyReceived + event.amount;
  const message = 'تم اعتماد التحويل وإتاحة الطلب للمطعم.';
  await patchFirestoreDocument(`orders/${id}`, {
    paymentStatus: stringValue('paid'),
    paymentTransactionId: stringValue(event.reference),
    paymentAmountReceived: numberValue(received),
    paymentAmountDifference: numberValue(Math.max(0, received - total)),
    paymentVerifiedAt: stringValue(now.toISOString()),
    paymentVerificationSource: stringValue('vf_cash_sms'),
    paymentVerifiedBy: stringValue(monitorUid),
  }, updateTime);
  const excess = await creditOrderOverpayment(
    document,
    received,
    event,
    monitorUid,
    now,
  );
  return {
    decision: 'matched',
    message: excess > 0.01
      ? `${message} وتمت إضافة الزيادة إلى محفظة العميل.`
      : message,
    orderId: id,
    reference: event.reference,
    overpaymentCredited: excess,
  };
}

async function writeAudit(
  event: ParsedEvent,
  decision: string,
  message: string,
  monitorUid: string,
  matchedOrderId: string | null,
): Promise<void> {
  await writeFirestoreDocument(`paymentMonitorEvents/${event.id}`, {
    id: stringValue(event.id),
    sender: stringValue(event.sender),
    receivedAt: stringValue(event.receivedAt),
    amount: event.amount == null ? nullValue() : numberValue(event.amount),
    senderPhone: event.senderPhone == null
      ? nullValue()
      : stringValue(normalizePhone(event.senderPhone)),
    senderName: event.senderName == null ? nullValue() : stringValue(event.senderName),
    walletNumber: event.walletNumber == null
      ? nullValue()
      : stringValue(normalizePhone(event.walletNumber)),
    reference: event.reference == null ? nullValue() : stringValue(event.reference),
    transactionAt: event.transactionAt == null
      ? nullValue()
      : stringValue(event.transactionAt),
    decision: stringValue(decision),
    message: stringValue(message),
    monitorUid: stringValue(monitorUid),
    orderId: matchedOrderId == null ? nullValue() : stringValue(matchedOrderId),
    processedAt: stringValue(new Date().toISOString()),
  });
}

async function monitorHistory(
  monitorUid: string,
): Promise<Record<string, unknown>[]> {
  const documents = await findFirestoreDocuments(
    'paymentMonitorEvents',
    'monitorUid',
    stringValue(monitorUid),
  );
  const history = await Promise.all(documents.map(async (document) => {
      const fields = documentFields(document);
      const processedAt = stringField(fields, 'processedAt') ?? new Date(0).toISOString();
      const receivedAt = stringField(fields, 'receivedAt') ?? processedAt;
      const storedDecision = stringField(fields, 'decision') ?? 'review';
      const linkedOrderId = stringField(fields, 'orderId');
      let decision = storedDecision;
      let message = stringField(fields, 'message') ?? '';

      // A review audit is immutable, but the order can later be cancelled and
      // refunded from the delivery app. Reconcile that current state when the
      // monitor history is read so a completed refund is not left in manual
      // review forever.
      if ((storedDecision === 'review' || storedDecision === 'duplicate') &&
          linkedOrderId !== null &&
          linkedOrderId.length > 0 &&
          !linkedOrderId.includes('/')) {
        try {
          const linkedOrder = await readFirestoreDocument(
            'orders/$linkedOrderId',
          );
          if (linkedOrder !== null) {
            const orderFieldsValue = documentFields(linkedOrder);
            const paymentStatus = stringField(
              orderFieldsValue,
              'paymentStatus',
            );
            const orderStatus = stringField(orderFieldsValue, 'status');
            if (paymentStatus === 'refunded' || orderStatus === 'refunded') {
              decision = 'refunded';
              message = 'تم إلغاء الطلب واسترداد المبلغ إلى محفظة العميل.';
            }
          }
        } catch {
          // Keep the stored review result if the linked order cannot be read.
        }
      }

      return {
        event: {
          id: stringField(fields, 'id') ?? orderId(document),
          sender: stringField(fields, 'sender') ?? '',
          receivedAt,
          amount: numberField(fields, 'amount'),
          senderPhone: stringField(fields, 'senderPhone'),
          senderName: stringField(fields, 'senderName'),
          walletNumber: stringField(fields, 'walletNumber'),
          reference: stringField(fields, 'reference'),
          transactionAt: stringField(fields, 'transactionAt'),
        },
        decision,
        message,
        processedAt,
        orderId: linkedOrderId,
      };
    }));
  return history
    .sort((left, right) =>
      String(right.processedAt).localeCompare(String(left.processedAt)));
}

async function createReviewAlert(
  event: ParsedEvent,
  reason: string,
  monitorUid: string,
  order: Record<string, unknown> | null,
): Promise<void> {
  const fields = order == null ? {} : orderFields(order);
  const now = new Date().toISOString();
  const orderIdValue = order == null ? null : orderId(order);
  const complaintId = safeComplaintId(event.id);
  await writeFirestoreDocument(`complaints/${complaintId}`, {
    id: stringValue(complaintId),
    kind: stringValue('payment'),
    category: stringValue('تنبيه دفع آلي'),
    description: stringValue(`استقبل النظام رسالة تحويل وتحتاج مراجعة: ${reason}`),
    reporterId: stringValue(stringField(fields, 'userId') ?? monitorUid),
    reporterName: stringValue(stringField(fields, 'customerName') ?? 'مراقب الدفع'),
    reporterEmail: stringValue(''),
    reporterRole: stringValue('customer'),
    reporterPhone: stringField(fields, 'customerPhone') == null
      ? nullValue()
      : stringValue(stringField(fields, 'customerPhone')!),
    isGuest: boolValue(false),
    status: stringValue('submitted'),
    createdAt: stringValue(now),
    updatedAt: stringValue(now),
    orderId: orderIdValue == null ? nullValue() : stringValue(orderIdValue),
    restaurantId: stringField(fields, 'restaurantId') == null
      ? nullValue()
      : stringValue(stringField(fields, 'restaurantId')!),
    adminReply: nullValue(),
    messages: { arrayValue: { values: [] } },
    paymentAmount: event.amount == null ? nullValue() : numberValue(event.amount),
    paymentNetwork: stringValue('Vodafone Cash'),
    paymentPayerName: event.senderName == null
      ? nullValue()
      : stringValue(event.senderName),
    paymentPayerPhone: event.senderPhone == null
      ? nullValue()
      : stringValue(normalizePhone(event.senderPhone)),
    paymentReference: event.reference == null
      ? nullValue()
      : stringValue(event.reference),
    paymentScreenshotPath: nullValue(),
    paymentAttemptedAt: stringValue(event.receivedAt),
  });
}

async function processEvent(
  event: ParsedEvent,
  monitorUid: string,
): Promise<Record<string, unknown>> {
  const now = new Date();
  const walletMatches = normalizePhone(event.walletNumber) === WALLET_NUMBER;
  if (event.sender.toLowerCase().replaceAll(' ', '') !== 'vf-cash' ||
      !walletMatches) {
    const message = 'الرسالة ليست إيصال Vodafone Cash للمحفظة المحددة.';
    await writeAudit(event, 'ignored', message, monitorUid, null);
    return { decision: 'ignored', message, reference: event.reference };
  }

  const existingOrder = await orderWithPaymentReference(event.reference);
  if (existingOrder != null) {
    const existingOrderId = orderId(existingOrder);
    const existingFields = orderFields(existingOrder);
    if (stringField(existingFields, 'paymentStatus') === 'paid') {
      try {
        const received = numberField(existingFields, 'paymentAmountReceived') ??
          event.amount ?? 0;
        const excess = event.amount == null
          ? 0
          : await creditOrderOverpayment(
            existingOrder,
            received,
            event,
            monitorUid,
            now,
          );
        const message = excess > 0.01
          ? 'تم اعتماد التحويل وإضافة الزيادة إلى محفظة العميل.'
          : 'تم اعتماد التحويل بالفعل وإتاحة الطلب للمطعم.';
        await writeAudit(event, 'matched', message, monitorUid, existingOrderId);
        return {
          decision: 'matched',
          message,
          orderId: existingOrderId,
          reference: event.reference,
          overpaymentCredited: excess,
        };
      } catch {
        const message = 'تم اعتماد الطلب لكن تعذر تسجيل الزيادة في محفظة العميل، وتحتاج العملية مراجعة.';
        await createReviewAlert(event, message, monitorUid, existingOrder);
        await writeAudit(event, 'review', message, monitorUid, existingOrderId);
        return {
          decision: 'review',
          message,
          orderId: existingOrderId,
          reference: event.reference,
        };
      }
    }
    const message = 'رقم العملية مستخدم من قبل ويحتاج مراجعة.';
    await createReviewAlert(event, message, monitorUid, existingOrder);
    await writeAudit(event, 'duplicate', message, monitorUid, existingOrderId);
    return {
      decision: 'duplicate',
      message,
      orderId: existingOrderId,
      reference: event.reference,
    };
  }

  const existingDeposit = await riderDepositWithPaymentReference(event.reference);
  if (existingDeposit != null) {
    const existingDepositId = riderDepositId(existingDeposit);
    const existingDepositFields = documentFields(existingDeposit);
    if (stringField(existingDepositFields, 'status') === 'confirmed') {
      const message = 'تم تأكيد إيداع المندوب بالفعل.';
      await writeAudit(event, 'matched', message, monitorUid,
        `deposit:${existingDepositId}`);
      return {
        decision: 'matched',
        message,
        depositId: existingDepositId,
        reference: event.reference,
      };
    }
  }

  const existingWalletTopUp = await walletTopUpWithPaymentReference(
    event.reference,
  );
  if (existingWalletTopUp != null) {
    const existingWalletTopUpId = walletTopUpId(existingWalletTopUp);
    const existingWalletFields = documentFields(existingWalletTopUp);
    if (stringField(existingWalletFields, 'status') === 'confirmed') {
      try {
        const result = await confirmWalletTopUp(
          existingWalletTopUp,
          event,
          monitorUid,
          now,
        );
        await writeAudit(event, 'matched', String(result.message), monitorUid,
          `wallet-top-up:${existingWalletTopUpId}`);
        return result;
      } catch {
        const message = 'تم تسجيل شحن المحفظة لكن تعذر إكمال التسوية، وتحتاج العملية مراجعة.';
        await createReviewAlert(event, message, monitorUid, null);
        await writeAudit(event, 'review', message, monitorUid,
          `wallet-top-up:${existingWalletTopUpId}`);
        return {
          decision: 'review',
          message,
          walletTopUpId: existingWalletTopUpId,
          reference: event.reference,
        };
      }
    }
  }

  const referenceTime = eventTime(event, now);
  const depositDocuments = await openRiderDepositRequests();
  const depositCandidates = candidateRiderDeposits(
    depositDocuments,
    event,
    referenceTime,
  );
  if (depositCandidates.length === 1 &&
      event.reference != null && event.amount != null) {
    const deposit = depositCandidates[0];
    const depositId = riderDepositId(deposit);
    try {
      const result = await confirmRiderDeposit(
        deposit,
        event,
        monitorUid,
        now,
      );
      await writeAudit(
        event,
        'matched',
        String(result.message),
        monitorUid,
        `deposit:${depositId}`,
      );
      return result;
    } catch {
      const message = 'حدث تغيير متزامن في إيداع المندوب، وتم تحويله للمراجعة.';
      await createReviewAlert(event, message, monitorUid, null);
      await writeAudit(event, 'review', message, monitorUid,
        `deposit:${depositId}`);
      return {
        decision: 'review',
        message,
        depositId,
        reference: event.reference,
      };
    }
  }

  const depositMismatchCandidates = candidateRiderDepositMismatches(
    depositDocuments,
    event,
    referenceTime,
  );
  if (depositMismatchCandidates.length === 1 &&
      event.reference != null && event.amount != null) {
    const deposit = depositMismatchCandidates[0];
    const depositId = riderDepositId(deposit);
    try {
      const result = await recordRiderDepositMismatch(
        deposit,
        event,
        monitorUid,
        now,
      );
      await writeAudit(
        event,
        'review',
        String(result.message),
        monitorUid,
        `deposit:${depositId}`,
      );
      return result;
    } catch {
      const message = 'تعذر تسجيل اختلاف مبلغ الإيداع، وتم تحويله للمراجعة.';
      await createReviewAlert(event, message, monitorUid, null);
      await writeAudit(event, 'review', message, monitorUid,
        `deposit:${depositId}`);
      return {
        decision: 'review',
        message,
        depositId,
        reference: event.reference,
      };
    }
  }

  const walletTopUpDocuments = await openWalletTopUpRequests();
  const walletTopUpCandidates = candidateWalletTopUps(
    walletTopUpDocuments,
    event,
    referenceTime,
  );
  if (walletTopUpCandidates.length === 1 &&
      event.reference != null && event.amount != null) {
    const walletTopUp = walletTopUpCandidates[0];
    const walletTopUpRequestId = walletTopUpId(walletTopUp);
    try {
      const result = await confirmWalletTopUp(
        walletTopUp,
        event,
        monitorUid,
        now,
      );
      await writeAudit(
        event,
        'matched',
        String(result.message),
        monitorUid,
        `wallet-top-up:${walletTopUpRequestId}`,
      );
      return result;
    } catch {
      const message = 'تعذر تحديث محفظة العميل، وتم تحويل العملية للمراجعة.';
      await createReviewAlert(event, message, monitorUid, null);
      await writeAudit(
        event,
        'review',
        message,
        monitorUid,
        `wallet-top-up:${walletTopUpRequestId}`,
      );
      return {
        decision: 'review',
        message,
        walletTopUpId: walletTopUpRequestId,
        reference: event.reference,
      };
    }
  }
  const walletTopUpMismatchCandidates = candidateWalletTopUpMismatches(
    walletTopUpDocuments,
    event,
    referenceTime,
  );
  if (walletTopUpCandidates.length === 0 &&
      walletTopUpMismatchCandidates.length === 1 &&
      event.reference != null && event.amount != null) {
    const walletTopUp = walletTopUpMismatchCandidates[0];
    const walletTopUpRequestId = walletTopUpId(walletTopUp);
    try {
      const result = await recordWalletTopUpMismatch(
        walletTopUp,
        event,
        monitorUid,
        now,
      );
      await writeAudit(
        event,
        'review',
        String(result.message),
        monitorUid,
        `wallet-top-up:${walletTopUpRequestId}`,
      );
      return result;
    } catch {
      const message = 'تعذر تسجيل نقص مبلغ شحن المحفظة، وتم تحويل العملية للمراجعة.';
      await createReviewAlert(event, message, monitorUid, null);
      await writeAudit(
        event,
        'review',
        message,
        monitorUid,
        `wallet-top-up:${walletTopUpRequestId}`,
      );
      return {
        decision: 'review',
        message,
        walletTopUpId: walletTopUpRequestId,
        reference: event.reference,
      };
    }
  }

  const orders = await openOrders();
  const candidates = candidateOrders(orders, event, referenceTime);
  const mismatchCandidates = candidateOrderMismatches(
    orders,
    event,
    referenceTime,
  );
  if (candidates.length === 0 && mismatchCandidates.length === 1 &&
      event.reference != null && event.amount != null) {
    const order = mismatchCandidates[0];
    const id = orderId(order);
    try {
      const result = await recordOrderAmountMismatch(
        order,
        event,
        monitorUid,
        now,
      );
      await writeAudit(event, 'review', String(result.message), monitorUid, id);
      return result;
    } catch {
      const message = 'تعذر تسجيل اختلاف مبلغ الطلب، وتم تحويله للمراجعة.';
      await createReviewAlert(event, message, monitorUid, order);
      await writeAudit(event, 'review', message, monitorUid, id);
      return {
        decision: 'review',
        message,
        orderId: id,
        reference: event.reference,
      };
    }
  }
  if (candidates.length !== 1 || event.reference == null || event.amount == null) {
    const message = candidates.length === 0
      ? reviewReason(orders, event, referenceTime)
      : candidates.length > 1
      ? 'يوجد أكثر من طلب محتمل بنفس البيانات.'
      : 'بيانات الرسالة ناقصة للاعتماد التلقائي.';
    const reviewOrder = candidates.length === 1 ? candidates[0] : null;
    await createReviewAlert(event, message, monitorUid, reviewOrder);
    await writeAudit(
      event,
      'review',
      message,
      monitorUid,
      reviewOrder == null ? null : orderId(reviewOrder),
    );
    return {
      decision: 'review',
      message,
      orderId: reviewOrder == null ? null : orderId(reviewOrder),
      reference: event.reference,
    };
  }

  const order = candidates[0];
  const id = orderId(order);
  const updateTime = order.updateTime;
  if (typeof updateTime !== 'string' || id.length === 0) {
    const message = 'تعذر التحقق من إصدار الطلب، وتم تحويله للمراجعة.';
    await createReviewAlert(event, message, monitorUid, order);
    await writeAudit(event, 'review', message, monitorUid, id || null);
    return { decision: 'review', message, orderId: id, reference: event.reference };
  }

  try {
    const result = await confirmOrderPayment(order, event, monitorUid, now);
    await writeAudit(event, 'matched', String(result.message), monitorUid, id);
    return result;
  } catch {
    const latest = await readFirestoreDocument(`orders/${id}`);
    const latestFields = latest == null ? {} : orderFields(latest);
    if (stringField(latestFields, 'paymentStatus') === 'paid' &&
        stringField(latestFields, 'paymentTransactionId') === event.reference) {
      try {
        const received = numberField(latestFields, 'paymentAmountReceived') ??
          event.amount ?? 0;
        const excess = event.amount == null || latest == null
          ? 0
          : await creditOrderOverpayment(
            latest,
            received,
            event,
            monitorUid,
            now,
          );
        const replayMessage = excess > 0.01
          ? 'تم اعتماد التحويل وإضافة الزيادة إلى محفظة العميل.'
          : 'تم اعتماد التحويل بالفعل وإتاحة الطلب للمطعم.';
        await writeAudit(event, 'matched', replayMessage, monitorUid, id);
        return {
          decision: 'matched',
          message: replayMessage,
          orderId: id,
          reference: event.reference,
          overpaymentCredited: excess,
        };
      } catch {
        const replayMessage = 'تم اعتماد الطلب لكن تعذر تسجيل الزيادة في محفظة العميل، وتحتاج العملية مراجعة.';
        await createReviewAlert(event, replayMessage, monitorUid, latest);
        await writeAudit(event, 'review', replayMessage, monitorUid, id);
        return {
          decision: 'review',
          message: replayMessage,
          orderId: id,
          reference: event.reference,
        };
      }
    }
    const conflictMessage = 'حدث تغيير متزامن في الطلب، وتم تحويل العملية للمراجعة.';
    await createReviewAlert(event, conflictMessage, monitorUid, order);
    await writeAudit(event, 'review', conflictMessage, monitorUid, id);
    return { decision: 'review', message: conflictMessage, orderId: id, reference: event.reference };
  }
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ message: 'طريقة الطلب غير مدعومة.' }, 405);
  }

  try {
    const auth = await authenticatedMonitor(request);
    if ('response' in auth) return auth.response;
    const body = await request.json() as Record<string, unknown>;
    const action = body.action;
    const deviceId = body.deviceId;
    const walletNumber = body.walletNumber;
    if (typeof deviceId !== 'string' || typeof walletNumber !== 'string') {
      return jsonResponse({ message: 'بيانات الجهاز غير مكتملة.' }, 400);
    }

    if (action === 'requestDevice' || action === 'checkDevice') {
      const access = await resolveDeviceAccess(
        auth.identity.uid,
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
      return await activateDevice(auth.identity.uid, deviceId, walletNumber);
    }

    const deviceError = await ensureDevice(auth.identity.uid, deviceId, walletNumber);
    if (deviceError != null) return deviceError;

    if (action === 'registerDevice') {
      return jsonResponse({ registered: true, walletNumber: WALLET_NUMBER });
    }
    if (action === 'getHistory') {
      return jsonResponse({ history: await monitorHistory(auth.identity.uid) });
    }
    if (action !== 'processSms') {
      return jsonResponse({ message: 'الإجراء غير معروف.' }, 400);
    }

    const event = parseEvent(body.event);
    if (event == null) {
      return jsonResponse({ message: 'بيانات رسالة التحويل غير صالحة.' }, 400);
    }
    const result = await processEvent(event, auth.identity.uid);
    return jsonResponse(result);
  } catch (error) {
    console.error('Payment monitor error:', error);
    return jsonResponse({ message: 'تعذر معالجة التحويل الآن.' }, 500);
  }
});
