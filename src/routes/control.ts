import type { FastifyInstance } from 'fastify';
import { TEST_CARDS, digits, isCardBehaviour, passesLuhn } from '../cards.js';
import { DAY_MS, localDateTime, parseDuration } from '../clock.js';
import type { Context } from '../context.js';
import { invalid, notFound, success } from '../envelope.js';
import { parseJson } from '../money.js';
import { type Body, objectBody, optionalText } from '../request.js';
import type { Delivery, Fault } from '../state.js';

interface OrderRoute {
  Params: { orderId: string };
  Body: unknown;
}

function count(body: Body, field: string, fallback: number | null): number | null {
  const value = body[field];
  if (value === undefined || value === null) {
    return fallback;
  }
  const parsed = Number(String(value));
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw invalid(`${field} must be a non-negative integer`);
  }
  return parsed;
}

function delivery(entry: Delivery) {
  return {
    id: entry.id,
    orderId: entry.orderId,
    url: entry.url,
    paymentStatus: entry.paymentStatus,
    delivered: entry.delivered,
    pending: entry.pending,
    attempts: entry.attempts.map((attempt) => ({ ...attempt, at: attempt.at.toISOString() })),
    body: parseJson(entry.body),
  };
}

export async function controlRoutes(app: FastifyInstance, context: Context): Promise<void> {
  const { bank, callbacks, clock, config, state } = context;

  app.get('/', async () =>
    success({
      now: clock.now().toISOString(),
      clockOffsetMs: clock.offset,
      orders: state.orders.size,
      savedCards: state.savedCards.size,
      payouts: state.payouts.size,
      payoutBalance: state.balance,
      refundWindowDays: config.refundWindowDays,
      otp: config.otp,
      testCards: TEST_CARDS,
    }),
  );

  app.post('/reset', async () => {
    callbacks.close();
    state.reset();
    clock.reset();
    return success();
  });

  app.post('/clock', async (request) => {
    const body = objectBody(request.body);
    const advance = optionalText(body, 'advance');
    const ms = advance === null ? count(body, 'advanceMs', null) : parseDuration(advance);
    if (ms === null) {
      throw invalid('advance must be an ISO-8601 duration such as P31D or PT2H, or advanceMs a number');
    }
    clock.advance(ms);
    return success({ now: clock.now().toISOString(), clockOffsetMs: clock.offset });
  });

  app.delete('/clock', async () => {
    clock.reset();
    return success({ now: clock.now().toISOString(), clockOffsetMs: clock.offset });
  });

  app.get('/orders', async () =>
    success([...state.orders.values()].reverse().map((order) => bank.orderInfo(order))),
  );

  app.get<OrderRoute>('/orders/:orderId', async (request) => {
    const order = bank.order(request.params.orderId);
    return success({
      ...bank.orderInfo(order),
      requestRrn: order.requestRrn,
      callbackUrl: order.callbackUrl,
      paymentUrl: bank.paymentUrl(order),
      paidAt: order.paidAt ? localDateTime(order.paidAt) : null,
      callbacks: state.deliveries.filter((entry) => entry.orderId === order.orderId).map(delivery),
    });
  });

  app.post<OrderRoute>('/orders/:orderId/pay', async (request) => {
    const body = objectBody(request.body);
    const order = bank.order(request.params.orderId);
    const pan = digits(optionalText(body, 'pan') ?? '4111111111111111');
    if (!passesLuhn(pan)) {
      throw invalid('pan is not a valid card number');
    }
    const otp = optionalText(body, 'otp') ?? config.otp;
    bank.chargeCard(
      order,
      pan,
      optionalText(body, 'holder') ?? 'TEST CARDHOLDER',
      otp === config.otp ? undefined : '3-D Secure authentication failed',
    );
    return success(bank.orderInfo(order));
  });

  app.post<OrderRoute>('/orders/:orderId/cancel', async (request) => {
    const order = bank.cancel(bank.order(request.params.orderId));
    return success(bank.orderInfo(order));
  });

  app.post<OrderRoute>('/orders/:orderId/age', async (request) => {
    const days = count(objectBody(request.body), 'days', null);
    if (days === null) {
      throw invalid('days is required');
    }
    const order = bank.order(request.params.orderId);
    const shift = days * DAY_MS;
    order.createdAt = new Date(order.createdAt.getTime() - shift);
    if (order.paidAt) {
      order.paidAt = new Date(order.paidAt.getTime() - shift);
    }
    for (const transaction of order.transactions) {
      transaction.createdAt = new Date(transaction.createdAt.getTime() - shift);
    }
    return success(bank.orderInfo(order));
  });

  app.get('/callbacks', async () => success(state.deliveries.map(delivery)));

  app.post<OrderRoute>('/orders/:orderId/callback', async (request) => {
    const order = bank.order(request.params.orderId);
    const url = optionalText(objectBody(request.body), 'url') ?? order.callbackUrl;
    if (!url) {
      throw invalid('The order has no callbackUrl; pass url');
    }
    bank.notify(order, url);
    await callbacks.settled();
    const latest = state.deliveries.at(-1);
    return success(latest ? delivery(latest) : null);
  });

  app.patch<{ Params: { cardUuid: string }; Body: unknown }>('/cards/:cardUuid', async (request) => {
    const card = state.savedCards.get(request.params.cardUuid);
    if (!card) {
      throw notFound('Card');
    }
    const behaviour = objectBody(request.body).behaviour;
    if (!isCardBehaviour(behaviour)) {
      throw invalid('behaviour must be approve, decline, insufficient_funds or expired_card');
    }
    card.behaviour = behaviour;
    return success({ cardUuid: card.cardUuid, behaviour: card.behaviour });
  });

  app.get('/faults', async () => success(state.faults));

  app.post('/faults', async (request) => {
    const body = objectBody(request.body);
    const path = optionalText(body, 'path');
    if (path === null || !path.startsWith('/api/v3')) {
      throw invalid('path must start with /api/v3');
    }
    const status = count(body, 'status', 400);
    if (status === null || status < 200 || status > 599) {
      throw invalid('status must be an HTTP status');
    }
    const raw = optionalText(body, 'raw');
    const fault: Fault = {
      id: state.next(),
      method: optionalText(body, 'method')?.toUpperCase() ?? null,
      path,
      status,
      code: raw === null ? (optionalText(body, 'code') ?? '15000') : null,
      message: optionalText(body, 'message'),
      raw,
      delayMs: count(body, 'delayMs', 0) ?? 0,
      remaining: count(body, 'times', 1),
    };
    state.faults.push(fault);
    return success(fault);
  });

  app.delete('/faults', async () => {
    state.faults = [];
    return success();
  });
}
