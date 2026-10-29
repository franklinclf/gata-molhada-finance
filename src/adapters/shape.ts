import { SourceFormatError } from '../core/http.ts';

export type Json = Record<string, unknown>;

/** The account type is valid data we do not model (for example an investment account). */
export class UnsupportedAccountError extends SourceFormatError {}

export function asRecord(value: unknown, path: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SourceFormatError(`${path}: expected an object`);
  }
  return value as Json;
}

export function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new SourceFormatError(`${path}: expected an array`);
  return value;
}

export function reqString(record: Json, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') throw new SourceFormatError(`${path}.${key}: expected a non-empty string`);
  return value;
}

export function optString(record: Json, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Accepts a number or a numeric string. */
export function reqNumber(record: Json, key: string, path: string): number {
  const value = record[key];
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new SourceFormatError(`${path}.${key}: expected a number`);
  return n;
}

export function optNumber(record: Json, key: string): number | null {
  const value = record[key];
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export function reqIsoInstant(record: Json, key: string, path: string): string {
  const raw = reqString(record, key, path);
  const time = new Date(raw);
  if (Number.isNaN(time.getTime())) throw new SourceFormatError(`${path}.${key}: not a valid date`);
  return time.toISOString();
}

/** Date part (YYYY-MM-DD) of an ISO string, or null when absent or invalid. */
export function optDay(record: Json, key: string): string | null {
  const raw = optString(record, key);
  if (raw === null) return null;
  const time = new Date(raw);
  return Number.isNaN(time.getTime()) ? null : time.toISOString().slice(0, 10);
}
