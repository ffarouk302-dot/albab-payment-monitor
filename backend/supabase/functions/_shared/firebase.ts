const FIREBASE_PROJECT_ID = 'albab-delivery';
const FIREBASE_ISSUER = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;
const FIREBASE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

export type FirebaseIdentity = {
  uid: string;
  email: string | null;
};

type FirebaseJwk = JsonWebKey & { kid?: string };
type JwkSet = { keys: FirebaseJwk[] };

let jwkCache: { expiresAt: number; keys: FirebaseJwk[] } | null = null;
let googleAccessToken: { value: string; expiresAt: number } | null = null;

function decodeBase64Url(value: string): ArrayBuffer {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
    .buffer as ArrayBuffer;
}

function encodeBase64Url(value: Uint8Array | ArrayBuffer): string {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function encodeJsonBase64Url(value: Record<string, unknown>): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function jsonSegment<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;
}

async function getFirebaseJwks(forceRefresh = false): Promise<FirebaseJwk[]> {
  if (!forceRefresh && jwkCache && jwkCache.expiresAt > Date.now()) {
    return jwkCache.keys;
  }

  const response = await fetch(FIREBASE_JWKS_URL);
  if (!response.ok) throw new Error('Unable to retrieve Firebase signing keys.');
  const set = await response.json() as JwkSet;
  const maxAge = response.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1];
  const cacheSeconds = maxAge ? Number(maxAge) : 3600;
  jwkCache = {
    keys: set.keys,
    expiresAt: Date.now() + cacheSeconds * 1000,
  };
  return set.keys;
}

export async function verifyFirebaseIdToken(
  token: string,
): Promise<FirebaseIdentity | null> {
  const segments = token.split('.');
  if (segments.length !== 3) return null;

  try {
    const header = jsonSegment<{ alg?: string; kid?: string }>(segments[0]);
    if (header.alg !== 'RS256' || !header.kid) return null;

    let key = (await getFirebaseJwks()).find((candidate) => candidate.kid === header.kid);
    if (!key) {
      key = (await getFirebaseJwks(true)).find((candidate) => candidate.kid === header.kid);
    }
    if (!key) return null;

    const imported = await crypto.subtle.importKey(
      'jwk',
      key,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const validSignature = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      imported,
      decodeBase64Url(segments[2]),
      new TextEncoder().encode(`${segments[0]}.${segments[1]}`),
    );
    if (!validSignature) return null;

    const claims = jsonSegment<{
      aud?: string;
      iss?: string;
      sub?: string;
      email?: string;
      exp?: number;
      iat?: number;
      auth_time?: number;
    }>(segments[1]);
    const now = Math.floor(Date.now() / 1000);
    if (
      claims.aud !== FIREBASE_PROJECT_ID ||
      claims.iss !== FIREBASE_ISSUER ||
      !claims.sub ||
      claims.sub.length > 128 ||
      !claims.exp || claims.exp <= now ||
      !claims.iat || claims.iat > now + 60 ||
      !claims.auth_time || claims.auth_time > now + 60
    ) {
      return null;
    }

    return { uid: claims.sub, email: claims.email ?? null };
  } catch {
    return null;
  }
}

function fromPem(value: string): ArrayBuffer {
  const contents = value
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replaceAll(/\s/g, '')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  return decodeBase64Url(contents);
}

export async function getGoogleAccessToken(): Promise<string> {
  if (googleAccessToken && googleAccessToken.expiresAt > Date.now() + 30_000) {
    return googleAccessToken.value;
  }

  const raw = Deno.env.get('FIREBASE_SERVICE_ACCOUNT_JSON');
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not configured.');
  const account = JSON.parse(raw) as {
    project_id?: string;
    client_email?: string;
    private_key?: string;
  };
  if (
    account.project_id !== FIREBASE_PROJECT_ID ||
    !account.client_email ||
    !account.private_key
  ) {
    throw new Error('Firebase service account configuration is invalid.');
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const unsigned = `${encodeJsonBase64Url({ alg: 'RS256', typ: 'JWT' })}.${encodeJsonBase64Url({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: issuedAt,
    exp: issuedAt + 3600,
  })}`;
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    fromPem(account.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(unsigned),
  );
  const assertion = `${unsigned}.${encodeBase64Url(new Uint8Array(signature))}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const body = await response.json() as { access_token?: string; expires_in?: number };
  if (!response.ok || !body.access_token) {
    throw new Error(`Google OAuth token request failed (${response.status}).`);
  }

  const expiresIn = body.expires_in ?? 3600;
  googleAccessToken = {
    value: body.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  return body.access_token;
}

export async function readFirestoreDocument(
  documentPath: string,
): Promise<Record<string, unknown> | null> {
  const accessToken = await getGoogleAccessToken();
  const path = documentPath.split('/').map(encodeURIComponent).join('/');
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Firestore read failed (${response.status}).`);
  return await response.json() as Record<string, unknown>;
}

export type FirestoreFields = Record<string, Record<string, unknown>>;

function firestoreDocumentName(documentPath: string): string {
  return `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${documentPath}`;
}

