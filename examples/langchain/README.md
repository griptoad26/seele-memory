# seele-cloud × LangChain JS — example

A `VectorStore`-shaped bridge that lets LangChain's `RetrievalQAChain`
treat `@seele/memory-client`'s recall API as if it were a normal
vector database.

The twist: seele-cloud returns ciphertext. This bridge decrypts snippets
on the way out so LangChain sees plaintext, but nothing about that
plaintext crosses the network boundary other than embedding vectors.

## Quick start

```ts
import { SeeleMemoryStore } from './SeeleMemoryStore'
import { RetrievalQAChain } from 'langchain/chains'
import { ChatOpenAI } from '@langchain/openai'

const store = new SeeleMemoryStore({
  baseUrl: 'https://seele-memory.griptoad.workers.dev',
  deviceToken: process.env.SEELE_DEVICE_TOKEN!,
  aesContentKeyB64: process.env.SEELE_AES_KEY_B64!,
})

const chain = RetrievalQAChain.fromLLM(
  new ChatOpenAI({ modelName: 'gpt-4o' }),
  store.asRetriever({ k: 5 }),
)

const res = await chain.call({ query: 'rust 2024 decisions' })
console.log(res.text)
```

## What's going on under the hood

| LangChain method | What it does here |
|---|---|
| `addVectors(vectors, documents)` | Encrypts each document with the content key, then uploads via `/api/sync/upload`. |
| `addDocuments(documents)` | Same, with `hashEmbedder384()` (or your real embedder) to compute the vector. |
| `similaritySearchVectorWithScore(qvec, k)` | Calls `/mem/v1/recall` with the bot grant + query_vector, decrypts results, returns `Document` objects. |

## Files

- `SeeleMemoryStore.ts` — the bridge.
- `usage.ts` — end-to-end example.
- `config.example.ts` — env shape, no real tokens.
