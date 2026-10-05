// ESM resolve hook: let a Node test import the CLIENT store, which is written
// for Vite's bundler resolution rather than Node's.
//
// The store does `import { api } from '../lib/api'` — extensionless, which Vite
// resolves and Node does not, so `import('.../stores/mission.js')` died with
// ERR_MODULE_NOT_FOUND on the STORE's own import, not on the store itself.
//
// Fix at the resolver rather than by editing the store: the extensionless
// specifier is correct source (it is what every other client module does, and
// changing it would be a bundler-shaped edit to fix a test harness). The hook
// only fills in `.js`/`.jsx` for a relative specifier that has no extension and
// resolves to a file that exists, and it stays inside the client package so it
// can never rewrite a bare specifier or a real node_modules lookup.

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const CLIENT_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..', 'client')

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    const parentPath = context.parentURL?.startsWith('file:')
      ? fileURLToPath(context.parentURL)
      : null
    if (parentPath && parentPath.startsWith(CLIENT_ROOT)) {
      const base = resolvePath(dirname(parentPath), specifier)
      for (const ext of ['.js', '.jsx', '/index.js', '/index.jsx']) {
        if (existsSync(base + ext)) return { url: new URL(base + ext, 'file:').href, shortCircuit: true }
      }
    }
  }
  return nextResolve(specifier, context)
}