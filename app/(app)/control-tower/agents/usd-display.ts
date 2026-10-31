/**
 * Display-only reading of a stored nano-USD amount. The stored nanos are never changed here.
 * Unknown stays unknown (owner rule: unknown cost is never zero), a non-zero amount that would round to
 * US$0.00 is reported as below one cent, and everything else is shown in whole cents.
 */
export type UsdDisplay = {kind:'unknown'} | {kind:'belowCent'} | {kind:'amount';value:number};

const NANOS_PER_CENT = BigInt('10000000');
const HALF_CENT = BigInt('5000000');
const ZERO = BigInt(0);

export function usdDisplay(nanos:string|null|undefined):UsdDisplay {
  if (typeof nanos !== 'string' || !/^\d{1,30}$/.test(nanos)) return {kind:'unknown'};
  const amount = BigInt(nanos);
  if (amount === ZERO) return {kind:'amount',value:0};
  const cents = (amount + HALF_CENT) / NANOS_PER_CENT;
  return cents === ZERO ? {kind:'belowCent'} : {kind:'amount',value:Number(cents) / 100};
}
