import Redis from 'ioredis'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'

// Singleton with HMR safety in Next.js dev
declare global {
  // eslint-disable-next-line no-var
  var _redisClient: Redis | undefined
}

function getClient(): Redis {
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

const SESSION_TTL = 60 * 60 * 24 // 24 hours

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

export async function saveHistory(
  sessionId: string,
  messages: MessageParam[],
): Promise<void> {
  const client = getClient()
  await client.set(
    `sonar:session:${sessionId}`,
    JSON.stringify(messages),
    'EX',
    SESSION_TTL,
  )
}

export async function clearHistory(sessionId: string): Promise<void> {
  const client = getClient()
  await client.del(`sonar:session:${sessionId}`)
}
