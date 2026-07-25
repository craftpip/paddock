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
    <div className={`flex flex-col border border-slate-800 rounded-lg overflow-hidden ${className}`}>
      {(headerRight || onClear || label) && (
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-800 bg-slate-900/50">
          <span className="text-[10px] text-slate-500 font-medium">
            {label}
            {runningCmd && <span className="text-cyan-400 ml-2">⏳ {runningCmd}</span>}
          </span>
          <div className="flex items-center gap-2">
            {headerRight}
            {onClear && (
              <button onClick={onClear} className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors">Clear</button>
            )}
          </div>
        </div>
      )}
      {children}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2 bg-slate-950 font-mono text-[10px] leading-relaxed">
        {lines.length === 0 && (
          <p className="text-slate-600">{emptyMessage}</p>
        )}
        {lines.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-all">
            {line.type === 'cmd' ? (
              <span><span className="text-slate-500">{line.ts}</span> <span className="text-cyan-400">$ {line.cmd}</span></span>
            ) : line.type === 'err' ? (
              <span className="text-red-400">{line.text}</span>
            ) : (
              <span className="text-slate-300">{line.text}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
