import {redirect} from 'next/navigation';
import {getSession} from '@/lib/session';
import {contractTemplates,contractCompanies} from '@/packs/contracts/service';
import {templateLabels} from '@/app/letters/templates/labels';
import {ContractTemplatesEditor} from './editor';
import '../../v9/workspace.css';
export default async function Page(){const session=await getSession();if(!session)redirect('/login');const [templates,companies,labels]=await Promise.all([contractTemplates(session),contractCompanies(session),templateLabels()]);return <main className="v9-workspace"><ContractTemplatesEditor templates={templates} companies={companies.filter(c=>c.gbs)} editorLabels={labels.editor}/></main>;}
