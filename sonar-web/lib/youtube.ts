// YouTube Data API v3 wrapper
// Docs: https://developers.google.com/youtube/v3/docs

const API_KEY = process.env.YOUTUBE_API_KEY
const BASE = 'https://www.googleapis.com/youtube/v3'

function assertKey() {
  if (!API_KEY) throw new Error('YOUTUBE_API_KEY is not set')
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface YTChannel {
  channelId: string
  title: string
  description: string
  subscriberCount: number | null
  viewCount: number | null
  videoCount: number | null
  publishedAt: string
  thumbnailUrl: string | null
  channelUrl: string
}

interface YTVideo {
  videoId: string
  title: string
  publishedAt: string
  viewCount: number | null
  likeCount: number | null
  commentCount: number | null
  duration: string | null
  videoUrl: string
}

// ─── Search for an artist's YouTube channel ───────────────────────────────────

export async function searchYouTubeChannel(artistName: string): Promise<string> {
  assertKey()

  // Search for channels matching the artist name
  const searchRes = await fetch(
    `${BASE}/search?part=snippet&type=channel&q=${encodeURIComponent(artistName)}&maxResults=3&key=${API_KEY}`,
  )
  if (!searchRes.ok) {
    const err = await searchRes.json().catch(() => ({}))
    throw new Error(`YouTube search failed: ${searchRes.status} — ${JSON.stringify(err)}`)
  }

  const searchData = await searchRes.json()
  const channelIds: string[] = (searchData.items ?? []).map(
    (item: { id: { channelId: string } }) => item.id.channelId,
  )

  if (!channelIds.length) return JSON.stringify({ channels: [], message: 'No channels found.' })

  // Fetch full stats for each channel
  const statsRes = await fetch(
    `${BASE}/channels?part=snippet,statistics&id=${channelIds.join(',')}&key=${API_KEY}`,
  )
  if (!statsRes.ok) throw new Error(`YouTube channels fetch failed: ${statsRes.status}`)

  const statsData = await statsRes.json()
  const channels: YTChannel[] = (statsData.items ?? []).map(
    (item: {
      id: string
      snippet: { title: string; description: string; publishedAt: string; thumbnails?: { default?: { url: string } } }
      statistics: { subscriberCount?: string; viewCount?: string; videoCount?: string; hiddenSubscriberCount?: boolean }
    }) => ({
      channelId: item.id,
      title: item.snippet.title,
      description: item.snippet.description.slice(0, 300),
      subscriberCount: item.statistics.hiddenSubscriberCount
        ? null
        : item.statistics.subscriberCount != null
          ? parseInt(item.statistics.subscriberCount)
          : null,
      viewCount: item.statistics.viewCount != null ? parseInt(item.statistics.viewCount) : null,
      videoCount: item.statistics.videoCount != null ? parseInt(item.statistics.videoCount) : null,
      publishedAt: item.snippet.publishedAt,
      thumbnailUrl: item.snippet.thumbnails?.default?.url ?? null,
      channelUrl: `https://www.youtube.com/channel/${item.id}`,
    }),
  )

  return JSON.stringify({ channels }, null, 2)
}

// ─── Get recent videos + stats for a channel ─────────────────────────────────

export async function getYouTubeChannelVideos(channelId: string, maxResults = 10): Promise<string> {
  assertKey()

  // Get the upload playlist for this channel
  const channelRes = await fetch(
    `${BASE}/channels?part=contentDetails,statistics&id=${channelId}&key=${API_KEY}`,
  )
  if (!channelRes.ok) throw new Error(`YouTube channel fetch failed: ${channelRes.status}`)

  const channelData = await channelRes.json()
  const channel = channelData.items?.[0]
  if (!channel) return JSON.stringify({ videos: [], message: 'Channel not found.' })

  const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads
  if (!uploadsPlaylistId) return JSON.stringify({ videos: [], message: 'No uploads playlist found.' })

  // Get recent uploads from the playlist
  const playlistRes = await fetch(
    `${BASE}/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=${maxResults}&key=${API_KEY}`,
  )
  if (!playlistRes.ok) throw new Error(`YouTube playlist fetch failed: ${playlistRes.status}`)

  const playlistData = await playlistRes.json()
  const videoIds: string[] = (playlistData.items ?? []).map(
    (item: { snippet: { resourceId: { videoId: string } } }) => item.snippet.resourceId.videoId,
  )

  if (!videoIds.length) return JSON.stringify({ videos: [] })

  // Fetch full stats for each video
  const videosRes = await fetch(
    `${BASE}/videos?part=snippet,statistics,contentDetails&id=${videoIds.join(',')}&key=${API_KEY}`,
  )
  if (!videosRes.ok) throw new Error(`YouTube videos fetch failed: ${videosRes.status}`)

  const videosData = await videosRes.json()
  const videos: YTVideo[] = (videosData.items ?? []).map(
    (item: {
      id: string
      snippet: { title: string; publishedAt: string }
      statistics: { viewCount?: string; likeCount?: string; commentCount?: string }
      contentDetails: { duration?: string }
    }) => ({
      videoId: item.id,
      title: item.snippet.title,
      publishedAt: item.snippet.publishedAt,
      viewCount: item.statistics.viewCount != null ? parseInt(item.statistics.viewCount) : null,
      likeCount: item.statistics.likeCount != null ? parseInt(item.statistics.likeCount) : null,
      commentCount: item.statistics.commentCount != null ? parseInt(item.statistics.commentCount) : null,
      duration: item.contentDetails.duration ?? null,
      videoUrl: `https://www.youtube.com/watch?v=${item.id}`,
    }),
  )

  return JSON.stringify({ videos }, null, 2)
}
