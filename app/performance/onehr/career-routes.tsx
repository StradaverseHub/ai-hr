import { getTranslations } from 'next-intl/server';
import type { careerRoutes } from '@/packs/performance/onehr/career-model';

export async function CareerRoutes({routes}:{routes:ReturnType<typeof careerRoutes>}) {
 const t=await getTranslations('onehr.careerMap');
 if(!routes.length)return null;
 return <section className="space-y-4" aria-label={t('title')}>
  <div><h3 className="font-semibold">{t('title')}</h3><p className="mt-1 text-sm text-muted-foreground">{t('help')}</p></div>
  {(['closest','stretch','longer','related'] as const).map(group=>{
   const members=routes.filter(r=>r.group===group);if(!members.length)return null;
   return <section key={group} className="space-y-3"><h4 className="text-sm font-medium">{t(`groups.${group}`)}</h4><div className="grid gap-3 sm:grid-cols-2">{members.map(route=><article key={route.profile.id} className="space-y-3 rounded-md border border-border p-4">
    <header><h5 className="text-sm font-semibold">{route.profile.jobTitle??route.profile.name}</h5><p className="text-xs text-muted-foreground">{route.profile.department} · {t('grade',{grade:route.profile.grade})} · {t(route.lane)}</p></header>
    <p className="text-sm">{route.readiness==null?t('unassessed'):t('readiness',{value:route.readiness,met:route.gap.met,total:route.gap.total})}</p>
    <details><summary className="cursor-pointer text-sm text-primary">{t('skills')}</summary><ul className="mt-3 space-y-2">{route.gap.rows.map(skill=><li key={skill.title} className="text-sm"><span className="font-medium">{skill.title}</span><span className="mt-0.5 block text-xs text-muted-foreground">{t(`states.${skill.state}`)} · {t('required',{level:skill.required})}{skill.have!=null&&` · ${t('demonstrated',{level:skill.have})}`}</span></li>)}</ul></details>
   </article>)}</div></section>;
  })}
 </section>;
}
