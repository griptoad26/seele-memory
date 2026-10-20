/**
 * @seele/memory-client — keytree.ts
 *
 * -----------------------------------------------------------------------
 *  PRIVACY-CRITICAL — read before editing
 * -----------------------------------------------------------------------
 *
 *  This module derives cryptographic key material from a 12-word BIP-39
 *  recovery phrase. The whole point of seele-cloud is that the server
 *  never sees the phrase, never sees the derived content key, and never
 *  sees the Ed25519 private key.
 *
 *  Concretely, that means:
 *
 *    1. Phrase handling is best-effort zeroize. We do not literally zero
 *       JavaScript strings (the engine owns those), but we DO wrap
 *       secret bytes in `KeyMaterial` so the byte arrays clear on drop.
 *
 *    2. Ed25519 seed → keypair happens in-memory only. We never
 *       serialize the private key outside of the worker's memory. If
 *       you find yourself logging it, STOP — that's the headline loss.
 *
 *    3. The HKDF info strings and salt MUST match the Rust side
 *       (xkg-core/src/keys.rs). If they diverge the same phrase
 *       will derive different keys on server vs device. Pin them
 *       below alongside the test that asserts parity.
 *
 *  The derivation layout is Option D per SPEC.md §"Privacy model":
 *
 *     BIP-39 phrase (128 bits entropy, English wordlist)
 *       └─ PBKDF2-HMAC-SHA512(phrase, "mnemonic", 2048, 64)
 *            ├─ HKDF-Expand(salt="xkg-core-v1", info="bip39-ed25519-master-v1")
 *            │     → 32-byte Ed25519 seed
 *            └─ HKDF-Expand(salt="xkg-core-v1", info="bip39-aes-content-key-v1")
 *                  → 32-byte AES-256-GCM content key
 *
 *  This module exposes a small surface area on purpose. Bot SDKs
 *  typically only need `generateRecoveryPhrase()` + `deriveKeyMaterial()`
 *  for first-time enrollments; per-bot keys (the Ed25519 keypair inside
 *  a `bot` row) are managed server-side via `/api/bots` and surfaced
 *  in this SDK as opaque blobs.
 */

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { hkdf } from '@noble/hashes/hkdf'
import { sha512 } from '@noble/hashes/sha512'
// We intentionally use `@stablelib/ed25519` over `tweetnacl` because it
// has a smaller footprint for browsers and ships ESM, but either would
// satisfy the contract. Do NOT swap to a library that can't run in a
// web worker (e.g. anything binding `node:crypto`).
import { generateKeyPairFromSeed, sign as edSign, verify as edVerify } from '@stablelib/ed25519'

// ---------------------------------------------------------------------------
// Public constants — keep in lock-step with xkg-core/src/keys.rs.
// ---------------------------------------------------------------------------

/** 12-word BIP-39 phrases encode 128 bits of entropy. v0.10.0 only. */
export const PHRASE_WORD_COUNT = 12

/** Ed25519 keys are 32 bytes (seed) / 64 bytes (expanded secret). */
export const ED25519_SEED_LEN = 32
export const ED25519_PUB_LEN = 32
export const ED25519_PRIV_LEN = 64 // seed || public (per RFC 8032)

/** AES-256-GCM key length. */
export const AES_KEY_LEN = 32

// HKDF info strings + salt — MUST match xkg-core/src/keys.rs:
//   HKDF_INFO_ED25519: b"bip39-ed25519-master-v1"
//   HKDF_INFO_AES:     b"bip39-aes-content-key-v1"
//   HKDF_SALT:         b"xkg-core-v1"
// Bump the v1 suffix if the derivation layout changes incompatibly,
// so existing phrases don't silently produce different keys.
const HKDF_INFO_ED25519 = new TextEncoder().encode('bip39-ed25519-master-v1')
const HKDF_INFO_AES = new TextEncoder().encode('bip39-aes-content-key-v1')
const HKDF_SALT = new TextEncoder().encode('xkg-core-v1')

// ---------------------------------------------------------------------------
// WebCrypto bridge — never import `node:crypto`. WebCrypto lives at
// `globalThis.crypto` in browsers and Node ≥18.
// ---------------------------------------------------------------------------

function getCrypto(): Crypto {
  const c = (globalThis as any).crypto
  if (!c || !c.subtle) {
    throw new Error(
      '@seele/memory-client: WebCrypto is not available on this runtime. ' +
        'Use Node 18+ or an evergreen browser.',
    )
  }
  return c as Crypto
}

// ---------------------------------------------------------------------------
// KeyMaterial — owns bytes; bytes wipe on `.zeroize()`. Mnemonic string
// lives alongside but is read-only.
// ---------------------------------------------------------------------------

/**
 * Sensitive key material derived from a recovery phrase.
 *
 * The class does not promise airtight zeroization — JavaScript memory
 * management prevents that. It does promise that callers can wipe the
 * byte arrays explicitly (`.zeroize()`) and that subsequent reads of
 * the wiped material will fail loudly. Use this like confidential
 * stack data: handle it, hand it off, wipe it.
 */
