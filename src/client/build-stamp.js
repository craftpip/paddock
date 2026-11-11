// One fingerprint of everything the bundle is built from. The Vite build
// writes it next to the bundle (build-stamp.json) and client-bundle-fresh
// .test.js recomputes it, so a bundle that was not built from the source on
// disk is a failing test instead of a page that quietly runs old code.
//
// A content hash, not a timestamp: a git checkout rewrites mtimes in no useful
// order, so "is the bundle newer than the source?" answers nothing.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const INPUTS = ['src', 'index.html', 'vite.config.js', 'build-stamp.js', 'package-lock.json']

function files(root, entry, out) {
  const full = join(root, entry)
  let list
  try {
    list = readdirSync(full, { withFileTypes: true })
  } catch (e) {
    if (e.code === 'ENOTDIR') out.push(full) // a file, not a directory
    return // a missing input contributes nothing
  }
  for (const item of list) files(root, join(entry, item.name), out)
}

export function sourceHash(clientDir) {
  const all = []
  for (const input of INPUTS) files(clientDir, input, all)
  const hash = createHash('sha256')
  for (const file of all.sort()) {
    hash.update(relative(clientDir, file).split('\\').join('/'))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** Vite plugin: write the fingerprint into the bundle directory. */
export function buildStamp(clientDir) {
  return {
    name: 'paddock-build-stamp',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'build-stamp.json',
        source: `${JSON.stringify({ sourceHash: sourceHash(clientDir) })}\n`,
      })
    },
  }
}
