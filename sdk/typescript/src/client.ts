/**
 * @seele/memory-client — client.ts
 *
 * -----------------------------------------------------------------------
 *  PRIVACY-CRITICAL — read before editing
 * -----------------------------------------------------------------------
 *
 *  `SeeleCloudClient` is the SDK's network surface for seele-cloud.
 *  The contract it speaks is end-to-end encrypted — every request that
 *  carries conversation content (sync envelopes) is encrypted on the
 *  caller's side before this client touches the bytes.
 *
 *  The client itself never sees plaintext bodies. It forwards opaque
 *  ciphertext blobs and per-bot grant JWTs. The recall path sends only
 *  embedding vectors (no query plaintext) and gets ciphertext back.
 *
 *  Two auth flavors:
 *    * **device token** (long-lived, scope=memory:write) for /api/keys/*
 *      and /api/sync/* — typically minted at first enrollment via
 *      `POST /api/keys/register` and stored in secure local storage
 *      by the embedding app.
 *    * **bot grant JWT** (short-lived, scope=memory:recall) for
 *      /mem/v1/* — minted on demand via `mintBot()`. The caller is
 *      expected to mint a new grant ahead of time (the bot SDK
 *      never holds the device token).
 *
 * -----------------------------------------------------------------------
 */

import type { Embedder, RecallOptions, RecallResponse, FullRecallOptions, FullRecallResponse } from './recall.js'
import { hashEmbedder384, recall as recallImpl, fullRecall as fullRecallImpl } from './recall.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const DEFAULT_BASE_URL = 'https://seele-memory.griptoad.workers.dev'

export interface SeeleCloudClientOptions {
  /** Server origin. Defaults to the live workers.dev deployment. */
  baseUrl?: string
  /** Long-lived device JWT (memory:write scope) for /api/keys + /api/sync. */
  deviceToken?: string
  /** Optional fetch override — useful for tests. */
  fetch?: typeof fetch
  /** Injectable embedder. Defaults to the hash-based stub. */
  embedder?: Embedder
  /** Optional metadata sent on every request (e.g. user agent). */
  headers?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface MintBotRequest {
  name: string
  scope_tags?: string[]
  ttl_seconds?: number
}

export interface MintBotResponse {
  bot_id: string
  user_id: string
  name: string
  scope_tags: string[]
  grant: { jwt: string; expires_at: string; scope: string }
  private_key: string // base64 PKCS8 — RETURNED ONCE
  public_key: string // base64 raw
  warning: string
}

export interface ListBotsResponse {
  bots: Array<{
    bot_id: string
    name: string
    scope_tags: string[]
    created_at: number
    revoked_at: number | null
  }>
}

export interface RegisterDeviceRequest {
  user_id: string
  email_hash?: string
  public_key?: string // base64 raw Ed25519 public key (user's master pubkey)
  device: {
    device_id: string
    name: string
    platform: string
    app_version: string
    public_key?: string // base64 raw per-device pubkey
    subkey_id?: string
  }
}

export interface RegisterDeviceResponse {
  user_id: string
  device_id: string
  device_token: string
  token_type: 'Bearer'
  expires_at: string
  scope: 'memory:write'
}

// Sync envelope shape mirrors xkg-core `SyncEnvelope`.
export interface SyncUploadRequest {
  // We accept the full envelope verbatim — the SDK does not need to
  // know what fields it contains. Encryption happens client-side.
  envelope: Record<string, unknown>
}

export interface SyncUploadResponse {
  ok: boolean
  // Server-defined fields; we don't commit to a stable shape here.
  [k: string]: unknown
}

export interface SyncDownloadResponse {
  envelope: Record<string, unknown> | null
  // Server-defined fields.
  [k: string]: unknown
}

export interface SyncStateResponse {
  state: Record<string, unknown>
}

export interface SyncDevicesResponse {
  devices: unknown[]
}

/**
 * Carries a freshly-minted bot grant JWT for the duration of one
 * bot session. The class is intentionally tiny — it does NOT hold
 * the device token, and the embedded JWT expires fast.
 */
export class BotSession {
  constructor(
    readonly bot: MintBotResponse,
    private readonly _client: SeeleCloudClient,
  ) {}

