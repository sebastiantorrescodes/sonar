// REST wrapper for the Redis Agent Memory Server (localhost:8000)
// Docs: https://github.com/redis/agent-memory-server
import type { ArtistCard } from './agent'

const MEMORY_URL = process.env.MEMORY_SERVER_URL ?? 'http://localhost:8000'
const NAMESPACE = 'artists'
const USER_ID = 'sonar'

// ─── Availability check ───────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var _memoryAvailable: boolean | null
}

async function isAvailable(): Promise<boolean> {
  if (global._memoryAvailable !== undefined && global._memoryAvailable !== null) {
    return global._memoryAvailable
  }
  try {
    const res = await fetch(`${MEMORY_URL}/v1/health`, { signal: AbortSignal.timeout(2000) })
    global._memoryAvailable = res.ok
  } catch {
    global._memoryAvailable = false
  }
  return global._memoryAvailable!
}

// ─── Store artist card as long-term memory ────────────────────────────────────

export async function storeArtistMemory(card: ArtistCard): Promise<void> {
  if (!(await isAvailable())) return

  // Combine the full brief with key stats for richer semantic search
  const text = [
    `Artist: ${card.name}`,
    `Genre: ${card.genre.join(', ')}`,
    card.location ? `Location: ${card.location}` : null,
    card.buzzScore != null ? `Buzz Score: ${card.buzzScore}/100` : null,
    card.monthlyListeners != null ? `Monthly Listeners: ${card.monthlyListeners}` : null,
    `Summary: ${card.summary}`,
    `Full Brief: ${card.fullBrief}`,
  ]
    .filter(Boolean)
    .join('\n')

  await fetch(`${MEMORY_URL}/v1/long-term-memory/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      memories: [
        {
          id: `artist:${card.name.toLowerCase().replace(/\s+/g, '-')}:${Date.now()}`,
          text,
          user_id: USER_ID,
          namespace: NAMESPACE,
          topics: card.genre.map((g) => g.toLowerCase().replace(/[^a-z0-9 ]/g, '')),
          entities: [card.name, ...(card.location ? [card.location] : [])],
        },
      ],
      deduplicate: true,
    }),
  }).catch(() => {}) // fire-and-forget, don't block the agent
}

// ─── Search past artist research ──────────────────────────────────────────────

export async function searchArtistMemory(query: string): Promise<string> {
  if (!(await isAvailable())) {
    return 'Long-term memory is not available right now.'
  }

  const res = await fetch(`${MEMORY_URL}/v1/long-term-memory/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: query,
      user_id: { eq: USER_ID },
      namespace: { eq: NAMESPACE },
      search_mode: 'semantic',
      limit: 5,
    }),
  })

  if (!res.ok) return 'Memory search failed.'

  const data = await res.json()
  // API returns { memories: [...], total: N }
  const results = (data.memories ?? data.results) as Array<{ text: string; dist?: number; score?: number }>

  if (!results?.length) return 'No past research found matching this query.'

  return results
    .map((r, i) => {
      // dist is cosine distance (lower = more similar); convert to similarity %
      const sim = r.dist != null ? ((1 - r.dist) * 100).toFixed(0) : r.score != null ? (r.score * 100).toFixed(0) : '?'
      return `[#${i + 1} — similarity ${sim}%]\n${r.text}`
    })
    .join('\n\n---\n\n')
}
