# Current: Plum workspace and Ledger

Current is an optional UI theme, selected from the account menu. It retains the approved Plum palette and now has its own navigation and record structure. The first rollout only changed shared paint; that did not implement the prototype's workspace or Ledger interaction.

## Workspace navigation

Every authenticated route uses a horizontal workspace bar instead of a sidebar. Workspace tabs expose their destinations in a second row. Modules expand an inline third row; Escape closes the module and returns focus to its trigger. The active workspace remains marked while browsing another workspace. On narrow screens the rows scroll within their own boundary.

The navigation consumes the existing Sidebar's filtered groups, pack destinations, active-route predicates, approval count, role authority and module entitlements. It is not a second navigation catalog. The company control separates its context caption from the active scope and keeps the existing multi-company behavior.

## Dashboard

The normal dashboard presents the user's configured cards as expandable colored work ribbons. The first section starts open. Existing card contents, destinations, mandatory cards and saved order remain authoritative. Customize still opens the existing reorder/add/remove interface; no preferences are discarded.

These ribbons summarize existing dashboard sections. They do not invent individual requests or inline approval actions from the prototype's demo data.

## Record workspaces

Personnel directory, Personnel administration and Payroll Process list use the compact Ledger with a persistent selected-record inspector. Selecting a record updates its facts and actions without navigating away. Open full record uses the existing destination. Table returns to the original full-column view. Pagination and filters remain outside the selected presentation.

The inspector resolves selection against the currently authorized page's records on every render. A scope, filter or page change cannot retain a removed record. The directory exposes only its existing work-contact projection. Administration follows the user's selected columns and includes draft records. Payroll reuses the actual table's rendered cells and actions, including publication/recalculation warnings and the original action gates; it does not recalculate or duplicate payroll logic.

Other screens receive the Current shell, page-heading hierarchy and shared Plum components. Their specialized tables and workflows remain owned by their pages; they do not all receive a generic inspector. Classic and Monolith retain their existing structure. Monolith remains the missing-cookie default.

## Validation

Exercise navigation for employee and administrator roles, module expansion/Escape, theme switching, record selection, replacement of a page's projection, original-table access, existing payroll actions, desktop and narrow layouts, company/account menus and print. Render real routes in addition to component tests. No schema, query, authorization or payroll-calculation changes belong to this presentation work.
