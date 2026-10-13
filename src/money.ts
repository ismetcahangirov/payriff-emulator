import { Decimal } from 'decimal.js';
import { parse, stringify } from 'lossless-json';

export { Decimal };

export function parseJson(text: string): unknown {
  return parse(text, null, (value) => new Decimal(value));
}

export function toJson(value: unknown): string {
  return (
    stringify(value, undefined, undefined, [
      { test: (candidate: unknown) => Decimal.isDecimal(candidate), stringify: (candidate: unknown) => (candidate as Decimal).toFixed(2) },
    ]) ?? 'null'
  );
}

export function toDecimal(value: unknown): Decimal | null {
  if (Decimal.isDecimal(value)) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Decimal(value.toString());
  }
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return new Decimal(value.trim());
  }
  return null;
}

export function cents(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export const ZERO = new Decimal(0);
