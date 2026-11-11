import { useDocumentTitle } from '../lib/useDocumentTitle'
export default function GlobalBackups() {
  useDocumentTitle('Backups')
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Backups</h1>
      </div>

      <div className="text-center py-20 text-ink-dim">
        <svg className="w-10 h-10 mx-auto mb-3 text-ink-dim" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5 8h14M5 8a 2 2 0 1 1 0 -4h14a 2 2 0 1 1 0 4M5 8v10a 2 2 0 0 0 2 2h10a 2 2 0 0 0 2 -2V8m-9 4h4" /></svg>
        <p className="text-lg font-semibold">Backups are being rebuilt</p>
        <p className="text-sm mt-1">The generic archive system was removed. Native driver backups are coming soon.</p>
      </div>
    </div>
  )
}
