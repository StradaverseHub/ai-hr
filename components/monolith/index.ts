/**
 * r400 — the Monolith primitives (docs/design/monolith/README.md §4, components.md), theme-aware: each
 * paints Monolith under <html data-ui-theme="monolith"> and today's Classic look otherwise. Built in step 3;
 * screens adopt them in step 4. None carries a string of its own — every label is the caller's.
 */
export { Status, LiveDot, StatusLine, STATUS_TONE_VARIANT, type StatusTone } from './status';
export { Cells, Kv, type Cell, type KvItem } from './figures';
export { Note, Empty, Panel } from './notes';
export { Section, type SectionTab } from './section';
export { HairlineTable, HairlineList, type HairlineRow, type HairlineListItem } from './table';
export { Steps, Ruler, type Step, type StepState, type Tick } from './steps';
export { Field, Switch, type SwitchProps } from './field';
export { MonoPageHeader } from './page-header';
export { OrdinalSection, SectionOrdinalProvider, useSectionOrdinal } from './section-ordinal';
