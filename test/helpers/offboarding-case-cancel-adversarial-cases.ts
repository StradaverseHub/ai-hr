/** Authored test-plan fixtures only: no executor, SQL, service calls or pass claims.
 * A future approved DB suite must create nonempty real rows and observe independent before/after
 * values and physical versions; it must not ask the verifier to supply its own expected result. */
export const CASE_CANCEL_EFFECT_ATTACKS=[
 {area:'case',mutation:'change_non_allowed_field',expected:'refuse'},
 {area:'case',mutation:'wrong_or_blank_reason',expected:'refuse'},
 {area:'case',mutation:'same_values_update_after_completed_receipt',expected:'refuse'},
 {area:'case',mutation:'reopen_then_recancel_with_same_reason',expected:'refuse'},
 {area:'steps',mutation:'edit_existing_row',expected:'refuse'},
 {area:'steps',mutation:'identical_values_update_changes_physical_version',expected:'refuse'},
 {area:'steps',mutation:'insert_or_reparent_extra_row',expected:'refuse'},
 {area:'it_return',mutation:'cancel_or_edit_existing_return',expected:'refuse'},
 {area:'it_return',mutation:'insert_or_reparent_extra_return',expected:'refuse'},
 {area:'it_items',mutation:'edit_or_insert_item',expected:'refuse'},
 {area:'linked_assets',mutation:'change_row_or_membership',expected:'refuse'},
 {area:'comments',mutation:'unexpected_row_change_or_extra',expected:'refuse'},
 {area:'native_event',mutation:'duplicate_candidate_or_wrong_payload_actor_subject',expected:'refuse'},
 {area:'native_history',mutation:'duplicate_candidate_or_wrong_reason_actor_case',expected:'refuse'},
 {area:'native_transaction',mutation:'released_child_savepoint_rows',expected:'refuse'},
 {area:'authority',mutation:'staff_revoked_or_downgraded_before_unwrap',expected:'refuse'},
 {area:'authority',mutation:'actor_person_or_case_subject_relinked',expected:'refuse'},
 {area:'authority',mutation:'assistant_grant_module_or_pause_revoked',expected:'refuse'},
 {area:'scope',mutation:'foreign_case_company_or_tenant',expected:'refuse'},
 {area:'interval',mutation:'real_concurrent_parent_child_writer_or_fk_membership_insert',expected:'fail_fast_or_block_writer_then_retry'},
 {area:'privacy',mutation:'expiry_discard_refusal_completion_or_canonical_erasure',expected:'private_pending_commitment_and_body_cleared'},
] as const;
export const CASE_CANCEL_POSITIVE_CONTROLS=[
 'real unlinked lifecycle manager with current company scope',
 'real linked USER/PERSON/employment with correct privacy targets',
 'genuine accepted outcome with a nonempty open IT return and item set preserved',
 'exact one original top-transaction event/history and case-only delta',
 'same review id returns the original completed receipt without another native write',
 'completed receipt remains valid after unrelated later IT work when the protected case tuple is unchanged',
 'outer custody refusal rolls back case/history/event and leaves original related rows intact',
] as const;
