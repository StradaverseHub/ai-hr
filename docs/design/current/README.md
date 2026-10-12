# Current: Plum and Ledger

Approved direction: Current, Plum palette, compact Ledger records. The design exploration lives in `scratchpad/future-ui-options` (local, ignored); production styles live in `app/current.css`.

## Theme integration

Select **Current** from the account menu's Theme control. The existing `ui_theme` cookie and server layout apply it on every route and on the first server paint. Classic and Monolith remain selectable; their tokens and the missing-cookie default are unchanged. All six locales expose the Current name.

Current uses the Plum surface family, lavender section bands, chartreuse primary actions and a pink error colour. The appearance toggle adjusts surface depth while retaining Plum. Portals consume the same root tokens. Printed documents use paper tokens.

## Shared page coverage

The root tokens apply across authenticated and public routes: shell, forms, buttons, dialogs, filters and navigation. Shared CardHeader and SectionHeader components supply the lavender band. The company switcher keeps the existing multi-company selection and submission behavior.

All native tables inside the main screen use compact Ledger paint: aligned tabular numbers, restrained headings, alternating Plum surfaces and lavender focus indicators. Shared StackedTable keeps its mobile labels and native table roles. Existing table interactions, sticky columns, selection, forms, detail links and exports remain owned by their pages. Read-only tables do not acquire a misleading click action.

## Scope limits

This is the shared theme rollout, not a rewrite of every route's information architecture. It does not add a generic inspector to every legacy table; pages keep their existing detail views. The prototype's fictional records, gross salaries and demo workflow never enter the application. No schema, authorization, calculation, or data-query changes are part of this theme.

## Validation required before deployment

Theme cookie/action tests; all-locale picker and immediate switching tests; contrast checks; TypeScript; full repository gate (the theme registry is in `lib/`); production build; rendered checks for representative dashboard, personnel, attendance, leave, payroll and administration routes including narrow viewports, menus, dialogs, and print. DOM tests alone are not visual evidence.
