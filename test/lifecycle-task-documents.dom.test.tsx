import {expect,it} from 'vitest';
import {render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {TaskDocuments} from '../components/lifecycle-v9/task-documents';
import type {LifecycleTaskDocument} from '../lib/lifecycle-task-documents';
import messages from '../messages/en.json';
const item:LifecycleTaskDocument={caseId:'existing-case',caseNumber:'OB-2026-FICTIONAL',module:'onb',revision:3,taskId:'task',taskName:'Device acceptance',taskStatus:'progress',dueOn:'2026-11-18',action:'signed',sourceName:'Onboarding checklist',sourceKind:'checklist',documentId:'saved-document',documentName:'Device acceptance',documentStatus:'opened',state:'released'};
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
