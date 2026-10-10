import {
  DEFAULT_LEDGER_NAME,
  deleteLedgerDatabase,
  setActiveLedger,
} from '@/ledger/db';

export type ClientKind = 'client' | 'review';
export type ReviewMeta = {
  fingerprint?: string;
  omittedEventCount: number;
  file: string;
  verdict: 'match' | 'mismatch' | 'none';
};
export type ClientRecord = {
  id: string;
  label: string;
  dbName: string;
  kind: ClientKind;
  createdAt: string;
  review?: ReviewMeta;
};

export const CLIENTS_KEY = 'coineda.clients';
export const ACTIVE_CLIENT_KEY = 'coineda.activeClient';

export class LastClientError extends Error {
  constructor() {
    super('The last client cannot be removed');
    this.name = 'LastClientError';
  }
}

// In-memory fallback for when localStorage throws (private mode).
const memory = new Map<string, string>();

const readRaw = (key: string): string | null => {
  try {
    const value = localStorage.getItem(key);
    if (value !== null) memory.set(key, value);
    return value;
  } catch {
    return memory.get(key) ?? null;
  }
};

const writeRaw = (key: string, value: string): void => {
  memory.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    // kept in memory only
  }
};

export const newClientId = (): string => {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

const isRecord = (r: unknown): r is ClientRecord =>
  !!r &&
  typeof r === 'object' &&
  typeof (r as ClientRecord).id === 'string' &&
  typeof (r as ClientRecord).label === 'string' &&
  typeof (r as ClientRecord).dbName === 'string' &&
  ((r as ClientRecord).kind === 'client' ||
    (r as ClientRecord).kind === 'review');

const write = (records: ClientRecord[]): void =>
  writeRaw(CLIENTS_KEY, JSON.stringify(records));

export const listClients = (): ClientRecord[] => {
  let records: ClientRecord[] = [];
  try {
    const parsed: unknown = JSON.parse(readRaw(CLIENTS_KEY) ?? '[]');
    if (Array.isArray(parsed)) records = parsed.filter(isRecord);
  } catch {
    records = [];
  }
  if (!records.some((r) => r.kind === 'client')) {
    records = [
      {
        id: newClientId(),
        label: 'My portfolio',
        dbName: DEFAULT_LEDGER_NAME,
        kind: 'client',
        createdAt: new Date().toISOString(),
      },
      ...records,
    ];
    write(records);
  }
  return records;
};

export const activeClient = (): ClientRecord => {
  const records = listClients();
  const id = readRaw(ACTIVE_CLIENT_KEY);
  return (
    records.find((r) => r.id === id) ??
    records.find((r) => r.kind === 'client') ??
    records[0]
  );
};

const add = (record: ClientRecord): ClientRecord => {
  write([...listClients(), record]);
  return record;
};

export const createClient = (label: string): ClientRecord => {
  const id = newClientId();
  return add({
    id,
    label,
    dbName: `coineda-client-${id}`,
    kind: 'client',
    createdAt: new Date().toISOString(),
  });
};

export const createReviewClient = (
  label: string,
  review: ReviewMeta,
): ClientRecord => {
  const id = newClientId();
  return add({
    id,
    label,
    dbName: `coineda-review-${id}`,
    kind: 'review',
    createdAt: new Date().toISOString(),
    review,
  });
};

export const renameClient = (id: string, label: string): void =>
  write(listClients().map((r) => (r.id === id ? { ...r, label } : r)));

export const updateReviewMeta = (id: string, review: ReviewMeta): void =>
  write(listClients().map((r) => (r.id === id ? { ...r, review } : r)));

export const setActiveClient = async (id: string): Promise<void> => {
  const record = listClients().find((r) => r.id === id);
  if (!record) return;
  writeRaw(ACTIVE_CLIENT_KEY, record.id);
  await setActiveLedger(record.dbName);
};

export const removeClient = async (id: string): Promise<void> => {
  const records = listClients();
  const target = records.find((r) => r.id === id);
  if (!target) return;
  const remaining = records.filter((r) => r.id !== id);
  if (target.kind === 'client' && !remaining.some((r) => r.kind === 'client'))
    throw new LastClientError();
  const wasActive = activeClient().id === id;
  const next = remaining.find((r) => r.kind === 'client');
  if (wasActive && next) await setActiveClient(next.id);
  await deleteLedgerDatabase(target.dbName);
  write(remaining);
};
