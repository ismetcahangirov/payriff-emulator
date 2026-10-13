import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { digits, passesLuhn } from '../cards.js';
import { localDateTime } from '../clock.js';
import type { Context } from '../context.js';
import { Code, PayriffError, envelope, invalid, rejected, success } from '../envelope.js';
import {
  type Body,
  callbackUrl,
  choice,
  flag,
  isUuid,
  metadata,
  objectBody,
  optionalAmount,
  optionalText,
  requiredAmount,
  requiredText,
} from '../request.js';
import { ZERO } from '../money.js';
import type { Order, PaymentStatus, Payout } from '../state.js';

const CURRENCIES = ['AZN', 'USD', 'EUR', 'PKR', 'AED', 'SAR'] as const;
const LANGUAGES = ['AZ', 'EN', 'RU', 'AR'] as const;
const OPERATIONS = ['PURCHASE', 'PRE_AUTH'] as const;

function header(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name.toLowerCase()];
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() ? first.trim() : null;
}

function requestRrn(request: FastifyRequest, body: Body): string {
  const rrn = header(request, 'X-REQUEST-RRN') ?? optionalText(body, 'requestRrn');
  if (rrn === null) {
    return randomUUID();
  }
  if (!isUuid(rrn)) {
    throw new PayriffError(500, Code.INTERNAL, 'Internal Error');
  }
  return rrn;
}

function page<T>(items: T[], query: Record<string, string | undefined>, sizeField: string) {
  const number = Math.max(0, Number.parseInt(query.page ?? '0', 10) || 0);
  const size = Math.min(100, Math.max(1, Number.parseInt(query[sizeField] ?? '10', 10) || 10));
  const totalPages = Math.max(1, Math.ceil(items.length / size));
  return {
    content: items.slice(number * size, number * size + size),
    totalElements: items.length,
    totalPages,
    number,
    size,
    first: number === 0,
    last: number >= totalPages - 1,
  };
}

function payoutStatus(payout: Payout) {
  return {
    bankName: payout.bankName,
    state: payout.state,
    cardPan: payout.maskedPan,
    transferAmount: payout.transferAmount,
    createdDate: localDateTime(payout.createdAt),
    formattedDate: localDateTime(payout.createdAt).replace('T', ' '),
    transferType: 'CARD',
    merchant: null,
    description: payout.description,
    fullName: payout.fullName,
    finCode: payout.finCode,
  };
}

