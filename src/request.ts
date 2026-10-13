import { isIP } from 'node:net';
import { invalid } from './envelope.js';
import { Decimal, toDecimal } from './money.js';

export type Body = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export function objectBody(body: unknown): Body {
  if (body && typeof body === 'object' && !Array.isArray(body) && !Decimal.isDecimal(body)) {
    return body as Body;
  }
  if (body === undefined || body === null) {
    return {};
  }
  throw invalid('Request body must be a JSON object');
}

export function optionalText(body: Body, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw invalid(`${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function requiredText(body: Body, field: string): string {
  const value = optionalText(body, field);
  if (value === null) {
    throw invalid(`${field} is required`);
  }
  return value;
}

export function optionalAmount(body: Body, field: string): Decimal | null {
  const value = body[field];
  if (value === undefined || value === null) {
    return null;
  }
  const amount = toDecimal(value);
  if (!amount) {
    throw invalid(`${field} must be a number`);
  }
  if (amount.lte(0)) {
    throw invalid(`${field} must be positive`);
  }
  if (amount.decimalPlaces() > 2) {
    throw invalid(`${field} must have at most two decimal places`);
  }
  return amount;
}

export function requiredAmount(body: Body, field: string): Decimal {
  const value = optionalAmount(body, field);
  if (value === null) {
    throw invalid(`${field} is required`);
  }
  return value;
}

export function flag(body: Body, field: string): boolean {
  const value = body[field];
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== 'boolean') {
    throw invalid(`${field} must be a boolean`);
  }
  return value;
}

export function choice<T extends string>(body: Body, field: string, allowed: readonly T[], fallback: T): T {
  const value = optionalText(body, field);
  if (value === null) {
    return fallback;
  }
  const upper = value.toUpperCase();
  const found = allowed.find((candidate) => candidate === upper);
  if (!found) {
    throw invalid(`${field} must be one of ${allowed.join(', ')}`);
  }
  return found;
}

export function metadata(body: Body, field: string): Record<string, unknown> | null {
  const value = body[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value) || Decimal.isDecimal(value)) {
    throw invalid(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
}

export function callbackUrl(value: string | null, allowHttp: boolean, required = true): string {
  if (value === null) {
    if (required) {
      throw invalid('callbackUrl is required');
    }
    return '';
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid('callbackUrl must be an absolute URL');
  }
  if (url.protocol === 'https:') {
    return value;
  }
  if (url.protocol === 'http:' && (allowHttp || isLoopback(url.hostname))) {
    return value;
  }
  throw invalid('callbackUrl must be https');
}
