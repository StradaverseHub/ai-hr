-- Operator switch for a customer's Feedback menu.
-- `feedback.menu_enabled` is platform-scoped: tenant_setting_write (0313) refuses every customer write,
-- so only these operator functions change it. No row means the default (on), so existing tenants keep
-- the menu without a backfill.
INSERT INTO setting_definition(key,module_code,scope,value_type,default_value,default_on_install,customer_visible,description,sort_order)
VALUES('feedback.menu_enabled',NULL,'platform','boolean','true'::jsonb,NULL,false,'Show the Feedback menu and board to this customer. Operator-managed.',111) ON CONFLICT(key) DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION app.operator_customer_feedback_menu(p_tenant uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result boolean;
BEGIN
 PERFORM app.assert_customer_operator();
 IF NOT EXISTS(SELECT 1 FROM public.tenant WHERE id=p_tenant AND id<>'00000000-0000-0000-0000-000000000000'::uuid)
 THEN RAISE EXCEPTION 'OPERATOR_CUSTOMER_MISSING'; END IF;
 SELECT CASE WHEN jsonb_typeof(s.value)='boolean' THEN (s.value)::boolean END INTO result
  FROM public.tenant_setting s WHERE s.tenant_id=p_tenant AND s.key='feedback.menu_enabled';
 RETURN coalesce(result,true);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.operator_customer_feedback_menu(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.operator_customer_feedback_menu(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.operator_set_customer_feedback_menu(p_tenant uuid,p_enabled boolean) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before boolean;
BEGIN
 PERFORM app.assert_customer_operator();
 IF p_enabled IS NULL THEN RAISE EXCEPTION 'OPERATOR_ACTION_INVALID'; END IF;
 PERFORM 1 FROM public.tenant WHERE id=p_tenant AND id<>'00000000-0000-0000-0000-000000000000'::uuid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'OPERATOR_CUSTOMER_MISSING'; END IF;
 SELECT CASE WHEN jsonb_typeof(s.value)='boolean' THEN (s.value)::boolean END INTO before
  FROM public.tenant_setting s WHERE s.tenant_id=p_tenant AND s.key='feedback.menu_enabled';
 IF coalesce(before,true)=p_enabled THEN RETURN; END IF;
 INSERT INTO public.tenant_setting(tenant_id,key,value,source,updated_by)
 VALUES(p_tenant,'feedback.menu_enabled',to_jsonb(p_enabled),'platform',app.current_user_id())
 ON CONFLICT(tenant_id,key) DO UPDATE SET value=EXCLUDED.value,source='platform',updated_by=EXCLUDED.updated_by,updated_at=now();
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(p_tenant,'tenant-setting',p_tenant,'tenant-setting.changed','user',app.current_user_id(),
  jsonb_build_object('key','feedback.menu_enabled','before',coalesce(before,true),'after',p_enabled,'by','operator'));
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.operator_set_customer_feedback_menu(uuid,boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.operator_set_customer_feedback_menu(uuid,boolean) TO ai_hr_app;
