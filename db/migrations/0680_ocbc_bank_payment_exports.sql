-- Approved board9eff8939. Source reservation idx670/1793330000003; journal parent-owned.
ALTER TABLE company_bank_profile ADD COLUMN file_contact_name text,
 ADD COLUMN file_contact_phone text, ADD COLUMN file_state_code text,
 ADD COLUMN require_payee_id_check boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE bank_payment_export (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 company_id uuid NOT NULL REFERENCES company(id), bank_profile_id uuid NOT NULL,
 actor_user_id uuid NOT NULL REFERENCES app_user(id), request_key uuid NOT NULL,
 value_date date NOT NULL, tape_id integer NOT NULL CHECK(tape_id BETWEEN 1 AND 999),
 format text NOT NULL, source_digest text NOT NULL, filename text NOT NULL, content text NOT NULL,
 record_count integer NOT NULL CHECK(record_count>0), total_cents bigint NOT NULL CHECK(total_cents>=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT bank_payment_export_tape_uq UNIQUE(tenant_id,value_date,tape_id),
 CONSTRAINT bank_payment_export_request_uq UNIQUE(tenant_id,actor_user_id,request_key)
);
--> statement-breakpoint
ALTER TABLE bank_payment_export ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_payment_export FORCE ROW LEVEL SECURITY;
CREATE POLICY bank_payment_export_read ON bank_payment_export FOR SELECT USING
 (tenant_id=app.current_tenant_id() AND actor_user_id=app.current_user_id() AND app.is_admin_for(company_id));
CREATE POLICY bank_payment_export_insert ON bank_payment_export FOR INSERT WITH CHECK
 (tenant_id=app.current_tenant_id() AND actor_user_id=app.current_user_id() AND app.is_admin_for(company_id));
GRANT SELECT,INSERT ON bank_payment_export TO app_user;

--> statement-breakpoint
-- The ledger is actor-scoped. Allocation must see the tenant's whole date to avoid collisions
-- between administrators/accounts; this narrowly returns only the next sequence, never artifacts.
CREATE FUNCTION app.next_bank_payment_tape(p_company uuid,p_date date) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE t uuid:=app.current_tenant_id();n integer;
BEGIN
 IF t IS NULL OR app.current_user_id() IS NULL OR NOT app.is_admin_for(p_company) THEN RAISE EXCEPTION 'Bank export unavailable'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('ocbc-tape:'||t::text||':'||p_date::text,0));
 SELECT coalesce(max(tape_id),0)+1 INTO n FROM public.bank_payment_export WHERE tenant_id=t AND value_date=p_date;
 IF n>999 THEN RAISE EXCEPTION 'OCBC value-date tape sequence is exhausted'; END IF;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION app.next_bank_payment_tape(uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.next_bank_payment_tape(uuid,date) TO app_user;
