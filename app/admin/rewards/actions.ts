'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { publicErrorMessage } from '@/lib/public-error';
import { cancelRewardReview } from '@/packs/rewards/service';

const str = (f: FormData, key: string) => String(f.get(key) ?? '').trim();

/** 62e743ed: cancel a started review with a written reason. cancelRewardReview decides; this only relays. */
export async function cancelRewardAction(f: FormData) {
  try { await cancelRewardReview(await getSession(), str(f, 'unitId'), Number(str(f, 'revision')), str(f, 'reason')); }
  catch (error) { redirect(`/admin/rewards?error=${encodeURIComponent(publicErrorMessage(error))}`); }
  revalidatePath('/rewards', 'layout'); revalidatePath('/admin/rewards', 'layout'); redirect('/admin/rewards?cancelled=1');
}
