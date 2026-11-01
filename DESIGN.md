---
name: AIHR
description: Atelier operational workspace and scoped public sign-in
colors:
  primary: "#c2410c"
  primary-hover: "#a8380a"
  primary-wash: "#fdf1ea"
  surface: "#ffffff"
  sidebar: "#f8f8f9"
  ink: "#1c1c1f"
  sidebar-ink: "#4b4b52"
  muted-ink: "#66666e"
  line: "#e8e8eb"
  line-strong: "#dcdce0"
  hover: "#efeff1"
  selected: "#e9e9ec"
  destructive: "#b42318"
  mark-ink: "#8a5a2e"
  mark-wash: "#f5ede5"
  login-ink: "#28235e"
  login-hover: "#373075"
  login-muted: "#60616b"
  login-line: "#8e8b9f"
  login-focus: "#7764c2"
  dark-surface: "#111113"
  dark-card: "#18181b"
  dark-ink: "#ededef"
  dark-primary: "#fb8a4a"
  mobile-switch-face: "#c7f51c"
  mobile-switch-ink: "#111600"
  mobile-lcd: "#101313"
  mobile-key-edge: "#30362a"
  mobile-light-bg: "#fafbfc"
  mobile-light-card: "#ffffff"
  mobile-light-ink: "#101214"
  mobile-light-muted: "#5d6472"
  mobile-light-border: "#d8dce2"
  mobile-light-accent: "#405400"
  mobile-dark-bg: "#111315"
  mobile-dark-card: "#202426"
  mobile-dark-ink: "#f6f7fa"
  mobile-dark-muted: "#bcc4d3"
  mobile-dark-border: "#3b4146"
typography:
  headline:
    fontFamily: "var(--font-jakarta), sans-serif"
    fontSize: "clamp(1.875rem, 2.5vw, 2.75rem)"
    fontWeight: 700
    lineHeight: 1.18
    letterSpacing: "-.025em"
  title:
    fontFamily: "var(--font-sans)"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-.015em"
  body:
    fontFamily: "var(--font-sans)"
    fontSize: ".875rem"
    lineHeight: "1.25rem"
  label:
    fontFamily: "var(--font-sans)"
    fontSize: ".8125rem"
    fontWeight: 500
  table-label:
    fontSize: ".78125rem"
    fontWeight: 500
    letterSpacing: "0"
  mobile-title:
    fontFamily: "system-ui"
    fontSize: "28px"
    fontWeight: 600
  mobile-body:
    fontFamily: "system-ui"
    fontSize: "15px"
  mobile-field:
    fontFamily: "system-ui"
    fontSize: "19px"
rounded:
  nav: ".375rem"
  control: ".5rem"
  surface: ".75rem"
  pill: "999px"
  mobile-control: "14px"
  mobile-panel: "22px"
  mobile-dock: "30px"
spacing:
  compact: ".5rem"
  row: ".75rem"
  content: "1rem"
  section: "1.5rem"
  gutter: "2rem"
  mobile-row: "16px"
  mobile-gutter: "20px"
  mobile-section: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: ".5rem 1rem"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-outline:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: ".375rem .75rem"
  login-submit:
    backgroundColor: "{colors.login-ink}"
    textColor: "{colors.surface}"
    rounded: "{rounded.surface}"
    padding: ".75rem 1rem"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "2.25rem"
  login-input:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.surface}"
    padding: "0 .75rem"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
  navigation:
    textColor: "{colors.sidebar-ink}"
    rounded: "{rounded.nav}"
    padding: "0 .5rem"
  suggestion:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.sidebar-ink}"
    rounded: "{rounded.pill}"
    padding: "0 .75rem"
  mobile-primary:
    backgroundColor: "{colors.mobile-switch-face}"
    textColor: "{colors.mobile-switch-ink}"
    rounded: "{rounded.mobile-control}"
    padding: "14px 16px"
  mobile-pass:
    backgroundColor: "{colors.mobile-light-card}"
    textColor: "{colors.mobile-light-ink}"
    padding: "22px"
    rounded: "26px"
  mobile-navigation:
    backgroundColor: "{colors.mobile-light-card}"
    textColor: "{colors.mobile-light-muted}"
    rounded: "27px"
    padding: "5px"
  mobile-clock-dock:
    padding: "10px"
    rounded: "{rounded.mobile-dock}"
