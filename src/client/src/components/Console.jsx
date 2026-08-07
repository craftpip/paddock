import { useEffect, useRef } from 'react'

/**
 * Reusable console output component.
 *
 * Props:
 *   lines         – [{ type: 'cmd'|'out'|'err', text?, cmd?, ts? }]
 *   runningCmd    – string of currently running command (empty = idle)
 *   onClear       – clear handler
 *   label         – header label (default "Console")
 *   emptyMessage  – shown when lines is empty
 *   autoScroll    – auto-scroll to bottom (default true)
 *   className     – extra classes on the outer container
 *   headerRight   – extra elements to render in the header (right side, before clear)
 *   children      – extra elements to render below the header bar (toolbar slot)
 */
export default function Console({
  lines = [],
  runningCmd = '',
  onClear,
  label = 'Console',
  emptyMessage = 'Click a button above to run a command. Output appears here.',
  autoScroll = true,
  className = '',
  headerRight,
  children,
}) {
  const scrollRef = useRef(null)

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [lines, autoScroll])

  return (
    <div className={`flex flex-col border border-line-faint rounded-lg overflow-hidden ${className}`}>
      {(headerRight || onClear || label) && (
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-line-faint bg-canvas/50">
          <span className="text-[10px] text-ink-dim font-medium">
            {label}
            {runningCmd && <span className="text-accent-text ml-2">⏳ {runningCmd}</span>}
          </span>
          <div className="flex items-center gap-2">
            {headerRight}
            {onClear && (
              <button onClick={onClear} className="text-[10px] text-ink-dim hover:text-ink-muted transition-colors">Clear</button>
            )}
          </div>
        </div>
      )}
      {children}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2 bg-sunken font-mono text-[10px] leading-relaxed">
        {lines.length === 0 && (
          <p className="text-ink-dim">{emptyMessage}</p>
        )}
        {lines.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-all">
            {line.type === 'cmd' ? (
              <span><span className="text-ink-dim">{line.ts}</span> <span className="text-accent-text">$ {line.cmd}</span></span>
            ) : line.type === 'err' ? (
              <span className="text-danger">{line.text}</span>
            ) : line.type === 'sys' ? (
              <span className="text-ink-dim italic">{line.text}</span>
            ) : (
              <span className="text-ink-muted">{line.text}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
