/**
 * Board 8d02748a — readable import log references. Pure, dependency-free and client-safe.
 *
 * Batch reference: a short batch number derived from the internal id (first 8 hex characters, upper case),
 * shown through the `importLog.batchLabel` message. It is display only: links, downloads, revert and paging
 * keep using the full internal id, so two batches sharing a short number is cosmetic.
 *
 * Imported by: the person recorded on the log row, with the Employee ID they held in the import's company on
 * the import date. Facts come from `app.import_log_actor_facts` (core/import-actor-label.ts); this file only
 * decides what to show. Wording is applied by the screen through next-intl, never here.
 */

export function importBatchCode(id: string): string {
  return id.replace(/-/g, '').slice(0, 8).toUpperCase();
}

export type ImportActor =
  | { kind: 'person'; name: string; employeeCode: string | null }
  | { kind: 'unlinked'; loginSuffix: string }
  | { kind: 'unavailable' };

export type ImportActorEmployment = {
  employeeCode: string | null;
  companyId: string | null;
  hiredOn: string;
  terminatedOn: string | null;
  lastWorkingDate: string | null;
};

/**
 * One Employee ID for the importer on the import date. Sibling of lib/current-employee-code.ts (the Users
 * directory rule, which is left unchanged): same active-on-date test, but one code, not a joined list.
 * Order: active on the date, then in one of the import's companies, then most recently hired.
 * When nothing was active that day, the most recently hired coded employment (still preferring the
 * import's companies). Null when the person has no coded employment.
 */
export function importActorEmployeeCode(
  employments: ImportActorEmployment[],
  importDate: string,
  companyIds: readonly string[],
): string | null {
  const companies = new Set(companyIds);
  const coded = employments.filter((e) => e.employeeCode?.trim());
  const active = (e: ImportActorEmployment) =>
    e.hiredOn <= importDate && !(e.terminatedOn && e.terminatedOn < importDate) && !(e.lastWorkingDate && e.lastWorkingDate < importDate);
  const ranked = [...coded].sort(
    (a, b) =>
      Number(active(b)) - Number(active(a)) ||
      Number(companies.has(b.companyId ?? '')) - Number(companies.has(a.companyId ?? '')) ||
      b.hiredOn.localeCompare(a.hiredOn),
  );
  return ranked[0]?.employeeCode?.trim() ?? null;
}

export type ImportActorFacts = {
  userExists: boolean;
  fullName: string | null;
  loginSuffix: string | null;
  importDate: string;
  companyIds: readonly string[];
  employments: ImportActorEmployment[];
};

export function importActorFromFacts(facts: ImportActorFacts | undefined): ImportActor {
  if (!facts) return { kind: 'unavailable' };
  const name = facts.fullName?.trim();
  if (name) return { kind: 'person', name, employeeCode: importActorEmployeeCode(facts.employments, facts.importDate, facts.companyIds) };
  if (facts.userExists) return { kind: 'unlinked', loginSuffix: facts.loginSuffix ?? '' };
  return { kind: 'unavailable' };
}

/** Minimal translator shape shared by next-intl's server and client `t` for the `importLog` namespace. */
type ImportLogTranslator = (key: 'actorWithId' | 'actorUnlinked' | 'actorUnavailable' | 'batchLabel', values?: Record<string, string>) => string;

export function formatImportActor(t: ImportLogTranslator, actor: ImportActor | null | undefined): string {
  if (!actor || actor.kind === 'unavailable') return t('actorUnavailable');
  if (actor.kind === 'unlinked') return t('actorUnlinked', { suffix: actor.loginSuffix });
  return actor.employeeCode ? t('actorWithId', { name: actor.name, employeeId: actor.employeeCode }) : actor.name;
}

export function formatImportBatch(t: ImportLogTranslator, id: string): string {
  return t('batchLabel', { code: importBatchCode(id) });
}
