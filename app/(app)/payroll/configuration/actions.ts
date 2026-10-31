'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { packFor } from '@/localization/registry';
import { StatutoryRulesetInvalidError } from '@/localization/my/statutory-config';
import type { StatutoryBody, StatutoryRuleset } from '@/localization/my/statutory-tables';

const BASE = '/payroll/configuration';

/** Publish a new effective-dated statutory version (admin; RLS enforces the write). */
export async function saveStatutoryAction(formData: FormData) {
  const s = await getSession();
  const pack = packFor('MY');
  if (!pack) redirect(`${BASE}?error=${encodeURIComponent('No localization pack for MY.')}`);

  // Optional same-origin return path (31646c85 — per-body sub-menu redesign): the advanced band-table
  // editor now launches from each body tab (/payroll/configuration/{epf,socso,eis,pcb}), so a publish
  // should return to the tab it was launched from, not always the index. Same allow-list regex as
  // setStatutoryComponentAction so it can't be turned into an open redirect. Defaults to BASE.
  const returnToRaw = String(formData.get('returnTo') ?? '').trim();
  const returnTo = /^\/[A-Za-z0-9/_-]*$/.test(returnToRaw) ? returnToRaw : BASE;

  const version = String(formData.get('version') ?? '').trim();
  const effectiveFrom = String(formData.get('effectiveFrom') ?? '');
  const notes = String(formData.get('notes') ?? '').trim() || null;

  let data: StatutoryRuleset;
  try {
    data = JSON.parse(String(formData.get('data') ?? '')) as StatutoryRuleset;
  } catch {
    redirect(`${returnTo}?edit=1&error=${encodeURIComponent('Malformed configuration payload.')}`);
  }

  try {
    await pack!.statutoryConfig.save(s, { version, effectiveFrom, data, notes });
  } catch (e) {
    const t = await getTranslations('payroll.config');
    const msg = e instanceof StatutoryRulesetInvalidError && e.problems.includes('pcb_child_relief_configuration_invalid')
      ? t('childQualificationInvalid') : e instanceof StatutoryRulesetInvalidError ? e.problems.join('; ') : publicErrorMessage(e);
    redirect(`${returnTo}?edit=1&error=${encodeURIComponent(msg)}`);
  }
  // Revalidate both the return tab AND the index (the overview banner/history/versions grid reflect the
  // new whole-ruleset version regardless of which tab published it).
  revalidatePath(returnTo);
  if (returnTo !== BASE) revalidatePath(BASE);
  redirect(`${returnTo}?toast=${encodeURIComponent('Statutory version published')}`);
}

/**
 * Publish an effective-dated override for ONE statutory body (ADR-0037, #6). The scalar form covers EPF
 * rates / OT ceiling / HRDF rates; for EPF the scalars merge onto the current EPF slice so the band
 * tables (Part A / Part E) survive. Band-heavy bodies (SOCSO/EIS/PCB) stay pack/whole-ruleset managed.
 */
export async function setStatutoryComponentAction(formData: FormData) {
  const s = await getSession();
  const pack = packFor('MY');
  if (!pack) redirect(`${BASE}?error=${encodeURIComponent('No localization pack for MY.')}`);

  // The overtime rate slice can now be edited from the Attendance Policy screen (feedback e776d17d:
  // overtime is an attendance/working-hours rule, not a statutory contribution). The write still goes
  // through this single action + setComponentOverrideMY path so kernel resolution, provenance and the
  // statutory.component.updated event stay identical; only the redirect/revalidate target moves. An
  // optional returnTo lets the attendance card bounce the admin back to /admin/attendance instead of the
  // payroll BASE. Allow-list to same-origin app paths so it can't be turned into an open redirect.
  const returnToRaw = String(formData.get('returnTo') ?? '').trim();
  const returnTo = /^\/[A-Za-z0-9/_-]*$/.test(returnToRaw) ? returnToRaw : BASE;

  const body = String(formData.get('body') ?? '') as StatutoryBody;
  const version = String(formData.get('version') ?? '').trim();
  const effectiveFrom = String(formData.get('effectiveFrom') ?? '');
  const notes = String(formData.get('notes') ?? '').trim() || null;
  const num = (k: string) => Number(formData.get(k));
  /** An optional numeric field: present + non-empty ⇒ its number; absent/blank ⇒ undefined (preserve). */
  const optNum = (k: string): number | undefined => {
    const raw = formData.get(k);
    if (raw == null || String(raw).trim() === '') return undefined;
    return Number(raw);
  };

  // Merge onto the baseline that will be active on the effective date (preserves EPF band tables).
  const current = (await pack!.statutoryConfig.readActive(s, { asOf: effectiveFrom || undefined })).ruleset;
  let data: unknown;
  if (body === 'epf') {
    data = {
      ...current.epf,
      employeeRate: num('employeeRate'),
      employerRateLow: num('employerRateLow'),
      employerRateHigh: num('employerRateHigh'),
      employerThreshold: num('employerThreshold'),
    };
  } else if (body === 'ot') {
    // Merge onto the active ot slice (epf-style spread) so editing wageCeiling alone preserves the two excess
    // multipliers, and editing a multiplier alone preserves wageCeiling. A submitted (non-blank) field wins;
    // a blank field falls through to the current value (or the EA fallback the calculator applies).
    const restMult = optNum('restDayExcessMultiplier');
    const holidayMult = optNum('holidayExcessMultiplier');
    data = {
      ...current.ot,
      wageCeiling: num('wageCeiling'),
      ...(restMult !== undefined ? { restDayExcessMultiplier: restMult } : {}),
      ...(holidayMult !== undefined ? { holidayExcessMultiplier: holidayMult } : {}),
    };
  } else if (body === 'hrdf') {
    data = { mandatoryRate: num('mandatoryRate'), optionalRate: num('optionalRate') };
  } else {
    redirect(`${BASE}?error=${encodeURIComponent('Only EPF, OT and HRDF support the scalar override form.')}`);
  }

  try {
    await pack!.statutoryConfig.setComponent(s, { body, version, effectiveFrom, data, notes });
  } catch (e) {
    const t = await getTranslations('payroll.config');
    const msg = e instanceof StatutoryRulesetInvalidError && e.problems.includes('pcb_child_relief_configuration_invalid')
      ? t('childQualificationInvalid') : e instanceof StatutoryRulesetInvalidError ? e.problems.join('; ') : publicErrorMessage(e);
    redirect(`${returnTo}?error=${encodeURIComponent(msg)}`);
  }
  revalidatePath(returnTo);
  redirect(`${returnTo}?toast=${encodeURIComponent('Per-body override published')}`);
}

/** Archive a per-body override so the overlay skips it (admin). */
export async function archiveStatutoryComponentAction(formData: FormData) {
  const s = await getSession();
  const pack = packFor('MY');
  if (!pack) redirect(`${BASE}?error=${encodeURIComponent('No localization pack for MY.')}`);
  const id = String(formData.get('id') ?? '');
  try {
    await pack!.statutoryConfig.archiveComponent(s, id);
  } catch (e) {
    redirect(`${BASE}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Override archived')}`);
}

/** Archive a stored version so the active resolution skips it (admin). */
export async function archiveStatutoryAction(formData: FormData) {
  const s = await getSession();
  const pack = packFor('MY');
  if (!pack) redirect(`${BASE}?error=${encodeURIComponent('No localization pack for MY.')}`);
  const id = String(formData.get('id') ?? '');
  try {
    await pack!.statutoryConfig.archive(s, id);
  } catch (e) {
    redirect(`${BASE}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Version archived')}`);
}
