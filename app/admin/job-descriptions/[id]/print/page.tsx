import {getTranslations} from 'next-intl/server';
import {notFound} from 'next/navigation';
import {requireAdmin} from '@/lib/authz';
import {readJobDocument} from '@/packs/job-descriptions/service';
import {JobDocument} from '../../document';
import {PrintButton} from './print-button';
export default async function PrintJobPage({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{revision?:string}>}){const s=await requireAdmin();const t=await getTranslations('jobDescriptions');const{id}=await params;const{revision}=await searchParams;const detail=await readJobDocument(s,id,revision).catch(()=>null);if(!detail)notFound();return <main className="mx-auto max-w-5xl space-y-5 print:max-w-none print:bg-white print:text-black"><div className="print:hidden"><PrintButton/></div><h1 className="text-2xl font-semibold">{detail.revision.title}</h1><JobDocument detail={detail} t={t}/><style>{`@media print{body{background:white!important}aside,header,nav,[data-sidebar],.print\\:hidden{display:none!important}main{margin:0!important;width:100%!important}a{color:inherit!important} [data-ui-card]{box-shadow:none!important;break-inside:auto}h2,h3{break-after:avoid} @page{margin:15mm}}`}</style></main>;}
