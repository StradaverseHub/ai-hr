import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { requireAdmin } from '@/lib/authz';
import { requireModule } from '@/lib/authz';
import {
  LEVEL, listAssignableUsers, listCatalogue, listCustomFields, listMyCompanies, listProvisionDefs, listStaff, listStepDefs, phaseLabels, getCompanyConfig,
  type CaseKind,
} from '@/packs/lifecycle/service';
import { cn } from '@/lib/utils';
import {
  loadDefaultsAction, resetStepsAction, saveCatalogueAction, saveCompanyAction, saveFieldsAction, saveProvisionsAction, saveStepsAction, setStaffAction,
} from './actions';

const TABS = ['staff', 'steps', 'checklists', 'companies', 'fields', 'catalogue'] as const;
const sel = 'h-9 w-full rounded-md border border-input bg-card px-2 text-sm';
const BLANK = 3;

export default async function LifecycleConfigPage({ searchParams }: { searchParams: Promise<{ tab?: string; kind?: string; scope?: string; error?: string; saved?: string }> }) {
  await requireModule('lifecycle');
  const s = await requireAdmin();
  const t = await getTranslations('lifecycle');
  const sp = await searchParams;
  const tab = (TABS as readonly string[]).includes(sp.tab ?? '') ? sp.tab! : 'staff';
  const companies = await listMyCompanies(s, LEVEL.admin);
  const kind: CaseKind = sp.kind === 'offboarding' ? 'offboarding' : 'onboarding';
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('config.title')} description={t('config.subtitle')}
        actions={<form action={loadDefaultsAction}><ConfirmSubmit size="sm" variant="outline" title={t('config.loadDefaultsTitle')} description={t('config.loadDefaultsDescription')} confirmLabel={t('config.loadDefaults')}>{t('config.loadDefaults')}</ConfirmSubmit></form>} />
      <ErrorBanner message={sp.error} />
      {sp.saved && <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">{t('config.saved')}</p>}
      <nav className="flex flex-wrap gap-1 border-b border-border" aria-label={t('config.title')}>
        {TABS.map((x) => <Link key={x} href={`/admin/lifecycle?tab=${x}`} aria-current={tab === x ? 'page' : undefined} className={cn('-mb-px border-b-2 px-3 py-2 text-sm', tab === x ? 'border-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground')}>{t(`config.tabs.${x}`)}</Link>)}
      </nav>

      {tab === 'staff' && <StaffTab companies={companies} s={s} />}
      {tab === 'steps' && <StepsTab kind={kind} s={s} />}
      {tab === 'checklists' && <ChecklistsTab s={s} companies={companies} kindParam={sp.kind} scopeParam={sp.scope} />}
      {tab === 'companies' && <CompaniesTab s={s} companies={companies} />}
      {tab === 'fields' && <FieldsTab s={s} kind={kind} companies={companies} />}
      {tab === 'catalogue' && <CatalogueTab s={s} />}
    </div>
  );
}

type Ctx = Awaited<ReturnType<typeof requireAdmin>>;
type Co = { id: string; name: string };

