/**
 * /api/chat — Vercel AI SDK route that uses seele-cloud as a tool.
 *
 * Flow:
 *   1. Read the user's content key + device token from cookies
 *      (set during the auth handshake in `/api/auth`).
 *   2. Mint a short-lived bot grant for this request.
 *   3. Expose `seele_recall` as an AI SDK tool. The tool's `execute`
 *      runs `recall()`, decrypts the response locally, and returns
 *      plaintext snippets to the model.
 *   4. The model cites them in its reply.
 *
 * Privacy: only the embedding vector leaves this process. The query
 * plaintext is consumed by `hashEmbedder384()` (replace with a real
 * embedder in production!) and never serialized to a network call.
 */

import { type NextRequest } from 'next/server'
import { generateText, tool } from 'ai'
import { openai } from '@ai-sdk/openai'
import { z } from 'zod'

import { openBotSession, recallAndDecrypt } from '../../../lib/seele'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SeeleCtxSchema = z.object({
  baseUrl: z.string().url(),
  deviceToken: z.string(),
  aesContentKeyB64: z.string(),
})

async function readCtx(req: NextRequest) {
  // The "x-seele-ctx" header carries a JSON blob in production; here
  // we expect it from a cookie set during /api/auth. The example
  // uses cookies for brevity.
  const cookie = req.cookies.get('seele_ctx')?.value
  if (!cookie) {
    throw new Error('missing seele_ctx cookie; complete /api/auth first')
  }
  const raw = JSON.parse(Buffer.from(cookie, 'base64').toString('utf8'))
  return SeeleCtxSchema.parse(raw)
}

export async function POST(req: NextRequest) {
  const ctx = await readCtx(req)
  const body = await req.json()
  const userMessage: string = body?.messages?.[body.messages.length - 1]?.content ?? ''

  // The tool itself runs the seele-cloud recall. The `execute`
  // is privileged code — it can hold the content key.
  const seeleTool = tool({
    description:
      'Search the user\'s encrypted seele-memory corpus for context. ' +
      'Returns decrypted snippets. Privacy: only embedding vectors and ' +
      'ciphertext cross the network boundary.',
    inputSchema: z.object({
      query: z.string().describe('Plaintext question to search for.'),
      top_k: z.number().int().min(1).max(50).default(5),
    }),
    execute: async ({ query, top_k }) => {
      const { baseUrl, deviceToken, aesContentKeyB64 } = ctx
      const session = await openBotSession(
        { baseUrl, deviceToken, aesContentKey: fromB64(aesContentKeyB64) },
        { name: 'vercel-bot', scopeTags: ['decisions'] },
      )
      const snippets = await recallAndDecrypt(
        { baseUrl, deviceToken, aesContentKey: fromB64(aesContentKeyB64) },
        session,
        query,
        top_k,
      )
      return { snippets }
    },
  })

  const result = await generateText({
    model: openai('gpt-4o'),
    messages: body.messages,
    tools: { seele_recall: seeleTool },
    toolChoice: 'auto',
    system:
      'You are the user\'s personal assistant with access to their memory. ' +
      'When asked about prior decisions, preferences, or past work, call ' +
      'seele_recall with a focused query before answering.',
  })

  return new Response(JSON.stringify(result), {
    headers: { 'content-type': 'application/json' },
  })
}

function fromB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'))
}
