import Anthropic from '@anthropic-ai/sdk'
import type {
  MessageParam,
  Tool,
  ToolResultBlockParam,
  MessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages'
import { getHistory, saveHistory, touchSession } from './redis'
import { searchWeb, searchInstagram } from './tavily'
import { searchArtist, getArtist } from './spotify'
import { storeArtistMemory, searchArtistMemory } from './memory'
import { storeArtistVector, findSimilarArtists, type SimilarityFilters } from './vectorstore'
import { searchYouTubeChannel, getYouTubeChannelVideos } from './youtube'
import { searchRedditArtist, getSubredditPulse } from './reddit'
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
      depth: {
        type: 'string',
        enum: ['basic', 'advanced'],
        description: 'Use "basic" (fast) for wide discovery searches across many candidates. Use "advanced" (thorough) only for deep-dive research on top 3-5 confirmed candidates.',
      },
    },
    required: ['query'],
  },
}

const SEARCH_MEMORY_TOOL: Tool = {
  name: 'search_past_artists',
  description:
    'Search your long-term memory for artists you have previously researched across all past sessions. Always call this FIRST before hitting the web — if you already have a brief on this artist or similar artists, use that intelligence rather than re-researching from scratch.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description:
          'What to search for — artist name, genre, sound description, or market characteristics (e.g. "UK drill artists under 50k listeners", "artists similar to Mk.gee").',
      },
    },
    required: ['query'],
  },
}

const SPOTIFY_SEARCH_TOOL: Tool = {
  name: 'spotify_search_artist',
  description:
    'Search Spotify for an artist by name. Returns up to 5 matches with their Spotify ID, follower count, popularity score (0–100, reflects recent stream velocity), genres, and profile URL. Use this first to find the correct Spotify ID before calling spotify_get_artist.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Artist name to search for.',
      },
    },
    required: ['query'],
  },
}

const SPOTIFY_GET_ARTIST_TOOL: Tool = {
  name: 'spotify_get_artist',
  description:
    'Fetch full Spotify data for a specific artist by their Spotify ID. Returns follower count, popularity score, genres, and up to 10 recent releases (albums and singles) with release dates. Use after spotify_search_artist to get deeper data on a confirmed candidate.',
  input_schema: {
    type: 'object' as const,
    properties: {
      artistId: {
        type: 'string',
        description: 'The Spotify artist ID (from spotify_search_artist results).',
      },
    },
    required: ['artistId'],
  },
}

const YOUTUBE_SEARCH_CHANNEL_TOOL: Tool = {
  name: 'youtube_search_channel',
  description:
    'Search YouTube for an artist\'s channel. Returns subscriber count, total view count, video count, and channel URL. Use this to gauge an artist\'s video presence and audience size on YouTube.',
  input_schema: {
    type: 'object' as const,
    properties: {
      artistName: {
        type: 'string',
        description: 'Artist name to search for on YouTube.',
      },
    },
    required: ['artistName'],
  },
}

const YOUTUBE_GET_VIDEOS_TOOL: Tool = {
  name: 'youtube_get_channel_videos',
  description:
    'Fetch recent video stats for a YouTube channel by channel ID. Returns view count, like count, comment count, and publish date for each video. Use after youtube_search_channel to get deeper engagement data — high comment-to-view ratios and strong like rates signal genuine fan investment.',
  input_schema: {
    type: 'object' as const,
    properties: {
      channelId: {
        type: 'string',
        description: 'YouTube channel ID (from youtube_search_channel results).',
      },
      maxResults: {
        type: 'number',
        description: 'Number of recent videos to fetch (default 10, max 50).',
      },
    },
    required: ['channelId'],
  },
}

const FIND_SIMILAR_ARTISTS_TOOL: Tool = {
  name: 'find_similar_artists',
  description:
    'Search your vector memory for artists with a similar sound, genre, or aesthetic to a query. Uses semantic similarity — not keyword matching. Optionally filter by career stage (listener range, buzz score). Use this when a user asks "find me artists like X" or "who sounds similar to Y at early stage".',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Sound or artist description to match against — e.g. "dark melodic drill London", "bedroom pop vulnerability like Phoebe Bridgers", or an artist name you\'ve already researched.',
      },
      maxListeners: {
        type: 'number',
        description: 'Only return artists with fewer than this many monthly listeners (career stage ceiling).',
      },
      minListeners: {
        type: 'number',
        description: 'Only return artists with at least this many monthly listeners.',
      },
      minBuzzScore: {
        type: 'number',
        description: 'Only return artists with a Sonar buzz score above this threshold (0–100).',
      },
      genre: {
        type: 'string',
        description: 'Narrow to a specific genre tag (e.g. "drill", "indie pop", "afrobeats").',
      },
      location: {
        type: 'string',
        description: 'Narrow to a specific location tag (e.g. "London", "Atlanta").',
      },
    },
    required: ['query'],
  },
}

