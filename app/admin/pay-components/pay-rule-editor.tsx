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
import { useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Plus, Sparkles, X } from 'lucide-react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Button, Field, inputCls } from '@/components/ui';
import {
  FORMULA_MAX_TERMS,
  FORMULA_OPERAND_REFS,
  FORMULA_OPS,
  PAY_RULE_KINDS,
  validatePayRule,
  type FormulaOperand,
  type FormulaOp,
  type FormulaTerm,
  type PayRule,
  type PayRuleKind,
} from '@/core/pay-rule';
import { draftPayRuleAction, previewPayRuleAction } from './actions';

/** A selectable pay item for the "another pay item" operand — code + display name, from the server. */
export type PayItemOption = { code: string; name: string };
/** A selectable employee for the preview — id + display name. */
export type PreviewEmployeeOption = { employmentId: string; name: string };

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
          onChange={(e) => onChange({ ref: 'number', value: e.target.value.trim() === '' ? NaN : Number(e.target.value) })}
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
  const [previewEmp, setPreviewEmp] = useState(previewEmployees[0]?.employmentId ?? '');
  const [preview, setPreview] = useState<
    | { ok: true; amount: number; scope: { basic: number; days: number; hours: number }; inputs: { code: string; amount: number }[] }
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
    startPreview(async () => {
      const res = await previewPayRuleAction({ code, kind: componentKind, prorates, rule, employmentId: previewEmp });
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

          <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[8rem_1fr_1fr_2rem]">
            <span className="text-sm text-muted-foreground">{t('formulaStart')}</span>
            <OperandFields op={start} onChange={setStart} payItems={payItems} />
            <span />
          </div>

          {terms.map((term, i) => (
            <div key={i} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[8rem_1fr_1fr_2rem]">
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
              <Field label={t('previewEmployee')}>
                <select value={previewEmp} onChange={(e) => setPreviewEmp(e.target.value)} className={inputCls}>
                  {previewEmployees.map((e) => (
                    <option key={e.employmentId} value={e.employmentId}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Button type="button" variant="secondary" size="sm" onClick={onPreview} disabled={previewing || !previewEmp}>
                {previewing && <Loader2 className="size-3.5 animate-spin" />}
                {t('previewRun')}
              </Button>
            </div>
          )}
          {preview && !preview.ok && <p className="text-xs font-medium text-destructive">{preview.message}</p>}
          {preview && preview.ok && (
            <div className="space-y-2 rounded-md bg-muted/50 p-3">
              <p className="text-sm">
                <span className="text-muted-foreground">{t('previewResult')}: </span>
                <span className="font-semibold tabular-nums">RM {money(preview.amount)}</span>
              </p>
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
