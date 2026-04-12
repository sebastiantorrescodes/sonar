import { tavily } from '@tavily/core'

function getClient() {
  if (!process.env.TAVILY_API_KEY) {
    throw new Error('TAVILY_API_KEY environment variable is not set')
  }
  return tavily({ apiKey: process.env.TAVILY_API_KEY })
}

export interface SearchResult {
  answer?: string
  results: Array<{
    title: string
    url: string
    content: string
    score: number
  }>
}

export async function searchInstagram(artistName: string): Promise<string> {
  const client = getClient()

  // Three targeted queries to pull follower count, engagement, and recent activity
  const queries = [
    `site:instagram.com "${artistName}" followers`,
    `"${artistName}" instagram followers engagement 2025`,
    `"${artistName}" instagram reels views likes`,
  ]

  const results = await Promise.all(
    queries.map((q) =>
      client
        .search(q, {
          searchDepth: 'advanced',
          maxResults: 3,
          includeAnswer: true,
          topic: 'general',
        })
        .catch(() => null),
    ),
  )

  const sections: string[] = []

  results.forEach((response, i) => {
    if (!response) return
    if (response.answer) {
      sections.push(`**Query ${i + 1}:** ${queries[i]}\n**Summary:** ${response.answer}`)
    }
    response.results.forEach((r: { title: string; url: string; content: string }) => {
      sections.push(`**${r.title}**\nSource: ${r.url}\n${r.content}`)
    })
  })

  return sections.join('\n\n---\n\n') || 'No Instagram data found.'
}

export async function searchWeb(
  query: string,
  options?: { maxResults?: number; topic?: 'general' | 'news'; depth?: 'basic' | 'advanced' },
): Promise<string> {
  const client = getClient()
  const response = await client.search(query, {
    searchDepth: options?.depth ?? 'basic',
    maxResults: options?.maxResults ?? 5,
    includeAnswer: true,
    topic: options?.topic ?? 'general',
  })

  const sections: string[] = []

  if (response.answer) {
    sections.push(`**Summary:** ${response.answer}`)
  }

  const formatted = response.results
    .map(
      (r: { title: string; url: string; content: string }) =>
        `**${r.title}**\nSource: ${r.url}\n${r.content}`,
    )
    .join('\n\n---\n\n')

  if (formatted) sections.push(formatted)

  return sections.join('\n\n') || 'No results found.'
}