  /** Decoded grant claims (sub, bot_id, scope, exp, iat, iss). */
  get claims() {
    // Decode without verification — server is trusted in v0.10.0.
    const payload = JSON.parse(
      Buffer.from(this.bot.grant.jwt.split('.')[1], 'base64').toString('utf8'),
    )
    return {
      sub: payload.sub,
      bot_id: payload.bot_id,
      scope: payload.scope,
      exp: payload.exp,
      iat: payload.iat,
      iss: payload.iss,
    }
  }

  /** True iff `Date.now()/1000` is past `claims.exp - skew`. */
  isExpired(skewSeconds = 30): boolean {
    const now = Math.floor(Date.now() / 1000)
    return this.claims.exp - now <= skewSeconds
  }

  /** Refresh — mint a new grant for the same bot. */
  async refresh(): Promise<void> {
    const fresh = await this._client.mintBot({
      name: this.bot.name,
      scope_tags: this.bot.scope_tags,
      ttl_seconds: 900,
    })
    // Update only the grant half; preserve bot_id, private_key, etc.
    Object.assign(this.bot, fresh)
    void this
  }

  // --- Wrapped convenience methods that ride this bot's grant ---

  /**
   * `POST /mem/v1/recall` over this bot's grant.
   * Returns opaque ciphertext snippets — the SDK does not decrypt them
   * here. The owning app decrypts using its `KeyMaterial`.
   */
  recall(opts: RecallOptions): Promise<RecallResponse> {
    return recallImpl(this._client, { ...opts, bot_id: this.bot.bot_id })
  }

  /** `POST /mem/v1/full-recall` over this bot's grant. */
  fullRecall(opts: FullRecallOptions): Promise<FullRecallResponse> {
    return fullRecallImpl(this._client, { ...opts, bot_id: this.bot.bot_id })
  }
}

/**
 * Network client for seele-cloud.
 *
 * The constructor is cheap; instantiate per-session and dispose. The
 * SDK never makes cross-user or cross-bot assumptions — a "client"
 * is a single user's device + a single bot, by convention.
 */
export class SeeleCloudClient {
  readonly baseUrl: string
  readonly deviceToken?: string
  readonly embedder?: Embedder
  private readonly _fetch: typeof fetch
  private readonly _headers: Record<string, string>

  constructor(opts: SeeleCloudClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.deviceToken = opts.deviceToken
    this.embedder = opts.embedder ?? hashEmbedder384
    this._fetch = opts.fetch ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : (undefined as any))
    this._headers = opts.headers ?? {}
    if (!this._fetch) {
      throw new Error('@seele/memory-client: no `fetch` available on this runtime')
    }
  }

  // ---------------------------------------------------------------------
  // Low-level HTTP
  // ---------------------------------------------------------------------

