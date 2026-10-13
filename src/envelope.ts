import { randomUUID } from 'node:crypto';

export const Code = {
  SUCCESS: '00000',
  REJECTED: '01000',
  INSUFFICIENT_BALANCE: '01200',
  DAILY_PAYOUT_LIMIT: '01300',
  INVALID_SECRET_KEY: '14010',
  VALIDATION: '15400',
  INTERNAL: '15000',
} as const;

export class PayriffError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const rejected = (message: string, status = 400) => new PayriffError(status, Code.REJECTED, message);

export const invalid = (message: string) => new PayriffError(400, Code.VALIDATION, message);

export const notFound = (what: string) => new PayriffError(404, Code.REJECTED, `${what} not found`);

export function envelope(code: string, message: string, payload?: unknown): Record<string, unknown> {
  const body: Record<string, unknown> = {
    code,
    message,
    route: 'dashboard/main',
    responseId: randomUUID().replaceAll('-', ''),
    responseDetails: null,
  };
  if (payload !== undefined) {
    body.payload = payload;
  }
  return body;
}

export const success = (payload?: unknown, message = 'Operation performed successfully') =>
  envelope(Code.SUCCESS, message, payload);