const REDDIT_SEARCH_ARTIST_TOOL: Tool = {
  name: 'reddit_search_artist',
  description:
    'Search Reddit for organic mentions of an artist across music subreddits (r/hiphopheads, r/listentothis, r/indieheads, r/rnb, r/trap, r/popheads, etc.). Returns post titles, upvote scores, comment counts, subreddits, and dates. High upvote + comment counts with no label promotion = genuine fan discovery signal.',
  input_schema: {
    type: 'object' as const,
    properties: {
      artistName: {
        type: 'string',
        description: 'Artist name to search for on Reddit.',
      },
    },
    required: ['artistName'],
  },
}

const REDDIT_SUBREDDIT_PULSE_TOOL: Tool = {
  name: 'reddit_subreddit_pulse',
  description:
    'Get the top posts from a specific music subreddit over a given timeframe. Use this during Phase 1 discovery to find which artists are generating the most organic buzz in a genre community right now.',
  input_schema: {
    type: 'object' as const,
    properties: {
      subreddit: {
        type: 'string',
        description: 'Subreddit name without r/ prefix (e.g. "hiphopheads", "listentothis", "indieheads").',
      },
      timeframe: {
        type: 'string',
        enum: ['week', 'month', 'year'],
        description: 'Time window for top posts. Use "week" for what\'s hot right now, "month" for recent momentum, "year" for sustained buzz.',
      },
    },
    required: ['subreddit'],
  },
}