---

# Design System: AIHR

## Overview

**Creative North Star: "Atelier / Maker's Mark"**

Atelier is the default authenticated workspace: neutral surfaces, compact controls, a quiet navigation rail and fire-orange actions. The existing Maker's Mark supplies its signature. This records the implemented system alongside the supported Classic and Monolith choices; light/dark remains an independent setting.

Public sign-in is a distinct, owner-specified indigo-and-white surface with AIHR identity. Its palette is scoped locally and remains light across app themes. Its typography resolves the existing font variable. The login composition belongs to its surface brief, not to every future screen.

Performance & Talent is the second scoped surface (D-P1-32 D3, APR-025, ADR-0152). Every page under `/performance`, employee and administration, renders inside `<div data-area-theme="performance">` (app/performance/layout.tsx), and app/performance/area-theme.css re-declares the app's own tokens there: a navy band with the area title, white 12px cards on a light grey page, navy headings and primary, hairline rows, red for AI actions with the app's own sparkles icon, pills, segmented tabs and a stage rail (`pt-*` classes). The area looks the same in Classic, Monolith and Atelier: the `monolith:` and `atelier:` variants do not match inside it and the themes' structural rules are reverted there. It has its own navy-tinted dark variant; light/dark stays the user's setting. Control sizes follow the source on a fine pointer and keep 44px targets on a coarse one. Portaled overlays (dialogs, menus, toasts) render outside the wrapper and keep the user's theme. No logo or client name is drawn.

The native OneHR+ default has its own approved **Daily Switch** world: porcelain/graphite surfaces, a chartreuse physical attendance key and dark LCD worked-time display. It applies to schema-1 native screens, replacing their prior default city/Opal presentation. Published schema-2 compositions retain their own theme, typography, artwork and navigation; explicit cobalt/coral schema-1 accents survive. Web Atelier, public web sign-in, Performance & Talent and lifecycle styling retain their existing scope.

The native Access Pass uses the original paired Opal mountain artwork, restored by the owner specifically for sign-in. Username and password share one opaque panel and one submit action; continuation states retain existing MFA, enrollment and recovery behavior. Evidence is source inspection of `mobile/lib/{daily-switch-theme,daily-switch,daily-navigation,sign-in-background,internal-sign-in,visual,design,ui}.tsx` (the theme module is `.ts`) and tab routes. Native rendered acceptance remains pending: no iOS/Android screenshot or contrast-verification claim follows from this documentation.

**Key Characteristics:**
- Flat shell and cards with hairline boundaries.
- Compact sentence-case operational hierarchy.
- Orange action/focus accent in Atelier; independent indigo sign-in.
- Human-confirmation signature and semantic status labels.

Evidence: app/atelier.css, app/globals.css, app/layout.tsx, components/ui.tsx, components/ui/{button,input,card}.tsx, app/login/{login.css,login-shell.tsx,internal-form.tsx}, and lib/ui-theme.ts. Direction lives in .impeccable/surfaces/app-layout-tsx.md and app-login-page-tsx.md. Desktop, phone and 681px login captures and desktop/phone appearance-settings captures were checked against this source.

## Colors

The operational palette is neutral with a restrained fire-orange accent; sign-in has its own deep indigo ground.

### Primary
- **Fire orange:** Atelier primary actions, focus and small counts; deepen on hover.
- **Welcome indigo:** public sign-in welcome panel, headings, links and submit action; not an additional authenticated-app accent.

