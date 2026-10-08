import { getSession } from '@/lib/session';
import { LEVEL, myLifecycleLevel, onboardingTemplate } from '@/packs/lifecycle/service';

export async function GET() {
  const s = await getSession();
  if ((await myLifecycleLevel(s)) < LEVEL.agent) return new Response('Forbidden', { status: 403 });
  return new Response(new Uint8Array(onboardingTemplate()), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': 'attachment; filename="onboarding-import-template.xlsx"',
      'x-content-type-options': 'nosniff',
    },
  });
}
