import formbody from '@fastify/formbody';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { Bank } from './bank.js';
import { Callbacks, type Send, httpSend } from './callbacks.js';
import { Clock } from './clock.js';
import type { Config } from './config.js';
import type { Context } from './context.js';
import { Code, PayriffError, envelope } from './envelope.js';
import { parseJson, toJson } from './money.js';
import { apiRoutes } from './routes/api.js';
import { controlRoutes } from './routes/control.js';
import { hostedRoutes } from './routes/hosted.js';
import { State } from './state.js';

export interface EmulatorOptions {
  config: Config;
  clock?: Clock;
  send?: Send;
  logger?: boolean;
}

export interface Emulator {
  app: FastifyInstance;
  context: Context;
}

export async function buildEmulator(options: EmulatorOptions): Promise<Emulator> {
  const { config } = options;
  const clock = options.clock ?? new Clock();
  const state = new State(config.payoutBalance);
  const callbacks = new Callbacks(state, config, clock, options.send ?? httpSend);
  const bank = new Bank(state, config, clock, callbacks);
  const context: Context = { config, clock, state, callbacks, bank };

  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 64 * 1024 });

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') {
      done(null, undefined);
      return;
    }
    try {
      done(null, parseJson(text));
    } catch {
      done(new PayriffError(400, Code.VALIDATION, 'Request body is not valid JSON'), undefined);
    }
  });
  app.setReplySerializer((payload) => toJson(payload));
  await app.register(formbody);

  app.setErrorHandler((error: FastifyError | PayriffError, request, reply) => {
    if (error instanceof PayriffError) {
      return reply.status(error.status).send(envelope(error.code, error.message));
    }
    if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.status(error.statusCode).send(envelope(Code.VALIDATION, error.message));
    }
    request.log.error(error);
    return reply.status(500).send(envelope(Code.INTERNAL, 'Internal Error'));
  });

  app.setNotFoundHandler((_request, reply) => reply.status(404).send(envelope(Code.REJECTED, 'Route not found')));

  app.get('/health', async () => ({ status: 'UP' }));
  await app.register(async (api) => apiRoutes(api, context), { prefix: '/api/v3' });
  await app.register(async (hosted) => hostedRoutes(hosted, context));
  await app.register(async (control) => controlRoutes(control, context), { prefix: '/_emulator' });

  app.addHook('onClose', async () => callbacks.close());

  return { app, context };
}
