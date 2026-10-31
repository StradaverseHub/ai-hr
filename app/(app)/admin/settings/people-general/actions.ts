'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { PeopleGeneralError, savePeopleGeneral } from '@/core/people-general';
import { publicErrorMessage } from '@/lib/public-error';
const PAGE = '/admin/settings/people-general';
export async function savePeopleGeneralAction(form: FormData) {
  const s = await getSession();
  const t = await getTranslations('peopleGeneral');
  let error: string | undefined;
  try {
    const values = form.getAll('allowDuplicatedNric'), emailValues = form.getAll('allowDuplicatedEmail');
    if ([values, emailValues].some(list => list.length > 1 || list.some(value => value !== 'true'))) throw new PeopleGeneralError('invalid');
    const revisions = form.getAll('revision');
    if (revisions.length !== 1 || typeof revisions[0] !== 'string') throw new PeopleGeneralError('invalid');
    await savePeopleGeneral(s, { allowDuplicatedNric: values.length === 1, allowDuplicatedEmail: emailValues.length === 1, revision: revisions[0] || null });
    revalidatePath(PAGE);
    revalidatePath('/admin/personnel/import');
  } catch (e) {
    error = e instanceof PeopleGeneralError ? t(`errors.${e.reason}`) : publicErrorMessage(e);
  }
  if (error) redirect(`${PAGE}?error=${encodeURIComponent(error)}`);
  redirect(`${PAGE}?toast=${encodeURIComponent(t('saved'))}`);
}
