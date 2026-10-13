export type CardBehaviour = 'approve' | 'decline' | 'insufficient_funds' | 'expired_card';

export interface TestCard {
  pan: string;
  brand: string;
  behaviour: CardBehaviour;
}

export const TEST_CARDS: readonly TestCard[] = [
  { pan: '4111111111111111', brand: 'VISA', behaviour: 'approve' },
  { pan: '5555555555554444', brand: 'MASTERCARD', behaviour: 'approve' },
  { pan: '4000000000000002', brand: 'VISA', behaviour: 'decline' },
  { pan: '4000000000009995', brand: 'VISA', behaviour: 'insufficient_funds' },
  { pan: '4000000000000069', brand: 'VISA', behaviour: 'expired_card' },
];

export const OUTCOME_TEXT: Record<CardBehaviour, string> = {
  approve: 'Approved',
  decline: 'Declined by the issuer',
  insufficient_funds: 'Insufficient funds',
  expired_card: 'Expired card',
};

export function digits(pan: string): string {
  return pan.replace(/[\s-]/g, '');
}

export function passesLuhn(pan: string): boolean {
  if (!/^\d{12,19}$/.test(pan)) {
    return false;
  }
  let sum = 0;
  for (let i = 0; i < pan.length; i++) {
    let digit = Number(pan[pan.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export function brandOf(pan: string): string {
  if (pan.startsWith('4')) {
    return 'VISA';
  }
  if (/^(5[1-5]|2[2-7])/.test(pan)) {
    return 'MASTERCARD';
  }
  return 'UNKNOWN';
}

export function mask(pan: string): string {
  return `${pan.slice(0, 6)}******${pan.slice(-4)}`;
}

export function behaviourOf(pan: string): CardBehaviour {
  return TEST_CARDS.find((card) => card.pan === pan)?.behaviour ?? 'approve';
}

export function isCardBehaviour(value: unknown): value is CardBehaviour {
  return typeof value === 'string' && value in OUTCOME_TEXT;
}