### Neutral
- **White content / pale grey rail:** flat adjoining surfaces, divided by a hairline.
- **Ink / muted ink:** headings and primary content versus descriptions, metadata and rail labels.
- **Line / strong line:** quiet divisions versus field/control boundaries. Selected rail rows use neutral grey rather than orange fill.
- **Confirmation tan:** the Maker's Mark disc only. StatusBadge retains its existing domain-specific semantic classes and explicit labels; the brief's illustrative status mapping is not substituted for the source mapping.

**The Scoped Accent Rule.** Use Atelier orange for actions, focus and small emphasis; keep public sign-in indigo inside its own surface.

Dark Atelier overrides the same semantic variables in app/atelier.css: lifted neutral surfaces and a lighter orange. The frontmatter samples its principal roles; the CSS remains the complete light/dark mapping. No contrast-audit claim is inferred from these definitions. Sidecar tonal ramps are generated preview interpolations, not additional source tokens.

### Native Daily Switch scope

Chartreuse is the default physical key face, active dark navigation and LCD digit color. Deep olive is its readable light-surface link accent. Porcelain/white and graphite/charcoal supply paired surface roles; text and muted text invert by appearance. The LCD stays dark in either appearance. The frontmatter's `mobile-*` roles derive from `nativeMobilePalette` and `DAILY_SWITCH`; named web roles above stay web-scoped.

**The Published Theme Rule.** Daily Switch defaults never override a published schema-2 tenant composition.

## Typography

**Body Font:** Atelier maps --font-jakarta to the platform UI stack: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial. --font-sans adds the existing CJK, Thai and Tamil fallback chain. There is no separate Atelier display face.

**Label/Mono Font:** employee codes use the existing --font-geist-mono through the shared mono utility. Public sign-in uses --font-jakarta, whose actual face follows the selected theme; it is not a separately pinned font.

### Hierarchy
- **Headline:** responsive public sign-in title, defined in frontmatter; the welcome headline is larger, with clamp(2rem, 3.1vw, 3.5rem) and a balanced 16ch measure.
- **Title:** operational PageHeader; Home greeting is a nearby larger step (1.5rem, 600, 1.25).
- **Body:** compact operational text; login intro copy uses 1rem with relaxed leading. Welcome description is limited to 50ch.
- **Label:** compact controls and card strips. Rail rows are .84375rem; table headings use the smaller frontmatter role, sentence case and no tracking.
- **Figures:** tables and compact pager ranges use tabular numerals.

### Native type

Native screens use the platform text face for operational content. Shared titles use `mobile-title`; metadata and label/value rows use `mobile-body`; Access Pass inputs use `mobile-field`. Native Text scaling remains enabled. Seven-segment worked-time digits are drawn geometry and are announced as one complete readable value; they are not an imported display font. The oversized IN face is a localized-action-labeled instrument, not a general heading treatment.

## Layout


The authenticated shell runs edge to edge. Its rail is 15.5rem and header is 3rem at desktop widths. Main content has 1.75rem top, 2rem horizontal and 2.5rem bottom padding. Below 640px, the gutter is 1rem and the header wraps scope and account controls onto separate rows. Existing page layouts and width contracts remain; Home's operational grid reaches 72rem while its opening sections stay within 53.75rem.

Public sign-in uses a 1.04:1 two-column split, at least one dynamic viewport tall. Each panel has fluid padding; the form is centered within a maximum 28rem column. Below 768px the welcome panel is hidden and a compact AIHR wordmark precedes the form, with 1.5rem side gutters. The built maximum is 28rem (448px at a 16px root), rather than the brief's approximate 440px. This is a surface composition, not the global page grid.

## V9 lifecycle reference override

The V9 onboarding/offboarding workspace and its employee work controls follow the owner's supplied Admin V9 HTML. Its `.v9-workspace` rules take precedence over conflicting Atelier defaults within that surface: Plus Jakarta Sans, indigo `#4f46e5`, ground `#e8ebf2`, white panels, `#d5d9e3` borders, `#1b1d29` text and `#565b6b` secondary text. The layout uses 16px insets/gaps and rounded panels, a 232px navigation column, four case-summary panels and a 280px case aside. Dates display day/month/year while retaining ISO storage and the shared Malaysia business clock.

