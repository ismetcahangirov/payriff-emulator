import { randomUUID } from 'node:crypto';
import type { Callbacks } from './callbacks.js';
import { type CardBehaviour, OUTCOME_TEXT, behaviourOf, brandOf, mask } from './cards.js';
import { DAY_MS, type Clock, localDateTime } from './clock.js';
import type { Config } from './config.js';
import { Code, PayriffError, invalid, notFound, rejected, success } from './envelope.js';
import { Decimal, ZERO, cents, toJson } from './money.js';
import type {
  CardDetails,
  CardSave,
  CardSaveStatus,
  Operation,
  Order,
  PaymentStatus,
  Payout,
  SavedCard,
  State,
} from './state.js';

export interface NewOrder {
  amount: Decimal;
  currency: string;
  language: string;
  operation: Operation;
  description: string | null;
  callbackUrl: string;
  cardSave: boolean;
  requestRrn: string;
  metadata: Record<string, unknown> | null;
  customerRef?: string | null;
  cardSaveId?: string | null;
  auto?: boolean;
}

export interface Charge {
  pan: string | null;
  maskedPan: string;
  brand: string;
  holder: string | null;
  behaviour: CardBehaviour;
  paymentWay: string;
  failure?: string;
}

export interface NewPayout {
  requestRrn: string;
  transferAmount: Decimal;
  description: string;
  fullName: string;
  finCode: string;
  cardPan: string;
}

const REFUNDABLE: readonly PaymentStatus[] = ['APPROVED', 'PARTIAL_REFUND'];

export class Bank {
  constructor(
    readonly state: State,
    readonly config: Config,
    readonly clock: Clock,
    readonly callbacks: Callbacks,
  ) {}

  createOrder(input: NewOrder): Order {
    const existing = this.state.ordersByRrn.get(input.requestRrn);
    if (existing) {
      return this.order(existing);
    }
    const order: Order = {
      orderId: randomUUID(),
      sessionId: randomUUID(),
      transactionId: 100_000 + this.state.next(),
      requestRrn: input.requestRrn,
      amount: input.amount,
      currency: input.currency,
      language: input.language,
      operation: input.operation,
      description: input.description,
      callbackUrl: input.callbackUrl,
      cardSave: input.cardSave,
      customerRef: input.customerRef ?? null,
      cardSaveId: input.cardSaveId ?? null,
      metadata: input.metadata,
      status: 'CREATED',
      createdAt: this.clock.now(),
      paidAt: null,
      paidAmount: ZERO,
      refundedAmount: ZERO,
      card: null,
      auto: input.auto ?? false,
      pendingCard: null,
      transactions: [],
    };
    this.state.orders.set(order.orderId, order);
    this.state.ordersByRrn.set(order.requestRrn, order.orderId);
    return order;
  }

  order(orderId: string): Order {
    const order = this.state.orders.get(orderId);
    if (!order) {
      throw notFound('Order');
    }
    this.expireIfStale(order);
    return order;
  }

  orderByRrn(requestRrn: string): Order {
    const orderId = this.state.ordersByRrn.get(requestRrn);
    if (!orderId) {
      throw notFound('Order');
    }
    return this.order(orderId);
  }

  paymentUrl(order: Order): string {
    return `${this.config.publicUrl}/pay/${order.orderId}`;
  }

  settle(order: Order, charge: Charge): Order {
    if (order.status !== 'CREATED') {
      throw rejected(`Order is ${order.status} and cannot be paid`);
    }
    const approved = charge.behaviour === 'approve' && !charge.failure;
    const description = charge.failure ?? OUTCOME_TEXT[charge.behaviour];
    const card: CardDetails = {
      maskedPan: charge.maskedPan,
      brand: charge.brand,
      uuid: null,
      cardHolderName: charge.holder,
      phoneNumber: null,
    };
    if (approved && order.cardSave) {
      card.uuid = this.saveCard(order, charge).cardUuid;
    }
    const now = this.clock.now();
    order.card = card;
    order.pendingCard = null;
    order.status = approved ? (order.operation === 'PRE_AUTH' ? 'PREAUTH_APPROVED' : 'APPROVED') : 'DECLINED';
    if (approved) {
      order.paidAt = now;
      order.paidAmount = order.operation === 'PURCHASE' ? order.amount : ZERO;
    }
    order.transactions.push({
      status: approved ? order.status : 'DECLINED',
      operation: order.operation,
      amount: order.amount,
      requestRrn: order.requestRrn,
      responseRrn: this.rrn(),
      pan: charge.maskedPan,
      paymentWay: charge.paymentWay,
      responseDescription: description,
      createdAt: now,
      cardDetails: card,
    });
    this.notify(order);
    return order;
  }

  chargeCard(order: Order, pan: string, holder: string | null, failure?: string): Order {
    return this.settle(order, {
      pan,
      maskedPan: mask(pan),
      brand: brandOf(pan),
      holder,
      behaviour: behaviourOf(pan),
      paymentWay: 'CARD',
      ...(failure ? { failure } : {}),
    });
  }

