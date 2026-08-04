'use server';

import { requireAdmin } from '@/lib/authz';
import {
  archiveNotice,
  createNotice,
  deleteNotice,
  duplicateNotice,
  publishNotice,
  restoreNotice,
  updateNotice,
  type NoticeInput,
} from '@/core/notice';
import { orgCriteriaFromFields } from '@/core/org-criteria';
import { fail, okToast } from '@/app/admin/_redirects';

/**
 * 6e122302 — the Notice Board's writes.
 *
 * Every one goes through `requireAdmin()` rather than a bare session: publishing a notice broadcasts to
 * every employee it resolves, and the route registration in lib/permissions.ts is what makes that guard
 * checkable by test/function-access.test.ts. RLS still fences which employments the publish can reach
 * (see migration 0390); the guard is the fail-fast layer in front of it.
 */

const BOARD = '/admin/notice-board';
const detail = (id: string) => `${BOARD}/${id}`;

/**
 * Read the form into a NoticeInput.
 *
 * The criteria come from the SHARED reader (`orgCriteriaFromFields`), which is the same field vocabulary
 * the Leave Adjustments screen posts. That is the point of generalising the resolver: one set of names,
 * one meaning, so "Finance + Executive" selects the same people on both screens.
 */
function inputFrom(fd: FormData): NoticeInput {
  const list = (name: string) => fd.getAll(name).map(String).filter(Boolean);
  const targetMode = fd.get('targetMode') === 'individual' ? 'individual' : 'criteria';
  return {
    title: String(fd.get('title') ?? ''),
    body: String(fd.get('body') ?? ''),
    startOn: String(fd.get('startOn') ?? ''),
    endOn: String(fd.get('endOn') ?? ''),
    showEndDate: fd.get('showEndDate') === 'on',
    targetMode,
    criteria: targetMode === 'criteria' ? orgCriteriaFromFields(list) : undefined,
    // One pasted block, split on whitespace or commas. Parsed HERE rather than mirrored into hidden inputs
    // by the browser, so the ids the action sees are the ids the user typed even with JS disabled.
    employmentIds:
      targetMode === 'individual'
        ? String(fd.get('employmentIdsRaw') ?? '')
            .split(/[\s,]+/)
            .filter(Boolean)
        : undefined,
    notifyOnPublish: fd.get('notifyOnPublish') === 'on',
    popupEnabled: fd.get('popupEnabled') === 'on',
    popupFrequency: fd.get('popupFrequency') === 'until_acknowledged' ? 'until_acknowledged' : 'once',
  };
}

export async function createNoticeAction(formData: FormData) {
  const s = await requireAdmin();
  let id: string;
  try {
    ({ id } = await createNotice(s, inputFrom(formData)));
  } catch (e) {
    return fail(`${BOARD}/new`, e);
  }
  // Land on the DRAFT, not back on the listing: the detail page is where the resolved audience count and
  // the publish button live, so this is the next step of the same task rather than a detour.
  okToast(detail(id), 'Notice saved as a draft');
}

export async function updateNoticeAction(formData: FormData) {
  const s = await requireAdmin();
  const id = String(formData.get('id') ?? '');
  try {
    await updateNotice(s, id, inputFrom(formData));
  } catch (e) {
    return fail(detail(id), e);
  }
  okToast(detail(id), 'Notice saved');
}

export async function publishNoticeAction(formData: FormData) {
  const s = await requireAdmin();
  const id = String(formData.get('id') ?? '');
  try {
    const res = await publishNotice(s, id);
    okToast(detail(id), `Published to ${res.recipients} employee(s)`);
  } catch (e) {
    fail(detail(id), e);
  }
}

export async function archiveNoticeAction(formData: FormData) {
  const s = await requireAdmin();
  const id = String(formData.get('id') ?? '');
  try {
    await archiveNotice(s, id);
    okToast(detail(id), 'Notice archived');
  } catch (e) {
    fail(detail(id), e);
  }
}

export async function restoreNoticeAction(formData: FormData) {
  const s = await requireAdmin();
  const id = String(formData.get('id') ?? '');
  try {
    await restoreNotice(s, id);
    okToast(detail(id), 'Notice restored');
  } catch (e) {
    fail(detail(id), e);
  }
}

export async function deleteNoticeAction(formData: FormData) {
  const s = await requireAdmin();
  const id = String(formData.get('id') ?? '');
  try {
    await deleteNotice(s, id);
  } catch (e) {
    return fail(detail(id), e);
  }
  // The notice is gone, so there is no detail page left to land on.
  okToast(BOARD, 'Notice deleted');
}

export async function duplicateNoticeAction(formData: FormData) {
  const s = await requireAdmin();
  const id = String(formData.get('id') ?? '');
  let copyId: string;
  try {
    ({ id: copyId } = await duplicateNotice(s, id));
  } catch (e) {
    return fail(BOARD, e);
  }
  okToast(detail(copyId), 'Notice duplicated as a draft');
}
