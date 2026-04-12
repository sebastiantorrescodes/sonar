// Reddit public JSON API — no credentials required
// Reddit serves .json versions of any page; just set a valid User-Agent

const USER_AGENT = 'Sonar/1.0 (A&R intelligence agent; research only)'
const BASE = 'https://www.reddit.com'

// Music subreddits ordered by relevance for A&R discovery
const MUSIC_SUBREDDITS = [
  'hiphopheads',
  'listentothis',
  'indieheads',
  'rnb',
  'trap',
  'popheads',
  'electronicmusic',
  'DnB',
  'afrobeats',
  'latinmusic',
]

interface RedditPost {
  title: string
  subreddit: string
  score: number
  numComments: number
  url: string
  permalink: string
  createdAt: string
  text: string | null
}

async function redditGet(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  })
  if (!res.ok) throw new Error(`Reddit API error ${res.status}: ${url}`)
  return res.json()
}

function parsePosts(data: unknown): RedditPost[] {
  const listing = data as { data: { children: Array<{ data: Record<string, unknown> }> } }
  return (listing?.data?.children ?? []).map(({ data: p }) => ({
    title: p.title as string,
    subreddit: p.subreddit as string,
    score: p.score as number,
    numComments: p.num_comments as number,
    url: p.url as string,
    permalink: `https://www.reddit.com${p.permalink as string}`,
    createdAt: new Date((p.created_utc as number) * 1000).toISOString().split('T')[0],
    text: p.selftext ? (p.selftext as string).slice(0, 300) : null,
  }))
}

// ─── Search Reddit globally for an artist ────────────────────────────────────

export async function searchRedditArtist(artistName: string): Promise<string> {
  // Run a global search + targeted music subreddit searches in parallel
  const subredditQueries = MUSIC_SUBREDDITS.slice(0, 5).map((sub) =>
    redditGet(
      `${BASE}/r/${sub}/search.json?q=${encodeURIComponent(artistName)}&sort=top&t=year&limit=5&restrict_sr=1`,
    ).catch(() => null),
  )

  const [globalData, ...subData] = await Promise.all([
    redditGet(
      `${BASE}/search.json?q=${encodeURIComponent(`"${artistName}"`)}&sort=relevance&t=year&limit=10&type=link`,
    ).catch(() => null),
    ...subredditQueries,
  ])

  const globalPosts = globalData ? parsePosts(globalData) : []
  const subPosts = subData
    .filter(Boolean)
    .flatMap((d) => parsePosts(d))

  // Deduplicate by permalink, then sort by score
  const seen = new Set<string>()
  const allPosts = [...globalPosts, ...subPosts]
    .filter((p) => {
      if (seen.has(p.permalink)) return false
      seen.add(p.permalink)
      return true
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 15)

  if (!allPosts.length) {
    return `No Reddit posts found for "${artistName}".`
  }

  // Summarise engagement signals
  const totalScore = allPosts.reduce((s, p) => s + p.score, 0)
  const totalComments = allPosts.reduce((s, p) => s + p.numComments, 0)
  const subreddits = [...new Set(allPosts.map((p) => p.subreddit))]

  const summary = [
    `Posts found: ${allPosts.length}`,
    `Total upvotes: ${totalScore.toLocaleString()}`,
    `Total comments: ${totalComments.toLocaleString()}`,
    `Subreddits: ${subreddits.join(', ')}`,
  ].join(' | ')

  const postList = allPosts
    .map(
      (p) =>
        `[${p.createdAt}] r/${p.subreddit} — "${p.title}" | ↑${p.score} | 💬${p.numComments}\n${p.permalink}${p.text ? `\n${p.text}` : ''}`,
    )
    .join('\n\n')

  return `${summary}\n\n${postList}`
}

// ─── Get top posts from a specific music subreddit ───────────────────────────

export async function getSubredditPulse(subreddit: string, timeframe: 'week' | 'month' | 'year' = 'month'): Promise<string> {
  const data = await redditGet(
    `${BASE}/r/${subreddit}/top.json?t=${timeframe}&limit=25`,
  )

  const posts = parsePosts(data)
  if (!posts.length) return `No posts found in r/${subreddit}.`

  const postList = posts
    .map(
      (p) =>
        `[${p.createdAt}] "${p.title}" | ↑${p.score} | 💬${p.numComments}\n${p.permalink}`,
    )
    .join('\n\n')

  return `Top ${posts.length} posts in r/${subreddit} (${timeframe}):\n\n${postList}`
}