  cancel(order: Order): Order {
    if (order.status !== 'CREATED') {
      throw rejected(`Order is ${order.status} and cannot be canceled`);
    }
    order.status = 'CANCELED';
    order.pendingCard = null;
    this.notify(order);
    return order;
  }

  expire(orderId: string): Order {
    const order = this.order(orderId);
    if (order.status !== 'CREATED') {
      throw rejected(`Order is ${order.status} and cannot be expired`);
    }
    order.status = 'EXPIRED';
    order.pendingCard = null;
    return order;
  }

  refund(orderId: string, requested: Decimal | null, reason: string | null, callbackUrl: string | null): Order {
    const order = this.order(orderId);
    if (!REFUNDABLE.includes(order.status) || !order.paidAt) {
      throw rejected(`Order is ${order.status} and cannot be refunded`);
    }
    if (this.clock.now().getTime() > order.paidAt.getTime() + this.config.refundWindowDays * DAY_MS) {
      throw rejected(`Refund time expired.\n Support ticket: ${this.ticket()}`);
    }
    const remaining = order.paidAmount.minus(order.refundedAmount);
    const amount = requested ?? remaining;
    if (amount.lte(0)) {
      throw invalid('amount must be positive');
    }
    if (amount.gt(remaining)) {
      throw rejected('Refund amount exceeds the payment');
    }
    order.refundedAmount = order.refundedAmount.plus(amount);
    order.status = order.refundedAmount.eq(order.paidAmount) ? 'REFUNDED' : 'PARTIAL_REFUND';
    order.transactions.push({
      status: order.status,
      operation: 'REFUND',
      amount,
      requestRrn: order.requestRrn,
      responseRrn: this.rrn(),
      pan: order.card?.maskedPan ?? null,
      paymentWay: order.transactions.at(-1)?.paymentWay ?? 'CARD',
      responseDescription: reason ?? 'Refunded',
      createdAt: this.clock.now(),
      cardDetails: order.card,
    });
    this.notify(order, callbackUrl ?? order.callbackUrl);
    return order;
  }

  complete(orderId: string, requested: Decimal | null): Order {
    const order = this.order(orderId);
    if (order.status !== 'PREAUTH_APPROVED') {
      throw rejected(`Order is ${order.status} and cannot be completed`);
    }
    const amount = requested ?? order.amount;
    if (amount.lte(0)) {
      throw invalid('amount must be positive');
    }
    if (amount.gt(order.amount)) {
      throw rejected('Complete amount exceeds the authorised amount');
    }
    const now = this.clock.now();
    order.status = 'APPROVED';
    order.paidAmount = amount;
    order.paidAt = now;
    order.transactions.push({
      status: 'APPROVED',
      operation: 'COMPLETE',
      amount,
      requestRrn: order.requestRrn,
      responseRrn: this.rrn(),
      pan: order.card?.maskedPan ?? null,
      paymentWay: 'CARD',
      responseDescription: 'Approved',
      createdAt: now,
      cardDetails: order.card,
    });
    this.notify(order);
    return order;
  }

  autoPay(cardUuid: string, input: Omit<NewOrder, 'cardSave'>): Order {
    const card = this.state.savedCards.get(cardUuid);
    if (!card || card.deleted) {
      throw notFound('Card');
    }
    const existing = this.state.ordersByRrn.get(input.requestRrn);
    if (existing) {
      return this.order(existing);
    }
    const order = this.createOrder({ ...input, cardSave: false, auto: true, customerRef: card.customerRef });
    this.settle(order, {
      pan: null,
      maskedPan: card.maskedPan,
      brand: card.cardBrand,
      holder: card.cardHolderName,
      behaviour: card.behaviour,
      paymentWay: 'AUTO_PAY',
    });
    if (order.card) {
      order.card.uuid = card.cardUuid;
    }
    return order;
  }

  startCardSave(
    customerRef: string,
    callbackUrl: string,
    description: string | null,
    metadata: Record<string, unknown> | null,
    idempotencyKey: string | null,
  ): CardSave {
    const known = idempotencyKey ? this.state.cardSavesByKey.get(idempotencyKey) : undefined;
    if (known) {
      const save = this.state.cardSaves.get(known);
      if (save) {
        return save;
      }
    }
    const cardSaveId = randomUUID();
    const order = this.createOrder({
      amount: ZERO,
      currency: 'AZN',
      language: 'AZ',
      operation: 'PURCHASE',
      description,
      callbackUrl,
      cardSave: true,
      requestRrn: randomUUID(),
      metadata,
      customerRef,
      cardSaveId,
    });
    const save: CardSave = { cardSaveId, orderId: order.orderId, customerRef, idempotencyKey };
    this.state.cardSaves.set(cardSaveId, save);
    if (idempotencyKey) {
      this.state.cardSavesByKey.set(idempotencyKey, cardSaveId);
    }
    return save;
  }