export class KeyMaterial {
  /** Mnemonic phrase the keys were derived from. Held so a re-prompt can show it. */
  readonly mnemonic: string

  /** 32 bytes — Ed25519 seed input. Zeroized on `zeroize()`. */
  private readonly _ed25519Seed: Uint8Array

  /** 64 bytes (RFC 8032: secret = seed || pub). Zeroized on `zeroize()`. */
  readonly ed25519SecretKey: Uint8Array

  /** 32 bytes (raw public key, suitable for transport as base64). */
  readonly ed25519PublicKey: Uint8Array

  /** 32 bytes — wrap with `sealWithContentKey()` (AES-256-GCM). */
  private readonly _aesContentKey: Uint8Array

  private _zeroed = false

  constructor(args: {
    mnemonic: string
    ed25519Seed: Uint8Array
    ed25519SecretKey: Uint8Array
    ed25519PublicKey: Uint8Array
    aesContentKey: Uint8Array
  }) {
    this.mnemonic = args.mnemonic
    this._ed25519Seed = args.ed25519Seed
    this.ed25519SecretKey = args.ed25519SecretKey
    this.ed25519PublicKey = args.ed25519PublicKey
    this._aesContentKey = args.aesContentKey
  }

  /**
   * Copy of the AES content key. Caller is responsible for zeroing the copy.
   *
   * Escape hatch (the `isPlaintext()` from the SDK brief): only call this
   * when you must hand raw bytes to a non-zeroizing surface (e.g. third
   * party libs that hold the buffer long term). Otherwise stay in the
   * `sealWithContentKey`/`openWithContentKey` helpers in this module,
   * which take `KeyMaterial` and zero nothing externally.
   */
  plaintextAesKey(): Uint8Array {
    this._assertNotZeroed()
    return new Uint8Array(this._aesContentKey)
  }

  /** Escape hatch — raw Ed25519 seed bytes. */
  plaintextEd25519Seed(): Uint8Array {
    this._assertNotZeroed()
    return new Uint8Array(this._ed25519Seed)
  }

  /**
   * Serialize the public half only — safe to send over the wire.
   * Returns a base64 string suitable for the `public_key` field of
   * `POST /api/keys/register`.
   */
  publicKeyBase64(): string {
    return bytesToBase64(this.ed25519PublicKey)
  }

  /**
   * Sign a message with this key's Ed25519 secret key. Returns a 64-byte
   * signature.
   */
  sign(message: Uint8Array): Uint8Array {
    this._assertNotZeroed()
    return edSign(this.ed25519SecretKey, message)
  }

  /** Wipe secret bytes. Idempotent. */
  zeroize(): void {
    if (this._zeroed) return
    zeroBuf(this._ed25519Seed)
    zeroBuf(this.ed25519SecretKey)
    zeroBuf(this._aesContentKey)
    this._zeroed = true
  }

  get isZeroed(): boolean {
    return this._zeroed
  }

  private _assertNotZeroed(): void {
    if (this._zeroed) {
      throw new Error('@seele/memory-client: KeyMaterial has been zeroized')
    }
  }
}

// ---------------------------------------------------------------------------
// Phrase generation
// ---------------------------------------------------------------------------

/**
 * Generate a fresh 12-word BIP-39 recovery phrase.
 *
 * Phrase format:
 *   - English wordlist (matches xkg-core / standard wallets)
 *   - 128 bits of entropy
 *   - Space-separated, lowercase, no passphrase
 *   - Empty passphrase is intentional — see SPEC.md §"Recovery"
 *
 * Throws if WebCrypto is unavailable. The phrase is meant to be shown
 * to the user exactly once; do not log it.
 */
export async function generateRecoveryPhrase(): Promise<string[]> {
  return generateRecoveryPhraseSync()
}

/** Synchronous variant — equivalent for our purposes; convenience only. */
export function generateRecoveryPhraseSync(): string[] {
  const phrase = generateMnemonic(wordlist, 128)
  return phrase.split(' ')
}

// ---------------------------------------------------------------------------
// Phrase validation
// ---------------------------------------------------------------------------

/**
 * Verify that a phrase is a valid 12-word BIP-39 English mnemonic with
 * the right checksum. Empty passphrase enforced.
 *
 * This does NOT verify the keys are registered server-side — only that
 * the phrase can produce well-formed keys when fed back through
 * `deriveKeyMaterial()`.
 */
export function isValidRecoveryPhrase(phrase: readonly string[] | string): boolean {
  const str = normalizePhrase(phrase)
  if (!str) return false
  const isArr = Array.isArray(phrase)
  if (isArr && phrase.length !== PHRASE_WORD_COUNT) return false
  return validateMnemonic(str, wordlist)
}

