import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { harness } from './helpers.js';

const payout = (fields: Record<string, unknown> = {}, merchant = 'ES1234567') => ({
  merchant,
  body: {
    transferAmount: '100.00',
    description: 'Campaign payout',
    fullName: 'Aysel Mammadova',
    finCode: '5abc12d',
    cardPan: '4111111111111111',
    requestRrn: randomUUID(),
    ...fields,
  },
});

describe('payouts', () => {
  it('pays out to a card number in the merchant envelope and draws the deposit down', async () => {
    const emulator = await harness({ PAYOUT_BALANCE: '1000.00' });
    const reply = await emulator.call('POST', '/api/v3/payout', payout());

    expect(reply.json.code).toBe('00000');
    expect(reply.payload).toMatchObject({ _final: 'true', state: 'SUCCESS', currentDepositBalance: 900 });
    expect(reply.raw.body).toContain('"currentDepositBalance":900.00');
  });

  it('answers the same payout to the same requestRrn', async () => {
    const emulator = await harness();
    const request = payout();
    await emulator.call('POST', '/api/v3/payout', request);
    const again = await emulator.call('POST', '/api/v3/payout', request);

    expect(again.payload.currentDepositBalance).toBe(900);
    expect(emulator.context.state.payouts.size).toBe(1);
  });

  it('refuses another merchant, a bad card and a bad FIN', async () => {
    const emulator = await harness();
    expect((await emulator.call('POST', '/api/v3/payout', payout({}, 'ES0000001'))).json.code).toBe('01000');
    expect((await emulator.call('POST', '/api/v3/payout', payout({ cardPan: '4111111111111112' }))).json.code).toBe('15400');
    expect((await emulator.call('POST', '/api/v3/payout', payout({ finCode: '123' }))).json.code).toBe('15400');
    expect((await emulator.call('POST', '/api/v3/payout', payout({ transferAmount: '0.50' }))).json.code).toBe('15400');
  });

  it('answers 01200 past the deposit and 01300 past the daily limit', async () => {
    const poor = await harness({ PAYOUT_BALANCE: '50.00' });
    expect((await poor.call('POST', '/api/v3/payout', payout())).json.code).toBe('01200');

    const limited = await harness({ PAYOUT_BALANCE: '10000.00', PAYOUT_DAILY_LIMIT: '150.00' });
    expect((await limited.call('POST', '/api/v3/payout', payout())).json.code).toBe('00000');
    expect((await limited.call('POST', '/api/v3/payout', payout())).json.code).toBe('01300');
  });

  it('records a failed transfer without touching the deposit', async () => {
    const emulator = await harness();
    const request = payout({ cardPan: '4000000000000002' });
    const reply = await emulator.call('POST', '/api/v3/payout', request);
    expect(reply.payload).toMatchObject({ state: 'FAIL', currentDepositBalance: 1000 });

    const info = await emulator.call('GET', `/api/v3/payout/info/${String(request.body.requestRrn)}`);
    expect(info.payload).toMatchObject({ state: 'FAIL', cardPan: '400000******0002' });
    const listed = await emulator.call('GET', '/api/v3/payouts?status=FAIL');
    expect(listed.payload.totalElements).toBe(1);
  });

  it('checks a cardholder', async () => {
    const emulator = await harness();
    const reply = await emulator.call('POST', '/api/v3/payout/check-cardholder', { cardPan: '4111111111111111' });
    expect(reply.json.payload).toBe('TEST C*******');
  });
});
