'use client';
import {useId,type ReactNode} from 'react';
import {useTranslations} from 'next-intl';
import type {Template} from '@/lib/lifecycle-v9-model';

/** Offboarding only: explicit fallback does not reinterpret legacy hrStep or template-version routing. */
export function OffboardingSignatureFallback({template,hasRouting,disabled,onChange}:{template:Template;hasRouting:boolean;disabled:boolean;onChange:(value:Template['offboardingHrSignature'])=>void}){
 const t=useTranslations('resignationJourney'),hint=useId();
 if(template.module!=='off'||hasRouting)return null;
 return <div className="v9-stack"><label className="v9-field"><span>{t('offboardingFallback')}</span><select value={template.offboardingHrSignature??''} disabled={disabled} aria-describedby={hint} onChange={event=>onChange(event.target.value?event.target.value as NonNullable<Template['offboardingHrSignature']>:undefined)}>
  <option value="">{t('offboardingFallbackLegacy')}</option><option value="pbp">{t('offboardingFallbackPbp')}</option><option value="beforeEmployee">{t('offboardingFallbackBeforeEmployee')}</option><option value="namedHr">{t('offboardingFallbackNamed')}</option>
 </select></label><p id={hint} className="v9-muted">{t('offboardingFallbackHint')}</p></div>;
}

/** The displayed version's routing is authoritative; stored legacy fallback values are left intact. */
export function OffboardingSignatureContext({template,hasRouting,children}:{template:Pick<Template,'module'|'type'>;hasRouting:boolean;children:ReactNode}){
 const t=useTranslations('resignationJourney');
 return template.module==='off'&&template.type==='Letter'&&hasRouting?<p className="v9-muted">{t('signingFollowsRouting')}</p>:<>{children}</>;
}
