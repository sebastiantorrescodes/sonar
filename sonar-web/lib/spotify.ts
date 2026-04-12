// Spotify Web API — Client Credentials flow (no user login required)
// Gives access to all public artist data
import { tavily } from '@tavily/core'

interface TokenCache {
  token: string
  expiresAt: number
}

declare global {
  // eslint-disable-next-line no-var
  var _spotifyToken: TokenCache | undefined
}

async function getToken(): Promise<string> {
  const now = Date.now()
  if (global._spotifyToken && global._spotifyToken.expiresAt > now + 30_000) {
    return global._spotifyToken.token
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set')
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Spotify auth failed: ${res.status} ${text}`)
  }

  const data = await res.json()
  global._spotifyToken = {
    token: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  }
  return global._spotifyToken.token
}

async function spotifyGet(path: string): Promise<unknown> {
  const token = await getToken()
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Spotify API error ${res.status}: ${text}`)
  }
  return res.json()
}

// ─── Tool: Search Artist ──────────────────────────────────────────────────────

export interface SpotifyArtist {
  id: string
  name: string
  genres: string[]
  popularity: number // 0–100, based on recent stream velocity
  followers: number
  spotifyUrl: string
  imageUrl?: string
}

export async function searchArtist(query: string, limit = 5): Promise<string> {
  const encoded = encodeURIComponent(query)
  const data = (await spotifyGet(
    `/search?q=${encoded}&type=artist&limit=${limit}&market=US`,
  )) as { artists: { items: SpotifyArtistRaw[] } }

  const items = data.artists?.items ?? []
  if (items.length === 0) return `No Spotify artists found for "${query}".`

  const artists: SpotifyArtist[] = items.map((a) => ({
    id: a.id,
    name: a.name,
    genres: a.genres ?? [],
    popularity: a.popularity ?? 0,
    followers: a.followers?.total ?? 0,
    spotifyUrl: a.external_urls?.spotify ?? '',
    imageUrl: a.images?.[0]?.url,
  }))

  return JSON.stringify(artists, null, 2)
}

// ─── Monthly listeners via Tavily (not in Spotify API) ───────────────────────

async function scrapeMonthlyListeners(artistName: string, artistId: string): Promise<number | null> {
  const apiKey = process.env.TAVILY_API_KEY
  if (!apiKey) return null

  const client = tavily({ apiKey })

  try {
    const res = await client.search(
      `"${artistName}" monthly listeners site:open.spotify.com`,
      { searchDepth: 'basic', maxResults: 3, includeAnswer: true },
    )

    const text = [res.answer ?? '', ...res.results.map((r) => r.content)].join(' ')

    // Match patterns like "12,345,678 monthly listeners" or "12.3M monthly listeners"
    const millionMatch = text.match(/([\d.]+)\s*[Mm]\s*monthly listeners/)
    if (millionMatch) return Math.round(parseFloat(millionMatch[1]) * 1_000_000)

    const exactMatch = text.match(/([\d,]+)\s*monthly listeners/)
    if (exactMatch) return parseInt(exactMatch[1].replace(/,/g, ''))
  } catch {
    // non-fatal — fall through and return null
  }

  // Fallback: search by Spotify profile URL directly
  try {
    const res = await client.search(
      `open.spotify.com/artist/${artistId} monthly listeners`,
      { searchDepth: 'basic', maxResults: 2, includeAnswer: true },
    )

    const text = [res.answer ?? '', ...res.results.map((r) => r.content)].join(' ')

    const millionMatch = text.match(/([\d.]+)\s*[Mm]\s*monthly listeners/)
    if (millionMatch) return Math.round(parseFloat(millionMatch[1]) * 1_000_000)

    const exactMatch = text.match(/([\d,]+)\s*monthly listeners/)
    if (exactMatch) return parseInt(exactMatch[1].replace(/,/g, ''))
  } catch {
    // non-fatal
  }

  return null
}

// ─── Tool: Get Artist Detail ──────────────────────────────────────────────────

export async function getArtist(artistId: string): Promise<string> {
  // Fetch profile and albums in parallel, then scrape monthly listeners with the artist name
  const [a, albumsData] = await Promise.all([
    spotifyGet(`/artists/${artistId}`) as Promise<SpotifyArtistRaw>,
    spotifyGet(`/artists/${artistId}/albums?include_groups=album,single&market=US&limit=10`) as Promise<{ items: SpotifyAlbumRaw[] }>,
  ])

  const monthlyListeners = await scrapeMonthlyListeners(a.name, artistId)

  const result = {
    id: a.id,
    name: a.name,
    genres: a.genres ?? [],
    popularity: a.popularity ?? 0,
    followers: a.followers?.total ?? 0,
    monthlyListeners,
    spotifyUrl: a.external_urls?.spotify ?? '',
    imageUrl: a.images?.[0]?.url,
    recentReleases: (albumsData.items ?? []).slice(0, 10).map((al) => ({
      name: al.name,
      type: al.album_type,
      releaseDate: al.release_date,
      totalTracks: al.total_tracks,
      spotifyUrl: al.external_urls?.spotify,
    })),
  }

  return JSON.stringify(result, null, 2)
}

// ─── Raw API types ────────────────────────────────────────────────────────────

interface SpotifyArtistRaw {
  id: string
  name: string
  genres?: string[]
  popularity?: number
  followers?: { total: number }
  external_urls?: { spotify: string }
  images?: { url: string }[]
}

interface SpotifyAlbumRaw {
  name: string
  album_type: string
  release_date: string
  total_tracks: number
  external_urls?: { spotify: string }
}
