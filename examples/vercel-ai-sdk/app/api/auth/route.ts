/**
 * /api/auth — exchanges a 12-word phrase for a device token + content key.
 *
 * Dev only. Production uses CF Access for identity + the phrase is
 * typed into the desktop/mobile client (no roundtrip needed).
 *
 * Flow:
 *   1. POST { phrase: "word1 word2 ..." }
 *   2. Server (this route) derives the AES content key, registers a
 *      device via POST /api/keys/register, gets back a device token.
 *   3. Sets a short-lived cookie (seele_ctx) that combines baseUrl,
 *      device_token, and aes_key_b64. The /api/chat route reads it.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import {
  deriveKeyMaterial,
  SeeleCloudClient,
  isValidRecoveryPhrase,
  bytesToBase64,
} from '@seele/memory-client'

const DEFAULT_BASE_URL = 'https://seele-memory.griptoad.workers.dev'

export const runtime = 'nodejs'

const Body = z.object({
  phrase: z.string().min(20),
  deviceName: z.string().min(1).default('vercel-ai-example'),
})

export async function POST(req: NextRequest) {
  const json = await req.json().catch(() => ({}))
  const parsed = Body.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad_request', message: parsed.error }, { status: 400 })
  }
  const { phrase, deviceName } = parsed.data
  if (!isValidRecoveryPhrase(phrase)) {
    return NextResponse.json(
      { error: 'bad_phrase', message: 'not a valid 12-word BIP-39 phrase' },
      { status: 400 },
    )
  }
  const km = deriveKeyMaterial(phrase)
  try {
    const client = new SeeleCloudClient({ baseUrl: DEFAULT_BASE_URL })
    const deviceId = crypto.randomUUID()
    const reg = await client.registerDevice({
      user_id: await userIdForPhrase(km),
      device: {
        device_id: deviceId,
        name: deviceName,
        platform: 'vercel-edge',
        app_version: '0.1.0',
        public_key: km.publicKeyBase64(),
        subkey_id: deviceId,
      },
    })
    const cookiePayload = {
      baseUrl: DEFAULT_BASE_URL,
      deviceToken: reg.device_token,
      aesContentKeyB64: bytesToBase64(km.plaintextAesKey()),
    }
    const cookieValue = Buffer.from(JSON.stringify(cookiePayload)).toString('base64')
    const res = NextResponse.json({ ok: true })
    res.cookies.set('seele_ctx', cookieValue, {
      httpOnly: true,
      sameSite: 'lax',
      // 5 minutes — enough for a few chat turns, far less than the
      // device token's 1-year TTL. Refetch /api/auth if it expires.
      maxAge: 300,
    })
    return res
  } finally {
    // Wipe the key material before leaving the route.
    km.zeroize()
  }
}

/**
 * Derive a stable user_id from the phrase's public key (base64).
 *
 * Real production users hit /api/keys/register with their email_hash
 * (via CF Access). For this dev-only flow, we use the user's public
 * key fingerprint — same phrase always produces the same user_id,
 * which is exactly what we want for a dev loop.
 */
async function userIdForPhrase(km: { ed25519PublicKey: Uint8Array }): Promise<string> {
  const buf = new Uint8Array(km.ed25519PublicKey)
  const digest = await crypto.subtle.digest('SHA-256', buf)
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `dev-${hex.slice(0, 32)}`
}
