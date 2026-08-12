'use client';

/**
 * Payroll Setup — the non-technical surface for the configurable pay-rule (the feedback's ask).
 *
 * 61bf109d — Input Type redesign + Formula Setting. The dropdown is now labelled INPUT TYPE and states how
 * the amount is MEASURED, in the words the ticket uses: a fixed amount · a quantity multiplied by a rate ·
 * a percentage of another amount · a number of days or hours worked · a value calculated by a formula.
 * Selecting one reveals only the fields that Input Type needs.
 *
 * There is STILL no textarea and no parser. The Formula Setting is a structured, row-based builder: a seed
 * operand followed by up to FORMULA_MAX_TERMS steps, each an operator plus an operand picked from the fixed,
 * named list (a fixed amount · basic salary · days worked · hours worked · another pay item). The rule it
 * produces is a VALUE serialised into the hidden `rule` field as JSON — the server re-validates it with the
 * same pure functions, and nothing anywhere evaluates a string.
 *
 * "Check against an employee" runs the candidate rule through the SERVER's previewPayRule, which calls the
 * same resolvePayComponentSet the payroll kernel calls. The preview therefore cannot drift from the run, and
 * it writes nothing. The panel shows the figures it used (basic, days, hours, referenced pay items) so the
 * result is checkable rather than magic.
 *
 * Live client-side validatePayRule (the SAME pure function the kernel uses) shows a Valid / error hint. The
 * catalog-aware failures (unknown pay item, cycle, statutory target) can only be judged against the catalog,
 * so they surface from the server on preview or on save — "Valid" here means STRUCTURALLY valid, and the
 * preview is what confirms the rest.
 *
 * The Prorates checkbox lives HERE (not in the flags row) because proration interacts with per-day/per-hour
 * rules — keeping them together lets the live validator surface the conflict as the admin toggles either one.
 */
import { useEffect, useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Plus, Sparkles, X } from 'lucide-react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Button, Field, inputCls } from '@/components/ui';
import {
  FORMULA_LABEL_MAX_LENGTH,
  FORMULA_MAX_TERMS,
  FORMULA_OPERAND_REFS,
  FORMULA_OPS,
  PAY_RULE_KINDS,
  formatPayRule,
  formatPayRuleOperand,
  validatePayRule,
  type FormulaOperand,
  type FormulaOp,
  type FormulaTerm,
  type PayRule,
  type PayRuleFormatLabels,
  type PayRuleKind,
  type PayRuleTraceStep,
} from '@/core/pay-rule';
import { draftPayRuleAction, previewPayRuleAction, searchPreviewEmployeesAction } from './actions';

/** A selectable pay item for the "another pay item" operand — code + display name, from the server. */
export type PayItemOption = { code: string; name: string };
/** A selectable employee for the preview. e318eaec — `employeeCode` is part of the shape because the option
 *  reads "Irwin Law (X000001)"; it used to read "null null" for everybody (core/pay-components.ts). */
export type PreviewEmployeeOption = { employmentId: string; name: string; employeeCode: string | null };

type Props = {
  code: string;
  kind: string;
  prorates: boolean;
  rule: PayRule | null;
  aiEnabled: boolean;
  /** Other ACTIVE pay items in this tenant's catalog (this one excluded) — the reference picker's options. */
  payItems: PayItemOption[];
  /** Employees the rule can be previewed against. */
  previewEmployees: PreviewEmployeeOption[];
};

const num = (v: string): number => (v.trim() === '' ? NaN : Number(v));
const money = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** e318eaec — the WORKING carries four decimals and only the final figure is rounded to the cent, which is
 *  what payroll itself does: rounding every intermediate step would print a chain that does not add up. */
const money4 = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
/** A literal on the formula line: 26, 8, 1.5 — never padded to "26.00", which would read as money. */
const plain = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });
/** e318eaec — the employee option label the ticket asks for: full name then employee ID. */
const employeeLabel = (e: PreviewEmployeeOption) => (e.employeeCode ? `${e.name} (${e.employeeCode})` : e.name);