  cardSave(cardSaveId: string): { save: CardSave; order: Order; status: CardSaveStatus } {
    const save = this.state.cardSaves.get(cardSaveId);
    if (!save) {
      throw notFound('Card save');
    }
    const order = this.order(save.orderId);
    return { save, order, status: cardSaveStatus(order.status) };
  }

  payout(input: NewPayout): Payout {
    const existing = this.state.payouts.get(input.requestRrn);
    if (existing) {
      return existing;
    }
    const now = this.clock.now();
    const today = localDateTime(now).slice(0, 10);
    const paidToday = [...this.state.payouts.values()]
      .filter((payout) => payout.state === 'SUCCESS' && localDateTime(payout.createdAt).startsWith(today))
      .reduce((sum, payout) => sum.plus(payout.transferAmount), ZERO);
    if (paidToday.plus(input.transferAmount).gt(this.config.payoutDailyLimit)) {
      throw new PayriffError(400, Code.DAILY_PAYOUT_LIMIT, 'Daily payout limit exceeded');
    }
    const fee = cents(input.transferAmount.times(this.config.payoutFeeRate).div(100));
    const amountWithFee = input.transferAmount.plus(fee);
    if (this.state.balance.lt(amountWithFee)) {
      throw new PayriffError(400, Code.INSUFFICIENT_BALANCE, 'Insufficient balance');
    }
    const behaviour = behaviourOf(input.cardPan);
    const succeeded = behaviour === 'approve';
    if (succeeded) {
      this.state.balance = this.state.balance.minus(amountWithFee);
    }
    const payout: Payout = {
      id: this.state.next(),
      requestRrn: input.requestRrn,
      transferAmount: input.transferAmount,
      fee,
      amountWithFee,
      description: input.description,
      fullName: input.fullName,
      finCode: input.finCode,
      maskedPan: mask(input.cardPan),
      bankName: 'EMULATOR BANK',
      state: succeeded ? 'SUCCESS' : 'FAIL',
      stateDescription: succeeded ? 'Success' : OUTCOME_TEXT[behaviour],
      createdAt: now,
      balanceAfter: this.state.balance,
    };
    this.state.payouts.set(payout.requestRrn, payout);
    return payout;
  }

  orderInfo(order: Order): Record<string, unknown> {
    const commission = cents(order.paidAmount.times(this.config.commissionRate).div(100));
    return {
      orderId: order.orderId,
      invoiceUuid: null,
      externalTransactionId: null,
      amount: order.amount,
      currencyType: order.currency,
      merchantName: this.config.merchantName,
      operationType: order.operation,
      paymentStatus: order.status,
      auto: order.auto,
      createdDate: localDateTime(order.createdAt),
      description: order.description,
      commission,
      commissionRate: this.config.commissionRate,
      paidAmount: order.paidAmount,
      refundedAmount: order.refundedAmount,
      metadata: order.metadata ? toJson(order.metadata) : null,
      idempotencyKey: null,
      transactions: order.transactions.map((transaction) => ({
        status: transaction.status,
        operation: transaction.operation,
        amount: transaction.amount,
        channel: 'PAYRIFF',
        channelType: 'ECOM',
        requestRrn: transaction.requestRrn,
        responseRrn: transaction.responseRrn,
        externalRrn: null,
        pan: transaction.pan,
        paymentWay: transaction.paymentWay,
        recurrenceId: null,
        responseDescription: transaction.responseDescription,
        merchantCategory: null,
        createdDate: localDateTime(transaction.createdAt),
        cardDetails: transaction.cardDetails ? { ...transaction.cardDetails } : null,
      })),
    };
  }

  notify(order: Order, url: string = order.callbackUrl): void {
    if (!url) {
      return;
    }
    const body = toJson(success(this.orderInfo(order), order.status));
    this.callbacks.notify(order.orderId, url, order.status, body);
  }

  private saveCard(order: Order, charge: Charge): SavedCard {
    const card: SavedCard = {
      cardUuid: randomUUID(),
      maskedPan: charge.maskedPan,
      cardBrand: charge.brand,
      cardHolderName: charge.holder,
      behaviour: charge.behaviour,
      customerRef: order.customerRef,
      createdAt: this.clock.now(),
      deleted: false,
    };
    this.state.savedCards.set(card.cardUuid, card);
    return card;
  }

  private expireIfStale(order: Order): void {
    if (
      order.status === 'CREATED' &&
      this.clock.now().getTime() > order.createdAt.getTime() + this.config.orderTtlMinutes * 60_000
    ) {
      order.status = 'EXPIRED';
      order.pendingCard = null;
    }
  }

  private rrn(): string {
    return String(this.state.next()).padStart(12, '0');
  }

  private ticket(): number {
    return 840_000 + (this.state.next() % 160_000);
  }
}

export function cardSaveStatus(status: PaymentStatus): CardSaveStatus {
  switch (status) {
    case 'CREATED':
      return 'CREATED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'DECLINED':
    case 'CANCELED':
      return 'DECLINED';
    default:
      return 'VERIFIED';
  }
}
