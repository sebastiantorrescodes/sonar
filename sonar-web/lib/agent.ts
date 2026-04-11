import Anthropic from '@anthropic-ai/sdk'
import type {
  MessageParam,
  Tool,
  ToolResultBlockParam,
  MessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages'
import { getHistory, saveHistory } from './redis'
import { searchWeb } from './tavily'
import { initMCPServers, getMCPTools, callMCPTool, isMCPTool } from './mcp'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ArtistCard {
  id: string
  name: string
  genre: string[]
  location?: string
  monthlyListeners?: number
  socialFollowing?: { platform: string; count: number }[]
  buzzScore?: number
  summary: string
  fullBrief: string
  outreachEmail: string
  spotifyUrl?: string
  imageUrl?: string
}

export type StreamEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; content: string; isError: boolean }
  | { type: 'artist_card'; data: ArtistCard }
  | { type: 'error'; message: string }
  | { type: 'done' }

// ─── Built-in Tools ───────────────────────────────────────────────────────────

const WEB_SEARCH_TOOL: Tool = {
  name: 'web_search',
  description:
    'Search the web for current information about artists — streaming numbers, social media growth, press coverage, live shows, recent releases, and industry buzz.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'The search query. Be specific — include artist name, topic, and time context.',
      },
      topic: {
        type: 'string',
        enum: ['general', 'news'],
        description: 'Use "news" for recent articles and announcements, "general" for broader research.',
      },
    },
    required: ['query'],
  },
}

const CREATE_ARTIST_CARD_TOOL: Tool = {
  name: 'create_artist_card',
  description:
    'Compile all gathered research into a structured artist card. Call this once you have sufficient intelligence on an artist — streaming data, social presence, fan sentiment, press coverage, and a clear read on their trajectory. This triggers a card on the frontend.',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Artist name' },
      genre: {
        type: 'array',
        items: { type: 'string' },
        description: 'Primary genres, most specific first',
      },
      location: { type: 'string', description: 'City, Country' },
      monthlyListeners: {
        type: 'number',
        description: 'Spotify monthly listeners if known',
      },
      socialFollowing: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            platform: { type: 'string' },
            count: { type: 'number' },
          },
          required: ['platform', 'count'],
        },
        description: 'Social media following counts by platform',
      },
      buzzScore: {
        type: 'number',
        description:
          'A 0–100 score reflecting momentum: recent press velocity, streaming growth, social engagement, and fan sentiment.',
      },
      summary: {
        type: 'string',
        description:
          '2–3 sentence A&R summary — who they are, what makes them interesting, why now.',
      },
      fullBrief: {
        type: 'string',
        description:
          'Full A&R brief covering: background, sound, comparable artists, recent trajectory, streaming/social data, fan reception, market timing, and signing recommendation.',
      },
      outreachEmail: {
        type: 'string',
        description:
          'Draft cold outreach email to the artist or their management. Warm, specific, credible — not templated.',
      },
      spotifyUrl: { type: 'string', description: 'Spotify artist profile URL if found' },
      imageUrl: { type: 'string', description: 'Artist photo URL if found' },
    },
    required: ['name', 'genre', 'summary', 'fullBrief', 'outreachEmail'],
  },
}

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are SONAR, an elite A&R intelligence agent for a forward-thinking record label. Your job: discover and deeply research emerging music artists who have genuine commercial and artistic potential.

When you receive a query:
1. **Research first.** Use web_search aggressively — search for the artist by name, then for "[artist] streaming stats", "[artist] press coverage", "[artist] reddit", "[artist] new music 2024 2025". Cast a wide net.
2. **If Spotify tools are available**, pull streaming data, listener demographics, and find similar artists in their orbit.
3. **If Reddit tools are available**, search for organic fan discussion — subreddits like r/indieheads, r/hiphopheads, r/rnb, r/popheads, or artist-specific communities.
4. **Compile your findings.** For each artist you've researched sufficiently, call create_artist_card to create a structured brief.
5. **If Slack tools are available**, post a concise summary to the team channel after generating cards.

Research depth over breadth. 1–3 artists researched thoroughly beats 10 artists skimmed.

