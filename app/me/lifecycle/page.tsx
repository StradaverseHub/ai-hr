import { requireModule } from '@/lib/authz';
import { v9OwnWork } from '@/packs/lifecycle/service';
import { EmployeeLifecycle } from './view';
import '../../lifecycle/v9/workspace.css';
export default async function Page() { return <EmployeeLifecycle cases={await v9OwnWork(await requireModule('lifecycle'))}/>; }
