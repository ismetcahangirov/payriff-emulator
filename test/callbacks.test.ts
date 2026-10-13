import { describe, expect, it } from 'vitest';
import { harness } from './helpers.js';

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('callbacks', () => {
  it('are unsigned JSON envelopes carrying the order', async () => {
    const emulator = await harness();
    const orderId = await emulator.createOrder();
    await emulator.pay(orderId);
    await emulator.context.callbacks.settled();

    expect(emulator.sent).toHaveLength(1);
    expect(Object.keys(emulator.sent[0]?.body ?? {})).toEqual(['code', 'message', 'route', 'responseId', 'responseDetails', 'payload']);
  });

  it('retry three times after a failure, then stop', async () => {
    const emulator = await harness();
    emulator.answers.push(500, 500, 500, 500, 500);
    const orderId = await emulator.createOrder();
    await emulator.pay(orderId);

    await until(() => emulator.context.state.deliveries[0]?.pending === false);
    const delivery = emulator.context.state.deliveries[0];
    expect(delivery?.attempts).toHaveLength(4);
    expect(delivery?.delivered).toBe(false);
  });

  it('stop retrying once the merchant answers 2xx', async () => {
    const emulator = await harness();
    emulator.answers.push(503, 200);
    const orderId = await emulator.createOrder();
    await emulator.pay(orderId);

    await until(() => emulator.context.state.deliveries[0]?.delivered === true);
    expect(emulator.context.state.deliveries[0]?.attempts.map((attempt) => attempt.httpStatus)).toEqual([503, 200]);
  });

  it('are sent again on request, to another address if asked', async () => {
    const emulator = await harness();
    const orderId = await emulator.createOrder();
    await emulator.pay(orderId);

    const resent = await emulator.call('POST', `/_emulator/orders/${orderId}/callback`, { url: 'https://elsewhere.test/cb' });
    expect(resent.payload).toMatchObject({ url: 'https://elsewhere.test/cb', delivered: true });
    expect(emulator.sent.at(-1)?.url).toBe('https://elsewhere.test/cb');
  });

  it('follow a refund to the callbackUrl it names', async () => {
    const emulator = await harness();
    const orderId = await emulator.createOrder();
    await emulator.pay(orderId);
    await emulator.call('POST', '/api/v3/refund', { orderId, callbackUrl: 'https://merchant.test/refunds' });
    await emulator.context.callbacks.settled();

    expect(emulator.sent.at(-1)).toMatchObject({ url: 'https://merchant.test/refunds', body: { payload: { paymentStatus: 'REFUNDED' } } });
  });
});