Employee return declarations and assigned-team recovery confirmation are separate controls. Team confirmation is shown only with a fresh item capability; errors retain the entered note and announce recovery guidance. View-only case groups have disabled fields and no case-action buttons. These visibility rules accompany service and database authorization.

The surface contract is recorded in [.impeccable/surfaces/lifecycle-v9.md](.impeccable/surfaces/lifecycle-v9.md). Current finish verdict: **source and interaction review complete; final release verification and reference-render comparison remain separate**. The scoped checklist and exact verification identities are recorded in [the finish review](docs/V9-LIFECYCLE-FINISH-REVIEW.md). Fictional rendered case, group and employee journeys establish working interactions; the original reference-file render remains unavailable, so exact visual parity and final integrated acceptance are not established. No new shipping raster assets are introduced by this surface.

### Native layout

The default screen gutter is the `mobile-gutter` step; common rows and sections use the native row/section steps. Home, Leave, Approvals and Me scroll under a floating bottom dock with bottom content clearance (126–130 native points). The dock respects the bottom safe area, caps at 560 points and uses five equal flexible destinations. Access Pass caps at 520 points, uses a 24-point horizontal inset and adjusts scrolling for the keyboard. Fields and native press targets retain at least 44-point control access; input rows use a 48-point minimum.

## Elevation & Depth

Atelier uses borders and surface tone for structure. Shell and cards have no shadow. Small button/quick-action shadows, a soft two-layer ask-box shadow and lifted overlays remain deliberate exceptions. Public sign-in has no floating card treatment.

**The Flat Surface Rule.** Keep the shell and cards flat; use the existing small control shadow, ask-box lift and overlay shadow for their established roles.

Exact shadows, focus halos, transition timings and breakpoints are recorded in the sidecar; their source definitions remain in the stylesheets.

### Native depth

The instrument dock uses an offset soft shadow and a narrow material gradient; its key uses inset highlights and a lower physical edge that compresses while pressed. Access Pass uses a soft offset shadow over an opaque panel. Ordinary schema-1 Material content is opaque; the old translucent overlay treatment is confined to published schema-2 rendering. The sidecar records the implemented dock/pass shadows. Existing generic primary-button hard offset shadow is not a reusable system rule (see not-canonized note).

## Shapes

Controls use the compact rounded step; cards, dialogs and login fields use the surface step. Rail rows use the smaller nav corner. Pills and identity discs stay circular. One-pixel borders define the operational geometry; the unsigned marker uses a dashed ring. Corners are gentle without making every component a capsule.

Native geometry is continuous-corner rather than web card geometry. The chartreuse key sits inside `mobile-dock`; ordinary primary controls use `mobile-control`; Access Pass uses its component-specific radius and bottom field dividers. A circular submit arrow is an action with an explicit accessible sign-in name. Native SF Symbols/Material Symbols provide the icon vocabulary.

## Components

### Buttons

Compact and purposeful. Shared primary and outline buttons retain their existing size variants; Atelier sets a 2rem minimum and automatic height rather than one fixed universal height. Explicit 2.75rem touch minimums survive. Primary actions use orange, outline actions use a strong neutral border and quiet grey hover. Public submit fills the form width, has a 3.25rem minimum and its own indigo hover. Busy login disables the submit control and reduces opacity.

### Chips

Home suggestions are outlined neutral pills with a quiet hover, not filled primary actions. Status pills pair readable text with a leading dot; draft uses a dashed hollow dot. Domain-specific semantic classes remain authoritative.

### Cards / Containers

Flat white surfaces with a hairline, surface corners and optional lightly tinted sentence-case header strip. Shared CardContent uses 1rem padding; callers may supply their own established layout padding. Overlays use the popover shadow rather than changing the card vocabulary.