/** Writes a complete Firestore document through the server-only REST API. */
export async function writeFirestoreDocument(
  documentPath: string,
  fields: FirestoreFields,
): Promise<void> {
  const accessToken = await getGoogleAccessToken();
  const response = await fetch(
    `https://firestore.googleapis.com/v1/${firestoreDocumentName(documentPath)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: firestoreDocumentName(documentPath),
        fields,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Firestore write failed (${response.status}).`);
  }
}

/** Updates selected fields only after checking the document version. */
export async function patchFirestoreDocument(
  documentPath: string,
  fields: FirestoreFields,
  updateTime: string,
): Promise<void> {
  const accessToken = await getGoogleAccessToken();
  const params = new URLSearchParams({
    'currentDocument.updateTime': updateTime,
  });
  for (const fieldPath of Object.keys(fields)) {
    params.append('updateMask.fieldPaths', fieldPath);
  }
  const response = await fetch(
    `https://firestore.googleapis.com/v1/${firestoreDocumentName(documentPath)}?${params}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: firestoreDocumentName(documentPath),
        fields,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Firestore conditional update failed (${response.status}).`);
  }
}

export type FirestoreCommitWrite =
  | { mode: 'create'; documentPath: string; fields: FirestoreFields }
  | {
    mode: 'update';
    documentPath: string;
    fields: FirestoreFields;
    updateTime: string;
  };

/** Applies immutable creates and version-checked updates atomically. */
export async function commitFirestoreWrites(
  writes: FirestoreCommitWrite[],
): Promise<void> {
  if (writes.length === 0) return;
  const accessToken = await getGoogleAccessToken();
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents:commit`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        writes: writes.map((write) => write.mode === 'create'
          ? {
            update: {
              name: firestoreDocumentName(write.documentPath),
              fields: write.fields,
            },
            currentDocument: { exists: false },
          }
          : {
            update: {
              name: firestoreDocumentName(write.documentPath),
              fields: write.fields,
            },
            updateMask: { fieldPaths: Object.keys(write.fields) },
            currentDocument: { updateTime: write.updateTime },
          }),
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Firestore atomic write failed (${response.status}).`);
  }
}

export async function findFirestoreDocuments(
  collectionId: string,
  fieldPath: string,
  value: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const accessToken = await getGoogleAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        where: {
          fieldFilter: {
            field: { fieldPath },
            op: 'EQUAL',
            value,
          },
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`Firestore query failed (${response.status}).`);
  const rows = await response.json() as Array<{
    document?: Record<string, unknown>;
  }>;
  return rows
    .map((row) => row.document)
    .filter((document): document is Record<string, unknown> => document != null);
}

export function stringValue(value: string): Record<string, unknown> {
  return { stringValue: value };
}

export function numberValue(value: number): Record<string, unknown> {
  return Number.isInteger(value)
    ? { integerValue: String(value) }
    : { doubleValue: value };
}

export function boolValue(value: boolean): Record<string, unknown> {
  return { booleanValue: value };
}

export function nullValue(): Record<string, unknown> {
  return { nullValue: null };
}

export function documentFields(
  document: Record<string, unknown> | null,
): Record<string, unknown> {
  return (document?.fields ?? {}) as Record<string, unknown>;
}

export function stringField(
  fields: Record<string, unknown>,
  name: string,
): string | null {
  const value = fields[name] as { stringValue?: unknown } | undefined;
  return typeof value?.stringValue === 'string' ? value.stringValue : null;
}

export function boolField(
  fields: Record<string, unknown>,
  name: string,
): boolean | null {
  const value = fields[name] as { booleanValue?: unknown } | undefined;
  return typeof value?.booleanValue === 'boolean' ? value.booleanValue : null;
}

export function numberField(
  fields: Record<string, unknown>,
  name: string,
): number | null {
  const value = fields[name] as { doubleValue?: unknown; integerValue?: unknown } | undefined;
  if (typeof value?.doubleValue === 'number') return value.doubleValue;
  if (typeof value?.integerValue === 'string') return Number(value.integerValue);
  return null;
}

export async function findFirestoreDocumentIds(
  collectionId: string,
  fieldPath: string,
  value: string,
): Promise<string[]> {
  const accessToken = await getGoogleAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        where: {
          fieldFilter: {
            field: { fieldPath },
            op: 'EQUAL',
            value: { stringValue: value },
          },
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`Firestore query failed (${response.status}).`);
  const rows = await response.json() as Array<{ document?: { name?: unknown } }>;
  return rows
    .map((row) => row.document?.name)
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.split('/').pop() ?? '')
    .filter((id) => id.length > 0);
}

export function mapField(
  fields: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  const value = fields[name] as {
    mapValue?: { fields?: Record<string, unknown> };
  } | undefined;
  return value?.mapValue?.fields ?? {};
}

export function arrayMapStringField(
  fields: Record<string, unknown>,
  arrayName: string,
  mapName: string,
): string[] {
  const arrayField = fields[arrayName] as {
    arrayValue?: { values?: Array<{ mapValue?: { fields?: Record<string, unknown> } }> };
  } | undefined;
  return (arrayField?.arrayValue?.values ?? []).map((item) => {
    const value = item.mapValue?.fields?.[mapName] as { stringValue?: unknown } | undefined;
    return typeof value?.stringValue === 'string' ? value.stringValue : '';
  });
}
