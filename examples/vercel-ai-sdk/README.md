# seele-cloud × Vercel AI SDK — example

A minimal Next.js route handler that wires `@seele/memory-client` into
Vercel's AI SDK `generateText()` as a `tool` step that retrieves
memory snippets, decrypts them locally, and feeds them to the LLM
as conversation context.

## What this shows

- Single function-call tool that wraps `recall()` from the SDK.
- Bot grant JWT minting (one per request — short-lived).
- On-device decryption of the response before the LLM sees it.
- Privacy: only the embedding vector leaves the host.

## Run it locally

```bash
pnpm install   # in this example dir
pnpm dev       # starts the example Next.js app
```

## Files

- `app/api/chat/route.ts` — the route handler. Reads the user's
  bot grant + AES content key from cookies / env, runs
  `generateText()` with the `seele_recall` tool, returns the
  response.
- `app/api/auth/route.ts` — exchanges a 12-word recovery phrase for
  a device token (for dev only; production uses CF Access).
- `lib/seele.ts` — thin facade around `@seele/memory-client`
  for the route handler.

## Why no plaintext query is sent

The Vercel AI SDK's `tool()` calls run on the server side that
*you* control (the Next.js function). The SDK's `recall()` builds
the query embedding on the same machine, ships only the vector to
`https://seele-memory.griptoad.workers.dev/mem/v1/recall`, and
receives opaque ciphertext. The decryption step uses the
content key derived from the user's recovery phrase; it never
leaves this process.

If you deploy this Vercel example as a real bot, register a real
embedder (see `docs/embedding.md`). The default `hashEmbedder384()`
is for shape-testing only.

## See also

- [`../claude-custom-action.json`](../claude-custom-action.json) — same idea, copy-pastable into a Claude "Custom Action" definition.
- [`../langchain`](../langchain) — LangChain JS equivalent.
- [`../../sdk/typescript/README.md`](../../sdk/typescript/README.md) — SDK reference.
