import Redis from 'ioredis'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'

// Singleton with HMR safety in Next.js dev
declare global {
  // eslint-disable-next-line no-var
  var _redisClient: Redis | undefined
}

export function getClient(): Redis {
  if (!process.env.REDIS_URL) {
    throw new Error('REDIS_URL environment variable is not set')
  }
  if (!global._redisClient) {
    global._redisClient = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    })
  }
  return global._redisClient
}

const SESSION_TTL = 60 * 60 * 24 * 7 // 7 days
const SESSIONS_INDEX = 'sonar:sessions' // sorted set: score = last updated timestamp

export interface SessionMeta {
  id: string
  firstQuery: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractFirstQuery(messages: MessageParam[]): string {
  const first = messages.find((m) => m.role === 'user')
  if (!first) return ''
  if (typeof first.content === 'string') return first.content.slice(0, 120)
  if (Array.isArray(first.content)) {
    const textBlock = first.content.find(
      (b): b is { type: 'text'; text: string } => 'type' in b && b.type === 'text',
    )
    return textBlock?.text?.slice(0, 120) ?? ''
  }
  return ''
}

// ─── Session history ──────────────────────────────────────────────────────────

export async function getHistory(sessionId: string): Promise<MessageParam[]> {
  const client = getClient()
  const raw = await client.get(`sonar:session:${sessionId}`)
  if (!raw) return []
  try {
    return JSON.parse(raw) as MessageParam[]
  } catch {
    return []
  }
}

// Register a session in the index as soon as a query comes in — before the
// agent loop finishes — so it shows up in the sidebar immediately.
export async function touchSession(sessionId: string, firstQuery: string): Promise<void> {
  const client = getClient()
  const now = Date.now()
  const metaKey = `sonar:session:${sessionId}:meta`

  const existingRaw = await client.get(metaKey)
  if (!existingRaw) {
    const meta: Omit<SessionMeta, 'id'> = {
      firstQuery: firstQuery.slice(0, 120),
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    }
    await Promise.all([
      client.set(metaKey, JSON.stringify(meta), 'EX', SESSION_TTL),
      client.zadd(SESSIONS_INDEX, now, sessionId),
    ])
  }
}

export async function saveHistory(
  sessionId: string,
  messages: MessageParam[],
): Promise<void> {
  const client = getClient()
  const now = Date.now()
  const metaKey = `sonar:session:${sessionId}:meta`

  const existingRaw = await client.get(metaKey)
  const existing = existingRaw ? (JSON.parse(existingRaw) as Omit<SessionMeta, 'id'>) : null

  const meta: Omit<SessionMeta, 'id'> = {
    firstQuery: existing?.firstQuery ?? extractFirstQuery(messages),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    messageCount: messages.length,
  }

  await Promise.all([
    client.set(`sonar:session:${sessionId}`, JSON.stringify(messages), 'EX', SESSION_TTL),
    client.set(metaKey, JSON.stringify(meta), 'EX', SESSION_TTL),
    client.zadd(SESSIONS_INDEX, now, sessionId),
  ])
}

export async function clearHistory(sessionId: string): Promise<void> {
  const client = getClient()
  await Promise.all([
    client.del(`sonar:session:${sessionId}`),
    client.del(`sonar:session:${sessionId}:meta`),
    client.zrem(SESSIONS_INDEX, sessionId),
  ])
}

// ─── Session index ────────────────────────────────────────────────────────────

export async function listSessions(): Promise<SessionMeta[]> {
  const client = getClient()

  // Primary: sorted set (populated for all sessions after indexing was added)
  let ids = await client.zrevrange(SESSIONS_INDEX, 0, 49)

  // Fallback: scan for session keys that predate the index
  // Runs once until the sorted set has entries, then becomes a no-op
  if (ids.length === 0) {
    const orphanIds: string[] = []
    const stream = client.scanStream({ match: 'sonar:session:*', count: 100 })

    for await (const keys of stream) {
      for (const key of keys as string[]) {
        // Skip meta sidecar keys
        if (key.endsWith(':meta')) continue
        const id = key.replace('sonar:session:', '')
        orphanIds.push(id)
      }
    }

    if (orphanIds.length > 0) {
      // Back-fill the sorted set — use the current time as a best-effort score
      // (we can't recover the original timestamp without reading every key)
      const now = Date.now()
      await Promise.all(
        orphanIds.map(async (id) => {
          // Try to build meta from the stored messages
          const raw = await client.get(`sonar:session:${id}`)
          if (!raw) return
          try {
            const messages = JSON.parse(raw) as MessageParam[]
            const firstQuery = extractFirstQuery(messages)
            const metaKey = `sonar:session:${id}:meta`
            const existingMeta = await client.get(metaKey)
            if (!existingMeta) {
              const meta: Omit<SessionMeta, 'id'> = {
                firstQuery,
                createdAt: now,
                updatedAt: now,
                messageCount: messages.length,
              }
              await client.set(metaKey, JSON.stringify(meta), 'EX', SESSION_TTL)
            }
            await client.zadd(SESSIONS_INDEX, now, id)
          } catch {
            // Corrupt session data — skip
          }
        }),
      )
      ids = await client.zrevrange(SESSIONS_INDEX, 0, 49)
    }
  }

  if (ids.length === 0) return []

  const results = await Promise.all(
    ids.map(async (id) => {
      const metaRaw = await client.get(`sonar:session:${id}:meta`)
      if (!metaRaw) {
        // Meta expired but index entry remains — clean up and skip
        client.zrem(SESSIONS_INDEX, id)
        return null
      }
      const meta = JSON.parse(metaRaw) as Omit<SessionMeta, 'id'>
      return { id, ...meta } satisfies SessionMeta
    }),
  )

  return results.filter((s): s is SessionMeta => s !== null)
}
