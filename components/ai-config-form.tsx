'use client';

/**
 * AI provider configuration (ADR-0023) — admin Settings client island. One card per provider: pick a
 * model, paste an API key (write-only — shown as ••••last4 once stored), test the connection, save,
 * and choose which provider is active. The key field is `type=password` + `autoComplete=off`; the
 * plaintext key is sent to a server action that encrypts it before it touches the DB and is never
 * echoed back. "Test" returns only ok/generic-reason.
 */
import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, PlugZap, Trash2 } from 'lucide-react';
import { Button, Card, Field, inputCls } from '@/components/ui';
import type { AiConfigView, AiProviderView } from '@/core/ai-config';
import {
  disableAiAction,
  removeAiProviderConfigAction,
  saveAiProviderConfigAction,
  setActiveProviderAction,
  testConnectionAction,
} from '@/app/admin/ai/actions';

export function AiConfigForm({ config }: { config: AiConfigView }) {
  const t = useTranslations('admin.ai');
  const anyActive = config.providers.some((p) => p.isActive);
  return (
    <div className="space-y-4">
      {anyActive && (
        <form action={disableAiAction} className="flex justify-end">
          <Button type="submit" variant="ghost" size="sm">
            {t('turnOff')}
          </Button>
        </form>
      )}
      {config.providers.map((p) => (
        <ProviderCard key={p.provider} p={p} storable={config.storable} />
      ))}
    </div>
  );
}

function ProviderCard({ p, storable }: { p: AiProviderView; storable: boolean }) {
  const t = useTranslations('admin.ai');
  const [model, setModel] = useState(p.model);
  const [key, setKey] = useState('');
  const [testing, startTest] = useTransition();

  function onTest() {
    startTest(async () => {
      const res = await testConnectionAction({ provider: p.provider, model, apiKey: key });
      if (res.ok) toast.success(t('testOk'));
      else toast.error(res.error ?? t('testFail'));
    });
  }

  const canSave = storable || p.configured; // need the secret set to store a NEW key
  const canTest = !testing && (Boolean(key) || p.isActive); // typed key, or test the active stored key

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{p.label}</h3>
        <div className="flex items-center gap-2">
          {p.isActive && (
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
              {t('active')}
            </span>
          )}
          {!p.configured && p.envKeyPresent && (
            <span className="text-[10px] text-muted-foreground">{t('envKeyPresent')}</span>
          )}
        </div>
      </div>

      <form action={saveAiProviderConfigAction} className="mt-3 space-y-3">
        <input type="hidden" name="provider" value={p.provider} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('model')}>
            <select name="model" value={model} onChange={(e) => setModel(e.target.value)} className={inputCls}>
              {p.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('apiKey')}>
            <input
              name="apiKey"
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={p.configured ? `•••• ${p.keyLast4}` : t('apiKeyPlaceholder')}
              className={inputCls}
            />
          </Field>
        </div>
        {!storable && <p className="text-xs text-amber-600 dark:text-amber-400">{t('notStorable')}</p>}
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" name="makeActive" defaultChecked={!p.isActive} className="size-4" />
          {t('makeActive')}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!canSave}>
            {t('save')}
          </Button>
          <Button type="button" variant="secondary" onClick={onTest} disabled={!canTest}>
            {testing ? <Loader2 className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />}
            {testing ? t('testing') : t('test')}
          </Button>
        </div>
      </form>

      {p.configured && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          {!p.isActive && (
            <form action={setActiveProviderAction}>
              <input type="hidden" name="provider" value={p.provider} />
              <Button type="submit" variant="ghost" size="sm">
                <CheckCircle2 className="size-3.5" />
                {t('useThis')}
              </Button>
            </form>
          )}
          <form action={removeAiProviderConfigAction}>
            <input type="hidden" name="provider" value={p.provider} />
            <Button type="submit" variant="ghost" size="sm">
              <Trash2 className="size-3.5" />
              {t('remove')}
            </Button>
          </form>
        </div>
      )}
    </Card>
  );
}
