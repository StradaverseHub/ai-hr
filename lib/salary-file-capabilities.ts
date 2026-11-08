import { MY_BANKS, type MyBank } from './my-banks';

/** The current payment-submission catalogue owns availability. Legacy bank metadata is not a capability. */
export type SalaryFileCapability = { bankKey: string; available: boolean };
export function salaryFileBankGroups(formats: readonly SalaryFileCapability[], banks: readonly MyBank[] = MY_BANKS) {
  const supported = new Set(formats.filter(format => format.available).map(format => format.bankKey));
  return {
    supported: banks.filter(bank => supported.has(bank.key)),
    other: banks.filter(bank => !supported.has(bank.key)),
  };
}
