import type { Clock } from './clock.js';
import type { Config } from './config.js';
import type { Delivery, State } from './state.js';

export type Send = (url: string, body: string, timeoutMs: number) => Promise<number>;

export const httpSend: Send = async (url, body, timeoutMs) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  await response.arrayBuffer().catch(() => undefined);
  return response.status;
};

export class Callbacks {
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly state: State,
    private readonly config: Config,
    private readonly clock: Clock,
    private readonly send: Send = httpSend,
  ) {}

  notify(orderId: string, url: string, paymentStatus: string, body: string): Delivery {
    const delivery: Delivery = {
      id: this.state.next(),
      orderId,
      url,
      paymentStatus,
      body,
      attempts: [],
      delivered: false,
      pending: true,
    };
    this.state.deliveries.push(delivery);
    this.attempt(delivery);
    return delivery;
  }

  async settled(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  close(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const delivery of this.state.deliveries) {
      delivery.pending = false;
    }
  }

  private attempt(delivery: Delivery): void {
    const run = this.deliver(delivery).finally(() => this.inFlight.delete(run));
    this.inFlight.add(run);
  }

  private async deliver(delivery: Delivery): Promise<void> {
    let httpStatus: number | null = null;
    let error: string | null = null;
    try {
      httpStatus = await this.send(delivery.url, delivery.body, this.config.callbackTimeoutMs);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    delivery.attempts.push({ at: this.clock.now(), httpStatus, error });
    if (httpStatus !== null && httpStatus >= 200 && httpStatus < 300) {
      delivery.delivered = true;
      delivery.pending = false;
      return;
    }
    const retriesMade = delivery.attempts.length - 1;
    if (retriesMade >= this.config.callbackRetries || !delivery.pending) {
      delivery.pending = false;
      return;
    }
    const delay = retriesMade === 0 ? this.config.callbackFirstRetryMs : this.config.callbackRetryMs;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.attempt(delivery);
    }, delay);
    timer.unref();
    this.timers.add(timer);
  }
}
