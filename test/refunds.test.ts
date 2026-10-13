import { describe, expect, it } from 'vitest';
import { DAY_MS } from '../src/clock.js';
import { harness } from './helpers.js';

describe('refunds', () => {
  it('refunds in full and keeps the commission', async () => {
    const emulator = await harness();
    const orderId = await emulator.createOrder({ amount: '10.00' });
    await emulator.pay(orderId);

    const refund = await emulator.call('POST', '/api/v3/refund', { orderId, amount: 10.0, refundReason: 'campaign_unsuccessful' });
    expect(refund.status).toBe(200);
    expect(refund.json.code).toBe('00000');

    const order = await emulator.call('GET', `/api/v3/orders/${orderId}`);
    expect(order.payload).toMatchObject({ paymentStatus: 'REFUNDED', refundedAmount: 10, commission: 0.3 });
  });

  it('refunds in parts and refuses more than is left with 01000', async () => {
    const emulator = await harness();
    const orderId = await emulator.createOrder({ amount: '10.00' });
    await emulator.pay(orderId);

    await emulator.call('POST', '/api/v3/refund', { orderId, amount: '4.00' });
    expect((await emulator.call('GET', `/api/v3/orders/${orderId}`)).payload.paymentStatus).toBe('PARTIAL_REFUND');

    const over = await emulator.call('POST', '/api/v3/refund', { orderId, amount: '6.01' });
    expect(over.status).toBe(400);
    expect(over.json).toMatchObject({ code: '01000', message: 'Refund amount exceeds the payment' });

    await emulator.call('POST', '/api/v3/refund', { orderId });
    expect((await emulator.call('GET', `/api/v3/orders/${orderId}`)).payload).toMatchObject({
      paymentStatus: 'REFUNDED',
      refundedAmount: 10,
    });
  });

  it('answers HTTP 400 01000 "Refund time expired" once the thirty days have passed', async () => {
    const emulator = await harness();
    const orderId = await emulator.createOrder();
    await emulator.pay(orderId);
    emulator.context.clock.advance(30 * DAY_MS + 1000);

    const late = await emulator.call('POST', '/api/v3/refund', { orderId, amount: '20.50' });

    expect(late.status).toBe(400);
    expect(late.json.code).toBe('01000');
    expect(String(late.json.message)).toMatch(/^Refund time expired\.\n Support ticket: \d{6}$/);
    expect(late.json).toMatchObject({ route: 'dashboard/main', responseDetails: null });
    expect(String(late.json.responseId)).toMatch(/^[0-9a-f]{32}$/);
    expect(late.json).not.toHaveProperty('payload');
  });

  it('still refunds on the last day of the window', async () => {
    const emulator = await harness();
    const orderId = await emulator.createOrder();
    await emulator.pay(orderId);
    emulator.context.clock.advance(30 * DAY_MS - 1000);

    expect((await emulator.call('POST', '/api/v3/refund', { orderId })).json.code).toBe('00000');
  });

  it('ages one order without moving the clock', async () => {
    const emulator = await harness();
    const old = await emulator.createOrder();
    const fresh = await emulator.createOrder();
    await emulator.pay(old);
    await emulator.pay(fresh);
    await emulator.call('POST', `/_emulator/orders/${old}/age`, { days: 31 });

    expect((await emulator.call('POST', '/api/v3/refund', { orderId: old })).json.code).toBe('01000');
    expect((await emulator.call('POST', '/api/v3/refund', { orderId: fresh })).json.code).toBe('00000');
  });

  it('refuses to refund an order that was never paid', async () => {
    const emulator = await harness();
    const orderId = await emulator.createOrder();

    const refund = await emulator.call('POST', '/api/v3/refund', { orderId });
    expect(refund.json).toMatchObject({ code: '01000', message: 'Order is CREATED and cannot be refunded' });
  });

  it('honours a configured window', async () => {
    const emulator = await harness({ REFUND_WINDOW_DAYS: '1' });
    const orderId = await emulator.createOrder();
    await emulator.pay(orderId);
    emulator.context.clock.advance(DAY_MS + 1000);

    expect((await emulator.call('POST', '/api/v3/refund', { orderId })).json.code).toBe('01000');
  });
});
