import { getTranslations } from 'next-intl/server';
import type { PublishedInstruction } from '@/lib/system-testing/model';
export async function TestingGuide({ definition }: { definition: PublishedInstruction }) {
  const t=await getTranslations('systemTestingWorkspace');
  return <div className="space-y-4 break-words">
    {definition.format===0?<p role="note" className="rounded-md border border-amber-400/50 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/25 dark:text-amber-100">{t('legacyUnknown')}</p>:<><p className="text-sm">{definition.objective}</p><dl className="grid gap-3 text-sm sm:grid-cols-2">{(['prerequisites','testData','permissions'] as const).map(key=><div key={key}><dt className="font-medium">{t(key)}</dt><dd><ul className="list-disc pl-4">{definition[key].map((v,i)=><li key={i}>{v}</li>)}</ul></dd></div>)}{(['jurisdiction','configuration'] as const).map(key=><div key={key}><dt className="font-medium">{t(key)}</dt><dd>{definition[key]??t('notSpecified')}</dd></div>)}</dl></>}
    {definition.format===0&&definition.precondition&&<p className="text-sm">{definition.precondition}</p>}
    <ol className="space-y-3">{definition.steps.map((step,index)=><li key={definition.format===1?(step as {id:string}).id:index} className="rounded-md border border-border p-3"><p className="mb-2 text-xs font-semibold text-muted-foreground">{t('stepNumber',{number:index+1})}</p><p className="text-sm">{typeof step==='string'?step:step.action}</p>{typeof step!=='string'&&<p className="mt-2 text-sm text-muted-foreground"><span className="font-medium">{t('expected')}: </span>{step.expected}</p>}</li>)}</ol>
    <dl className="grid gap-3 text-sm sm:grid-cols-2"><div><dt className="font-medium">{t('expectedBehavior')}</dt><dd>{definition.expectedBehavior??t('notSpecified')}</dd></div><div><dt className="font-medium">{t('expectedFunction')}</dt><dd>{definition.expectedFunction??t('notSpecified')}</dd></div></dl>
  </div>;
}
