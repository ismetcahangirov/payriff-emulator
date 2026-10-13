import { describe, expect, it } from 'vitest';
import { parseDuration } from '../src/clock.js';
import { harness } from './helpers.js';

describe('the control API', () => {
  it('injects a fault a given number of times, then answers normally', async () => {
    const emulator = await harness();
    const orderId = await emulator.createOrder();
    await emulator.call('POST', '/_emulator/faults', { method: 'GET', path: '/api/v3/orders', status: 503, code: '15000', times: 1 });

    expect((await emulator.call('GET', `/api/v3/orders/${orderId}`)).status).toBe(503);
    expect((await emulator.call('GET', `/api/v3/orders/${orderId}`)).status).toBe(200);
  });

  it('answers a raw body that is not an envelope', async () => {
    const emulator = await harness();
    await emulator.call('POST', '/_emulator/faults', { path: '/api/v3/refund', status: 502, raw: '<html>Bad Gateway</html>' });

    const reply = await emulator.call('POST', '/api/v3/refund', { orderId: 'x' });
    expect(reply.status).toBe(502);
    expect(reply.raw.body).toBe('<html>Bad Gateway</html>');
  });

  it('moves the clock and resets everything', async () => {
    const emulator = await harness();
    await emulator.createOrder();
    const moved = await emulator.call('POST', '/_emulator/clock', { advance: 'P31D' });
    expect(moved.payload.clockOffsetMs).toBe(31 * 86_400_000);

    await emulator.call('POST', '/_emulator/reset');
    const summary = await emulator.call('GET', '/_emulator');
    expect(summary.payload).toMatchObject({ orders: 0, clockOffsetMs: 0 });
  });

  it('shows an order with its callbacks', async () => {
    const emulator = await harness();
    const orderId = await emulator.createOrder();
    await emulator.pay(orderId);
    await emulator.context.callbacks.settled();

    const order = await emulator.call('GET', `/_emulator/orders/${orderId}`);
    expect(order.payload).toMatchObject({ paymentStatus: 'APPROVED', callbacks: [{ delivered: true }] });
    expect(order.raw.body).toContain('"amount":20.50');
  });

  it('parses ISO-8601 durations', () => {
    expect(parseDuration('P31D')).toBe(31 * 86_400_000);
    expect(parseDuration('PT2H30M')).toBe(9_000_000);
    expect(parseDuration('P1DT1S')).toBe(86_401_000);
    expect(parseDuration('P')).toBeNull();
    expect(parseDuration('31 days')).toBeNull();
  });

  it('answers health without a key', async () => {
    const emulator = await harness();
    const health = await emulator.app.inject({ method: 'GET', url: '/health' });
    expect(health.json()).toEqual({ status: 'UP' });
  });
});
