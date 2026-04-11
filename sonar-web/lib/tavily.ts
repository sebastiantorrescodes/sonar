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

export async function searchWeb(
  query: string,
  options?: { maxResults?: number; topic?: 'general' | 'news' },
): Promise<string> {
  const client = getClient()
  const response = await client.search(query, {
    searchDepth: 'advanced',
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
