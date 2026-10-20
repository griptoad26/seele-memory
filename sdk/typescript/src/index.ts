/**
 * @seele/memory-client — public entry point.
 *
 * Exports the SDK surface. Tree-shakable via the `exports` map in
 * `package.json`. For browser-only consumers there is a separate
 * `./web` entry that excludes Node-specific convenience helpers
 * (Buffer for base64, etc.) — same effect at smaller bundle.
 */

export * from './keytree.js'
export * from './grants.js'
export * from './recall.js'
export * from './client.js'
