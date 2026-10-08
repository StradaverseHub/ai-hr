'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { publicErrorMessage } from '@/lib/public-error';
import { requireAdmin } from '@/lib/authz';
import * as lc from '@/packs/lifecycle/service';
import type { CaseKind, StepInput } from '@/packs/lifecycle/service';

async function run(back: string, fn: () => Promise<void>): Promise<never> {
  const s = await requireAdmin();
  void s;
  try { await fn(); } catch (e) { redirect(`${back}${back.includes('?') ? '&' : '?'}error=${encodeURIComponent(publicErrorMessage(e))}`); }
  revalidatePath('/admin/lifecycle');
  redirect(`${back}${back.includes('?') ? '&' : '?'}saved=1`);
}
const str = (f: FormData, k: string): string => String(f.get(k) ?? '').trim();
const kindOf = (f: FormData): CaseKind => (str(f, 'kind') === 'offboarding' ? 'offboarding' : 'onboarding');

export async function setStaffAction(f: FormData) {
  const s = await requireAdmin();
  return run('/admin/lifecycle?tab=staff', async () => {
    const level = str(f, 'level');
    await lc.setStaff(s, { userId: str(f, 'userId'), companyId: str(f, 'companyId') || null, level: level === 'agent' || level === 'manager' ? level : null });
  });
}

export async function saveStepsAction(f: FormData) {
  const s = await requireAdmin(); const kind = kindOf(f);
  return run(`/admin/lifecycle?tab=steps&kind=${kind}`, async () => {
    const n = Number(str(f, 'n') || '0');
    const steps: StepInput[] = [];
    for (let i = 0; i < n; i++) {
      if (str(f, `remove_${i}`) === 'on') continue;
      const label = str(f, `label_${i}`);
      if (!label) continue;
      steps.push({ key: str(f, `key_${i}`) || undefined, phase: Number(str(f, `phase_${i}`) || '0'), label, ownerTeam: str(f, `owner_${i}`), hrms: str(f, `hrms_${i}`) === 'on', rule: (str(f, `rule_${i}`) || 'always') as StepInput['rule'] });
    }
    await lc.saveStepDefs(s, kind, steps);
  });
}
export async function resetStepsAction(f: FormData) {
  const s = await requireAdmin(); const kind = kindOf(f);
  return run(`/admin/lifecycle?tab=steps&kind=${kind}`, async () => { await lc.resetStepDefs(s, kind); });
}

export async function saveProvisionsAction(f: FormData) {
  const s = await requireAdmin();
  const kind = str(f, 'kind') === 'return' ? 'return' : 'requisition';
  const scope = str(f, 'scope');
  return run(`/admin/lifecycle?tab=checklists&kind=${kind}&scope=${scope || 'common'}`, async () => {
    const n = Number(str(f, 'n') || '0');
    const items: { key?: string; name: string }[] = [];
    for (let i = 0; i < n; i++) {
      if (str(f, `remove_${i}`) === 'on') continue;
      const name = str(f, `name_${i}`);
      if (name) items.push({ key: str(f, `key_${i}`) || undefined, name });
    }
    await lc.saveProvisionDefs(s, kind, scope && scope !== 'common' ? scope : null, items);
  });
}

export async function saveCompanyAction(f: FormData) {
  const s = await requireAdmin();
  return run('/admin/lifecycle?tab=companies', async () => {
    await lc.saveCompanyConfig(s, str(f, 'companyId'), { approvalLevels: Number(str(f, 'approvalLevels')), accessSystems: str(f, 'accessSystems').split(/\r?\n/).map((x) => x.trim()).filter(Boolean) });
  });
}

export async function saveFieldsAction(f: FormData) {
  const s = await requireAdmin(); const kind = kindOf(f);
  return run(`/admin/lifecycle?tab=fields&kind=${kind}`, async () => {
    const n = Number(str(f, 'n') || '0');
    const fields: Partial<lc.CustomFieldDef>[] = [];
    for (let i = 0; i < n; i++) {
      if (str(f, `remove_${i}`) === 'on') continue;
      const label = str(f, `label_${i}`);
      if (!label) continue;
      fields.push({
        key: str(f, `key_${i}`) || undefined, label, type: (str(f, `type_${i}`) || 'text') as lc.CustomFieldDef['type'], required: str(f, `required_${i}`) === 'on',
        options: str(f, `options_${i}`).split(',').map((x) => x.trim()).filter(Boolean), companyIds: f.getAll(`companies_${i}`).map(String).filter(Boolean),
      });
    }
    await lc.saveCustomFields(s, kind, fields);
  });
}

export async function saveCatalogueAction(f: FormData) {
  const s = await requireAdmin();
  return run('/admin/lifecycle?tab=catalogue', async () => {
    await lc.saveCatalogueItem(s, {
      id: str(f, 'id') || undefined, itemCode: str(f, 'itemCode'), itemName: str(f, 'itemName'), category: str(f, 'category') === 'software' ? 'software' : 'hardware',
      description: str(f, 'description') || null, approvalLevels: Number(str(f, 'approvalLevels') || '1'), active: str(f, 'active') === 'on',
    });
  });
}

export async function loadDefaultsAction() {
  const s = await requireAdmin();
  return run('/admin/lifecycle?tab=staff', async () => { await lc.loadHandoverDefaults(s); });
}
