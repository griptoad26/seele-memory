/**
 * End-to-end usage example for the LangChain bridge.
 *
 * Reads env vars for the device token + AES content key (16-byte-b64).
 * Production: do NOT load these from process.env directly — they
 * belong in a keychain / KMS. This example uses env vars for terseness.
 */

import { ChatOpenAI } from '@langchain/openai'
import { RetrievalQAChain } from 'langchain/chains'
import { SeeleMemoryStore } from './SeeleMemoryStore'
import { base64ToBytes } from '@seele/memory-client'

async function main() {
  const store = new SeeleMemoryStore({
    baseUrl: process.env.SEELE_BASE_URL ?? 'https://seele-memory.griptoad.workers.dev',
    deviceToken: process.env.SEELE_DEVICE_TOKEN!,
    aesContentKey: base64ToBytes(process.env.SEELE_AES_KEY_B64!),
  })

  // 1) Index some sample documents (writes happen via /api/sync/upload
  //    with AES-GCM-encrypted bodies).
  await store.addDocuments([
    { pageContent: 'Decided to ship Rust 2024 by Q3; using sealevel-rs.', metadata: { tag: 'rust-decisions' } },
    { pageContent: 'Trip to Kyoto 2026-04; bring Rick Steves guidebook.', metadata: { tag: 'travel' } },
    { pageContent: 'xkg-core SyncTarget::SeeleCloud lands in v0.10.0.', metadata: { tag: 'projects' } },
  ])

  // 2) Build a QA chain over the bridge.
  const chain = RetrievalQAChain.fromLLM(
    new ChatOpenAI({ modelName: 'gpt-4o', temperature: 0 }),
    store.asRetriever({ k: 3 }),
  )

  // 3) Query.
  const res = await chain.call({ query: 'what did I decide about Rust 2024?' })
  console.log(res.text)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
