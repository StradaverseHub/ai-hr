export const TXN_UNITS = ['amount', 'qty', 'hours', 'days', 'units'] as const;
export type TxnUnit = (typeof TXN_UNITS)[number];
export const isTxnUnit = (value: unknown): value is TxnUnit => TXN_UNITS.includes(value as TxnUnit);