const OP_KEY: Record<FormulaOp, string> = { '+': 'op_add', '-': 'op_sub', '*': 'op_mul', '/': 'op_div' };

/**
 * One formula operand: the ref picker, plus the value/code input for the two refs that carry data.
 *
 * Declared at MODULE scope, not inside PayRuleEditor. A component created during a render is a new type on
 * every render, so React unmounts and remounts it on each keystroke — which would drop focus out of the
 * number field mid-typing. (react-hooks/static-components catches exactly this.)
 */
function OperandFields({
  op,
  onChange,
  payItems,
}: {
  op: FormulaOperand;
  onChange: (o: FormulaOperand) => void;
  payItems: PayItemOption[];
}) {
  const t = useTranslations('payRule');
  return (
    <>
      <select
        value={op.ref}
        onChange={(e) => {
          const ref = e.target.value as FormulaOperand['ref'];
          if (ref === 'number') onChange({ ref: 'number', value: 0 });
          else if (ref === 'component') onChange({ ref: 'component', code: payItems[0]?.code ?? '' });
          else onChange({ ref } as FormulaOperand);
        }}
        className={inputCls}
        aria-label={t('formulaStart')}
      >
        {FORMULA_OPERAND_REFS.map((r) => (
          <option key={r} value={r}>
            {t(`operand_${r}`)}
          </option>
        ))}
      </select>
      {op.ref === 'number' ? (
        <input
          type="number"
          step="0.01"
          min="0"
          value={String(op.value)}
          onChange={(e) =>
            onChange({
              ref: 'number',
              value: e.target.value.trim() === '' ? NaN : Number(e.target.value),
              // Keep the name attached to its number when the figure is retyped.
              ...(op.label ? { label: op.label } : {}),
            })
          }
          className={inputCls}
          aria-label={t('operand_number')}
        />
      ) : op.ref === 'component' ? (
        <select
          value={op.code}
          onChange={(e) => onChange({ ref: 'component', code: e.target.value })}
          className={inputCls}
          aria-label={t('componentLabel')}
        >
          <option value="">{t('componentPlaceholder')}</option>
          {payItems.map((p) => (
            <option key={p.code} value={p.code}>
              {p.code} — {p.name}
            </option>
          ))}
        </select>
      ) : (
        <span />
      )}
      {/* e318eaec — NAME THIS NUMBER. The reporter's complaint in one box: 26, 8 and 1.5 all read "A fixed
          amount" and nothing says which is a working-day divisor, which is an hours divisor and which is an
          overtime rate. The name is stored ON the operand and is DISPLAY ONLY — it never reaches
          resolvePayRule, so naming a number cannot move a cent. Empty ⇒ the key is dropped entirely, so an
          unnamed number serialises exactly as it always has and a stored rule is untouched by this feature
          until someone types in this box. */}
      {op.ref === 'number' ? (
        <input
          type="text"
          maxLength={FORMULA_LABEL_MAX_LENGTH}
          value={op.label ?? ''}
          onChange={(e) => {
            const label = e.target.value;
            onChange(label.trim() === '' ? { ref: 'number', value: op.value } : { ref: 'number', value: op.value, label });
          }}
          placeholder={t('numberLabelPlaceholder')}
          className={inputCls}
          aria-label={t('numberLabel')}
        />
      ) : (
        <span />
      )}
    </>
  );
}

