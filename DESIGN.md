# God’s Eye Web Design System

## 1. Direction

The existing desktop research interface uses a technical editorial style: a fixed 1120px shell, compact uppercase metadata, squared controls, blue accents, restrained gradients, and dense result grids. This document records the existing implementation so additions preserve it.

## 2. Color

All interface colors come from the custom properties in `web/src/styles.css`. The paired light and dark palettes use `--page`, `--text`, `--muted`, `--accent`, `--line`, `--input-*`, `--secondary-*`, `--notice-*`, `--score-*`, `--card-*`, and `--shadow` by semantic role. New components reuse those roles; raw colors stay confined to the token declarations.

## 3. Typography

- Display and metadata: Space Grotesk, weights 500–600.
- Body and controls: DM Sans, weights 400–700.
- Existing scale: 3rem masthead, 2.35rem screen headings, 1.2rem query emphasis, 1.08rem textarea, .7–.86rem labels and metadata.

## 4. Spacing and layout

The interface is desktop-only at 1200px and wider. Its 1120px shell uses the shared `--space-1` through `--space-7` steps for compact component spacing, a 12px form rhythm, 16–24px card rhythm, 24–48px section rhythm, and a four-column result grid. Compact supporting text uses the shared `--metadata-size` token. Browser mechanics such as intrinsic widths and wrapping remain local to components.

## 5. Components

- Form controls use a visible label, one-pixel `--input-border`, `--input-bg`, two-pixel radius, and the shared focus ring. Disabled options remain visible and muted.
- Primary, secondary, and text buttons preserve their existing background, border, weight, focus, and disabled treatments.
- Notices use the existing notice border/background and expose concise status or alert text.
- Provenance uses the score-note surface and compact definition-list rows. Search progress captures the submitted model label; results and detail render the completed response snapshot.

## 6. Motion and interaction

The existing scanner is the only continuous animation. Controls use browser-native interaction feedback and the shared focus-visible outline. Reduced motion disables the scanner animation through the existing media query.

## 7. Depth and surface

Panels use the existing mixed strategy: one-pixel semantic borders, subtle tonal gradients, and the single `--shadow` elevation token. Nested controls and cards use borders and tonal shifts without new shadows.

## 8. Accessibility constraints and accepted debt

Target WCAG 2.2 AA: every control has a programmatic label, keyboard focus remains visible, disabled models remain discoverable in the selector and accompanying preparation guidance, and completed provenance does not change with later form edits. The 1200px desktop minimum is an explicit product constraint and narrow screens receive a dedicated explanatory alert. No new accepted debt is introduced by the model selector.
