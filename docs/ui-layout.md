# Shared UI spacing

The dashboard uses one small horizontal inset: `--ui-inset: 12px`, defined in
`chart/monitor.css`. It applies at every screen width and in both themes, across
standalone, paired, mirrored, protected and history views and both access roles.
The independent configuration-recovery page defines the same token because it
must work without the dashboard bundle.

Each visible hierarchy level has one spacing owner:

- Plain nested disclosures use a 12 px logical start margin, including those
  inside ordinary content wrappers.
- Bordered cards and windows use 12 px content padding. Their summary and body
  align; do not also indent their outer wrapper for that same level. Peer rows
  share their container's alignment. Tables retain their cell alignment.
- Notices and warnings use the same content inset. Further actual nested content
  may add one further step; a wrapper alone is not a new level.
- Dialog headers, scrolling bodies and footers align to the same inset. Sticky
  headers may offset their margin to paint across the window without moving text.

Horizontal hierarchy is separate from vertical rhythm, touch targets, page-edge
gutters, chart geometry, icon/checkbox space and list-marker gutters. Do not replace
those dimensions with the inset or remove a safety message to make a layout fit.
Role and access changes alter content and permissions, never the spacing token.
Preserve keyboard focus, disclosure state, scroll, native arrows and readable
wrapping during refreshes and role transitions.

`node test/browser/spacing-smoke.js` checks the full static disclosure catalogue,
card surfaces, warnings and window styles in both themes at 320, 390, 640, 641,
768 and 1440 px. Feature browser suites separately exercise real rendered data,
dynamic windows, role transitions, permissions and failure states. The shared
geometry check measures combined margin and padding so accidental double insets
fail validation. Synthetic browser coverage does not certify every installed
browser or physical device.
