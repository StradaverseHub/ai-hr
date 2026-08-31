/**
 * AI Report Designer (ADR-0074, feedback c440b365). DRAFT-ONLY, one-shot. Natural language → the SAME
 * declarative CustomReportSpec a hand-built report uses, validated by the SAME `validateReportSpec`.
 *
 * Mirrors core/pay-rule-ai.ts line for line:
 *   - short read-tx to resolveActiveAiConfig (null ⇒ feature OFF when unconfigured → typed error → the
 *     UI button simply doesn't light up: the feature FAILS CLOSED when no provider is configured);
 *   - the prompt contains ONLY the closed field catalogue + the admin's REDACTED sentence — NO employee
 *     row data ever leaves the tenant (the PDPA story: schema out, never data);
 *   - generateDraft OUTSIDE any tx, small maxTokens;
 *   - ONE shot: an invalid/unparseable output ⇒ a single typed error (no retry, no 2nd call);
 *   - NEVER writes a report — returns the spec + one-line explanation for the human to review/adjust/save;
 *   - appends a `custom-report.ai-drafted` event (actor { type: 'agent' }, PII-free payload).
 */
import { withTenant, type SessionContext } from '../db/client';
import { appendEvent } from '../db/events';
import { generateDraft, redactPII } from '../lib/ai';
import { resolveActiveAiConfig } from './ai-config';
import { getDataset, validateReportSpec, REPORT_DATASETS } from './report-registry';
import { recordProposal } from './agent-proposal';
import type { CustomReportSpec } from '../db/schema';

export class ReportDraftError extends Error {
  constructor(public readonly reason: 'not_configured' | 'invalid_output') {
    super(`report-draft:${reason}`);
    this.name = 'ReportDraftError';
  }
}

/** Serialise a single dataset's catalogue (ids + labels + types + filters) for the system prompt. */
function catalogueFor(datasetId: string): string {
  const ds = getDataset(datasetId);
  if (!ds) return '';
  const fields = ds.fields.map((f) => `${f.id} (${f.label}, ${f.type})`).join('; ');
  const filters = ds.filters.map((f) => `${f.id} (${f.kind})`).join('; ') || 'none';
  return `Dataset "${ds.id}" — fields: ${fields}. Allowed filters: ${filters}.`;
}

const SYSTEM = [
  'You design ONE tabular report for a Malaysian HR / payroll system by choosing columns from a FIXED',
  'field catalogue. You do NOT write SQL and you may ONLY use the exact field ids and filter ids given.',
  'Choose a sensible ordered subset of columns for the request, arranging identity columns first, then',
  'grouping related fields, and putting numeric/currency totals last. You may set a sort (one field +',
  'asc/desc), an optional groupBy field, and mark numeric/currency fields to total in a summary row and/or',
  'average in an averages row. Set an alignment per column following the rule: names/text → left, dates →',
  'center, numbers/currency → right, status → center. Also RECOMMEND (advisory, for the human): any extra',
  'useful field ids from the catalogue not already chosen, the best export format (excel|pdf|word|csv), and',
  'the best orientation.',
  'Respond with ONLY a single minified JSON object on one line, of the shape:',
  '{"spec":{"datasetId":"<id>","columns":["<fieldId>",...],"sort":{"field":"<fieldId>","dir":"asc|desc"},',
  '"groupBy":"<fieldId or omit>","layout":{"title":"<short title>","subtitle":"<short or omit>",',
  '"orientation":"portrait|landscape","align":{"<fieldId>":"left|center|right",...},',
  '"summary":["<numericFieldId>",...],"averages":["<numericFieldId>",...]}},',
  '"explanation":"<one short sentence>",',
  '"recommendations":{"extraColumns":["<fieldId>",...],"bestFormat":"excel|pdf|word|csv","note":"<short>"}}.',
  'Use ONLY field ids from the given dataset. No markdown, no code fences, no preamble.',
].join(' ');

function parseModelJson(text: string): { spec: unknown; explanation: unknown } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    return obj && typeof obj === 'object' ? (obj as { spec: unknown; explanation: unknown }) : null;
  } catch {
    return null;
  }
}

/** Advisory smart-recommendations returned alongside the drafted spec (the human decides what to apply). */
export type ReportRecommendations = {
  /** Field ids the AI suggests adding (validated against the dataset; unknown ids dropped). */
  extraColumns: { id: string; label: string }[];
  /** Suggested best export format for this report. */
  bestFormat: 'excel' | 'pdf' | 'word' | 'csv' | null;
  note: string | null;
};

export type ReportDraftResult = { spec: CustomReportSpec; explanation: string; recommendations: ReportRecommendations };

/**
 * Draft a report spec from a plain-language description. `datasetId` fixes which module the report is for
 * (the builder passes the currently-selected dataset). Returns the spec + explanation for the admin to
 * review; NEVER writes a report.
 */
