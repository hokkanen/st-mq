# Shared UI conventions

## Links, actions and explanations

Ordinary navigation links inherit their accent color, underline offset and
keyboard focus from `chart/monitor.css`. A link must not need a section-specific
stylesheet to look like the rest of the application. Footer attributions inherit
their footer color; status-card readings keep their card layout and reading
colors. Ordinary setup, documentation, evidence and recovery links all use the
shared navigation treatment. A different section is not a reason for another
link style.

Use the shared button styles and `secondary-button` for ordinary actions.
Keep size/layout differences tied to their actual role and available space.
Use `chart/status-details.js` for compact explanations and `chart/confirmation.js`
for ordinary confirmations. Reuse existing controls instead of adding another
interaction pattern for an equivalent action.

Reusable windows must ignore a queued native close event if they have already
reopened. Only an actual closed window releases its current draft and restores
focus. Nested selectors and calendars follow the same rule for their containing
window. One-use confirmation dialogs have no reopen lifecycle.

Ordinary API reads and chart reads share response decoding and failure wording
through `chart/network.js`. Malformed content and interrupted downloads remain
distinct; neither error prints raw response fragments. Cancellation and deadlines
keep their original meaning, and a failed follow-up read cannot establish that a
previously accepted action failed.

## Spacing and hierarchy

The dashboard separates outer card/window breathing room from nested indentation.
Two tokens in `chart/monitor.css` apply in both themes, across
standalone, paired, mirrored, protected and history views and both access roles.
The independent configuration-recovery page defines the same tokens because it
must work without the dashboard bundle.

| Viewport width | Outer padding (`--ui-surface-inset`) | Nested step (`--ui-inset`) |
| --- | --- | --- |
| Above 800 px | 24 px | 12 px |
| 481–800 px | 20 px | 10 px |
| Up to 480 px | 16 px | 8 px |

The small nested step must not replace outer padding. Conversely, increasing
outer padding must not enlarge the indentation at every lower fold level.

Each visible hierarchy level has one spacing owner:

- Plain nested disclosures use the small logical start margin, including those
  inside ordinary content wrappers.
- Outer panels, comparison cards, the pairing card and windows use the larger
  padding. Pairing and Recording status rows own it when their wrapper has none.
- Inner bordered folds, notices and compact surfaces keep the small content
  inset. A fold's summary and body align; do not also indent its outer wrapper
  for that same level. Peer rows share their container's alignment. Tables retain
  their cell alignment and may keep compact cell padding.
- Further actual nested content may add one step; a wrapper alone is not a level.
- Dialog headers, scrolling bodies and footers align to the outer padding. Sticky
  headers may offset their margin to paint across the window without moving text.

Horizontal hierarchy is separate from vertical rhythm, touch targets, page-edge
gutters, chart geometry, icon/checkbox space and list-marker gutters. Do not replace
those dimensions with the inset or remove a safety message to make a layout fit.
Role and access changes alter content and permissions, never the spacing token.
Preserve keyboard focus, disclosure state, scroll, native arrows and readable
wrapping during refreshes and role transitions.

`node test/browser/spacing-smoke.js` checks the full static disclosure catalogue,
card surfaces, warnings and window styles in both themes from 320 to 1440 px,
including both sides of the 480 and 800 px spacing breakpoints. It verifies that
small outer padding, large fold steps and doubled steps are rejected.
It also checks themed links and keyboard focus throughout that catalogue,
including an ordinary link with no feature-specific class.
Feature browser suites separately exercise real rendered data,
dynamic windows, role transitions, permissions and failure states. The shared
geometry check measures combined margin and padding so accidental double insets
fail validation. Synthetic browser coverage does not certify every installed
browser or physical device.
