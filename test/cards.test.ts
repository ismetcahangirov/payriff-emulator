import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { passesLuhn } from '../src/cards.js';
import { TEST_CARDS } from '../src/cards.js';
import { harness } from './helpers.js';

describe('saved cards', () => {
  it('saves a card on an order that asks to, and charges it with autoPay', async () => {
    const emulator = await harness();
    const orderId = await emulator.createOrder({ cardSave: true });
    await emulator.pay(orderId);
    const order = await emulator.call('GET', `/api/v3/orders/${orderId}`);
    const transactions = order.payload.transactions as Array<{ cardDetails: { uuid: string } }>;
    const cardUuid = transactions[0]?.cardDetails.uuid;
    expect(cardUuid).toMatch(/^[0-9a-f-]{36}$/);

    const charged = await emulator.call('POST', '/api/v3/autoPay', { cardUuid, amount: 7.25, description: 'Monthly' }, { 'x-request-rrn': randomUUID() });
    expect(charged.json.code).toBe('00000');
    expect(charged.payload).toMatchObject({ auto: true, paymentStatus: 'APPROVED', paymentUrl: null });
    expect(charged.raw.body).toContain('"amount":7.25');
  });

  it('registers a card through /cards/save and lists it for its customer', async () => {
    const emulator = await harness();
    const started = await emulator.call('POST', '/api/v3/cards/save', { customerRef: 'backer-1', callbackUrl: 'https://merchant.test/cards' }, { 'x-idempotency-key': 'save-1' });
    const again = await emulator.call('POST', '/api/v3/cards/save', { customerRef: 'backer-1', callbackUrl: 'https://merchant.test/cards' }, { 'x-idempotency-key': 'save-1' });
    expect(again.payload.cardSaveId).toBe(started.payload.cardSaveId);

    const cardSaveId = String(started.payload.cardSaveId);
    expect((await emulator.call('GET', `/api/v3/cards/save/${cardSaveId}`)).payload.status).toBe('CREATED');

    await emulator.pay(String(started.payload.orderId));
    const verified = await emulator.call('GET', `/api/v3/cards/save/${cardSaveId}`);
    expect(verified.payload).toMatchObject({ status: 'VERIFIED', maskedPan: '411111******1111', customerRef: 'backer-1' });

    const listed = await emulator.call('GET', '/api/v3/cards/save?customerRef=backer-1');
    expect(listed.json.payload).toHaveLength(1);

    expect((await emulator.call('DELETE', `/api/v3/cards/${String(verified.payload.cardUuid)}`)).json.code).toBe('00000');
    expect((await emulator.call('GET', '/api/v3/cards/save?customerRef=backer-1')).json.payload).toHaveLength(0);
  });

  it('refuses autoPay on a deleted card and declines when the card is told to', async () => {
    const emulator = await harness();
    const orderId = await emulator.createOrder({ cardSave: true });
    await emulator.pay(orderId);
    const cardUuid = [...emulator.context.state.savedCards.keys()][0] ?? '';

    await emulator.call('PATCH', `/_emulator/cards/${cardUuid}`, { behaviour: 'insufficient_funds' });
    const declined = await emulator.call('POST', '/api/v3/autoPay', { cardUuid, amount: '3.00' });
    expect(declined.payload.paymentStatus).toBe('DECLINED');

    await emulator.call('DELETE', `/api/v3/cards/${cardUuid}`);
    const gone = await emulator.call('POST', '/api/v3/autoPay', { cardUuid, amount: '3.00' });
    expect(gone.status).toBe(404);
    expect(gone.json).toMatchObject({ code: '01000', message: 'Card not found' });
  });

  it('publishes only Luhn-valid test cards', () => {
    for (const card of TEST_CARDS) {
      expect(passesLuhn(card.pan), card.pan).toBe(true);
    }
  });
});
