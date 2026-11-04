import {getTranslations} from 'next-intl/server';
import {z} from 'zod';
import {scopedSession} from '@/lib/scope';
import {orgChartSnapshot,orgChartDate,recordOrgChartExport,orgChartActorName,orgChartCompanies} from '@/core/org-chart';
import {getCompanyLogo} from '@/core/admin';
import {orgChartVisibleIds,orgChartSearchIds} from '@/lib/org-chart-model';
import {renderOrgChartPdf} from '@/lib/org-chart-pdf';
const filterSchema=z.object({companyId:z.string().max(64).optional(),businessUnitId:z.string().max(64).optional(),departmentId:z.string().max(64).optional(),employmentType:z.string().max(32).optional(),status:z.enum(['all','active','probation','notice']).optional(),query:z.string().max(150).optional(),asOf:z.string().max(10)}).strict();
export async function POST(request:Request){
 const {s}=await scopedSession();const scopeIds=(await orgChartCompanies(s)).map(company=>company.id);const form=await request.formData();let filter,collapsed:string[];
 try{filter=filterSchema.parse(JSON.parse(String(form.get('filter')??'')));orgChartDate(filter.asOf);collapsed=z.array(z.uuid()).max(20000).parse(JSON.parse(String(form.get('collapsed')??'[]')));}catch{return new Response('Invalid organisation view',{status:400});}
 if(filter.companyId&&!scopeIds.includes(filter.companyId))return new Response('Unavailable',{status:403});
 const snapshot=await orgChartSnapshot(s,{companyIds:scopeIds,filter});if(!snapshot.canManage)return new Response('Unavailable',{status:403});
 const scope=form.get('scope')==='branch'?'branch':'current';const root=scope==='branch'?String(form.get('root')??''):undefined;
 if(root&&!snapshot.employees.some(e=>e.employmentId===root))return new Response('Unavailable',{status:404});
 if(scope==='branch'&&!root)return new Response('Choose a branch',{status:400});
 const search=scope==='current'&&filter.query?.trim()?orgChartSearchIds(snapshot.employees,snapshot.edges,filter.query):null;
 const selected=search?snapshot.employees.filter(e=>search.has(e.employmentId)):snapshot.employees;
 const selectedEdges=search?snapshot.edges.filter(e=>search.has(e.manager)&&search.has(e.subordinate)):snapshot.edges;
 const visible=orgChartVisibleIds(selected,selectedEdges,scope==='current'?collapsed:[],root);
 const employees=snapshot.employees.filter(e=>visible.has(e.employmentId));const edges=snapshot.edges.filter(e=>visible.has(e.manager)&&visible.has(e.subordinate));
 if(!employees.length)return new Response('No employees in this view',{status:400});
 const t=await getTranslations('org');const actor=await orgChartActorName(s);const companyIds=[...new Set(employees.map(e=>e.companyId))];
 const names=[...new Set(employees.map(e=>e.company))].join(' · ');const logo=companyIds.length===1?await getCompanyLogo(s,companyIds[0]):null;
 const named=(id:string|undefined,key:'companyId'|'businessUnitId'|'departmentId',label:'company'|'businessUnit'|'department')=>id?snapshot.options.find(o=>o[key]===id)?.[label]??t('filters.all'):t('filters.all');
 const filterText=[`${t('filters.asOf')}: ${filter.asOf}`,`${t('filters.company')}: ${named(filter.companyId,'companyId','company')}`,`${t('filters.businessUnit')}: ${named(filter.businessUnitId,'businessUnitId','businessUnit')}`,`${t('filters.department')}: ${named(filter.departmentId,'departmentId','department')}`,`${t('filters.employmentType')}: ${filter.employmentType?t('types.'+filter.employmentType):t('filters.all')}`,`${t('filters.status')}: ${t('statuses.'+(filter.status??'all'))}`,...(filter.query?[`${t('searchAria')}: ${filter.query}`]:[])].join(' · ');
 const layout={horizontal:form.get('horizontal')==='true',paper:form.get('paper')==='A3'?'A3' as const:'A4' as const,orientation:form.get('orientation')==='portrait'?'portrait' as const:'landscape' as const,pagination:form.get('pagination')==='pages'?'pages' as const:'fit' as const};
 const bytes=await renderOrgChartPdf({employees,edges,title:t('title'),company:names,filters:filterText,generated:new Date().toISOString(),generatedBy:actor,confidential:form.get('confidential')==='true'?t('export.confidential'):null,logo,...layout,labels:{reports:t('directReports',{count:0}),topLevel:t('topLevel.tag'),outside:t('outsideShort'),vacant:t('vacantSuperior'),unassigned:t('integrity.unassigned'),page:t('export.page')}});
 await recordOrgChartExport(s,{companyIds,asOf:filter.asOf,employmentIds:employees.map(e=>e.employmentId),filters:filter,layout:{...layout,scope,root,collapsed:scope==='current'?collapsed:[]}});
 return new Response(new Uint8Array(bytes),{headers:{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="org-chart-${filter.asOf}.pdf"`,'Cache-Control':'private, no-store'}});
}