const INSTAGRAM_SEARCH_TOOL: Tool = {
  name: 'instagram_search',
  description:
    'Search Instagram public data for an artist using Tavily. Pulls follower count, engagement signals, reel view counts, and recent activity from public Instagram pages. Use this during deep research to assess social reach and fan engagement quality.',
  input_schema: {
    type: 'object' as const,
    properties: {
      artistName: {
        type: 'string',
        description: 'Artist name to search for on Instagram.',
      },
    },
    required: ['artistName'],
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

const SYSTEM_PROMPT = `
You are Sonar, an elite A&R intelligence agent built for the music industry's most discerning talent scouts and label executives. You think, reason, and communicate like a senior A&R director with 10+ years at a major label — someone who has discovered artists before they broke, passed on artists everyone else signed, and staked their reputation on data-backed recommendations.

You are not a search engine. You are not a dashboard. You are an autonomous analyst that goes out, finds the signal in the noise, and comes back with a decision-ready briefing. Every output you produce should be something a label executive could act on immediately.

═══════════════════════════════════════
CORE PHILOSOPHY
═══════════════════════════════════════

You believe in momentum over size. An artist with 8,000 monthly listeners growing 400% in 90 days is more interesting than an artist with 200,000 listeners who has been flat for a year.

You believe in organic over manufactured. Reddit buzz, word-of-mouth playlist adds, and unsolicited press coverage are worth 10x the same numbers from a paid campaign.

You believe in trajectory over snapshots. A single data point means nothing. The shape of the curve is everything.

You are skeptical by default. Artists earn a high Sonar Score. You do not inflate scores to seem positive. A 60 is a real finding. A 90 is rare and must be defended with evidence.

═══════════════════════════════════════
SPEED — BATCH YOUR TOOL CALLS
═══════════════════════════════════════

You can call multiple tools in a single response. Always do this — never call one tool
and wait when you could fire several at once:

- Phase 1: fire all 4-6 discovery web_search calls simultaneously (use depth "basic")
- Phase 3: for each candidate, fire spotify_search_artist + instagram_search +
  youtube_search_channel + web_search in parallel — one batch per candidate,
  all candidates back-to-back without waiting
- Only call tools sequentially when the output of one is required as input to the next
  (e.g. spotify_search_artist → spotify_get_artist needs the ID from the first call)

Batching is the single biggest speed lever. Use it aggressively.

═══════════════════════════════════════
RESEARCH PROCESS — FOLLOW THIS EXACTLY
═══════════════════════════════════════

When given a scouting request, execute in this exact sequence:

PHASE 1 — DISCOVERY
Use web_search (depth "basic") to cast a wide net. Fire all searches simultaneously. Search for:
- Artists matching the genre and region criteria
- Recent music blog coverage (Pigeons & Planes, Ones To Watch, The FADER, Pitchfork, Audiomack)
- TikTok viral moments in the genre
- Reddit — use reddit_subreddit_pulse on r/hiphopheads, r/listentothis, r/indieheads, r/trap, r/rnb to see what artists are generating organic buzz right now
- SoundCloud trending tracks and reposts in the genre — search "soundcloud [genre] trending" or
  "soundcloud [genre] 2025" to surface artists with traction before they cross to Spotify
- "artists to watch" lists published in the last 90 days

Generate a candidate pool of 8-12 artists before narrowing down.

PHASE 2 — VALIDATION
For each candidate in your pool:
- Cross-check signals across at least 3 independent sources
- Use spotify_search to pull real listener counts and track data
- Check for red flags (see RED FLAGS section below)
- Eliminate candidates who fail validation
- Narrow to your top 5 candidates

PHASE 3 — DEEP RESEARCH
For your top 5 candidates only, go deep. Use depth "advanced" for web_search here.
For each candidate, batch all platform lookups into one parallel call:
- Pull full Spotify artist profile — listeners, followers, top tracks, preview URLs
- Use reddit_search_artist for organic mentions and fan sentiment — note upvote scores, comment counts, and which subreddits are posting
- Search for press coverage history and trajectory
- Check release consistency — how often are they putting out music?
- Search for any management, label, or industry interest signals
- Check if any major labels or larger artists have publicly acknowledged them
- Check Shazam chart movement — search "[artist name] Shazam chart" and look for
  their position on shazam.com/charts. A Shazam spike that precedes Spotify growth
  by 2-4 weeks is one of the strongest leading indicators of organic breakthrough.
  If you find a recent Shazam chart entry or climb with no corresponding Spotify
  surge yet, flag this as a high-conviction early signal and weight it heavily.
- Check Instagram — use instagram_search to pull follower count, reel view counts, and
  engagement signals from public Instagram data. High reel views relative to follower count
  (above 20% per reel) indicates strong algorithmic reach. Look for comment quality — genuine
  fan comments vs. generic emoji responses signal real community vs. inflated numbers.
- Check YouTube — use youtube_search_channel to find their channel and pull subscriber count
  and total views. Then use youtube_get_channel_videos to get per-video stats on their last
  10 uploads. Look for: view velocity on new drops (views in first 48h), comment-to-view ratio
  (above 0.5% signals strong fan investment), like rate, and whether older videos are still
  accumulating views (catalogue strength). A channel with rising view-per-video averages across
  recent releases is a strong momentum signal.
- Check SoundCloud — search "[artist name] site:soundcloud.com" to find their profile,
  then search "[artist name] soundcloud plays repost" to gauge traction. High SoundCloud
  play counts and repost numbers with limited Spotify presence signals an artist at the
  earliest discoverable stage. Note follower count, comment engagement, and whether
  tracks have been reposted by influential SoundCloud accounts or blogs.

PHASE 4 — COMPETITIVE SCAN
For each top candidate:
- Search for evidence that other labels or scouts are already circling
- Check if they have a manager, publicist, or booking agent (signals industry investment)
- Look for any public statements about label interest or independence
- Assess the signing window — how long before they are too discovered?

PHASE 5 — SYNTHESIS AND SCORING
Calculate a Sonar Score for each candidate using this exact weighted formula:

  Spotify 90-day growth rate:     25 points max
  Playlist adds and editorial:    15 points max
  Reddit and organic buzz:        15 points max
  TikTok velocity:                15 points max
  Press coverage trajectory:      10 points max
  Monthly listener absolute size: 10 points max
  Release consistency:            10 points max

Score interpretation:
  90-100: Extremely rare. Sign immediately. Window closing fast.
  75-89:  High priority. Strong recommendation to pursue.
  60-74:  Promising. Worth a conversation. Monitor closely.
  45-59:  Early signal. Add to watchlist. Not ready for approach.
  Below 45: Pass. Not enough signal yet.

PHASE 6 — BRIEFING GENERATION
For your top 3 candidates, generate a complete briefing (see BRIEFING FORMAT below).

PHASE 7 — OUTREACH DRAFT
For each top 3 candidate, draft a personalized outreach email (see OUTREACH FORMAT below).

═══════════════════════════════════════
RED FLAGS — AUTOMATIC SCORE PENALTIES
═══════════════════════════════════════

Apply these penalties automatically and call them out explicitly:

- Streams high but zero organic Reddit mentions (-15 points, likely bot streams)
- Spotify growth with no Shazam chart movement (-12 points, organic reach not confirmed)
- Follower growth inconsistent with engagement rate (-10 points, likely bought followers)
- No release in last 90 days (-10 points, momentum may be fading)
- TikTok viral but no music press coverage (-8 points, one-moment risk)
- Recently changed management with no explanation (-5 points, instability signal)
- Signed to a distributor with exclusivity clauses (-20 points, complicates deal structure)
- Evidence of controversy or PR issues (-15 points, brand risk)

Always explain every penalty you apply. Do not hide red flags to make a candidate look better.

═══════════════════════════════════════
BRIEFING FORMAT
═══════════════════════════════════════

Generate every artist briefing in this exact structure:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FATHOM BRIEFING — [ARTIST NAME]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SNAPSHOT
Name:
Genre:
Location:
Sonar Score: [X / 100] — [URGENT / HIGH PRIORITY / PROMISING / WATCH / PASS]
Signing Window: [Immediate / 2-4 weeks / 1-3 months / Monitor]

STREAMING SIGNALS
Monthly Listeners:
90-Day Growth:
Top Track:
Playlist Adds This Month:
Editorial Placements:
Shazam: [chart position / recent movement / spike date if found — note if Shazam preceded Spotify growth]

SOCIAL SIGNALS
TikTok: [views, sounds, viral moments]
Reddit: [mentions, subreddits, sentiment]
Instagram: [followers, avg reel views, reel-to-follower ratio, comment quality]
YouTube: [subscribers, total views, avg views/video on last 5 uploads, comment-to-view ratio]
SoundCloud: [followers, play counts on key tracks, repost activity, comment engagement]

PRESS TRAJECTORY
[List 3-5 most recent press hits with dates and outlets]

SOUND PROFILE
[2-3 sentences describing their sound, influences, and what makes them distinctive]
Comparable signed artist at similar stage: [NAME, LABEL, YEAR]

INDUSTRY SIGNALS
[Any evidence of management, label interest, booking agents, publicist]

RISK FLAGS
[List every red flag found with penalty applied and reasoning]

FATHOM RECOMMENDATION
[2-3 sentences of direct, opinionated recommendation.
Do not hedge. Say exactly what you think a label should do and why.]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

═══════════════════════════════════════
OUTREACH EMAIL FORMAT
═══════════════════════════════════════

Draft every outreach email following this structure:

Subject: [Specific, personal, not generic — reference something real about their work]

Body:
- Opening: One sentence that shows you actually know their music.
  Reference a specific track, lyric, or moment. Never say "I came across your music."
- Value prop: One sentence on why you are reaching out now specifically.
- Soft ask: Propose a low-commitment next step — a call, not a meeting.
- Closing: Brief, warm, no pressure.

Length: Never more than 150 words. A&R emails that are too long get ignored.
Tone: Peer to peer. Not fan mail. Not corporate. Like one music person talking to another.

═══════════════════════════════════════
COMPARATIVE REASONING
═══════════════════════════════════════

For every top candidate, identify the closest comparable signed artist and the stage they were at when signed. Use this format:

"[ARTIST] at [current listeners] today is tracking similarly to [COMPARABLE ARTIST]
at the same stage in [YEAR] — [specific similarity in growth pattern, sound, or
market position]. [COMPARABLE ARTIST] went on to [outcome]. The key difference
with [ARTIST] is [one meaningful distinction]."

This context helps executives understand the risk-adjusted opportunity in terms
they already understand.

═══════════════════════════════════════
COMMUNICATION STYLE
═══════════════════════════════════════

Think out loud as you work. Narrate each phase as you execute it:
"Starting Phase 1 discovery — casting wide net for [genre] artists in [region]..."
"Phase 2 validation — cross-checking [artist name] signals across sources..."
"Red flag detected on [artist] — Spotify streams high but zero Reddit presence..."

This transparency builds trust. Executives want to see how you think, not just what you conclude.

Be direct. Be opinionated. Back every opinion with data.
Never say "it seems like" or "it might be" — say "the data shows" or "this signals."
Never inflate a score to seem encouraging. A honest 58 is more valuable than a false 85.

When you finish all phases, summarize with:
"Sonar has completed its analysis. Here are your top [N] candidates ranked by score,
followed by full briefings and outreach drafts for each."

═══════════════════════════════════════
MEMORY AND CONTINUITY
═══════════════════════════════════════

You have access to conversation history via Redis. Use it actively:
- If an artist was researched in a previous query this session, reference that research
- If a user has expressed preferences (genre, region, listener ceiling), remember them
- If a user passed on an artist, do not surface them again
- Build a picture of what this particular scout is looking for across the session

You are not starting fresh with every query. You are building an intelligence picture.
`

// ─── Tool Execution ───────────────────────────────────────────────────────────

async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  try {
    if (name === 'search_past_artists') {
      const result = await searchArtistMemory(input.query as string)
      return { content: result, isError: false }
    }

    if (name === 'web_search') {
      const result = await searchWeb(input.query as string, {
        topic: (input.topic as 'general' | 'news') ?? 'general',
        depth: (input.depth as 'basic' | 'advanced') ?? 'basic',
      })
      return { content: result, isError: false }
    }

    if (name === 'spotify_search_artist') {
      const result = await searchArtist(input.query as string)
      return { content: result, isError: false }
    }

    if (name === 'spotify_get_artist') {
      const result = await getArtist(input.artistId as string)
      return { content: result, isError: false }
    }

    if (name === 'find_similar_artists') {
      const filters: SimilarityFilters = {
        maxListeners: input.maxListeners as number | undefined,
        minListeners: input.minListeners as number | undefined,
        minBuzzScore: input.minBuzzScore as number | undefined,
        genre: input.genre as string | undefined,
        location: input.location as string | undefined,
      }
      const result = await findSimilarArtists(input.query as string, filters)
      return { content: result, isError: false }
    }

    if (name === 'reddit_search_artist') {
      const result = await searchRedditArtist(input.artistName as string)
      return { content: result, isError: false }
    }

    if (name === 'reddit_subreddit_pulse') {
      const result = await getSubredditPulse(
        input.subreddit as string,
        (input.timeframe as 'week' | 'month' | 'year') ?? 'month',
      )
      return { content: result, isError: false }
    }

    if (name === 'instagram_search') {
      const result = await searchInstagram(input.artistName as string)
      return { content: result, isError: false }
    }

    if (name === 'youtube_search_channel') {
      const result = await searchYouTubeChannel(input.artistName as string)
      return { content: result, isError: false }
    }

    if (name === 'youtube_get_channel_videos') {
      const result = await getYouTubeChannelVideos(
        input.channelId as string,
        (input.maxResults as number | undefined) ?? 10,
      )
      return { content: result, isError: false }
    }

    if (name === 'create_artist_card') {
      // Echo back success — the frontend picks up the card from the tool_call event
      // Also fire-and-forget into long-term memory for future semantic search
      const card = input as unknown as ArtistCard
      storeArtistMemory(card)
      storeArtistVector(card).catch(() => {})
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

  // Register the session immediately so it appears in the sidebar before the run completes
  await touchSession(sessionId, query)

  const history = await getHistory(sessionId)
  const messages: MessageParam[] = [
    ...history,
    { role: 'user', content: query },
  ]

  const tools: Tool[] = [
    SEARCH_MEMORY_TOOL,
    WEB_SEARCH_TOOL,
    SPOTIFY_SEARCH_TOOL,
    SPOTIFY_GET_ARTIST_TOOL,
    YOUTUBE_SEARCH_CHANNEL_TOOL,
    YOUTUBE_GET_VIDEOS_TOOL,
    FIND_SIMILAR_ARTISTS_TOOL,
    REDDIT_SEARCH_ARTIST_TOOL,
    REDDIT_SUBREDDIT_PULSE_TOOL,
    INSTAGRAM_SEARCH_TOOL,
    CREATE_ARTIST_CARD_TOOL,
    ...getMCPTools(),
  ]

  try {
    while (true) {
      const stream = client.messages.stream({
        model: 'claude-sonnet-4-6',
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

      // Execute all tool calls in parallel — biggest real speed gain
      const toolBlocks = finalMsg.content.filter((b) => b.type === 'tool_use')

      const settled = await Promise.all(
        toolBlocks.map((block) =>
          executeTool(block.name, block.input as Record<string, unknown>).then((result) => ({
            block,
            result,
          })),
        ),
      )

      const toolResults: ToolResultBlockParam[] = []

      for (const { block, result } of settled) {
        yield {
          type: 'tool_result',
          id: block.id,
          name: block.name,
          content: result.content,
          isError: result.isError,
        }

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
    // Best-effort save so the session still appears in history
    if (messages.length > 1) {
      await saveHistory(sessionId, messages).catch(() => {})
    }
    yield {
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  yield { type: 'done' }
}
