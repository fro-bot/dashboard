# Design

The dashboard's visual system. Source of truth: `assets/styleguide.md` (the full Fro Bot styleguide). Executable tokens: `web/src/styles/tokens.css` (wired into Tailwind 4 via `@theme`).

## Aesthetic

Afrofuturism × cyberpunk. Dark-default — the brand "lives in the dark." Deep-purple/void backgrounds, high-contrast cyan/magenta/amber accents, structured geometry, deliberate glow on focal interactive elements only.

## Tokens (the single source of truth)

Components style exclusively from tokens — **no ad-hoc hex, no inline color literals**. The semantic set:

- **Surfaces:** `--color-bg` (#0d0216 void), `--color-surface` (#1a0b2e), `--color-surface-raised`, `--color-surface-overlay`.
- **Text:** `--color-text` (#ffffff), `--color-text-muted`, `--color-text-subtle`.
- **Accents:** `--color-accent` (cyan, = action/links), `--color-cta` (magenta, = emphasis), `--color-highlight` (amber).
- **Status:** `--color-success`, `--color-warning`, `--color-error`, `--color-info`.
- **Scale:** spacing (4px base), radius, type scale, motion durations/easing.

Dark is the default (`:root` / `[data-theme="dark"]`); light overrides via `[data-theme="light"]` and `prefers-color-scheme`. Both themes preserve the styleguide's documented WCAG pairings.

## Color intent (don't blur these)

- **Cyan = action.** Links, interactive, primary affordances.
- **Magenta = emphasis.** CTAs, focal emphasis — sparingly.
- **Amber = highlight.** Badges, warnings, stars.
- At most two accent colors in a single component.

## Glow

Glow is reserved for *focal interactive elements*, never applied indiscriminately. A glow on every card is slop; a glow on the one element that matters is brand. This distinction is why the Impeccable detector stays on for `dark-glow` / gratuitous-purple patterns even though the brand is purple-and-glow.

## Motion

Purposeful, fast (≤250ms default), `prefers-reduced-motion` honored. The styleguide defines a `--ease-spring` (bouncy) easing as an intentional brand token for playful micro-interactions; it is deliberately allowlisted in the Impeccable detector (`.impeccable/config.json`) as a documented brand exception, while bounce-easing detection stays active everywhere else.

## Quality gate

`npx impeccable detect` runs in CI over `web/src`. It catches genuine design-quality regressions (touch targets, line length, heading order, cramped padding, gratuitous glow/gradient) while the brand's intentional deep-purple + focal-glow + spring-easing elements are allowlisted as identity, not slop.