  async get<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    return this._req<T>('GET', path, undefined, init)
  }

  async post<T = unknown>(path: string, body?: unknown, init?: RequestInit): Promise<T> {
    return this._req<T>('POST', path, body, init)
  }

  private async _req<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    init?: RequestInit,
  ): Promise<T> {
    if (!path.startsWith('/')) {
      throw new Error('@seele/memory-client: path must start with "/"')
    }
    const url = this.baseUrl + path
    const headers = new Headers(init?.headers ?? {})
    headers.set('content-type', 'application/json')
    for (const [k, v] of Object.entries(this._headers)) headers.set(k, v)
    // Bot routes use Bearer=<bot_grant_jwt>; sync uses Bearer=<device_token>;
    // recall uses Bearer=<bot_grant_jwt>. We auto-attach whatever is
    // present in `init.headers.authorization` or fall back to the
    // device token. Bot sessions override this when wrapping.
    if (!headers.has('authorization') && this.deviceToken) {
      headers.set('authorization', `Bearer ${this.deviceToken}`)
    }
    const resp = await this._fetch(url, {
      ...init,
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : init?.body,
    })
    return this._parse<T>(resp)
  }

  private async _parse<T>(resp: Response): Promise<T> {
    const ct = resp.headers.get('content-type') || ''
    const text = await resp.text()
    if (!text) {
      if (!resp.ok) throw new SeeleHttpError(resp.status, 'empty_body', '')
      return {} as T
    }
    if (ct.includes('application/json')) {
      let parsed: any
      try {
        parsed = JSON.parse(text)
      } catch (_) {
        throw new SeeleHttpError(resp.status, 'bad_json', text.slice(0, 1024))
      }
      if (!resp.ok) {
        throw new SeeleHttpError(resp.status, parsed?.error || 'http_error', parsed?.message || text)
      }
      return parsed as T
    }
    if (!resp.ok) throw new SeeleHttpError(resp.status, 'http_error', text.slice(0, 1024))
    return text as unknown as T
  }

  // ---------------------------------------------------------------------
  // High-level operations
  // ---------------------------------------------------------------------

  /**
   * `POST /api/keys/register` — first-time device enrollment.
   * Returns a long-lived device token suitable for storage in
   * secure local storage (Keychain on iOS, EncryptedSharedPreferences
   * on Android, etc.).
   */
  async registerDevice(req: RegisterDeviceRequest): Promise<RegisterDeviceResponse> {
    return this.post<RegisterDeviceResponse>('/api/keys/register', req)
  }

  /**
   * `POST /api/bots` — mint a new bot + grant JWT.
   *
   * The bot's Ed25519 private_key is returned **only at mint time**.
   * The caller must persist it; future mints generate a fresh
   * keypair.
   */
  async mintBot(req: MintBotRequest): Promise<MintBotResponse> {
    return this.post<MintBotResponse>('/api/bots', req)
  }

  /** Get a `BotSession` wrapping a freshly-minted bot. */
  async openBot(req: MintBotRequest): Promise<BotSession> {
    const bot = await this.mintBot(req)
    return new BotSession(bot, this._cloneForBot(bot.grant.jwt))
  }

  /** `GET /api/bots` — list caller's bots. */
  async listBots(): Promise<ListBotsResponse> {
    return this.get<ListBotsResponse>('/api/bots')
  }

  /** `POST /api/bots/:id/revoke` — revoke a bot. */
  async revokeBot(bot_id: string): Promise<{ bot_id: string; revoked_at: number; already_revoked?: boolean }> {
    return this.post(`/api/bots/${encodeURIComponent(bot_id)}/revoke`, {})
  }

  // ---------------------------------------------------------------------
  // Sync (envelope exchange — content is opaque to the server).
  // ---------------------------------------------------------------------

  /**
   * `POST /api/sync/upload` — push an encrypted envelope. The envelope
   * must already be encrypted with the per-device subkey. The SDK
   * does NOT decrypt anything on this path; the cipher-shape is
   * the caller's responsibility.
   */
  async syncUpload(envelope: Record<string, unknown>): Promise<SyncUploadResponse> {
    return this.post<SyncUploadResponse>('/api/sync/upload', { envelope })
  }

  /** `POST /api/sync/download` — pull latest envelope for this device. */
  async syncDownload(): Promise<SyncDownloadResponse> {
    return this.post<SyncDownloadResponse>('/api/sync/download', {})
  }

  /** `GET /api/sync/state` — get sync cursors / last seen. */
  async syncState(): Promise<SyncStateResponse> {
    return this.get<SyncStateResponse>('/api/sync/state')
  }

  /** `GET /api/sync/devices` — list devices for this user. */
  async syncDevices(): Promise<SyncDevicesResponse> {
    return this.get<SyncDevicesResponse>('/api/sync/devices')
  }

  // ---------------------------------------------------------------------
  // Recall — usually invoked through `BotSession.recall()`, not directly.
  // ---------------------------------------------------------------------

  async recall(opts: RecallOptions): Promise<RecallResponse> {
    return recallImpl(this, opts)
  }

  async fullRecall(opts: FullRecallOptions): Promise<FullRecallResponse> {
    return fullRecallImpl(this, opts)
  }

  // ---------------------------------------------------------------------
  // Internal — produce a client variant whose Authorization is the
  // bot grant JWT instead of the device token. Used by BotSession.
  // ---------------------------------------------------------------------

  _cloneForBot(grantJwt: string): SeeleCloudClient {
    const c = Object.create(SeeleCloudClient.prototype) as SeeleCloudClient
    ;(c as any).baseUrl = this.baseUrl
    ;(c as any).deviceToken = undefined
    ;(c as any).embedder = this.embedder
    ;(c as any)._fetch = this._fetch
    ;(c as any)._headers = { ...this._headers, authorization: `Bearer ${grantJwt}` }
    return c
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SeeleHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(`@seele/memory-client: HTTP ${status} ${code}: ${message}`)
    this.name = 'SeeleHttpError'
  }
}
