// A refusal raised by an action taken INSIDE a dialog renders inside that
// dialog. The page's own feedback line sits behind the modal, so a refused
// action there looks like a button that did nothing.
export function errorText(e, fallback = 'That did not work. Try again.') {
  return e?.error || e?.message || fallback
}

export default function DialogError({ children, className = '' }) {
  if (!children) return null
  return (
    <p role="alert" className={`msn-dialog-error mb-2 rounded bg-danger-soft px-2 py-1 text-[11px] text-danger ${className}`}>
      {children}
    </p>
  )
}
