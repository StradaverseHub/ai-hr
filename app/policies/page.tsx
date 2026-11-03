import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz-model';
import { AiCentreTabs } from '@/components/ai-centre/centre-tabs';
import { AiCentrePolicies } from '@/components/ai-centre/policies';

/** AI v2 Phase 2, P2-5 — AI Centre › Policies, the Living Handbook (approved mock-up Handbook.dc.html).
 *
 * Its own linkable page (not a view of /assistant) so the semantic model's my_policy_handbook read, the guides and an
 * Ask reply can link it. Every signed-in person: the view decides what each person sees, and migration 0971's
 * row-level security decides what it can read (administrators: the policies of the companies they administer;
 * everyone else: approved versions of their own company's policies). Inside the AI Centre tab bar. */
export default async function PoliciesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await getSession();
  const sp = await searchParams;
  const query = Object.fromEntries(Object.entries(sp).map(([key, value]) => [key, typeof value === 'string' ? value : undefined]));
  return (
    <div data-ai-centre="policies" className="mx-auto max-w-6xl space-y-6">
      <AiCentreTabs active="policies" isAdmin={isAdmin(s)} />
      <AiCentrePolicies session={s} query={query} />
    </div>
  );
}
