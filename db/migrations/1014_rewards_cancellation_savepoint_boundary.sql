-- The native cancellation proof is rooted in the transaction even if its
-- row was written in a child savepoint. The legacy path keeps its old rule.
DO $patch$
DECLARE definition text; anchor text:='  IF command=''withdraw'' THEN';
BEGIN
 definition:=pg_get_functiondef('app.reward_decision_published_source_guard()'::regprocedure);
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN
  RAISE EXCEPTION 'Reward withdrawal decision boundary changed';
 END IF;
 EXECUTE replace(definition,anchor,anchor||E'\n'
  ||'   IF EXISTS (SELECT FROM app.reward_cancel_native_effect effect'
  ||' WHERE effect.xact_id=pg_current_xact_id() AND effect.tenant_id=NEW.tenant_id'
  ||' AND effect.tenant_id=app.current_tenant_id() AND effect.user_id=app.current_user_id()'
  ||' AND effect.user_id=NEW.actor_id AND effect.unit_id=NEW.unit_id'
  ||' AND effect.decision_id=NEW.id AND effect.active AND NOT effect.completed)'
  ||' THEN RETURN NEW; END IF;');
END;
$patch$;
