# Shared Form answers and signature receipts

Status: proposed, not implemented or registered as a migration. Automatic approval review rejected the privileged Form adapter and fingerprint changes. Existing Contract letters and signing continue to use their current owner. Empty response-table drafts are unregistered and have no application entry point.

The proposed behavior follows the HTML and existing V9 Forms:

1. A Form comes from the published document blocks and fields. It uses the actual Contract case and employee; it does not create a pretend Onboarding/Offboarding case.
2. A verified assigned HR reviewer completes HR-owned fields. Personnel-locked fields cannot be edited through the ordinary Form save action. The employee's actual person identity cannot gain HR field-editing power by being labelled “HR” in a routing step.
3. The actual employee completes employee-owned fields when their step is pending. Their responses may be completed after an earlier HR signature, as existing V9 Forms allow.
4. The first signature freezes the legal template, merged Personnel/decision values and HR-owned responses. Later employee answers have separate revisions and a separate signed receipt. The earlier HR signature is never represented as approval of answers entered later.
5. Signing checks the exact legal-content hash and the answer revision/hash reviewed on screen. A concurrent edit or changed employee identity refuses the stale action. A direct generic-signing call cannot skip Form validation.
6. The final released Form records a fingerprint covering the frozen legal base, final responses and actual signature receipts. The existing signing owner remains the only owner of routes and signing actions.
7. Only current or previous verified routed actors, plus the explicitly assigned document owner, see Form contents. Case-view permission alone does not expose a released Form. Future assigned actors do not see it before their turn unless they are its document owner.
8. Saving or completing an email-attached Form does not reopen a Contract case or change posting/pay status. Form answers do not update Personnel or Payroll. Any later Personnel correction requires its existing authorised review and writer.

The private response owner would store answer revisions, action preparations and immutable receipts keyed to the existing canonical signing document. A public action accepts only a document ID, expected revisions/hashes and a patch to declared field IDs; it cannot select another employee, field owner, source table or role.

The API proposed for the finished UI is:

```ts
readContractSharedForm(context, letterId)
// null for a non-Form; hidden metadata for an actor without Form-body access;
// otherwise: values, editableFieldIds, missingLockedFields,
// responseRevision, responseHash, legalBaseHash and receipt summaries.

saveContractSharedForm(context, {
 id, contentRevision, contentHash, responseRevision, responseHash,
 values: { /* only declared, native-authorised field IDs */ }
})

// Existing review/sign action, with an additional Form concurrency proof:
actContractSharedLetter(context, {
 /* existing exact actor/step/content/signature input */,
 responseRevision, responseHash
})
```

The rejected adapter's intended private body gate is shown below for review. It is not an applied migration:

```sql
-- After confirming this is a Form belonging to the actual tenant/document:
-- owner, pending actor or recorded past actor must match BOTH account and person.
EXISTS (
 SELECT 1 FROM jsonb_array_elements(signing.data->'route'->'steps') step
 WHERE step->'owner'='true'::jsonb
 AND step->>'holderId'=app.current_user_id()::text
 AND step->>'holderPersonId'=app.contract_actor_person(app.current_user_id())::text
)
OR EXISTS (
 SELECT 1 FROM app.document_signing_pending_steps(signing.data) step
 WHERE step->>'holderId'=app.current_user_id()::text
 AND step->>'holderPersonId'=app.contract_actor_person(app.current_user_id())::text
)
OR EXISTS (
 SELECT 1 FROM jsonb_array_elements(signing.data->'actions') action
 WHERE action->>'actorId'=app.current_user_id()::text
 AND action->>'actorPersonId'=app.contract_actor_person(app.current_user_id())::text
)
```

The new base projection would apply only to a newly prepared Form before its canonical signing document is created. It retains only merge values referenced by that published Form and its field/signature blocks. Existing letters, historical snapshots and signatures do not change their fingerprint protocol.

Required hosted checks include field-type/options/required/show-when parity with V9, actual-identity field ownership, foreign subject/account relinking, concurrent saves and stale signing, HR-before-employee receipt scopes, generic-signing bypass refusal, released Form privacy, email-case isolation, restricted-owner migrations and populated upgrades.

Approval is requested for this bounded Form response and receipt behavior, separately from approval for selected Personnel/statutory field reads. It does not approve merging, staging installation or release.