export function PayRuleEditor({
  code,
  kind: componentKind,
  prorates: initialProrates,
  rule: initialRule,
  aiEnabled,
  payItems,
  previewEmployees,
}: Props) {
  const t = useTranslations('payRule');
  const tc = useTranslations('payComponents');
  const [kind, setKind] = useState<PayRuleKind>(initialRule?.kind ?? 'fixed');
  const [prorates, setProrates] = useState(initialProrates);
  const [pct, setPct] = useState(initialRule?.kind === 'percent_of' ? String(initialRule.pct) : '');
  const [pctBase, setPctBase] = useState<'basic' | 'component'>(
    initialRule?.kind === 'percent_of' && initialRule.base === 'component' ? 'component' : 'basic',
  );
  const [pctCode, setPctCode] = useState(
    initialRule?.kind === 'percent_of' && initialRule.base === 'component' ? (initialRule.componentCode ?? '') : '',
  );
  const [rate, setRate] = useState(
    initialRule?.kind === 'per_day' || initialRule?.kind === 'per_hour' || initialRule?.kind === 'qty_rate'
      ? String(initialRule.rate)
      : '',
  );
  const [qty, setQty] = useState(initialRule?.kind === 'qty_rate' ? String(initialRule.qty) : '');
  const [value, setValue] = useState(initialRule?.kind === 'flat_capped' ? String(initialRule.value) : '');
  const [cap, setCap] = useState(initialRule?.kind === 'flat_capped' ? String(initialRule.cap) : '');
  // Formula state: a seed operand plus an ordered list of steps.
  const [start, setStart] = useState<FormulaOperand>(initialRule?.kind === 'formula' ? initialRule.start : { ref: 'basic' });
  const [terms, setTerms] = useState<FormulaTerm[]>(initialRule?.kind === 'formula' ? initialRule.terms : []);
  const [aiOpen, setAiOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [pending, startTransition] = useTransition();
  // Preview state.
  const [previewEmp, setPreviewEmp] = useState<PreviewEmployeeOption | null>(previewEmployees[0] ?? null);
  // e318eaec — SERVER-SIDE employee search (the ticket asks for it, and the old control was a bare
  // "fifty most recently hired" window with no way to reach anyone else). `query` is what the operator
  // typed; `found` is the server's answer; the initial list is what the page already loaded.
  const [empQuery, setEmpQuery] = useState('');
  const [found, setFound] = useState<PreviewEmployeeOption[]>(previewEmployees);
  const [searching, startSearch] = useTransition();
  const [preview, setPreview] = useState<
    | {
        ok: true;
        amount: number;
        scope: { basic: number; days: number; hours: number };
        inputs: { code: string; amount: number }[];
        zeroDivisor: string | null;
        steps: PayRuleTraceStep[];
      }
    | { ok: false; message: string }
    | null
  >(null);
  const [previewing, startPreview] = useTransition();

  // Build the candidate rule from the current fields (fixed ⇒ null = legacy behaviour).
  const rule = useMemo<PayRule | null>(() => {
    switch (kind) {
      case 'fixed':
        return null;
      case 'percent_of':
        return pctBase === 'component'
          ? { kind: 'percent_of', base: 'component', componentCode: pctCode, pct: num(pct) }
          : { kind: 'percent_of', base: 'basic', pct: num(pct) };
      case 'per_day':
        return { kind: 'per_day', rate: num(rate) };
      case 'per_hour':
        return { kind: 'per_hour', rate: num(rate) };
      case 'flat_capped':
        return { kind: 'flat_capped', value: num(value), cap: num(cap) };
      case 'qty_rate':
        return { kind: 'qty_rate', qty: num(qty), rate: num(rate) };
      case 'formula':
        return { kind: 'formula', start, terms };
      default:
        return null;
    }
  }, [kind, pct, pctBase, pctCode, rate, qty, value, cap, start, terms]);

  const validation = validatePayRule(rule, prorates);
  const hint = validation.ok
    ? { ok: true as const, text: t('valid') }
    : { ok: false as const, text: t(`errors.${validation.code}`) };

  /**
   * e318eaec — how a formula is DRAWN, in one place, for both the live line below and the working in the
   * preview panel. Passing the same labels to core's formatPayRule is what stops the two from describing
   * one formula two different ways in any of the six locales.
   */
  const formatLabels = useMemo<PayRuleFormatLabels>(
    () => ({
      operand: (ref) => t(`operand_${ref}`),
      payItem: (c) => payItems.find((p) => p.code === c)?.name ?? null,
      number: plain,
    }),
    [payItems, t],
  );
  /**
   * THE READABLE FORMULA LINE — the ticket's headline ask, and the one place the precedence trap lives.
   *
   * The brackets DESCRIBE the order the steps already run in; they do not introduce precedence. The stored
   * rule is a left-to-right fold and stays one, which is why the reporter's Overtime 1.5 keeps paying
   * exactly what it pays today. See the long note above formatPayRule in core/pay-rule.ts.
   */
  const formulaLine = useMemo(() => formatPayRule(rule, formatLabels), [rule, formatLabels]);

  // Debounced server-side employee search. 250ms so a fast typist issues one query, not eight.
  useEffect(() => {
    const q = empQuery.trim();
    const timer = setTimeout(() => {
      startSearch(async () => setFound(await searchPreviewEmployeesAction(q)));
    }, 250);
    return () => clearTimeout(timer);
  }, [empQuery]);

  /** The dropdown's options: what the search returned, with the CURRENT selection kept in the list even when
   *  it no longer matches — narrowing a search must never silently re-point the preview at someone else. */
  const employeeOptions = useMemo(() => {
    if (!previewEmp || found.some((e) => e.employmentId === previewEmp.employmentId)) return found;
    return [previewEmp, ...found];
  }, [found, previewEmp]);

  function applyRule(r: PayRule) {
    setKind(r.kind);
    if (r.kind === 'percent_of') {
      setPct(String(r.pct));
      setPctBase(r.base === 'component' ? 'component' : 'basic');
      setPctCode(r.base === 'component' ? (r.componentCode ?? '') : '');
    }
    if (r.kind === 'per_day' || r.kind === 'per_hour') setRate(String(r.rate));
    if (r.kind === 'qty_rate') {
      setQty(String(r.qty));
      setRate(String(r.rate));
    }
    if (r.kind === 'flat_capped') {
      setValue(String(r.value));
      setCap(String(r.cap));
    }
    if (r.kind === 'formula') {
      setStart(r.start);
      setTerms(r.terms);
    }
  }

  function onAssist() {
    startTransition(async () => {
      const res = await draftPayRuleAction({ description, componentCode: code || null, componentProrates: prorates });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      if (res.rule) {
        applyRule(res.rule);
        setAiOpen(false);
        toast.success(res.explanation ?? t('assistResultTitle'));
      }
    });
  }

  function onPreview() {
    if (!previewEmp) return;
    startPreview(async () => {
      const res = await previewPayRuleAction({
        code,
        kind: componentKind,
        prorates,
        rule,
        employmentId: previewEmp.employmentId,
      });
      setPreview(res.ok ? res : { ok: false, message: res.message });
    });
  }

  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-3 sm:col-span-3">
      {/* Serialised rule for the server action. Empty when fixed ⇒ null rule (legacy behaviour). */}
      <input type="hidden" name="rule" value={rule ? JSON.stringify(rule) : ''} />

      <div className="flex items-center justify-between gap-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('sectionTitle')}</h4>
        {aiEnabled && (
          <Button type="button" variant="secondary" size="sm" onClick={() => setAiOpen(true)} className="shrink-0">
            <Sparkles className="size-3.5" />
            {t('assistButton')}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t('sectionHint')}</p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label={t('kindLabel')}>
          <select value={kind} onChange={(e) => setKind(e.target.value as PayRuleKind)} className={inputCls}>
            {PAY_RULE_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`kind_${k}`)}
              </option>
            ))}
          </select>
        </Field>

        {kind === 'percent_of' && (
          <>
            <Field label={t('pctLabel')}>
              <input type="number" min="0" step="0.01" value={pct} onChange={(e) => setPct(e.target.value)} className={inputCls} />
            </Field>
            <Field label={t('baseLabel')}>
              <select value={pctBase} onChange={(e) => setPctBase(e.target.value as 'basic' | 'component')} className={inputCls}>
                <option value="basic">{t('base_basic')}</option>
                <option value="component">{t('base_component')}</option>
              </select>
            </Field>
            {pctBase === 'component' && (
              <Field label={t('componentLabel')}>
                <select value={pctCode} onChange={(e) => setPctCode(e.target.value)} className={inputCls}>
                  <option value="">{t('componentPlaceholder')}</option>
                  {payItems.map((p) => (
                    <option key={p.code} value={p.code}>
                      {p.code} — {p.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </>
        )}
        {kind === 'qty_rate' && (
          <>
            <Field label={t('qtyLabel')}>
              <input type="number" min="0" step="0.01" value={qty} onChange={(e) => setQty(e.target.value)} className={inputCls} />
            </Field>
            <Field label={t('rateLabel')}>
              <input type="number" min="0" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} className={inputCls} />
            </Field>
          </>
        )}
        {kind === 'per_day' && (
          <Field label={t('rateDayLabel')}>
            <input type="number" min="0" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} className={inputCls} />
          </Field>
        )}
        {kind === 'per_hour' && (
          <Field label={t('rateHourLabel')}>
            <input type="number" min="0" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} className={inputCls} />
          </Field>
        )}
        {kind === 'flat_capped' && (
          <>
            <Field label={t('valueLabel')}>
              <input type="number" min="0" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} className={inputCls} />
            </Field>
            <Field label={t('capLabel')}>
              <input type="number" min="0" step="0.01" value={cap} onChange={(e) => setCap(e.target.value)} className={inputCls} />
            </Field>
          </>
        )}
      </div>

      {/* ── Formula Setting ────────────────────────────────────────────────────────────────────────
          A seed operand plus ordered steps. No free text: every operand comes from the fixed, named list
          and every operator from FORMULA_OPS, so the admin cannot author something the validator has not
          seen. Steps apply top-to-bottom with no hidden operator precedence. */}
      {kind === 'formula' && (
        <div className="space-y-3 rounded-lg border border-border bg-background/60 p-3">
          <div className="flex items-center justify-between gap-3">
            <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('formulaTitle')}</h5>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={terms.length >= FORMULA_MAX_TERMS}
              onClick={() => setTerms([...terms, { op: '+', operand: { ref: 'number', value: 0 } }])}
            >
              <Plus className="size-3.5" />
              {t('formulaAddStep')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('formulaHint')}</p>

          {/* ── e318eaec — THE FORMULA, READ BACK ────────────────────────────────────────────────────
              "There is no line anywhere that reads the formula back to you as a formula." This is it, and
              it updates as steps are added, removed or changed because it is derived from the same `rule`
              value the hidden field submits — there is no second state to keep in sync.
              THE BRACKETS DESCRIBE THE EXISTING ORDER. They are not a new precedence rule and the engine
              did not change: (Basic salary + All fixed allowances) / 26 / 8 × 1.5 × Hours worked is what
              the stored left-to-right fold has always computed. */}
          {formulaLine && (
            <div className="space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('formulaLine')}</p>
              <p className="rounded-md border border-primary/30 bg-primary/5 p-3 font-mono text-sm font-semibold leading-relaxed break-words">
                {formulaLine}
              </p>
              <p className="text-xs text-muted-foreground">{t('formulaLineHint')}</p>
            </div>
          )}

          {/* 2da9937a — dividing by a live value is now allowed, and it carries a consequence the admin
              must know about BEFORE they save: an employee for whom that value is zero is paid nothing for
              this item. Shown only when the formula actually does it, so it is a consequence of a choice
              just made rather than standing boilerplate everyone learns to skip. */}
          {terms.some((s) => s.op === '/' && s.operand.ref !== 'number') && (
            <p className="rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">{t('formulaDivisionNote')}</p>
          )}

          {/* Five columns since e318eaec: operator · what · value · NAME FOR THAT VALUE · remove. */}
          <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[7rem_1fr_1fr_1fr_2rem]">
            <span className="text-sm text-muted-foreground">{t('formulaStart')}</span>
            <OperandFields op={start} onChange={setStart} payItems={payItems} />
            <span />
          </div>

          {terms.map((term, i) => (
            <div key={i} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[7rem_1fr_1fr_1fr_2rem]">
              <select
                value={term.op}
                onChange={(e) => {
                  const next = [...terms];
                  next[i] = { ...term, op: e.target.value as FormulaOp };
                  setTerms(next);
                }}
                className={inputCls}
                aria-label={t('formulaTitle')}
              >
                {FORMULA_OPS.map((o) => (
                  <option key={o} value={o}>
                    {t(OP_KEY[o])}
                  </option>
                ))}
              </select>
              <OperandFields
                op={term.operand}
                payItems={payItems}
                onChange={(operand) => {
                  const next = [...terms];
                  next[i] = { ...term, operand };
                  setTerms(next);
                }}
              />
              <button
                type="button"
                onClick={() => setTerms(terms.filter((_, j) => j !== i))}
                aria-label={t('formulaRemoveStep')}
                title={t('formulaRemoveStep')}
                className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Check against an employee ──────────────────────────────────────────────────────────────
          The server evaluates the CANDIDATE rule with the same function the payroll run uses, against this
          employee's real basic / hours / other pay items. Nothing is written. */}
      {kind !== 'fixed' && (
        <div className="space-y-3 rounded-lg border border-border bg-background/60 p-3">
          <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('previewTitle')}</h5>
          <p className="text-xs text-muted-foreground">{t('previewHint')}</p>
          {previewEmployees.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('previewNone')}</p>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              {/* e318eaec — search by name OR employee ID, answered by the server (the list is capped, so
                  filtering the cap client-side would only ever search the fifty rows already loaded). */}
              <Field label={t('previewSearch')}>
                <input
                  type="search"
                  value={empQuery}
                  onChange={(e) => setEmpQuery(e.target.value)}
                  placeholder={t('previewSearchPlaceholder')}
                  className={inputCls}
                />
              </Field>
              <Field label={t('previewEmployee')}>
                <select
                  value={previewEmp?.employmentId ?? ''}
                  onChange={(e) => setPreviewEmp(employeeOptions.find((o) => o.employmentId === e.target.value) ?? null)}
                  className={inputCls}
                >
                  {/* Was `${firstName} ${lastName}` — "null null" for every person on the reporter's
                      tenant, because every name there lives in full_name (core/pay-components.ts). */}
                  {employeeOptions.map((e) => (
                    <option key={e.employmentId} value={e.employmentId}>
                      {employeeLabel(e)}
                    </option>
                  ))}
                </select>
              </Field>
              <Button type="button" variant="secondary" size="sm" onClick={onPreview} disabled={previewing || !previewEmp}>
                {previewing && <Loader2 className="size-3.5 animate-spin" />}
                {t('previewRun')}
              </Button>
              {searching && <Loader2 className="mb-2 size-3.5 animate-spin text-muted-foreground" />}
            </div>
          )}
          {!searching && empQuery.trim() !== '' && found.length === 0 && (
            <p className="text-xs text-muted-foreground">{t('previewSearchNone')}</p>
          )}
          {preview && !preview.ok && <p className="text-xs font-medium text-destructive">{preview.message}</p>}
          {preview && preview.ok && (
            <div className="space-y-2 rounded-md bg-muted/50 p-3">
              {/* e318eaec — the formula this answer came from, drawn by the SAME formatPayRule the live line
                  above uses, so the panel and the builder cannot disagree about what the rule says. */}
              {formulaLine && <p className="font-mono text-xs break-words text-muted-foreground">{formulaLine}</p>}
              <p className="text-sm">
                <span className="text-muted-foreground">{t('previewResult')}: </span>
                <span className="font-semibold tabular-nums">RM {money(preview.amount)}</span>
              </p>
              {/* ── SHOW THE WORKING (e318eaec) ─────────────────────────────────────────────────────
                  "This is particularly useful when HR is checking why the payroll result is different from
                  their expectation." Every row here came OUT OF the fold that produced the figure above
                  (PayRuleTraceStep), not from a second walk over the steps — so it cannot describe a route
                  to the answer that the evaluator did not take. Four decimals on the way, cents at the end,
                  which is what payroll does. */}
              {preview.steps.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('previewSteps')}</p>
                  <ol className="space-y-0.5 text-xs">
                    {preview.steps.map((s, i) => (
                      <li key={i} className="flex items-baseline justify-between gap-3 border-b border-border/50 py-0.5 last:border-0">
                        <span className="min-w-0">
                          <span className="mr-1.5 text-muted-foreground tabular-nums">{i + 1}.</span>
                          {s.op === null ? t('formulaStart') : t(OP_KEY[s.op])}{' '}
                          <span className="font-medium">{formatPayRuleOperand(s.operand, formatLabels)}</span>
                          {s.op !== null && s.operand.ref !== 'number' && (
                            <span className="text-muted-foreground tabular-nums"> ({money4(s.value)})</span>
                          )}
                        </span>
                        <span className="shrink-0 font-mono tabular-nums">{money4(s.running)}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-3">
                <div>
                  <dt className="inline">{t('base_basic')}: </dt>
                  <dd className="inline tabular-nums">{money(preview.scope.basic)}</dd>
                </div>
                <div>
                  <dt className="inline">{t('previewDays')}: </dt>
                  <dd className="inline tabular-nums">{preview.scope.days}</dd>
                </div>
                <div>
                  <dt className="inline">{t('previewHours')}: </dt>
                  <dd className="inline tabular-nums">{money(preview.scope.hours)}</dd>
                </div>
              </dl>
              {preview.inputs.length > 0 && (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-3">
                  <div className="col-span-full font-medium">{t('previewInputs')}</div>
                  {preview.inputs.map((i) => (
                    <div key={i.code}>
                      <dt className="inline font-mono">{i.code}: </dt>
                      <dd className="inline tabular-nums">{money(i.amount)}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {/* 2da9937a — a 0 with no explanation is the failure mode this whole feature was designed
                  around. When a live divisor was zero for this employee, say so IN PLACE of leaving the
                  admin to work it out, and say what the payroll run will do about it. */}
              {preview.zeroDivisor && (
                <p className="rounded-md bg-amber-500/10 p-2 text-xs font-medium text-amber-700 dark:text-amber-400">
                  {preview.zeroDivisor}
                </p>
              )}
              <p className="text-xs text-muted-foreground">{t('previewNote')}</p>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          {/* The form submits `prorates` via this checkbox (moved out of the flags row, see file header). */}
          <input
            type="checkbox"
            name="prorates"
            checked={prorates}
            onChange={(e) => setProrates(e.target.checked)}
            className="size-4 rounded"
          />
          {tc('colProrates')}
        </label>
        {kind !== 'fixed' && (
          <span className={`text-xs font-medium ${hint.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}`}>
            {hint.text}
          </span>
        )}
      </div>

      <AlertDialog.Root open={aiOpen} onOpenChange={setAiOpen}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg">
            <AlertDialog.Title className="text-base font-semibold">{t('assistTitle')}</AlertDialog.Title>
            <AlertDialog.Description className="mt-1.5 text-sm text-muted-foreground">{t('assistDescription')}</AlertDialog.Description>
            <textarea
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('assistPlaceholder')}
              className={`${inputCls} mt-3`}
            />
            <div className="mt-4 flex items-center justify-end gap-3">
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="outline" size="sm">
                  {t('assistCancel')}
                </Button>
              </AlertDialog.Cancel>
              <Button type="button" size="sm" onClick={onAssist} disabled={pending || description.trim() === ''}>
                {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                {t('assistSubmit')}
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}
