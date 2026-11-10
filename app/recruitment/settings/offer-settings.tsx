import { getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { Field, Input, btnPrimary, tableWrapCls, tbodyCls, thCls, theadCls } from '@/components/ui';
import { OFFER_FIELD_TYPES, offerSettings, type OfferSettings } from '@/packs/recruitment/service';
import { saveApprovalFlowAction, saveOfferFieldAction, updateOfferSettingsAction } from '../actions';
import { selectCls, textareaCls } from '../shared';

/**
 * Settings › Offers and approvals (slices 3–4): offer validity (a label only — nothing is sent), the optional
 * automation (off by default), the offer-field set (type fixed at creation; required, needs approval, private), and
 * the ordered approver lists for offers and requisitions. Pay is a money field a person enters; nothing computes it.
 */
export async function OfferSettingsSection({ s, companyId, here }: { s: SessionContext; companyId: string; here: string }) {
  const [t, settings] = await Promise.all([getTranslations('recruitment.settings.offers'), offerSettings(s, companyId)]);
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  const flow = (kind: 'offer' | 'requisition', current: OfferSettings['offerFlow']) => (
    <form action={saveApprovalFlowAction} className="space-y-3 rounded-xl border border-border bg-card p-4">
      {hidden('companyId', companyId)}{hidden('kind', kind)}{hidden('returnTo', here)}
      <h3 className="text-sm font-semibold">{t(kind === 'offer' ? 'offerFlow' : 'requisitionFlow')}</h3>
      <p className="text-xs text-muted-foreground">{t('flowNote')}</p>
      <ol className="grid gap-2 sm:grid-cols-2">
        {Array.from({ length: Math.min(20, Math.max(3, current.length + 1)) }, (_, i) => (
          <li key={i}><Field label={t('step', { n: i + 1 })}>
            <select name="approverIds" defaultValue={current[i]?.userId ?? ''} className={selectCls}>
              <option value="">{t('noApprover')}</option>
              {settings.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field></li>
        ))}
      </ol>
      <button type="submit" className={btnPrimary}>{t('saveFlow')}</button>
    </form>
  );
  return (
    <div className="space-y-6">
      <form action={updateOfferSettingsAction} className="space-y-4 rounded-xl border border-border bg-card p-4">
        {hidden('companyId', companyId)}{hidden('returnTo', here)}
        <h2 className="text-base font-semibold">{t('rulesTitle')}</h2>
        <Field label={t('validDays')} className="max-w-xs"><Input name="validDays" type="number" min={1} max={365} defaultValue={settings.validDays} required /></Field>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="acceptMovesForward" defaultChecked={settings.acceptMovesForward} className="mt-0.5" />{t('acceptMoves')}</label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="declineArchives" defaultChecked={settings.declineArchives} className="mt-0.5" />{t('declineArchives')}</label>
        <p className="text-xs text-muted-foreground">{t('automationNote')}</p>
        <button type="submit" className={btnPrimary}>{t('save')}</button>
      </form>

      <section className="space-y-3" aria-labelledby="fields-title">
        <h2 id="fields-title" className="text-base font-semibold">{t('fieldsTitle')}</h2>
        <div className={tableWrapCls}>
          <table className="w-full text-sm">
            <thead className={theadCls}><tr>
              <th className={thCls}>{t('label')}</th><th className={thCls}>{t('type')}</th><th className={thCls}>{t('required')}</th><th className={thCls}>{t('needsApproval')}</th>
              <th className={thCls}>{t('private')}</th><th className={thCls}>{t('enabled')}</th><th className={thCls}><span className="sr-only">{t('save')}</span></th>
            </tr></thead>
            <tbody className={tbodyCls}>
              {settings.fields.map((f) => {
                const form = `field-${f.id}`;
                return (
                  <tr key={f.id}>
                    <td className="px-3 py-2"><Input form={form} name="label" defaultValue={f.label} maxLength={120} required aria-label={t('label')} />
                      {f.type === 'single_choice' && <textarea form={form} name="choices" defaultValue={f.choices.join('\n')} rows={2} className={`${textareaCls} mt-1`} aria-label={t('choices')} />}</td>
                    <td className="px-3 py-2">{t(`types.${f.type}`)}</td>
                    {(['required', 'needsApproval', 'private', 'enabled'] as const).map((flag) => (
                      <td key={flag} className="px-3 py-2"><input form={form} type="checkbox" name={flag} defaultChecked={f[flag]} aria-label={t(flag)} /></td>
                    ))}
                    <td className="px-3 py-2"><form id={form} action={saveOfferFieldAction}>{hidden('fieldId', f.id)}{hidden('returnTo', here)}
                      <button type="submit" className="text-sm text-primary hover:underline">{t('save')}</button></form></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <form action={saveOfferFieldAction} className="grid gap-3 rounded-xl border border-dashed border-border p-4 sm:grid-cols-3 sm:items-end">
          {hidden('companyId', companyId)}{hidden('returnTo', here)}{hidden('enabled', 'on')}
          <Field label={t('label')}><Input name="label" maxLength={120} required /></Field>
          <Field label={t('type')}>
            <select name="type" defaultValue="text" className={selectCls}>
              {OFFER_FIELD_TYPES.map((x) => <option key={x} value={x}>{t(`types.${x}`)}</option>)}
            </select>
          </Field>
          <Field label={t('choices')}><textarea name="choices" rows={2} className={textareaCls} placeholder={t('choicesHint')} /></Field>
          <div className="flex flex-wrap gap-4 text-sm sm:col-span-2">
            {(['required', 'needsApproval', 'private'] as const).map((flag) => <label key={flag} className="flex items-center gap-2"><input type="checkbox" name={flag} />{t(flag)}</label>)}
          </div>
          <button type="submit" className={btnPrimary}>{t('addField')}</button>
        </form>
      </section>

      <section className="grid gap-4 lg:grid-cols-2" aria-label={t('flowsTitle')}>
        {flow('offer', settings.offerFlow)}
        {flow('requisition', settings.requisitionFlow)}
      </section>
    </div>
  );
}