export async function apiRoutes(api: FastifyInstance, context: Context): Promise<void> {
  const { bank, config, state } = context;

  api.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split('?')[0] ?? '';
    const fault = state.faults.find(
      (candidate) =>
        (candidate.method === null || candidate.method === request.method) &&
        path.startsWith(candidate.path) &&
        (candidate.remaining === null || candidate.remaining > 0),
    );
    if (fault) {
      if (fault.remaining !== null) {
        fault.remaining -= 1;
      }
      if (fault.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
      }
      if (fault.raw !== null) {
        return reply.status(fault.status).type('text/html').send(fault.raw);
      }
      if (fault.code !== null) {
        return reply.status(fault.status).send(envelope(fault.code, fault.message ?? 'Injected fault'));
      }
    }
    const key = header(request, 'Authorization');
    if (key === null || !config.secretKeys.includes(key)) {
      return reply.status(401).send(envelope(Code.INVALID_SECRET_KEY, 'Invalid secret key'));
    }
    return undefined;
  });

  const info = (order: Order) => success(bank.orderInfo(order));

  api.post('/orders', async (request) => {
    const body = objectBody(request.body);
    const rrn = requestRrn(request, body);
    const order = bank.createOrder({
      amount: requiredAmount(body, 'amount'),
      currency: choice(body, 'currency', CURRENCIES, 'AZN'),
      language: choice(body, 'language', LANGUAGES, 'AZ'),
      operation: choice(body, 'operation', OPERATIONS, 'PURCHASE'),
      description: optionalText(body, 'description'),
      callbackUrl: callbackUrl(optionalText(body, 'callbackUrl'), config.allowHttpCallbacks),
      cardSave: flag(body, 'cardSave'),
      requestRrn: rrn,
      metadata: metadata(body, 'metadata'),
    });
    return success({
      orderId: order.orderId,
      sessionId: order.sessionId,
      paymentUrl: bank.paymentUrl(order),
      previewUrl: null,
      transactionId: order.transactionId,
      comissionRate: config.commissionRate,
      amount: order.amount,
      fee: ZERO,
      totalAmount: order.amount,
    });
  });

  api.get<{ Params: { orderId: string } }>('/orders/:orderId', async (request) => info(bank.order(request.params.orderId)));

  api.get<{ Params: { orderId: string } }>('/orders/:orderId/status', async (request) =>
    info(bank.order(request.params.orderId)),
  );

  api.get<{ Params: { requestRrn: string } }>('/orders/:requestRrn/rrn', async (request) =>
    info(bank.orderByRrn(request.params.requestRrn)),
  );

  api.patch<{ Querystring: { orderId?: string } }>('/expire-status', async (request) => {
    const orderId = request.query.orderId ?? optionalText(objectBody(request.body), 'orderId');
    if (!orderId) {
      throw invalid('orderId is required');
    }
    bank.expire(orderId);
    return success();
  });

  api.post('/refund', async (request) => {
    const body = objectBody(request.body);
    bank.refund(
      requiredText(body, 'orderId'),
      optionalAmount(body, 'amount'),
      optionalText(body, 'refundReason'),
      optionalText(body, 'callbackUrl') === null
        ? null
        : callbackUrl(optionalText(body, 'callbackUrl'), config.allowHttpCallbacks),
    );
    return success();
  });

  api.post('/complete', async (request) => {
    const body = objectBody(request.body);
    bank.complete(requiredText(body, 'orderId'), optionalAmount(body, 'amount'));
    return success();
  });

  api.post('/autoPay', async (request) => {
    const body = objectBody(request.body);
    const order = bank.autoPay(requiredText(body, 'cardUuid'), {
      amount: requiredAmount(body, 'amount'),
      currency: choice(body, 'currency', CURRENCIES, 'AZN'),
      language: 'AZ',
      operation: choice(body, 'operation', OPERATIONS, 'PURCHASE'),
      description: optionalText(body, 'description'),
      callbackUrl: callbackUrl(optionalText(body, 'callbackUrl'), config.allowHttpCallbacks, false),
      requestRrn: requestRrn(request, body),
      metadata: null,
    });
    const orderInfo = bank.orderInfo(order);
    return success({
      orderId: order.orderId,
      paymentUrl: null,
      description: order.description,
      amount: order.amount,
      commission: orderInfo.commission,
      commissionRate: config.commissionRate,
      auto: true,
      paymentStatus: order.status,
      transactions: orderInfo.transactions,
    });
  });

  api.post('/cards/save', async (request) => {
    const body = objectBody(request.body);
    const save = bank.startCardSave(
      requiredText(body, 'customerRef'),
      callbackUrl(optionalText(body, 'callbackUrl'), config.allowHttpCallbacks),
      optionalText(body, 'description'),
      metadata(body, 'metadata'),
      header(request, 'X-Idempotency-Key'),
    );
    const order = bank.order(save.orderId);
    return success({
      cardSaveId: save.cardSaveId,
      orderId: order.orderId,
      sessionId: order.sessionId,
      paymentUrl: bank.paymentUrl(order),
      amount: order.amount,
    });
  });

  api.get<{ Params: { cardSaveId: string } }>('/cards/save/:cardSaveId', async (request) => {
    const { save, order, status } = bank.cardSave(request.params.cardSaveId);
    return success({
      cardSaveId: save.cardSaveId,
      orderId: order.orderId,
      status,
      cardUuid: order.card?.uuid ?? null,
      maskedPan: order.card?.maskedPan ?? null,
      cardBrand: order.card?.brand ?? null,
      amount: order.amount,
      customerRef: save.customerRef,
    });
  });

  api.get<{ Querystring: { customerRef?: string } }>('/cards/save', async (request) => {
    const customerRef = request.query.customerRef?.trim();
    if (!customerRef) {
      throw invalid('customerRef is required');
    }
    const cards = [...state.savedCards.values()]
      .filter((card) => !card.deleted && card.customerRef === customerRef)
      .map((card) => ({
        cardUuid: card.cardUuid,
        maskedPan: card.maskedPan,
        cardBrand: card.cardBrand,
        createdDate: localDateTime(card.createdAt),
      }));
    return success(cards);
  });

  api.delete<{ Params: { cardUuid: string } }>('/cards/:cardUuid', async (request) => {
    const card = state.savedCards.get(request.params.cardUuid);
    if (!card || card.deleted) {
      throw new PayriffError(404, Code.REJECTED, 'Card not found');
    }
    card.deleted = true;
    return success();
  });

  api.post('/payout', async (request) => {
    const outer = objectBody(request.body);
    if (optionalText(outer, 'merchant') !== config.merchantId) {
      throw rejected('Merchant not found');
    }
    const body = objectBody(outer.body);
    const transferAmount = requiredAmount(body, 'transferAmount');
    if (transferAmount.lt(1)) {
      throw invalid('transferAmount must be at least 1');
    }
    const cardPan = digits(requiredText(body, 'cardPan'));
    if (!/^\d{16}$/.test(cardPan) || !passesLuhn(cardPan)) {
      throw invalid('cardPan is not a valid card number');
    }
    const finCode = requiredText(body, 'finCode').toUpperCase();
    if (!/^[0-9A-Z]{7}$/.test(finCode)) {
      throw invalid('finCode must be seven letters and digits');
    }
    const rrn = optionalText(body, 'requestRrn') ?? header(request, 'X-IDEMPOTENCY-KEY') ?? randomUUID();
    const payout = bank.payout({
      requestRrn: rrn,
      transferAmount,
      description: requiredText(body, 'description'),
      fullName: requiredText(body, 'fullName'),
      finCode,
      cardPan,
    });
    return success({
      _final: 'true',
      state: payout.state,
      stateDescription: payout.stateDescription,
      currentDepositBalance: payout.balanceAfter,
      walletHistoryId: payout.id,
      bankName: payout.bankName,
    });
  });

  api.get<{ Params: { requestRrn: string } }>('/payout/info/:requestRrn', async (request) => {
    const payout = state.payouts.get(request.params.requestRrn);
    if (!payout) {
      throw new PayriffError(404, Code.REJECTED, 'Payout not found');
    }
    return success(payoutStatus(payout));
  });

  api.post('/payout/check-cardholder', async (request) => {
    const cardPan = digits(requiredText(objectBody(request.body), 'cardPan'));
    if (!/^\d{16}$/.test(cardPan) || !passesLuhn(cardPan)) {
      throw invalid('cardPan is not a valid card number');
    }
    return success('TEST C*******');
  });

  api.get<{ Querystring: Record<string, string | undefined> }>('/payouts', async (request) => {
    const wanted = request.query.status?.toUpperCase();
    const payouts = [...state.payouts.values()]
      .filter((payout) => !wanted || payout.state === wanted)
      .reverse()
      .map((payout) => ({
        id: payout.id,
        requestRrn: payout.requestRrn,
        transferAmount: payout.transferAmount,
        amountWithFee: payout.amountWithFee,
        fee: payout.fee,
        createdDate: localDateTime(payout.createdAt),
        state: payout.state,
        stateDescription: payout.stateDescription,
        cardPan: payout.maskedPan,
        finCode: payout.finCode,
        fullName: payout.fullName,
        description: payout.description,
      }));
    return success(page(payouts, request.query, 'size'));
  });

  api.get<{ Querystring: Record<string, string | undefined> }>('/transactions', async (request) => {
    const { orderId, status } = request.query;
    const transactions = [...state.orders.values()]
      .filter((order) => order.status !== 'CREATED')
      .filter((order) => !orderId || order.orderId === orderId)
      .filter((order) => !status || order.status === (status.toUpperCase() as PaymentStatus))
      .reverse()
      .map((order) => ({
        id: order.transactionId,
        orderId: order.orderId,
        amount: order.amount,
        currencyType: order.currency,
        paymentStatus: order.status,
        description: order.description,
        cardNumber: order.card?.maskedPan ?? null,
        card_brand: order.card?.brand ?? null,
        payment_way: order.transactions.at(-1)?.paymentWay ?? null,
        createdDate: localDateTime(order.createdAt),
      }));
    return success(page(transactions, request.query, 'offset'));
  });
}
