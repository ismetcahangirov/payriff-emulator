import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach } from 'vitest';
import { type Emulator, buildEmulator } from '../src/app.js';
import { Clock } from '../src/clock.js';
import { type Config, loadConfig } from '../src/config.js';

export const SECRET = 'test-secret';
export const CALLBACK = 'https://merchant.test/payriff/callback';

export interface Sent {
  url: string;
  body: Record<string, unknown>;
  raw: string;
}

export interface Harness extends Emulator {
  sent: Sent[];
  answers: number[];
  call: (method: string, url: string, body?: unknown, headers?: Record<string, string>) => Promise<Reply>;
  createOrder: (fields?: Record<string, unknown>, rrn?: string) => Promise<string>;
  pay: (orderId: string, fields?: Record<string, unknown>) => Promise<Reply>;
}

export interface Reply {
  status: number;
  json: Record<string, unknown>;
  payload: Record<string, unknown>;
  raw: LightMyRequestResponse;
}

const open: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

export async function harness(overrides: Record<string, string> = {}): Promise<Harness> {
  const config: Config = loadConfig({
    PAYRIFF_SECRET_KEYS: SECRET,
    PAYRIFF_MERCHANT_ID: 'ES1234567',
    PUBLIC_URL: 'http://emulator.test',
    CALLBACK_FIRST_RETRY_MS: '5',
    CALLBACK_RETRY_MS: '5',
    ...overrides,
  });
  const sent: Sent[] = [];
  const answers: number[] = [];
  const emulator = await buildEmulator({
    config,
    clock: new Clock(),
    send: async (url, raw) => {
      sent.push({ url, raw, body: JSON.parse(raw) as Record<string, unknown> });
      return answers.shift() ?? 200;
    },
  });
  open.push(emulator.app);

  const call: Harness['call'] = async (method, url, body, headers = {}) => {
    const raw = await emulator.app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: SECRET, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { payload: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const json = raw.headers['content-type']?.toString().includes('json') ? (raw.json() as Record<string, unknown>) : {};
    return { status: raw.statusCode, json, payload: (json.payload ?? {}) as Record<string, unknown>, raw };
  };

  const createOrder: Harness['createOrder'] = async (fields = {}, rrn = randomUUID()) => {
    const reply = await call(
      'POST',
      '/api/v3/orders',
      { amount: '20.50', currency: 'AZN', callbackUrl: CALLBACK, ...fields },
      { 'x-request-rrn': rrn },
    );
    if (reply.status !== 200) {
      throw new Error(`order not created: ${reply.raw.body}`);
    }
    return String(reply.payload.orderId);
  };

  const pay: Harness['pay'] = (orderId, fields = {}) => call('POST', `/_emulator/orders/${orderId}/pay`, fields);

  return { ...emulator, sent, answers, call, createOrder, pay };
}

export function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}
