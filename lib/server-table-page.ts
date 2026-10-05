import type { PageState } from './pagination';

/** Plain-data state accompanying rows already filtered, ordered and paged in SQL. */
export type ServerTablePage<K extends string> = {
  state: PageState;
  query: string;
  sort: K;
  dir: 'asc' | 'desc';
};

export type LoanSortKey = 'employee' | 'type' | 'principal' | 'instalment' | 'outstanding' | 'progress' | 'status';
export type AppliedLoanSortKey = 'payPeriod' | 'employee' | 'company' | 'amount' | 'createdOn';
