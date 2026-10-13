import { Decimal } from './money.js';

export interface Config {
  host: string;
  port: number;
  publicUrl: string;
  secretKeys: string[];
  merchantId: string;
  merchantName: string;
  commissionRate: Decimal;
  refundWindowDays: number;
  orderTtlMinutes: number;
  otp: string;
  allowHttpCallbacks: boolean;
  callbackRetries: number;
  callbackFirstRetryMs: number;
  callbackRetryMs: number;
  callbackTimeoutMs: number;
  payoutBalance: Decimal;
  payoutDailyLimit: Decimal;
  payoutFeeRate: Decimal;
}

type Env = Record<string, string | undefined>;

function text(env: Env, name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value ? value : fallback;
}

function integer(env: Env, name: string, fallback: number): number {
  const value = env[name]?.trim();
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, not "${value}"`);
  }
  return parsed;
}

function decimal(env: Env, name: string, fallback: string): Decimal {
  const value = text(env, name, fallback);
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`${name} must be a non-negative decimal, not "${value}"`);
  }
  return new Decimal(value);
}

export function loadConfig(env: Env = process.env): Config {
  const port = integer(env, 'PORT', 4010);
  return {
    host: text(env, 'HOST', '127.0.0.1'),
    port,
    publicUrl: text(env, 'PUBLIC_URL', `http://localhost:${port}`).replace(/\/+$/, ''),
    secretKeys: text(env, 'PAYRIFF_SECRET_KEYS', 'emulator-secret-key')
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean),
    merchantId: text(env, 'PAYRIFF_MERCHANT_ID', 'ES0000000'),
    merchantName: text(env, 'PAYRIFF_MERCHANT_NAME', 'Emulator Merchant'),
    commissionRate: decimal(env, 'COMMISSION_RATE', '3'),
    refundWindowDays: integer(env, 'REFUND_WINDOW_DAYS', 30),
    orderTtlMinutes: integer(env, 'ORDER_TTL_MINUTES', 30),
    otp: text(env, 'OTP_CODE', '123456'),
    allowHttpCallbacks: text(env, 'ALLOW_HTTP_CALLBACKS', 'false') === 'true',
    callbackRetries: integer(env, 'CALLBACK_RETRIES', 3),
    callbackFirstRetryMs: integer(env, 'CALLBACK_FIRST_RETRY_MS', 165_000),
    callbackRetryMs: integer(env, 'CALLBACK_RETRY_MS', 300_000),
    callbackTimeoutMs: integer(env, 'CALLBACK_TIMEOUT_MS', 10_000),
    payoutBalance: decimal(env, 'PAYOUT_BALANCE', '1000.00'),
    payoutDailyLimit: decimal(env, 'PAYOUT_DAILY_LIMIT', '5000.00'),
    payoutFeeRate: decimal(env, 'PAYOUT_FEE_RATE', '0'),
  };
}
