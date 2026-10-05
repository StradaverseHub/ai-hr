'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { withdrawProfileChangesForLockedFields } from '@/core/profile';
import {
  TenantSettingError,
  profileChangeAllowedKeys,
  setTenantSetting,
} from '@/core/tenant-settings';
import {
  PROFILE_REQUESTABLE_KEYS,
  PROFILE_REQUEST_APPROVERS,
  PROFILE_REQUEST_APPROVER_SETTING_KEY,
  PROFILE_REQUEST_FIELDS_SETTING_KEY,
  type ProfileRequestApprover,
} from '@/lib/profile-requestable-fields';

const PAGE = '/admin/settings/profile-requests';

/** A typed refusal names WHICH condition of 0313's write policy failed; anything else reports itself. */
async function refuse(e: unknown): Promise<never> {
  const t = await getTranslations('profileRequestSettings');
  const msg = e instanceof TenantSettingError ? t(`refused.${e.reason}`) : publicErrorMessage(e);
  redirect(`${PAGE}?error=${encodeURIComponent(msg)}`);
}

/**
 * WHICH FIELDS an employee may ask to change — the plan's first stage-three promise.
 *
 * ⚠️ THE POSTED NAMES ARE INTERSECTED WITH THE DECLARATION, never trusted. The form posts one `field`
 * entry per ticked box, and a hand-rolled POST could name anything at all; only keys
 * `lib/profile-requestable-fields.ts` declares survive, so this form can never store a permission over a
 * field that does not exist — or, worse, over one deliberately left out of the declaration (an HR
 * determination, or something on the withheld list an employee may not even see).
 *
 * ── AND THE PENDING REQUESTS ARE DEALT WITH IN THE SAME BREATH ──────────────────────────────────────
 * A field that was allowed and is now not is a LOCKED field, and every request waiting on one is
 * rejected with a reason the employee can read. The order matters: the setting is written FIRST, so a
 * failure part-way cannot leave requests withdrawn under a permission that was never actually changed.
 * The reason sentence is composed HERE rather than in the service because it is customer-facing prose
 * and belongs in the six catalogues, not in a core module.
 */
export async function saveProfileRequestFieldsAction(formData: FormData) {
  const s = await getSession();
  const t = await getTranslations('profileRequestSettings');

  const declared = new Set(PROFILE_REQUESTABLE_KEYS);
  const posted = formData.getAll('field').map((v) => String(v));
  // Declaration ORDER, not posted order: the stored array is read by people, and a stable order means a
  // diff of two tenants' settings is legible.
  const next = PROFILE_REQUESTABLE_KEYS.filter((k) => posted.includes(k) && declared.has(k));

  const before = profileChangeAllowedKeys(s);
  const locked = [...before].filter((k) => !next.includes(k));

  try {
    await setTenantSetting(s, { key: PROFILE_REQUEST_FIELDS_SETTING_KEY, value: next });
  } catch (e) {
    await refuse(e);
  }

  let withdrawn = 0;
  try {
    ({ withdrawn } = await withdrawProfileChangesForLockedFields(s, {
      lockedKeys: locked,
      reason: t('withdrawnReason'),
    }));
  } catch (e) {
    await refuse(e);
  }

  revalidatePath(PAGE);
  revalidatePath('/me');
  revalidatePath('/approvals');
  const toast = withdrawn > 0 ? t('savedFieldsWithdrew', { count: withdrawn }) : t('savedFields');
  redirect(`${PAGE}?toast=${encodeURIComponent(toast)}`);
}

/**
 * WHO APPROVES — the plan's second stage-three promise, and SINGLE-LEVEL, as the reporter approved it.
 *
 * The value is matched against the closed list rather than passed through: a setting that decides who
 * may approve a pay-affecting change must never be able to hold a word nothing in the product
 * understands. An unrecognised value would resolve to `admin` on read anyway (the narrow answer), but
 * refusing it here means the stored row and the enforced rule always say the same thing.
 */
export async function saveProfileRequestApproverAction(formData: FormData) {
  const s = await getSession();
  const t = await getTranslations('profileRequestSettings');
  const raw = String(formData.get('approver') ?? '');
  const approver = PROFILE_REQUEST_APPROVERS.find((a) => a === raw) as ProfileRequestApprover | undefined;
  if (!approver) redirect(`${PAGE}?error=${encodeURIComponent(t('unknownApprover'))}`);

  try {
    await setTenantSetting(s, { key: PROFILE_REQUEST_APPROVER_SETTING_KEY, value: approver });
  } catch (e) {
    await refuse(e);
  }

  revalidatePath(PAGE);
  revalidatePath('/approvals');
  redirect(`${PAGE}?toast=${encodeURIComponent(t('savedApprover'))}`);
}
