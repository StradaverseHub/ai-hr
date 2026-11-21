type ReprocessTaxIdentity = {
  employmentId: string;
  employeeCode: string | null;
  name: string;
};

export type ReprocessTaxEmployee = ReprocessTaxIdentity & (
  | { status: 'ready' | 'recalculating' }
  | { status: 'blocked'; reason: string; previousReviewReason: string | null }
);

export type ReprocessTaxReadiness = {
  employees: ReprocessTaxEmployee[];
  taxReviewHref: string | null;
};