Your output should feel like a seasoned A&R rep's notes — sharp, specific, and opinionated. Lead with what's interesting, back it with data, and give a clear read on whether this artist is worth pursuing.`

// ─── Tool Execution ───────────────────────────────────────────────────────────

async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  try {
    if (name === 'web_search') {
      const result = await searchWeb(input.query as string, {
        topic: (input.topic as 'general' | 'news') ?? 'general',
      })
      return { content: result, isError: false }
    }

    if (name === 'create_artist_card') {
      // The agent calling this tool IS the result — we just echo back success
      return {
        content: JSON.stringify(input),
        isError: false,
      }
    }

    if (isMCPTool(name)) {
      const result = await callMCPTool(name, input)
      return { content: result, isError: false }
    }

    return { content: `Unknown tool: ${name}`, isError: true }
  } catch (err) {
    return {
      content: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    }
  }
}

// ─── Agent Loop ───────────────────────────────────────────────────────────────

export async function* runAgent(
  query: string,
  sessionId: string,
): AsyncGenerator<StreamEvent> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  // Init MCP servers (no-op if already connected or not configured)
  await initMCPServers()

  const history = await getHistory(sessionId)
  const messages: MessageParam[] = [
    ...history,
    { role: 'user', content: query },
  ]

  const tools: Tool[] = [
    WEB_SEARCH_TOOL,
    CREATE_ARTIST_CARD_TOOL,
    ...getMCPTools(),
  ]

  try {
    while (true) {
      const stream = client.messages.stream({
        model: 'claude-opus-4-6',
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        messages,
        tools,
      })

      // Accumulate input JSON for tool_use blocks indexed by stream position
      const inputAccumulator = new Map<number, { id: string; name: string; json: string }>()

      for await (const event of stream as AsyncIterable<MessageStreamEvent>) {
        if (event.type === 'content_block_start') {
          const block = event.content_block
          if (block.type === 'tool_use') {
            inputAccumulator.set(event.index, {
              id: block.id,
              name: block.name,
              json: '',
            })
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta
          if (delta.type === 'text_delta') {
            yield { type: 'text', content: delta.text }
          } else if (delta.type === 'input_json_delta') {
            const acc = inputAccumulator.get(event.index)
            if (acc) acc.json += delta.partial_json
          }
        } else if (event.type === 'content_block_stop') {
          const acc = inputAccumulator.get(event.index)
          if (acc) {
            let parsed: Record<string, unknown> = {}
            try {
              parsed = JSON.parse(acc.json || '{}')
            } catch {
              parsed = {}
            }
            yield {
              type: 'tool_call',
              id: acc.id,
              name: acc.name,
              input: parsed,
            }
            inputAccumulator.delete(event.index)
          }
        }
      }

      const finalMsg = await stream.finalMessage()
      messages.push({ role: 'assistant', content: finalMsg.content })

      if (finalMsg.stop_reason !== 'tool_use') break

      // Execute all tool calls in the response
      const toolResults: ToolResultBlockParam[] = []

      for (const block of finalMsg.content) {
        if (block.type !== 'tool_use') continue

        const result = await executeTool(
          block.name,
          block.input as Record<string, unknown>,
        )

        yield {
          type: 'tool_result',
          id: block.id,
          name: block.name,
          content: result.content,
          isError: result.isError,
        }

        // Emit artist card event when that tool is called successfully
        if (block.name === 'create_artist_card' && !result.isError) {
          const cardData = block.input as Record<string, unknown>
          yield {
            type: 'artist_card',
            data: {
              id: block.id,
              name: cardData.name as string,
              genre: (cardData.genre as string[]) ?? [],
              location: cardData.location as string | undefined,
              monthlyListeners: cardData.monthlyListeners as number | undefined,
              socialFollowing: cardData.socialFollowing as ArtistCard['socialFollowing'],
              buzzScore: cardData.buzzScore as number | undefined,
              summary: cardData.summary as string,
              fullBrief: cardData.fullBrief as string,
              outreachEmail: cardData.outreachEmail as string,
              spotifyUrl: cardData.spotifyUrl as string | undefined,
              imageUrl: cardData.imageUrl as string | undefined,
            },
          }
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result.content,
          is_error: result.isError,
        })
      }

      messages.push({ role: 'user', content: toolResults })
    }

    await saveHistory(sessionId, messages)
  } catch (err) {
    yield {
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  yield { type: 'done' }
}
