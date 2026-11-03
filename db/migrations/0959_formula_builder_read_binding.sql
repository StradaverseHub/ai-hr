-- Authoring rows require Formula Builder View. Keep independent payroll calculation and trace readers.
ALTER POLICY formula_read ON public.pay_formula
 USING(tenant_id=app.current_tenant_id() AND (app.pay_formula_catalog_access() OR app.financial_formula_runtime_read(id,true)));
ALTER POLICY formula_read ON public.pay_formula_revision
 USING(tenant_id=app.current_tenant_id() AND (app.pay_formula_catalog_access() OR app.financial_formula_runtime_read(formula_id,true)));
ALTER POLICY formula_read ON public.pay_formula_event
 USING(tenant_id=app.current_tenant_id() AND (app.pay_formula_catalog_access() OR app.financial_formula_runtime_read(formula_id,false)));
ALTER POLICY formula_read ON public.pay_formula_accumulation
 USING(tenant_id=app.current_tenant_id() AND (app.pay_formula_catalog_access() OR app.financial_catalog_reference_read()));
