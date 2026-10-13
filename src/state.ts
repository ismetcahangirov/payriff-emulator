import type { CardBehaviour } from './cards.js';
import type { Decimal } from './money.js';

export type PaymentStatus =
  | 'CREATED'
  | 'APPROVED'
  | 'CANCELED'
  | 'DECLINED'
  | 'REFUNDED'
  | 'PREAUTH_APPROVED'
  | 'EXPIRED'
  | 'PARTIAL_REFUND';

export type Operation = 'PURCHASE' | 'PRE_AUTH';

export interface CardDetails {
  maskedPan: string;
  brand: string;
  uuid: string | null;
  cardHolderName: string | null;
  phoneNumber: string | null;
}

export interface OrderTransaction {
  status: string;
  operation: string;
  amount: Decimal;
  requestRrn: string;
  responseRrn: string;
  pan: string | null;
  paymentWay: string;
  responseDescription: string;
  createdAt: Date;
  cardDetails: CardDetails | null;
}

export interface PendingCard {
  pan: string;
  holder: string;
  failure: string | null;
}

export interface Order {
  orderId: string;
  sessionId: string;
  transactionId: number;
  requestRrn: string;
  amount: Decimal;
  currency: string;
  language: string;
  operation: Operation;
  description: string | null;
  callbackUrl: string;
  cardSave: boolean;
  customerRef: string | null;
  cardSaveId: string | null;
  metadata: Record<string, unknown> | null;
  status: PaymentStatus;
  createdAt: Date;
  paidAt: Date | null;
  paidAmount: Decimal;
  refundedAmount: Decimal;
  card: CardDetails | null;
  auto: boolean;
  pendingCard: PendingCard | null;
  transactions: OrderTransaction[];
}

export interface SavedCard {
  cardUuid: string;
  maskedPan: string;
  cardBrand: string;
  cardHolderName: string | null;
  behaviour: CardBehaviour;
  customerRef: string | null;
  createdAt: Date;
  deleted: boolean;
}

export type CardSaveStatus = 'CREATED' | 'VERIFIED' | 'DECLINED' | 'EXPIRED';

export interface CardSave {
  cardSaveId: string;
  orderId: string;
  customerRef: string;
  idempotencyKey: string | null;
}

export type TransferState = 'SUCCESS' | 'FAIL';

export interface Payout {
  id: number;
  requestRrn: string;
  transferAmount: Decimal;
  fee: Decimal;
  amountWithFee: Decimal;
  description: string;
  fullName: string;
  finCode: string;
  maskedPan: string;
  bankName: string;
  state: TransferState;
  stateDescription: string;
  createdAt: Date;
  balanceAfter: Decimal;
}

export interface DeliveryAttempt {
  at: Date;
  httpStatus: number | null;
  error: string | null;
}

export interface Delivery {
  id: number;
  orderId: string;
  url: string;
  paymentStatus: string;
  body: string;
  attempts: DeliveryAttempt[];
  delivered: boolean;
  pending: boolean;
}

export interface Fault {
  id: number;
  method: string | null;
  path: string;
  status: number;
  code: string | null;
  message: string | null;
  raw: string | null;
  delayMs: number;
  remaining: number | null;
}

export class State {
  orders = new Map<string, Order>();
  ordersByRrn = new Map<string, string>();
  savedCards = new Map<string, SavedCard>();
  cardSaves = new Map<string, CardSave>();
  cardSavesByKey = new Map<string, string>();
  payouts = new Map<string, Payout>();
  deliveries: Delivery[] = [];
  faults: Fault[] = [];
  balance: Decimal;
  private sequence = 0;

  constructor(private readonly initialBalance: Decimal) {
    this.balance = initialBalance;
  }

  next(): number {
    this.sequence += 1;
    return this.sequence;
  }

  reset(): void {
    this.orders.clear();
    this.ordersByRrn.clear();
    this.savedCards.clear();
    this.cardSaves.clear();
    this.cardSavesByKey.clear();
    this.payouts.clear();
    this.deliveries = [];
    this.faults = [];
    this.balance = this.initialBalance;
    this.sequence = 0;
  }
}
