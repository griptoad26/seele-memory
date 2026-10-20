/**
 * @seele/memory-client — _test-utils.ts
 *
 * Tiny helpers used only by the test suite. Not exported in the
 * public API.
 */

/** Hex string → Uint8Array. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('@seele/memory-client: hex length must be even')
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/** Uint8Array → hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}
