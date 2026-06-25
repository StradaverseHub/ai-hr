/**
 * EPF five-category UI → three lawful enum mapping (ADR-0046, #2).
 *
 * The statutory card surfaces five named categories; KWSP/EPF Act only recognise three lawful shapes
 * (`auto | voluntary_excess | exempt`). This maps the UI selection down to the enum value + the rates
 * to persist, at the server boundary — the client never decides the persisted enum. Rates arrive as
 * percentages (e.g. 11) and are converted to decimals (0.11); a null rate keeps that side statutory.
 *
 * Manual (by fixed amount) is DEFERRED (no KWSP fixed-amount election); the UI option is disabled and
 * any stray submission is coerced defensively to `auto`. See docs/adr/0046-epf-five-category-ui-labels.md.
 */
import type { EpfMode } from '../localization/my/payroll';

export type EpfUiMode = 'auto' | 'manual_percentage' | 'semi_auto' | 'manual_fixed' | 'none';

export type EpfElectionFields = {
  epfMode: EpfMode;
  epfEmployeeRate: number | null;
  epfEmployerRate: number | null;
};

/** Convert a percentage form value (string|null) to a decimal rate, or null when absent/blank. */
function pct(v: string | number | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n / 100;
}

/** Map a UI category + raw rate inputs onto the lawful enum value and the rates to persist. */
export function mapEpfUiMode(
  uiMode: string | null | undefined,
  rawEmployeeRate: string | number | null | undefined,
  rawEmployerRate: string | number | null | undefined,
): EpfElectionFields {
  switch (uiMode) {
    case 'manual_percentage':
      return { epfMode: 'voluntary_excess', epfEmployeeRate: pct(rawEmployeeRate), epfEmployerRate: pct(rawEmployerRate) };
    case 'semi_auto':
      // Employee side elected; employer side forced statutory (null) — that's "semi-auto".
      return { epfMode: 'voluntary_excess', epfEmployeeRate: pct(rawEmployeeRate), epfEmployerRate: null };
    case 'none':
      return { epfMode: 'exempt', epfEmployeeRate: null, epfEmployerRate: null };
    // 'manual_fixed' is deferred (ADR-0046) and disabled in the UI; coerce defensively to auto.
    case 'auto':
    case 'manual_fixed':
    default:
      return { epfMode: 'auto', epfEmployeeRate: null, epfEmployerRate: null };
  }
}
