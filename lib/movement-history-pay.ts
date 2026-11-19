import { PAYMENT_METHODS, type PaymentMethod } from './payment-methods';

export const MOVEMENT_HISTORY_PAY_FIELDS = ['basicSalary', 'paymentMethod'] as const;
export type HistoryPayField = (typeof MOVEMENT_HISTORY_PAY_FIELDS)[number];
export type HistoryPayFacts = Partial<Record<HistoryPayField, { before: string; after?: string }>>;

export const isMovementHistoryPayField = (field: string): field is HistoryPayField =>
  (MOVEMENT_HISTORY_PAY_FIELDS as readonly string[]).includes(field);

export function normaliseHistoryPayValue(field: HistoryPayField, value: string): string | null {
  if (field === 'paymentMethod') return PAYMENT_METHODS.includes(value as PaymentMethod) ? value : null;
  return /^\d{1,10}(?:\.\d{1,2})?$/.test(value) ? Number(value).toFixed(2) : null;
}
