import { describe, expect, it } from 'vitest';
import { expiredBy } from '../src/routes/hosted.js';
import { CALLBACK, form, harness } from './helpers.js';

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const CARD = { pan: '4111 1111 1111 1111', holder: 'TEST CARDHOLDER', expiry: '12/39', cvv: '123' };

describe('the payment page', () => {
  it('takes a card and a 3-D Secure code, then sends the browser to the callback with a GET and posts the news', async () => {
    const emulator = await harness();
    const orderId = await emulator.createOrder({ description: 'A pledge' });

    const page = await emulator.app.inject({ method: 'GET', url: `/pay/${orderId}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('20.50 AZN');
    expect(page.body).toContain('A pledge');
    expect(page.body).toContain('Not Payriff. A local test tool: never enter a real card.');

    const otp = await emulator.app.inject({ method: 'POST', url: `/pay/${orderId}`, headers: FORM, payload: form(CARD) });
    expect(otp.statusCode).toBe(200);
    expect(otp.body).toContain('One-time code');

    const done = await emulator.app.inject({ method: 'POST', url: `/pay/${orderId}/otp`, headers: FORM, payload: form({ otp: '123456' }) });
    expect(done.statusCode).toBe(303);
    expect(done.headers.location).toBe(CALLBACK);

    await emulator.context.callbacks.settled();
    expect(emulator.sent).toHaveLength(1);
    expect(emulator.sent[0]?.url).toBe(CALLBACK);
    expect(emulator.sent[0]?.body).toMatchObject({ code: '00000', payload: { orderId, paymentStatus: 'APPROVED' } });
    expect(emulator.sent[0]?.raw).toContain('"amount":20.50');
  });

  it('declines a wrong 3-D Secure code', async () => {
    const emulator = await harness();
    const orderId = await emulator.createOrder();
    await emulator.app.inject({ method: 'POST', url: `/pay/${orderId}`, headers: FORM, payload: form(CARD) });
    await emulator.app.inject({ method: 'POST', url: `/pay/${orderId}/otp`, headers: FORM, payload: form({ otp: '000000' }) });

    const order = await emulator.call('GET', `/api/v3/orders/${orderId}`);
    expect(order.payload.paymentStatus).toBe('DECLINED');
    expect(order.raw.body).toContain('3-D Secure authentication failed');
  });

  it('asks again for a number that fails the Luhn check, as Payriff does', async () => {
    const emulator = await harness();
    const orderId = await emulator.createOrder();
    const retry = await emulator.app.inject({
      method: 'POST',
      url: `/pay/${orderId}`,
      headers: FORM,
      payload: form({ ...CARD, pan: '5200000000000000' }),
    });

    expect(retry.statusCode).toBe(422);
    expect(retry.body).toContain('The card number is not valid.');
    expect((await emulator.call('GET', `/api/v3/orders/${orderId}`)).payload.paymentStatus).toBe('CREATED');
  });

  it('declines with the test card outcome and with an expired card', async () => {
    const emulator = await harness();
    for (const [card, text] of [
      [{ ...CARD, pan: '4000000000009995' }, 'Insufficient funds'],
      [{ ...CARD, expiry: '01/20' }, 'Expired card'],
    ] as const) {
      const orderId = await emulator.createOrder();
      await emulator.app.inject({ method: 'POST', url: `/pay/${orderId}`, headers: FORM, payload: form(card) });
      await emulator.app.inject({ method: 'POST', url: `/pay/${orderId}/otp`, headers: FORM, payload: form({ otp: '123456' }) });
      const order = await emulator.call('GET', `/api/v3/orders/${orderId}`);
      expect(order.payload.paymentStatus).toBe('DECLINED');
      expect(order.raw.body).toContain(text);
    }
  });

  it('cancels, posts the news and returns the browser', async () => {
    const emulator = await harness();
    const orderId = await emulator.createOrder();
    const cancel = await emulator.app.inject({ method: 'POST', url: `/pay/${orderId}/cancel` });

    expect(cancel.statusCode).toBe(303);
    await emulator.context.callbacks.settled();
    expect(emulator.sent[0]?.body).toMatchObject({ payload: { paymentStatus: 'CANCELED' } });
  });

  it('shows the outcome instead of the form once an order is decided', async () => {
    const emulator = await harness();
    const orderId = await emulator.createOrder();
    await emulator.pay(orderId);

    const page = await emulator.app.inject({ method: 'GET', url: `/pay/${orderId}` });
    expect(page.body).toContain('APPROVED');
    expect(page.body).not.toContain('Card number');
  });

  it('reads an expiry as the end of its month', () => {
    const now = new Date(Date.UTC(2026, 9, 13));
    expect(expiredBy('10/26', now)).toBe(false);
    expect(expiredBy('09/26', now)).toBe(true);
    expect(expiredBy('13/26', now)).toBeNull();
    expect(expiredBy('1026', now)).toBeNull();
  });
});
