/** PostgreSQL-native content version, not authentication or release evidence. The window expression
 * binds the history and its version in ONE statement/snapshot; a later read cannot acknowledge an unseen reply. */
export const FEEDBACK_DIALOGUE_SOURCE_AGGREGATE = "encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(id::text, question, answer, resolved_at IS NOT NULL) ORDER BY id)::text, '[]'), 'UTF8')), 'hex')";
export const FEEDBACK_DIALOGUE_SOURCE_WINDOW = "encode(sha256(convert_to((jsonb_agg(jsonb_build_array(id::text, question, answer, resolved_at IS NOT NULL)) OVER (PARTITION BY feedback_request_id ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING))::text, 'UTF8')), 'hex')";
