import { todayInKualaLumpur } from '@/lib/hr-date';
import { requireModule } from '@/lib/authz';
import { v9OwnWork } from '@/packs/lifecycle/service';
import { EmployeeLifecycle } from './view';
import '../../lifecycle/v9/workspace.css';
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [cases, query] = await Promise.all([v9OwnWork(await requireModule('lifecycle')), searchParams]);
  const caseId = typeof query.case === 'string' ? query.case : '', documentId = typeof query.document === 'string' ? query.document : '';
  // The query only selects an already-authorized projection; it never loads a different subject.
  const selected = cases.some(c => c.id === caseId && c.documents.some(document => document.id === documentId)) ? { caseId, documentId } : null;
  return <EmployeeLifecycle key={selected ? selected.caseId + ':' + selected.documentId : 'tasks'} today={todayInKualaLumpur()} cases={cases} initialSelection={selected}/>;
}
