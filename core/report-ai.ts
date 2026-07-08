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
  'asc/desc), an optional groupBy field, and mark numeric/currency fields to total in a summary row.',
  'Respond with ONLY a single minified JSON object on one line, of the shape:',
  '{"spec":{"datasetId":"<id>","columns":["<fieldId>",...],"sort":{"field":"<fieldId>","dir":"asc|desc"},',
  '"groupBy":"<fieldId or omit>","layout":{"title":"<short title>","orientation":"portrait|landscape",',
  '"summary":["<numericFieldId>",...]}},"explanation":"<one short sentence>"}.',
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

export type ReportDraftResult = { spec: CustomReportSpec; explanation: string };

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

  const parsed = parseModelJson(raw);
  const rawSpec = parsed?.spec as Partial<CustomReportSpec> | undefined;
  const explanation = typeof parsed?.explanation === 'string' ? parsed.explanation.trim() : '';
  if (!parsed || !rawSpec) throw new ReportDraftError('invalid_output');

  // Force the datasetId to the one the caller selected (the model must not switch modules).
  const spec: CustomReportSpec = {
    datasetId: p.datasetId,
    columns: Array.isArray(rawSpec.columns) ? rawSpec.columns.filter((c) => typeof c === 'string') : [],
    sort: rawSpec.sort ?? null,
    groupBy: rawSpec.groupBy ?? null,
    filters: rawSpec.filters ?? undefined,
    layout: rawSpec.layout ?? null,
  };

  const v = validateReportSpec(spec);
  if (!v.ok || !explanation) throw new ReportDraftError('invalid_output');

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

  return { spec, explanation };
}

/** Referenced so the registry stays the single catalogue source in this module (lint: no-unused). */
export const AI_DESIGNER_DATASET_IDS = Object.keys(REPORT_DATASETS);