export async function draftReportSpec(
  ctx: SessionContext,
  p: { datasetId: string; description: string },
): Promise<ReportDraftResult> {
  const ds = getDataset(p.datasetId);
  if (!ds) throw new ReportDraftError('invalid_output');

  const cfg = await withTenant(ctx, (tx) => resolveActiveAiConfig(tx, ctx));
  if (!cfg) throw new ReportDraftError('not_configured');

  // Only the catalogue for the chosen dataset + the redacted request leaves the tenant. No employee data.
  const prompt = [
    catalogueFor(p.datasetId),
    'The report request is:',
    redactPII(p.description),
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await generateDraft(cfg, { system: SYSTEM, prompt, maxTokens: 768 });

  const parsed = parseModelJson(raw) as
    | { spec?: Partial<CustomReportSpec>; explanation?: unknown; recommendations?: unknown }
    | null;
  const rawSpec = parsed?.spec as Partial<CustomReportSpec> | undefined;
  const explanation = typeof parsed?.explanation === 'string' ? parsed.explanation.trim() : '';
  // ADR-0084 §2.4 — `validateReportSpec` IS this surface's adjudicator, and there are TWO refusal points,
  // not one: output that will not parse at all, and output that parses into an invalid spec. They are
  // different failures (a provider problem versus a prompt problem) and a single blanket reason would
  // hide which one is happening. Both record BEFORE throwing, in the ledger's own transaction.
  const ledger = (reason: string | null, shape: Record<string, unknown>) =>
    recordProposal(ctx, {
      type: 'report_spec',
      // No subject: nothing is written until the admin saves the report.
      facts: { datasetId: p.datasetId },
      proposal: shape,
      adjudication: reason === null ? { ok: true } : { ok: false, reason },
      provider: cfg.provider,
      model: cfg.model,
    });

  if (!parsed || !rawSpec) {
    await ledger('unparseable_output', {});
    throw new ReportDraftError('invalid_output');
  }

  const fieldIds = new Set(ds.fields.map((f) => f.id));
  // Sanitise the AI's layout: keep only align entries for known fields; drop alignment for unknown ids.
  const rawLayout = (rawSpec.layout ?? null) as NonNullable<CustomReportSpec['layout']> | null;
  const cleanAlign = rawLayout?.align
    ? Object.fromEntries(Object.entries(rawLayout.align).filter(([k]) => fieldIds.has(k)))
    : undefined;
  const cleanSummary = Array.isArray(rawLayout?.summary) ? rawLayout!.summary.filter((f) => fieldIds.has(f)) : undefined;
  const cleanAverages = Array.isArray(rawLayout?.averages) ? rawLayout!.averages.filter((f) => fieldIds.has(f)) : undefined;

  // Force the datasetId to the one the caller selected (the model must not switch modules).
  const spec: CustomReportSpec = {
    datasetId: p.datasetId,
    columns: Array.isArray(rawSpec.columns) ? rawSpec.columns.filter((c) => typeof c === 'string') : [],
    sort: rawSpec.sort ?? null,
    groupBy: rawSpec.groupBy ?? null,
    filters: rawSpec.filters ?? undefined,
    layout: rawLayout
      ? {
          ...rawLayout,
          align: cleanAlign && Object.keys(cleanAlign).length ? cleanAlign : undefined,
          summary: cleanSummary,
          averages: cleanAverages,
        }
      : null,
  };

  const v = validateReportSpec(spec);
  // The spec's SHAPE is recorded, never its contents: column ids are a schema fact, but a filter value
  // can carry employee data, and this is a telemetry table (§2.3 — the facts are hashed, never stored).
  const shape = { datasetId: spec.datasetId, columnCount: spec.columns.length, hasFilters: Boolean(spec.filters) };
  await ledger(!v.ok ? `validate_report_spec:${v.reason}` : !explanation ? 'no_explanation' : null, shape);
  if (!v.ok || !explanation) throw new ReportDraftError('invalid_output');

  // Smart recommendations (advisory): validated extra columns, best export format, a short note.
  const rec = (parsed.recommendations ?? {}) as { extraColumns?: unknown; bestFormat?: unknown; note?: unknown };
  const labelById = new Map(ds.fields.map((f) => [f.id, f.label]));
  const chosen = new Set(spec.columns);
  const extraColumns = (Array.isArray(rec.extraColumns) ? rec.extraColumns : [])
    .filter((c): c is string => typeof c === 'string' && fieldIds.has(c) && !chosen.has(c))
    .map((id) => ({ id, label: labelById.get(id) ?? id }));
  const bestFormat = (['excel', 'pdf', 'word', 'csv'] as const).includes(rec.bestFormat as never)
    ? (rec.bestFormat as ReportRecommendations['bestFormat'])
    : null;
  const recommendations: ReportRecommendations = {
    extraColumns,
    bestFormat,
    note: typeof rec.note === 'string' ? rec.note.trim().slice(0, 240) : null,
  };

  await withTenant(ctx, (tx) =>
    appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'custom-report',
      aggregateId: ctx.tenantId, // pre-save draft: keyed to the tenant, no report row exists yet
      eventType: 'custom-report.ai-drafted',
      actor: { type: 'agent' },
      payload: { provider: cfg.provider, model: cfg.model, datasetId: p.datasetId, columnCount: spec.columns.length },
    }),
  );

  return { spec, explanation, recommendations };
}

/** Referenced so the registry stays the single catalogue source in this module (lint: no-unused). */
export const AI_DESIGNER_DATASET_IDS = Object.keys(REPORT_DATASETS);
