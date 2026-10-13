import type { FastifyInstance, FastifyReply } from 'fastify';
import { digits, passesLuhn } from '../cards.js';
import type { Context } from '../context.js';
import { PayriffError } from '../envelope.js';
import { cardPage, otpPage, resultPage } from '../pages.js';
import type { Order } from '../state.js';

type Form = Record<string, string | undefined>;

interface PayRoute {
  Params: { orderId: string };
  Body: Form;
}

export function expiredBy(expiry: string, now: Date): boolean | null {
  const match = /^(\d{2})\s*\/\s*(\d{2})$/.exec(expiry.trim());
  if (!match) {
    return null;
  }
  const month = Number(match[1]);
  const year = 2000 + Number(match[2]);
  if (month < 1 || month > 12) {
    return null;
  }
  return Date.UTC(year, month, 1) <= now.getTime();
}

export async function hostedRoutes(app: FastifyInstance, context: Context): Promise<void> {
  const { bank, config, clock } = context;

  const html = (reply: FastifyReply, page: string, status = 200) =>
    reply.status(status).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(page);

  const lookUp = (orderId: string): Order | null => {
    try {
      return bank.order(orderId);
    } catch (error) {
      if (error instanceof PayriffError && error.status === 404) {
        return null;
      }
      throw error;
    }
  };

  const finish = (reply: FastifyReply, order: Order) =>
    order.callbackUrl ? reply.redirect(order.callbackUrl, 303) : html(reply, resultPage(order, config.merchantName));

  app.get<PayRoute>('/pay/:orderId', async (request, reply) => {
    const order = lookUp(request.params.orderId);
    if (!order) {
      return reply.status(404).type('text/plain').send('Order not found');
    }
    if (order.status !== 'CREATED') {
      return html(reply, resultPage(order, config.merchantName));
    }
    return html(reply, cardPage(order, config.merchantName));
  });

  app.post<PayRoute>('/pay/:orderId', async (request, reply) => {
    const order = lookUp(request.params.orderId);
    if (!order) {
      return reply.status(404).type('text/plain').send('Order not found');
    }
    if (order.status !== 'CREATED') {
      return html(reply, resultPage(order, config.merchantName), 409);
    }
    const form = request.body ?? {};
    const pan = digits(form.pan ?? '');
    const holder = (form.holder ?? '').trim();
    const expired = expiredBy(form.expiry ?? '', clock.now());
    const retry = (message: string) => html(reply, cardPage(order, config.merchantName, message), 422);
    if (!passesLuhn(pan)) {
      return retry('The card number is not valid.');
    }
    if (holder === '') {
      return retry('Enter the cardholder name.');
    }
    if (expired === null) {
      return retry('Enter the expiry date as MM/YY.');
    }
    if (!/^\d{3,4}$/.test((form.cvv ?? '').trim())) {
      return retry('Enter the three or four digit CVV.');
    }
    order.pendingCard = { pan, holder, failure: expired ? 'Expired card' : null };
    return html(reply, otpPage(order, config.merchantName, config.otp));
  });

  app.post<PayRoute>('/pay/:orderId/otp', async (request, reply) => {
    const order = lookUp(request.params.orderId);
    if (!order) {
      return reply.status(404).type('text/plain').send('Order not found');
    }
    const pending = order.pendingCard;
    if (order.status !== 'CREATED' || !pending) {
      return reply.redirect(`/pay/${order.orderId}`, 303);
    }
    const otpFailed = (request.body?.otp ?? '').trim() !== config.otp;
    bank.chargeCard(
      order,
      pending.pan,
      pending.holder,
      otpFailed ? '3-D Secure authentication failed' : (pending.failure ?? undefined),
    );
    return finish(reply, order);
  });

  app.post<PayRoute>('/pay/:orderId/cancel', async (request, reply) => {
    const order = lookUp(request.params.orderId);
    if (!order) {
      return reply.status(404).type('text/plain').send('Order not found');
    }
    if (order.status === 'CREATED') {
      bank.cancel(order);
    }
    return finish(reply, order);
  });
}
