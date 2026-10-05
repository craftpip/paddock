/**
 * The status/emphasis tone table — one place that knows which token pairs with
 * which. Imported by Badge, by toast, and by the inline error/warning banners,
 * which are all the same idea at different sizes.
 *
 * This is a table and not a template string on purpose. A **solid** fill must
 * use its own `-ink` token, never `text-ink`: in dark mode `bg-accent
 * text-ink` is cream text on orange, which is how the whole Mission page once
 * ended up unreadable. Same for the tinted `soft` fills, which take the plain
 * tone colour for their text, not `-ink`.
 *
 * Naming: success / warning / danger / info / brand. Never ok / warn / error.
 */
export const TONES = {
  neutral: {
    solid: 'bg-ink-muted text-canvas',
    soft: 'bg-raised text-ink-muted',
    outline: 'border border-line text-ink-muted',
    panel: 'bg-raised border-line text-ink-muted',
  },
  accent: {
    solid: 'bg-accent text-accent-ink',
    soft: 'bg-accent-soft text-accent-text',
    outline: 'border border-accent-line text-accent-text',
    panel: 'bg-accent-soft border-accent-line text-accent-text',
  },
  success: {
    solid: 'bg-success text-success-ink',
    soft: 'bg-success-soft text-success',
    outline: 'border border-success-line text-success',
    panel: 'bg-success-soft border-success-line text-success',
  },
  warning: {
    solid: 'bg-warning text-warning-ink',
    soft: 'bg-warning-soft text-warning',
    outline: 'border border-warning-line text-warning',
    panel: 'bg-warning-soft border-warning-line text-warning',
  },
  danger: {
    solid: 'bg-danger text-danger-ink',
    soft: 'bg-danger-soft text-danger',
    outline: 'border border-danger-line text-danger',
    panel: 'bg-danger-soft border-danger-line text-danger',
  },
  info: {
    solid: 'bg-info text-info-ink',
    soft: 'bg-info-soft text-info',
    outline: 'border border-info-line text-info',
    panel: 'bg-info-soft border-info-line text-info',
  },
  brand: {
    solid: 'bg-brand text-brand-ink',
    soft: 'bg-brand-soft text-brand',
    outline: 'border border-brand-line text-brand',
    panel: 'bg-brand-soft border-brand-line text-brand',
  },
}

export default TONES
