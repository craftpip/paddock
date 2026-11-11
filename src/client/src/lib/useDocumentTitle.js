import { useEffect } from 'react'

const DEFAULT_TITLE = 'Paddock'

/** Name the browser tab after the page, and put the default back on leaving.
 *  Mission used to set its title once and never reset it, so the tab kept
 *  saying "Mission" on every page visited afterwards. */
export function useDocumentTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} — Paddock` : DEFAULT_TITLE
    return () => { document.title = DEFAULT_TITLE }
  }, [title])
}
