/**
 * config.example.ts — shape of the env vars the example reads.
 *
 * DO NOT commit real tokens. Use placeholders like below, replace
 * at deploy time with values injected from your secrets manager.
 */

export const config = {
  SEELE_BASE_URL: 'https://seele-memory.griptoad.workers.dev',
  // Mint at first enrollment via POST /api/keys/register. One year TTL.
  SEELE_DEVICE_TOKEN: '<replace-with-device-token-from-/api/keys/register>',
  // Base64 of the 32-byte AES content key derived from your 12-word phrase.
  // Derive locally with `@seele/memory-client`'s `deriveKeyMaterial()`.
  SEELE_AES_KEY_B64: '<base64-of-32-bytes>',
}
