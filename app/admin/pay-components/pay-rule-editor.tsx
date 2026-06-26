'use client';

/**
 * Payroll Setup — the non-technical surface for the configurable pay-rule (the feedback's ask). A dropdown
 * of rule kinds (Fixed amount / % of basic / Per day / Per hour / Capped flat) reveals the relevant number
 * field(s); there is NO textarea and NO parser — the admin never sees an expression error. Live client-side
 * validatePayRule (the SAME pure function the kernel uses) shows a Valid / error hint, including the
 * proration-conflict message. An "Assist with AI" button drafts a rule from a plain sentence; "Use this rule"
 * only populates the fields (human-in-the-loop — it never auto-saves). The selected rule is serialised into a
 * hidden `rule` input the server action reads; empty / Fixed ⇒ today's behaviour (null rule).
 *
 * The Prorates checkbox lives HERE (not in the flags row) because proration interacts with per-day/per-hour
 * rules — keeping them together lets the live validator surface the conflict as the admin toggles either one.
 */
import { useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Sparkles } from 'lucide-react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Button, Field, inputCls } from '@/components/ui';
import { validatePayRule, PAY_RULE_KINDS, type PayRule, type PayRuleKind } from '@/core/pay-rule';
import { draftPayRuleAction } from './actions';

type Props = {
  code: string;
  prorates: boolean;
  rule: PayRule | null;
  aiEnabled: boolean;
};

const num = (v: string): number => (v.trim() === '' ? NaN : Number(v));

export function PayRuleEditor({ code, prorates: initialProrates, rule: initialRule, aiEnabled }: Props) {
  const t = useTranslations('payRule');
  const tc = useTranslations('payComponents');
  const [kind, setKind] = useState<PayRuleKind>(initialRule?.kind ?? 'fixed');
  const [prorates, setProrates] = useState(initialProrates);
  const [pct, setPct] = useState(initialRule?.kind === 'percent_of' ? String(initialRule.pct) : '');
  const [rate, setRate] = useState(
    initialRule?.kind === 'per_day' || initialRule?.kind === 'per_hour' ? String(initialRule.rate) : '',
  );
  const [value, setValue] = useState(initialRule?.kind === 'flat_capped' ? String(initialRule.value) : '');
  const [cap, setCap] = useState(initialRule?.kind === 'flat_capped' ? String(initialRule.cap) : '');
  const [aiOpen, setAiOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [pending, startTransition] = useTransition();

  // Build the candidate rule from the current fields (fixed ⇒ null = legacy behaviour).
  const rule = useMemo<PayRule | null>(() => {
    switch (kind) {
      case 'fixed':
        return null;
      case 'percent_of':
        return { kind: 'percent_of', base: 'basic', pct: num(pct) };
      case 'per_day':
        return { kind: 'per_day', rate: num(rate) };
      case 'per_hour':
        return { kind: 'per_hour', rate: num(rate) };
      case 'flat_capped':
        return { kind: 'flat_capped', value: num(value), cap: num(cap) };
      default:
        return null;
    }
  }, [kind, pct, rate, value, cap]);

  const validation = validatePayRule(rule, prorates);
  const hint = validation.ok ? { ok: true as const, text: t('valid') } : { ok: false as const, text: t(`errors.${validation.code}`) };

  function applyRule(r: PayRule) {
    setKind(r.kind);
    if (r.kind === 'percent_of') setPct(String(r.pct));
    if (r.kind === 'per_day' || r.kind === 'per_hour') setRate(String(r.rate));
    if (r.kind === 'flat_capped') {
      setValue(String(r.value));
      setCap(String(r.cap));
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
          <Field label={t('pctLabel')}>
            <input type="number" min="0" step="0.01" value={pct} onChange={(e) => setPct(e.target.value)} className={inputCls} />
          </Field>
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
