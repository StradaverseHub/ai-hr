import {captureAiReviewScreenshots,aiReviewDomHtml} from './helpers/ai-review-screenshots';
import {expect,it} from 'vitest';
import {render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {TaskDocuments} from '../components/lifecycle-v9/task-documents';
import type {LifecycleTaskDocument} from '../lib/lifecycle-task-documents';
import messages from '../messages/en.json';
const item:LifecycleTaskDocument={caseId:'existing-case',caseNumber:'OB-2026-FICTIONAL',module:'off',revision:3,taskId:'task',taskName:'Device acceptance',taskStatus:'progress',dueOn:'2026-11-18',action:'signed',sourceName:'Onboarding checklist',sourceKind:'checklist',documentId:'saved-document',documentName:'Device acceptance',documentStatus:'opened',state:'released'};
it('renders existing document links, source, status, completion instruction and unreleased holds',()=>{
 render(<NextIntlClientProvider locale="en" messages={messages}><TaskDocuments page={{items:[item,{...item,taskId:'survey',taskName:'Survey',documentName:'Survey',documentId:null,documentStatus:null,state:'unreleased'}],total:2,offset:0,limit:50}}/></NextIntlClientProvider>);
 expect(screen.getByRole('heading',{name:'Documents to complete'})).toBeInTheDocument();
 expect(screen.getByRole('link',{name:'Open'})).toHaveAttribute('href','/me/lifecycle?case=existing-case&document=saved-document');
 expect(screen.getByRole('link',{name:'Open document'})).toHaveAttribute('href','/me/lifecycle?case=existing-case&document=saved-document');
 expect(screen.getByText('Opened')).toBeInTheDocument();expect(screen.getAllByText('From Onboarding checklist')).toHaveLength(2);
 expect(screen.getAllByText('Completes when you sign the document')).toHaveLength(2);expect(screen.getByText('This document hasn’t been released yet')).toBeInTheDocument();
});
it('keeps signed documents viewable and never offers a guessed link for duplicate records',()=>{
 render(<NextIntlClientProvider locale="en" messages={messages}><TaskDocuments page={{items:[{...item,taskStatus:'done',documentStatus:'signed'},{...item,taskId:'other',documentId:null,state:'review'}],total:2,offset:0,limit:50}}/></NextIntlClientProvider>);
 expect(screen.getByRole('heading',{name:'Completed documents'})).toBeInTheDocument();expect(screen.getByRole('link',{name:'View'})).toBeInTheDocument();expect(screen.getByText('Signed')).toBeInTheDocument();expect(screen.getByText('HR needs to review multiple saved documents for this template.')).toBeInTheDocument();
});

it.each(['light','dark'] as const)('captures the approved task document states in %s on phone and desktop',async mode=>{
 const {container}=render(<NextIntlClientProvider locale="en" messages={messages}><div className="mx-auto max-w-5xl space-y-5"><h1 className="text-2xl font-semibold">My tasks</h1><TaskDocuments page={{items:[item,{...item,taskId:'survey',taskName:'Onboarding survey',documentName:'Onboarding survey',documentId:null,documentStatus:null,state:'unreleased'},{...item,taskId:'signed-task',taskName:'Completed acceptance',documentId:'signed-document',documentName:'Completed acceptance',documentStatus:'signed',taskStatus:'done'}],total:3,offset:0,limit:50}}/></div></NextIntlClientProvider>);
 await captureAiReviewScreenshots(aiReviewDomHtml(container),'en',`feedback-task-documents-${mode}`,'real My tasks document component; fictional existing instances; authenticated open/sign verified separately','classic',mode);
},30000);