### Inputs / Fields

App fields use a strong boundary, compact corners, and orange focus border plus a three-pixel translucent halo. Public fields have their own darker neutral stroke and a 3.25rem minimum. The password control reserves right-side space for the inline SVG visibility toggle. The public surface supplies a two-pixel violet focus outline with four-pixel offset; existing field focus utilities may add their ring.

### Navigation

Quiet grey rail, compact icon-and-label rows, grey hover and a neutral selected row with medium-weight ink. Stroke SVGs are 1rem. Nested rows have a thin structural guide line; expansion rotates the chevron with the existing short transition. Preserve the current permission-aware navigation and mobile shell behavior rather than deriving a new menu from this visual guide.

Expanded-menu section titles are semantic, noninteractive headings. Their compact uppercase type, extra vertical spacing and trailing divider distinguish them from clickable rows. Keep this treatment local to navigation.

### Tables and pagination

Sentence-case headings, hairline divisions and 2.75rem cell height, with neutral row hover/focus. Pager and filter controls appear above rows within shared paged cards. Row actions use compact borderless text controls, with accent on hover.

### Maker's Mark

The existing signature distinguishes a named person's confirmation from pending work: a small tan disc with inset impression versus an empty dashed ring. Preserve its meaning; decorative uses would weaken the distinction.

### Native Daily Switch and Access Pass

- **Attendance instrument:** idle presents the tall IN key; accepted working state compresses that marker, displays elapsed worked time on the LCD and exposes a separate Clock out control. ClockPanel owns preparation, explicit review, required evidence, submission and receipt recovery directly on Home. The visual component never computes an HR entitlement or records attendance itself. Busy/review/unresolved states disable the primary action. The working IN marker is decorative and hidden from accessibility.
- **Access Pass:** opaque field group; organization is read-only when supplied by the signed workplace and remains editable when needed. Username/password submit together; recovery sits beside the password label, visibility toggle has a localized label, workplace switching stays in the header. Dark/light mountains are bundled and decorative; authentication logic still owns continuation and failure states.
- **Five-destination dock:** Home, Clock, Leave, Approvals and Me; native symbols plus labels, selected semantics and reduced press opacity. Unread inbox remains reachable from Home. Published tenant navigation uses its own renderer.
- **Leave and identity:** native default balance cards increase the reading scale while preserving masked/shared-pool data; Me uses a compact identity panel. No sample balance, invented request or unsupported AI input is added.

## Do's and Don'ts

### Do:
- **Do** reuse the shared card, field, button and table hooks so Atelier styling reaches new operational screens.
- **Do** keep status text alongside its color and preserve tabular figures in tables.
- **Do** preserve supported saved theme choices; Atelier supplies the fallback.
- **Do** retain visible keyboard focus and the reduced-motion path.

- **Do** use the native `mobile-*` roles only within the Daily Switch default, preserving tenant composition authority.
- **Do** keep the original mountain artwork scoped to native sign-in and announce instrument values as complete text.

### Don't:
- **Don't** apply the public login split or indigo palette to authenticated screens by default.
- **Don't** replace the existing Atelier identity or restyle Classic and Monolith through unscoped overrides.
- **Don't** treat the presence of a dark palette as a completed contrast audit.

Not canonized or repaired: PRODUCT.md still describes the older floating indigo shell and stronger dark-mode assurance; the shell brief still lists mobile as unresolved despite implemented responsive rules. Navigation section captions are not a heading/eyebrow style for page content. Existing glyph back-arrow markup is not promoted into an icon rule. These pre-existing items are outside this documentation pass.

Native not canonized or repaired: generic schema-1 primary buttons currently carry a hard zero-blur lower shadow; it is not a default shadow token. Native rendered quality, text scaling, compact-device overflow and light/dark contrast remain unverified in this source-only pass. Existing PRODUCT.md and web-scope drift above are preserved rather than repaired.
