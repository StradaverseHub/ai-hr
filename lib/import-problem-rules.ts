/**
 * Board d3ba1e9f (part 2: Bank and Statutory, Cost Center Allocations, Information-Only Correction) — the small
 * shared toolkit those three Error Log adapters use to turn an import's own English problem sentence into an
 * ImportProblemLine: which message key translates it, which field it names, and which common correction applies.
 *
 * Client-safe: no database, no React, no server-only imports (scale rule 7). The adapters run in the browser for
 * the check/result screens and on the server for the downloads, with the same translator shape, so the screen and
 * the file say the same thing.
 *
 * Wording: a sentence the rules recognise is shown through its message key, whose English text keeps today's
 * sentence; any other sentence is shown exactly as the import wrote it (never dropped, never paraphrased).
 */
import { parseDatabaseErrorRef } from './database-error-token';
import type { ImportProblemLine } from './import-problem-lines';

/** The messages namespace these adapters own (messages/*.json). */
export const IMPORT_PROBLEM_RULES_NS = 'importErrorLogDataBankCostInfo';

/**
 * A ROOT translator (full dotted keys): next-intl's useTranslations() / getTranslations(). `has` is used when
 * present to fall back to registry captions for a missing label key.
 */
export type ImportProblemText = ((key: string, values?: Record<string, unknown>) => string) & { has?: (key: string) => boolean };

/** Adapt a next-intl root translator (whose `values` type is narrower) to ImportProblemText without losing `has`. */
export function importProblemText(root: { (key: string, values?: never): string; has?: (key: string) => boolean }): ImportProblemText {
  const text = ((key: string, values?: Record<string, unknown>) => root(key, values as never)) as ImportProblemText;
  if (typeof root.has === 'function') text.has = (key: string) => root.has!(key);
  return text;
}

/** The common corrections (messages importErrorLogDataBankCostInfo.corrections.*). */
export type ImportCorrectionKey =
  | 'duplicateInFile' | 'duplicateEmployeeInFile' | 'chooseReference' | 'chooseCompany' | 'chooseCostCenter' | 'date'
  | 'required' | 'yesNo' | 'revalidate' | 'permission' | 'systemError' | 'textCode' | 'noFormula' | 'existingEmployee'
  | 'percentage' | 'periodUnit' | 'reason' | 'statutoryRecord' | 'template' | 'bankPair';

/** One recognised sentence. `key` is relative to the adapter's own sub-namespace; without a key the sentence is kept
 *  verbatim and the rule only names its field and correction. */
export type ImportProblemRule = {
  re: RegExp;
  key?: string;
  /** Correction chosen from the match (overrides `correction`). */
  correctionOf?: (m: RegExpExecArray) => ImportCorrectionKey | undefined;
  /** Message values from the match groups. */
  values?: (m: RegExpExecArray) => Record<string, string | number>;
  /** The field (adapter-specific column key) the sentence is about. */
  field?: string | ((m: RegExpExecArray) => string | undefined);
  /** The entered value the sentence quotes, when it quotes one. */
  value?: (m: RegExpExecArray) => string | undefined;
  correction?: ImportCorrectionKey;
};

export type MatchedProblem = { problem: string; field?: string; value?: string; correction?: string; matched: boolean };

/** Translate one sentence through the first matching rule, or keep it verbatim. */
export function matchProblem(message: string, rules: readonly ImportProblemRule[], scope: string, t: ImportProblemText): MatchedProblem {
  for (const rule of rules) {
    const m = rule.re.exec(message);
    if (!m) continue;
    const field = typeof rule.field === 'function' ? rule.field(m) : rule.field;
    const correction = rule.correctionOf?.(m) ?? rule.correction;
    return {
      problem: rule.key ? t(`${IMPORT_PROBLEM_RULES_NS}.${scope}.${rule.key}`, rule.values?.(m)) : message,
      field,
      value: rule.value?.(m),
      correction: correction ? correctionText(correction, t) : undefined,
      matched: true,
    };
  }
  return { problem: message, matched: false };
}

export const correctionText = (key: ImportCorrectionKey, t: ImportProblemText) => t(`${IMPORT_PROBLEM_RULES_NS}.corrections.${key}`);

/**
 * A sentence that carries a redacted-error reference (lib/public-error.ts, `DB-<kind>-<hex>`) is a system failure:
 * the screen and the log show the plain sentence in the viewer's language with the reference beside it.
 */
export function systemProblem(message: string, t: ImportProblemText): Pick<ImportProblemLine, 'problem' | 'correction' | 'errorReference' | 'stage'> | null {
  const parsed = parseDatabaseErrorRef(message);
  if (!parsed) return null;
  return { problem: t(`common.databaseError.${parsed.kind}`, { ref: parsed.ref }), correction: correctionText('systemError', t), errorReference: parsed.ref, stage: 'system' };
}

/** Escape text for use inside a RegExp. */
export const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
