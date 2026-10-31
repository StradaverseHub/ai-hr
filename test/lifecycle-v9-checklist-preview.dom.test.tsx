import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChecklistPreview } from '../app/(app)/lifecycle/v9/checklist-preview';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
import { fictionalV9Case } from './fixtures/lifecycle-v9/case';
it('previews the matched checklist using the last-day anchor without assigning or changing work',()=>{
 const config=v9Defaults();config.checklists=[{id:'preview',name:'Fictional exit checklist',module:'off',rules:{},tasks:[{id:'handover',name:'Fictional handover',by:'employee',group:null,mode:'manual',opens:-1,due:0,required:true,documentTemplate:null,documentAction:'signed'}]}];
 const c=fictionalV9Case({state:'pending'}),source=JSON.stringify({c,config});
 render(<ChecklistPreview c={c} config={config}/>);
 expect(screen.getByText('Fictional handover *')).toBeVisible();
 expect(screen.getByText('Employee · Due 30/11/2026 · Opens 29/11/2026')).toBeVisible();
 expect(screen.queryByRole('combobox')).not.toBeInTheDocument();expect(screen.queryByRole('button')).not.toBeInTheDocument();
 expect(JSON.stringify({c,config})).toBe(source);
});
