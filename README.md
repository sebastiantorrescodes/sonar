# Sonar — A&R Intelligence

Sonar is an AI-powered talent scouting tool for the music industry. It acts as an autonomous A&R (Artists & Repertoire) agent that researches emerging artists across multiple platforms, scores their momentum, and produces decision-ready briefings for label executives and talent scouts.

## What It Does

You give Sonar a natural language query — *"Find emerging indie artists in London with under 50k monthly listeners"* — and it runs a multi-phase research pipeline:

1. **Discovery** — Casts a wide net across music blogs, Reddit communities, SoundCloud, and TikTok to build a pool of 8–12 candidates
2. **Validation** — Cross-checks signals across at least 3 independent sources per artist and cuts down to the top 5
3. **Deep Research** — For finalists, pulls full data in parallel: Spotify streams, YouTube engagement, Reddit sentiment, Instagram reach, press coverage trajectory, and Shazam chart movement
4. **Competitive Scan** — Checks for existing management, label interest, or industry signals that affect the signing window
5. **Scoring** — Computes a Sonar Score (0–100) using a weighted formula: stream growth rate, playlist adds, organic social buzz, TikTok velocity, press trajectory, release consistency, and absolute listener size
6. **Briefings** — Produces a structured A&R brief per artist including comparable signed artists, risk flags, and a direct signing recommendation
7. **Outreach Drafts** — Writes a personalized cold outreach email for each top candidate

Artist cards stream to the UI in real time as the agent completes its research.

## Architecture

```
sonar-web/         Next.js 15 app
├── app/
│   ├── page.tsx           Chat UI + streaming artist card display
│   └── api/
│       ├── agent/         SSE streaming endpoint that runs the agent loop
│       └── sessions/      Session list + history retrieval
└── lib/
    ├── agent.ts           Core agent loop (Claude claude-sonnet-4-6 + tool use + streaming)
    ├── spotify.ts         Spotify Web API — artist search, listener counts, releases
    ├── youtube.ts         YouTube Data API — channel stats, per-video engagement
    ├── reddit.ts          Reddit API — organic mentions, subreddit pulse
    ├── tavily.ts          Tavily Search API — web search + Instagram scraping
    ├── redis.ts           Session history (Redis)
    ├── memory.ts          Long-term artist memory across sessions (Redis)
    ├── vectorstore.ts     Semantic similarity search (Redis Stack + Voyage AI embeddings)
    └── mcp.ts             MCP server integrations (Spotify MCP, etc.)
```

The agent runs on **Claude claude-sonnet-4-6** with prompt caching enabled — the large system prompt and tool definitions are cached after the first turn, keeping multi-turn research sessions fast and cheap.

Long-term memory has two layers:
- **Qualitative** — artist summaries and sound descriptions embedded with Voyage AI (`voyage-3`) and stored as 1024-dim vectors in Redis Stack for semantic similarity search
- **Quantitative** — listener counts, buzz scores, and metadata stored as filterable Redis hash fields alongside the vector

## Key Features

- **Streaming UI** — The agent feed shows every tool call in real time; artist cards appear as research completes
- **Session history** — Past sessions are stored in Redis and browsable from the sidebar
- **Cross-session memory** — Previously researched artists are recalled before hitting the web, so the same artist is never re-researched from scratch
- **Semantic similarity** — "Find artists similar to Mk.gee at early stage" queries the vector store before touching any external API
- **MCP extensible** — Additional data sources can be wired in via MCP server config without touching the agent core
- **Parallel tool calls** — All platform lookups for a given candidate fire simultaneously; Claude is instructed to batch tool calls aggressively

## Setup

### Prerequisites

- Node.js 20+
- Redis Stack (for session history + vector search)
- API keys: Anthropic, Spotify, YouTube Data API v3, Tavily, Voyage AI

### Environment Variables

Create `sonar-web/.env.local`:

```env
ANTHROPIC_API_KEY=
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
YOUTUBE_API_KEY=
TAVILY_API_KEY=
VOYAGE_API_KEY=
REDIS_URL=redis://localhost:6379
```

### Run

```bash
cd sonar-web
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Seed Vector Index (optional)

To initialize the Redis vector index schema before the first artist is stored:

```bash
cd sonar-web
npx tsx scripts/seed-vectors.ts
```

## Usage

Type a scouting query in the search bar and hit **Scan**. Examples:

- *"Find breaking drill artists in Chicago with under 30k monthly listeners"*
- *"Who sounds like yeule but hasn't been signed yet?"*
- *"Show me artists generating buzz on r/indieheads this month"*
- *"Find me artists similar to the ones I researched last session"*

The left panel shows the agent's live tool feed. The right panel fills with artist cards as research completes. Each card has a **Full Brief** button (full A&R writeup) and a **Draft Outreach** button (ready-to-send email).
