// Reapplies the PAD xterm.js patch after `npm install` replaces node_modules.
//
// Why: tmux scrolls the pane with `CSI Ps S` (SU) when output overflows.
// xterm's generic scrollUp() shifts the scroll region in place and discards
// the scrolled-out lines, so a tmux-backed terminal never accumulates
// scrollback and the mouse wheel has nothing to scroll. Real terminals push
// those lines into scrollback when the scroll region starts at the top of the
// screen. This patch routes SU through BufferService.scroll() in that case.
//
// Vite bundles the COMPILED bundle (node_modules/@xterm/xterm/lib/xterm.mjs,
// the "module" field), not src/common/InputHandler.ts, so the patch is applied
// to both the TypeScript source and the compiled lib bundles (mjs + umd).
//
// Idempotent: skips when the marker is already present. Run it before `vite
// build` (wired via "prebuild" in package.json).

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcFile = join(root, 'node_modules/@xterm/xterm/src/common/InputHandler.ts')
const mjsFile = join(root, 'node_modules/@xterm/xterm/lib/xterm.mjs')
const umdFile = join(root, 'node_modules/@xterm/xterm/lib/xterm.js')

const MARKER = 'PAD PATCH: when the scroll region starts at the top of the screen'
const START = '  public scrollUp(params: IParams): boolean {'
const END = '    return true;\n  }\n\n  /**\n   * CSI Ps T  Scroll down'

// Compiled lib bundles are minified single-line files. The patched scrollUp
// starts with the marker comment, then adds the scrollback-preserving branch.
// Loop var: mjs uses `i`, umd uses `t`.
function compiledOriginal(loopVar) {
  const dirty = `this._dirtyRowTracker.markRangeDirty(this._activeBuffer.scrollTop,this._activeBuffer.scrollBottom)`
  return (
    `scrollUp(e){let ${loopVar}=e.params[0]||1;` +
    `for(;${loopVar}--;)this._activeBuffer.lines.splice(this._activeBuffer.ybase+this._activeBuffer.scrollTop,1),` +
    `this._activeBuffer.lines.splice(this._activeBuffer.ybase+this._activeBuffer.scrollBottom,0,` +
    `this._activeBuffer.getBlankLine(this._eraseAttrData()));` +
    `return ${dirty},!0}`
  )
}

function compiledPatched(loopVar) {
  const scroll = `this._bufferService.scroll(this._eraseAttrData())`
  const dirty = `this._dirtyRowTracker.markRangeDirty(this._activeBuffer.scrollTop,this._activeBuffer.scrollBottom)`
  return (
    `/*${MARKER}*/` +
    compiledOriginal(loopVar)
      .replace(`let ${loopVar}=e.params[0]||1;`, `let ${loopVar}=e.params[0]||1;if(0===this._activeBuffer.scrollTop){for(;${loopVar}--;)${scroll};return ${dirty},!0}`)
  )
}

const libTargets = [
  { file: mjsFile, from: compiledOriginal('i'), to: compiledPatched('i') },
  { file: umdFile, from: compiledOriginal('t'), to: compiledPatched('t') },
]

let failures = 0

function patchCompiled({ file, from, to }) {
  let src
  try {
    src = readFileSync(file, 'utf8')
  } catch (err) {
    console.error(`[patch-xterm] cannot read ${file}: ${err.message}`)
    failures++
    return
  }
  if (src.includes(MARKER)) {
    console.log(`[patch-xterm] ${file}: already patched, nothing to do.`)
    return
  }
  const idx = src.indexOf(from)
  if (idx === -1) {
    console.error(`[patch-xterm] ${file}: scrollUp() not found in expected shape; aborting without changes.`)
    failures++
    return
  }
  writeFileSync(file, src.slice(0, idx) + to + src.slice(idx + from.length), 'utf8')
  console.log(`[patch-xterm] ${file}: patched scrollUp() to preserve scrollback when scrollTop === 0.`)
}

// --- TypeScript source -----------------------------------------------------
let src
try {
  src = readFileSync(srcFile, 'utf8')
} catch (err) {
  console.error(`[patch-xterm] cannot read ${srcFile}: ${err.message}`)
  failures++
  src = null
}

if (src) {
  if (src.includes(MARKER)) {
    console.log(`[patch-xterm] ${srcFile}: already patched, nothing to do.`)
  } else {
    const i = src.indexOf(START)
    const j = src.indexOf(END, i)
    if (i === -1 || j === -1) {
      console.error(`[patch-xterm] ${srcFile}: scrollUp() not found in expected shape; aborting without changes.`)
      failures++
    } else {
      const patched =
        src.slice(0, i) +
        `  public scrollUp(params: IParams): boolean {
    let param = params.params[0] || 1;

    // ${MARKER}
    // lines that scroll out of the region belong in the scrollback (a real terminal
    // keeps them). The generic inline shift below discards them instead, so a
    // tmux-backed terminal (tmux scrolls the pane with \`CSI Ps S\` on overflow)
    // never grows xterm's scrollback and the mouse wheel has nothing to scroll.
    // Route through BufferService.scroll() so scrolled-out lines enter the
    // scrollback exactly like a bottom line-feed does.
    if (this._activeBuffer.scrollTop === 0) {
      while (param--) {
        this._bufferService.scroll(this._eraseAttrData());
      }
      this._dirtyRowTracker.markRangeDirty(this._activeBuffer.scrollTop, this._activeBuffer.scrollBottom);
      return true;
    }

    while (param--) {
      this._activeBuffer.lines.splice(this._activeBuffer.ybase + this._activeBuffer.scrollTop, 1);
      this._activeBuffer.lines.splice(this._activeBuffer.ybase + this._activeBuffer.scrollBottom, 0, this._activeBuffer.getBlankLine(this._eraseAttrData()));
    }
` +
        src.slice(j)
      writeFileSync(srcFile, patched, 'utf8')
      console.log(`[patch-xterm] ${srcFile}: patched scrollUp() to preserve scrollback when scrollTop === 0.`)
    }
  }
}

// --- Compiled lib bundles (what Vite actually builds) ----------------------
for (const target of libTargets) patchCompiled(target)

if (failures > 0) {
  console.error(`[patch-xterm] ${failures} target(s) failed.`)
  process.exit(1)
}