async function StaffTab({ s, companies }: { s: Ctx; companies: Co[] }) {
  const t = await getTranslations('lifecycle');
  const [staff, users] = await Promise.all([listStaff(s), listAssignableUsers(s)]);
  return (
    <div className="space-y-4">
      <Card className="p-4 text-sm text-muted-foreground">{t('config.staffHint')}</Card>
      <Card className="overflow-hidden">
        <SectionHeader title={t('config.tabs.staff')} count={staff.length} />
        <ul className="divide-y divide-border text-sm">
          {staff.length === 0 && <li className="px-4 py-3 text-muted-foreground">{t('config.noStaff')}</li>}
          {staff.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-2 px-4 py-2">
              <span>{m.name} · {t(`config.level.${m.level}`)} · {m.companyId ? companies.find((c) => c.id === m.companyId)?.name ?? '—' : t('config.allCompanies')}</span>
              <form action={setStaffAction}><input type="hidden" name="userId" value={m.userId} /><input type="hidden" name="companyId" value={m.companyId ?? ''} /><input type="hidden" name="level" value="" /><Button type="submit" size="sm" variant="ghost" className="text-destructive">{t('config.remove')}</Button></form>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="p-4">
        <form action={setStaffAction} className="grid gap-3 sm:grid-cols-4">
          <Field label={t('config.user')}><select name="userId" required className={sel}>{users.map((u) => <option key={u.userId} value={u.userId}>{u.name}</option>)}</select></Field>
          <Field label={t('common.company')}><select name="companyId" className={sel}><option value="">{t('config.allCompanies')}</option>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label={t('config.levelLabel')}><select name="level" className={sel}><option value="agent">{t('config.level.agent')}</option><option value="manager">{t('config.level.manager')}</option></select></Field>
          <div className="flex items-end"><Button type="submit">{t('config.addStaff')}</Button></div>
        </form>
      </Card>
    </div>
  );
}

async function StepsTab({ s, kind }: { s: Ctx; kind: CaseKind }) {
  const t = await getTranslations('lifecycle');
  const defs = (await listStepDefs(s, kind)).filter((d) => d.active);
  const phases = phaseLabels(kind);
  const rules = kind === 'onboarding' ? ['always', 'carpark', 'laptop'] : ['always', 'outcome_accepted', 'outcome_rejected'];
  const rows = [...defs, ...Array.from({ length: BLANK }, () => null)];
  return (
    <div className="space-y-4">
      <div className="flex gap-3 text-sm">{(['onboarding', 'offboarding'] as const).map((k) => <Link key={k} href={`/admin/lifecycle?tab=steps&kind=${k}`} className={k === kind ? 'font-medium' : 'text-muted-foreground hover:text-foreground'}>{t(`tabs.${k}`)}</Link>)}</div>
      <p className="text-sm text-muted-foreground">{t('config.stepsHint')}</p>
      <form action={saveStepsAction}>
        <input type="hidden" name="kind" value={kind} /><input type="hidden" name="n" value={rows.length} />
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-2 py-2">#</th><th className="px-2 py-2">{t('config.stepWording')}</th><th className="px-2 py-2">{t('config.ownerTeam')}</th><th className="px-2 py-2">{t('config.phase')}</th><th className="px-2 py-2">{t('config.rule')}</th><th className="px-2 py-2">HRMS</th><th className="px-2 py-2">{t('config.remove')}</th></tr></thead>
            <tbody className="divide-y divide-border">
              {rows.map((d, i) => (
                <tr key={d?.key ?? `new-${i}`}>
                  <td className="px-2 py-1.5 text-xs text-muted-foreground">{i + 1}<input type="hidden" name={`key_${i}`} value={d?.key ?? ''} /></td>
                  <td className="px-2 py-1.5"><input name={`label_${i}`} defaultValue={d?.label ?? ''} aria-label={t('config.stepWording')} className={inputCls} /></td>
                  <td className="px-2 py-1.5"><input name={`owner_${i}`} defaultValue={d?.ownerTeam ?? ''} aria-label={t('config.ownerTeam')} className={inputCls} /></td>
                  <td className="px-2 py-1.5"><select name={`phase_${i}`} defaultValue={d?.phase ?? 0} aria-label={t('config.phase')} className={sel}>{Object.entries(phases).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
                  <td className="px-2 py-1.5"><select name={`rule_${i}`} defaultValue={d?.rule ?? 'always'} aria-label={t('config.rule')} className={sel}>{rules.map((r) => <option key={r} value={r}>{t(`config.rules.${r}`)}</option>)}</select></td>
                  <td className="px-2 py-1.5"><input type="checkbox" name={`hrms_${i}`} defaultChecked={d?.hrms} aria-label="HRMS" className="size-4" /></td>
                  <td className="px-2 py-1.5">{d && <input type="checkbox" name={`remove_${i}`} aria-label={t('config.remove')} className="size-4" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <div className="mt-3 flex gap-2"><Button type="submit">{t('common.save')}</Button></div>
      </form>
      <form action={resetStepsAction}><input type="hidden" name="kind" value={kind} /><ConfirmSubmit size="sm" variant="ghost" title={t('config.resetTitle')} description={t('config.resetDescription')} confirmLabel={t('config.reset')}>{t('config.reset')}</ConfirmSubmit></form>
    </div>
  );
}

async function ChecklistsTab({ s, companies, kindParam, scopeParam }: { s: Ctx; companies: Co[]; kindParam?: string; scopeParam?: string }) {
  const t = await getTranslations('lifecycle');
  const kind = kindParam === 'return' ? 'return' : 'requisition';
  const scope = companies.find((c) => c.id === scopeParam)?.id ?? null;
  const items = (await listProvisionDefs(s, kind, scope)).filter((i) => i.active);
  const rows = [...items, ...Array.from({ length: BLANK }, () => null)];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 text-sm">
        {(['requisition', 'return'] as const).map((k) => <Link key={k} href={`/admin/lifecycle?tab=checklists&kind=${k}${scope ? `&scope=${scope}` : ''}`} className={k === kind ? 'font-medium' : 'text-muted-foreground hover:text-foreground'}>{t(`requisitions.kind.${k}`)}</Link>)}
        <span className="text-muted-foreground">|</span>
        <Link href={`/admin/lifecycle?tab=checklists&kind=${kind}`} className={!scope ? 'font-medium' : 'text-muted-foreground hover:text-foreground'}>{t('config.common')}</Link>
        {companies.map((c) => <Link key={c.id} href={`/admin/lifecycle?tab=checklists&kind=${kind}&scope=${c.id}`} className={scope === c.id ? 'font-medium' : 'text-muted-foreground hover:text-foreground'}>{c.name}</Link>)}
      </div>
      <p className="text-sm text-muted-foreground">{t('config.checklistHint')}</p>
      <form action={saveProvisionsAction}>
        <input type="hidden" name="kind" value={kind} /><input type="hidden" name="scope" value={scope ?? 'common'} /><input type="hidden" name="n" value={rows.length} />
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-2 py-2">#</th><th className="px-2 py-2">{t('config.itemName')}</th><th className="px-2 py-2">{t('config.remove')}</th></tr></thead>
            <tbody className="divide-y divide-border">
              {rows.map((d, i) => (
                <tr key={d?.key ?? `new-${i}`}>
                  <td className="px-2 py-1.5 text-xs text-muted-foreground">{i + 1}<input type="hidden" name={`key_${i}`} value={d?.key ?? ''} /></td>
                  <td className="px-2 py-1.5"><input name={`name_${i}`} defaultValue={d?.name ?? ''} aria-label={t('config.itemName')} className={inputCls} /></td>
                  <td className="px-2 py-1.5">{d && <input type="checkbox" name={`remove_${i}`} aria-label={t('config.remove')} className="size-4" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <div className="mt-3"><Button type="submit">{t('common.save')}</Button></div>
      </form>
    </div>
  );
}

async function CompaniesTab({ s, companies }: { s: Ctx; companies: Co[] }) {
  const t = await getTranslations('lifecycle');
  const cfgs = await Promise.all(companies.map(async (c) => [c, await getCompanyConfig(s, c.id)] as const));
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('config.companiesHint')}</p>
      {cfgs.map(([c, cfg]) => (
        <Card key={c.id} className="p-4">
          <form action={saveCompanyAction} className="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="companyId" value={c.id} />
            <h2 className="col-span-full text-sm font-semibold">{c.name}</h2>
            <Field label={t('config.approvalLevels')}>
              <select name="approvalLevels" defaultValue={cfg.approvalLevels} className={sel}><option value="0">{t('config.levels0')}</option><option value="1">{t('config.levels1')}</option><option value="2">{t('config.levels2')}</option></select>
            </Field>
            <Field label={t('config.accessSystems')} className="row-span-2"><textarea name="accessSystems" rows={5} defaultValue={cfg.accessSystems.join('\n')} className={`${inputCls} h-auto py-2`} /></Field>
            <div className="self-end"><Button type="submit" size="sm">{t('common.save')}</Button></div>
          </form>
        </Card>
      ))}
    </div>
  );
}

async function FieldsTab({ s, kind, companies }: { s: Ctx; kind: CaseKind; companies: Co[] }) {
  const t = await getTranslations('lifecycle');
  const defs = (await listCustomFields(s, kind)).filter((d) => d.active);
  const rows = [...defs, ...Array.from({ length: BLANK }, () => null)];
  return (
    <div className="space-y-4">
      <div className="flex gap-3 text-sm">{(['onboarding', 'offboarding'] as const).map((k) => <Link key={k} href={`/admin/lifecycle?tab=fields&kind=${k}`} className={k === kind ? 'font-medium' : 'text-muted-foreground hover:text-foreground'}>{t(`tabs.${k}`)}</Link>)}</div>
      <p className="text-sm text-muted-foreground">{t('config.fieldsHint')}</p>
      <form action={saveFieldsAction}>
        <input type="hidden" name="kind" value={kind} /><input type="hidden" name="n" value={rows.length} />
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-2 py-2">{t('config.fieldName')}</th><th className="px-2 py-2">{t('config.fieldType')}</th><th className="px-2 py-2">{t('config.fieldOptions')}</th><th className="px-2 py-2">{t('config.fieldCompanies')}</th><th className="px-2 py-2">{t('config.required')}</th><th className="px-2 py-2">{t('config.remove')}</th></tr></thead>
            <tbody className="divide-y divide-border">
              {rows.map((d, i) => (
                <tr key={d?.key ?? `new-${i}`} className="align-top">
                  <td className="px-2 py-1.5"><input type="hidden" name={`key_${i}`} value={d?.key ?? ''} /><input name={`label_${i}`} defaultValue={d?.label ?? ''} aria-label={t('config.fieldName')} className={inputCls} /></td>
                  <td className="px-2 py-1.5"><select name={`type_${i}`} defaultValue={d?.type ?? 'text'} aria-label={t('config.fieldType')} className={sel}>{(['text', 'longtext', 'number', 'date', 'yesno', 'choice'] as const).map((x) => <option key={x} value={x}>{t(`config.fieldTypes.${x}`)}</option>)}</select></td>
                  <td className="px-2 py-1.5"><input name={`options_${i}`} defaultValue={d?.options.join(', ') ?? ''} aria-label={t('config.fieldOptions')} className={inputCls} /></td>
                  <td className="px-2 py-1.5"><select name={`companies_${i}`} multiple defaultValue={d?.companyIds ?? []} aria-label={t('config.fieldCompanies')} className="w-full rounded-md border border-input bg-card px-2 py-1 text-sm">{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></td>
                  <td className="px-2 py-1.5"><input type="checkbox" name={`required_${i}`} defaultChecked={d?.required} aria-label={t('config.required')} className="size-4" /></td>
                  <td className="px-2 py-1.5">{d && <input type="checkbox" name={`remove_${i}`} aria-label={t('config.remove')} className="size-4" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <div className="mt-3"><Button type="submit">{t('common.save')}</Button></div>
      </form>
    </div>
  );
}

async function CatalogueTab({ s }: { s: Ctx }) {
  const t = await getTranslations('lifecycle');
  const items = await listCatalogue(s);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('config.catalogueHint')}</p>
      {[...items, null].map((it) => (
        <Card key={it?.id ?? 'new'} className="p-3">
          <form action={saveCatalogueAction} className="grid items-end gap-2 sm:grid-cols-[6rem_1fr_8rem_8rem_6rem_auto]">
            <input type="hidden" name="id" value={it?.id ?? ''} />
            <Field label={t('config.itemCode')}><input name="itemCode" defaultValue={it?.itemCode ?? ''} required className={inputCls} /></Field>
            <Field label={t('config.itemName')}><input name="itemName" defaultValue={it?.itemName ?? ''} required className={inputCls} /></Field>
            <Field label={t('config.category')}><select name="category" defaultValue={it?.category ?? 'hardware'} className={sel}><option value="hardware">{t('requests.category.hardware')}</option><option value="software">{t('requests.category.software')}</option></select></Field>
            <Field label={t('config.approvalLevels')}><select name="approvalLevels" defaultValue={it?.approvalLevels ?? 1} className={sel}><option value="1">{t('config.levels1')}</option><option value="2">{t('config.levels2')}</option></select></Field>
            <label className="flex items-center gap-1.5 pb-2 text-sm"><input type="checkbox" name="active" defaultChecked={it?.active ?? true} className="size-4" />{t('config.active')}</label>
            <Button type="submit" size="sm">{it ? t('common.save') : t('config.addItem')}</Button>
            <input type="hidden" name="description" value={it?.description ?? ''} />
          </form>
        </Card>
      ))}
    </div>
  );
}