function normalizePhrase(phrase: readonly string[] | string): string {
  if (Array.isArray(phrase)) {
    const out: string[] = []
    for (const w of phrase) out.push(w)
    return out.join(' ')
  }
  return phrase as string
}

// ---------------------------------------------------------------------------
// Key derivation (BIP-39 → Ed25519 + AES content key)
// ---------------------------------------------------------------------------

/**
 * Derive full `KeyMaterial` from a 12-word recovery phrase.
 *
 * The derived keys are deterministic — the same phrase always produces
 * the same Ed25519 keypair and AES content key, on every device, in
 * every language runtime. That's how recovery works: a fresh device
 * with no other state just re-derives.
 */
export function deriveKeyMaterial(phrase: readonly string[] | string): KeyMaterial {
  if (!isValidRecoveryPhrase(phrase)) {
    throw new Error('@seele/memory-client: not a valid 12-word BIP-39 phrase')
  }
  const phraseStr = normalizePhrase(phrase)

  // 1. BIP-39 seed = PBKDF2-HMAC-SHA512("mnemonic" + passphrase, "", 2048, 64).
  //    `@scure/bip39` is synchronous for the seed; we use the empty-passphrase
  //    form to match xkg-core/src/keys.rs.
  const seed64 = mnemonicToSeedSync(phraseStr, '')

  // 2. HKDF-SHA512 into (32-byte Ed25519 seed, 32-byte AES key).
  const edSeed = hkdf(sha512, seed64, HKDF_SALT, HKDF_INFO_ED25519, ED25519_SEED_LEN)
  const aesKey = hkdf(sha512, seed64, HKDF_SALT, HKDF_INFO_AES, AES_KEY_LEN)

  // 3. Ed25519 seed → keypair via @stablelib.
  const kp = generateKeyPairFromSeed(edSeed)

  return new KeyMaterial({
    mnemonic: phraseStr,
    ed25519Seed: edSeed,
    ed25519SecretKey: kp.secretKey,
    ed25519PublicKey: kp.publicKey,
    aesContentKey: aesKey,
  })
}

// ---------------------------------------------------------------------------
// AES-256-GCM content key helpers — used by SDK clients that want to
// encrypt/decrypt envelopes without going through xkg-core.
// ---------------------------------------------------------------------------

/**
 * AES-256-GCM seal. Returns `nonce(12) || ciphertext`. Matches the
 * envelope format produced by xkg-core (see `keys.rs::seal_with_content_key`).
 */
export async function sealWithContentKey(
  contentKey: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  if (contentKey.length !== AES_KEY_LEN) {
    throw new Error(`@seele/memory-client: AES key must be ${AES_KEY_LEN} bytes`)
  }
  const crypto = getCrypto()

  const nonce = new Uint8Array(12)
  crypto.getRandomValues(nonce)

  const key = await crypto.subtle.importKey(
    'raw',
    contentKey as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  )

  const params: AesGcmParams = {
    name: 'AES-GCM',
    iv: nonce as BufferSource,
    ...(aad ? { additionalData: aad as BufferSource } : {}),
  }

  const ct = await crypto.subtle.encrypt(params, key, plaintext as BufferSource)

  // nonce || ciphertext
  const out = new Uint8Array(nonce.length + ct.byteLength)
  out.set(nonce, 0)
  out.set(new Uint8Array(ct), nonce.length)
  return out
}

/** AES-256-GCM open. Expects `nonce(12) || ciphertext`. */
export async function openWithContentKey(
  contentKey: Uint8Array,
  sealed: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  if (contentKey.length !== AES_KEY_LEN) {
    throw new Error(`@seele/memory-client: AES key must be ${AES_KEY_LEN} bytes`)
  }
  if (sealed.length < 12 + 16) {
    throw new Error('@seele/memory-client: sealed blob too short')
  }
  const crypto = getCrypto()

  const nonce = sealed.subarray(0, 12)
  const ct = sealed.subarray(12)

  const key = await crypto.subtle.importKey(
    'raw',
    contentKey as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  )

  const params: AesGcmParams = {
    name: 'AES-GCM',
    iv: nonce as BufferSource,
    ...(aad ? { additionalData: aad as BufferSource } : {}),
  }
  const pt = await crypto.subtle.decrypt(params, key, ct as BufferSource)
  return new Uint8Array(pt)
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    // Node path. Buffer extends Uint8Array.
    return Buffer.from(bytes).toString('base64')
  }
  // Browser path — chunked to avoid stack overflow on large arrays.
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(s)
}

export function base64ToBytes(s: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(s, 'base64'))
  }
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function zeroBuf(b: Uint8Array): void {
  // `Buffer` zeros are more reliable on V8; on browsers there's no
  // portable way to force the GC, but at least we don't leak to logs.
  if (typeof Buffer !== 'undefined' && b instanceof Buffer) {
    b.fill(0)
    return
  }
  b.fill(0)
}
