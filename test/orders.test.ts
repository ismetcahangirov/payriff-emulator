import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CALLBACK, harness } from './helpers.js';

describe('orders', () => {
  it('creates an order and answers the decimal as it was sent', async () => {
    const emulator = await harness();
    const reply = await emulator.call(
      'POST',
      '/api/v3/orders',
      '{"amount":20.50,"currency":"AZN","language":"EN","operation":"PURCHASE","callbackUrl":"https://merchant.test/cb","cardSave":false}',
      { 'x-request-rrn': randomUUID() },
    );

    expect(reply.status).toBe(200);
    expect(reply.json.code).toBe('00000');
    expect(reply.raw.body).toContain('"amount":20.50');
    expect(reply.payload.paymentUrl).toBe(`http://emulator.test/pay/${String(reply.payload.orderId)}`);
    expect(reply.raw.body).toContain('"comissionRate":3.00');
  });

  it('answers the same order to the same X-REQUEST-RRN', async () => {
    const emulator = await harness();
    const rrn = randomUUID();
    const first = await emulator.createOrder({}, rrn);
    const second = await emulator.createOrder({ amount: '99.00' }, rrn);

    expect(second).toBe(first);
    expect(emulator.context.state.orders.size).toBe(1);
  });

  it('answers 15000 Internal Error to an X-REQUEST-RRN that is not a UUID', async () => {
    const emulator = await harness();
    const reply = await emulator.call(
      'POST',
      '/api/v3/orders',
      { amount: '5.00', callbackUrl: CALLBACK },
      { 'x-request-rrn': 'pledge-raise-1' },
    );

    expect(reply.status).toBe(500);
    expect(reply.json.code).toBe('15000');
    expect(reply.json.message).toBe('Internal Error');
  });

  it('refuses a missing or wrong secret key with 14010', async () => {
    const emulator = await harness();
    const wrong = await emulator.call('GET', '/api/v3/orders/x', undefined, { authorization: 'nope' });

    expect(wrong.status).toBe(401);
    expect(wrong.json.code).toBe('14010');
  });

  it('validates the amount, the currency and the callback', async () => {
    const emulator = await harness();
    const cases = [
      { amount: '0', callbackUrl: CALLBACK },
      { amount: '1.005', callbackUrl: CALLBACK },
      { amount: '5.00', currency: 'GBP', callbackUrl: CALLBACK },
      { amount: '5.00', callbackUrl: 'http://merchant.test/cb' },
      { amount: '5.00' },
    ];
    for (const body of cases) {
      const reply = await emulator.call('POST', '/api/v3/orders', body);
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(reply.json.code).toBe('15400');
    }
  });

  it('accepts an http callback on a loopback host, or anywhere when allowed', async () => {
    const strict = await harness();
    expect((await strict.call('POST', '/api/v3/orders', { amount: '1.00', callbackUrl: 'http://localhost:8080/cb' })).status).toBe(200);

    const relaxed = await harness({ ALLOW_HTTP_CALLBACKS: 'true' });
    expect((await relaxed.call('POST', '/api/v3/orders', { amount: '1.00', callbackUrl: 'http://api:8080/cb' })).status).toBe(200);
  });

  it('looks an order up by id, by status and by RRN, and 404s an unknown one with 01000', async () => {
    const emulator = await harness();
    const rrn = randomUUID();
    const orderId = await emulator.createOrder({}, rrn);

    for (const path of [`/api/v3/orders/${orderId}`, `/api/v3/orders/${orderId}/status`, `/api/v3/orders/${rrn}/rrn`]) {
      const reply = await emulator.call('GET', path);
      expect(reply.payload.orderId).toBe(orderId);
      expect(reply.payload.paymentStatus).toBe('CREATED');
    }

    const missing = await emulator.call('GET', '/api/v3/orders/unknown');
    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ code: '01000', message: 'Order not found' });
  });

  it('expires an unpaid order on request and after its time to live', async () => {
    const emulator = await harness({ ORDER_TTL_MINUTES: '30' });
    const asked = await emulator.createOrder();
    expect((await emulator.call('PATCH', `/api/v3/expire-status?orderId=${asked}`)).status).toBe(200);
    expect((await emulator.call('GET', `/api/v3/orders/${asked}`)).payload.paymentStatus).toBe('EXPIRED');

    const stale = await emulator.createOrder();
    emulator.context.clock.advance(31 * 60_000);
    expect((await emulator.call('GET', `/api/v3/orders/${stale}`)).payload.paymentStatus).toBe('EXPIRED');
  });

  it('pays through the control API and reports the card masked', async () => {
    const emulator = await harness();
    const orderId = await emulator.createOrder();
    await emulator.pay(orderId, { pan: '5555555555554444', holder: 'AYSEL MAMMADOVA' });

    const order = await emulator.call('GET', `/api/v3/orders/${orderId}`);
    expect(order.payload).toMatchObject({ paymentStatus: 'APPROVED', paidAmount: 20.5, commission: 0.62 });
    expect(order.raw.body).toContain('"maskedPan":"555555******4444"');
    expect(order.raw.body).not.toContain('5555555555554444');
  });

  it('completes a pre-authorisation for no more than was authorised', async () => {
    const emulator = await harness();
    const orderId = await emulator.createOrder({ operation: 'PRE_AUTH', amount: '50.00' });
    await emulator.pay(orderId);
    expect((await emulator.call('GET', `/api/v3/orders/${orderId}`)).payload.paymentStatus).toBe('PREAUTH_APPROVED');

    const over = await emulator.call('POST', '/api/v3/complete', { orderId, amount: '60.00' });
    expect(over.json.code).toBe('01000');

    expect((await emulator.call('POST', '/api/v3/complete', { orderId, amount: '40.00' })).json.code).toBe('00000');
    const order = await emulator.call('GET', `/api/v3/orders/${orderId}`);
    expect(order.payload).toMatchObject({ paymentStatus: 'APPROVED', paidAmount: 40 });
  });

  it('lists transactions newest first, in pages', async () => {
    const emulator = await harness();
    const first = await emulator.createOrder();
    const second = await emulator.createOrder();
    await emulator.pay(first);
    await emulator.pay(second, { pan: '4000000000000002' });

    const listed = await emulator.call('GET', '/api/v3/transactions?page=0&offset=1');
    expect(listed.payload).toMatchObject({ totalElements: 2, totalPages: 2, size: 1, first: true, last: false });
    expect((listed.payload.content as Array<Record<string, unknown>>)[0]).toMatchObject({ orderId: second, paymentStatus: 'DECLINED' });
  });
});
