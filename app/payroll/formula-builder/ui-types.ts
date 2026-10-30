import type {PayFormulaView} from '@/lib/pay-formula-model';
export type FormulaCapabilities={view:boolean;edit:boolean;test:boolean;activate:boolean;deactivate:boolean;delete:boolean};
export type FormulaBuilderOptions={companies:{id:string;name:string}[];employees:{id:string;companyId:string;code:string;name:string}[];cycles:{id:string;companyId:string;code:string;label:string}[];payItems:{code:string;name:string}[];activeFormulas:{id:string;formulaId:string;description:string;revisionId:string;dependencies:string[]}[];accumulations:{id:string;code:string;members:string[]}[];capabilities:FormulaCapabilities};
export type FormulaBuilderView=PayFormulaView&{capabilities?:FormulaCapabilities};
export const NO_FORMULA_CAPABILITIES:FormulaCapabilities={view:false,edit:false,test:false,activate:false,deactivate:false,delete:false};
export const formulaInput='mt-1 block w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';
export const formulaButton='inline-flex min-h-9 items-center justify-center rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
export const formulaPrimary=formulaButton+' border-primary bg-primary text-primary-foreground hover:bg-primary/90';
