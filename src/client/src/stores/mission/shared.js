// Helpers shared by the Mission store and its slices.

export function errText(e, fallback = 'Something went wrong') {
  return e?.message || e?.error || fallback
}
