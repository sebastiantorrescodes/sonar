// Two-layer artist store backed by Redis Stack (RediSearch + vectors)
//
// Layer 1 — Qualitative (embedded):
//   genre tags, summary, sound description, comparable artists
//   → Voyage AI voyage-3 → 1024-dim FLOAT32 vector → HNSW index
//
// Layer 2 — Quantitative (plain metadata, never embedded):
//   monthlyListeners, buzzScore, followers, location, spotifyUrl
//   → stored as HASH fields alongside the vector
//   → filtered in RediSearch using numeric/tag pre-filters
//
// Search flow:
//   1. Embed the query text (qualitative similarity)
//   2. KNN over the vector field (optionally pre-filtered by metadata)
//   3. Return top matches with all metadata fields + cosine similarity score

import type { ArtistCard } from './agent'
import { getClient } from './redis'

const VOYAGE_BASE = 'https://api.voyageai.com/v1'
const INDEX_NAME = 'sonar:artists:idx'
const KEY_PREFIX = 'sonar:artist:'
const VECTOR_DIM = 1024 // voyage-3 output dimensions

// ─── Voyage AI embedding ──────────────────────────────────────────────────────

async function embed(text: string): Promise<Buffer> {
  const apiKey = process.env.VOYAGE_API_KEY
  if (!apiKey) throw new Error('VOYAGE_API_KEY is not set')

  const res = await fetch(`${VOYAGE_BASE}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: 'voyage-3', input: [text] }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Voyage embed failed: ${res.status} ${err}`)
  }

  const data = await res.json()
  const floats: number[] = data.data[0].embedding
  // Redis expects the vector as a raw FLOAT32 binary buffer
  return Buffer.from(new Float32Array(floats).buffer)
}

// ─── Qualitative text builder ─────────────────────────────────────────────────
// Only the parts that describe sound, style, and identity go here.
// Numbers never touch the embedding model.

function buildQualitativeText(card: ArtistCard): string {
  const lines = [
    `Artist: ${card.name}`,
    `Genre: ${card.genre.join(', ')}`,
    card.location ? `Location: ${card.location}` : null,
    `Summary: ${card.summary}`,
    `Full Brief: ${card.fullBrief}`,
  ]
  return lines.filter(Boolean).join('\n')
}

// ─── Index bootstrap ──────────────────────────────────────────────────────────

export async function ensureArtistIndex(): Promise<void> {
  const redis = getClient()

  try {
    await redis.call('FT.INFO', INDEX_NAME)
    return // index already exists
  } catch {
    // doesn't exist yet — create it
  }

  await redis.call(
    'FT.CREATE', INDEX_NAME,
    'ON', 'HASH',
    'PREFIX', '1', KEY_PREFIX,
    'SCHEMA',
    // ── Searchable metadata fields ─────────────────────────────────────────
    'name',             'TEXT',
    'genre',            'TAG',  'SEPARATOR', ',',
    'location',         'TAG',
    'monthlyListeners', 'NUMERIC', 'SORTABLE',
    'followers',        'NUMERIC', 'SORTABLE',
    'buzzScore',        'NUMERIC', 'SORTABLE',
    // ── Non-indexed payload fields ─────────────────────────────────────────
    'spotifyUrl',       'TEXT', 'NOINDEX',
    'imageUrl',         'TEXT', 'NOINDEX',
    'qualitativeText',  'TEXT', 'NOINDEX',
    // ── Vector field (HNSW — approximate KNN, fast at scale) ──────────────
    'vector', 'VECTOR', 'HNSW', '6',
      'TYPE',            'FLOAT32',
      'DIM',             String(VECTOR_DIM),
      'DISTANCE_METRIC', 'COSINE',
  )
}

// ─── Store artist ─────────────────────────────────────────────────────────────

export async function storeArtistVector(card: ArtistCard): Promise<void> {
  await ensureArtistIndex()

  const qualitativeText = buildQualitativeText(card)
  const vectorBuffer = await embed(qualitativeText)

  const redis = getClient()
  const key = `${KEY_PREFIX}${card.id}`

  // hset with a Buffer value requires the field/value interleaved array form
  await redis.hset(key, [
    'name',             card.name,
    'genre',            card.genre.join(','),
    'location',         card.location ?? '',
    'monthlyListeners', String(card.monthlyListeners ?? 0),
    'followers',        String(0), // add when available
    'buzzScore',        String(card.buzzScore ?? 0),
    'spotifyUrl',       card.spotifyUrl ?? '',
    'imageUrl',         card.imageUrl ?? '',
    'qualitativeText',  qualitativeText,
    'vector',           vectorBuffer,
  ])
}

// ─── Search ───────────────────────────────────────────────────────────────────

export interface SimilarityFilters {
  maxListeners?: number
  minListeners?: number
  minBuzzScore?: number
  maxBuzzScore?: number
  genre?: string       // tag filter, e.g. "indie pop" or "drill"
  location?: string    // tag filter, e.g. "London"
}

export async function findSimilarArtists(
  query: string,
  filters?: SimilarityFilters,
  topK = 10,
): Promise<string> {
  await ensureArtistIndex()

  const vectorBuffer = await embed(query)

  // ── Build pre-filter expression ────────────────────────────────────────────
  const filterParts: string[] = []

  if (filters?.minListeners != null || filters?.maxListeners != null) {
    const min = filters.minListeners ?? 0
    const max = filters.maxListeners ?? '+inf'
    filterParts.push(`@monthlyListeners:[${min} ${max}]`)
  }
  if (filters?.minBuzzScore != null) {
    const max = filters.maxBuzzScore ?? '+inf'
    filterParts.push(`@buzzScore:[${filters.minBuzzScore} ${max}]`)
  }
  if (filters?.genre) {
    // Escape special chars for TAG query
    const tag = filters.genre.replace(/[^a-zA-Z0-9 ]/g, '').trim()
    filterParts.push(`@genre:{${tag}}`)
  }
  if (filters?.location) {
    const tag = filters.location.replace(/[^a-zA-Z0-9 ]/g, '').trim()
    filterParts.push(`@location:{${tag}}`)
  }

  const preFilter = filterParts.length ? `(${filterParts.join(' ')})` : '*'
  const knnQuery = `${preFilter}=>[KNN ${topK} @vector $vec AS similarity]`

  const redis = getClient()

  let raw: unknown[]
  try {
    raw = (await redis.call(
      'FT.SEARCH', INDEX_NAME,
      knnQuery,
      'PARAMS', '2', 'vec', vectorBuffer,
      'RETURN', '7',
        'name', 'genre', 'location',
        'monthlyListeners', 'buzzScore', 'spotifyUrl', 'similarity',
      'SORTBY', 'similarity',
      'LIMIT', '0', String(topK),
      'DIALECT', '2',
    )) as unknown[]
  } catch (err) {
    return `Vector search error: ${err instanceof Error ? err.message : String(err)}`
  }

  // FT.SEARCH returns: [total, key1, [field, val, ...], key2, ...]
  const total = raw[0] as number
  if (total === 0) return 'No similar artists found in memory.'

  const artists: Array<Record<string, string>> = []
  for (let i = 1; i < raw.length; i += 2) {
    const fields = raw[i + 1] as string[]
    const obj: Record<string, string> = {}
    for (let j = 0; j < fields.length; j += 2) {
      obj[fields[j]] = fields[j + 1]
    }
    artists.push(obj)
  }

  return artists
    .map((a, idx) => {
      // similarity is cosine distance (lower = closer); convert to %
      const simPct = ((1 - parseFloat(a.similarity ?? '1')) * 100).toFixed(0)
      const listeners = parseInt(a.monthlyListeners ?? '0').toLocaleString()
      const buzz = a.buzzScore ?? 'N/A'
      return [
        `[#${idx + 1} — ${simPct}% match] ${a.name}`,
        `Genre: ${a.genre ?? 'unknown'} | Location: ${a.location || 'unknown'}`,
        `Monthly listeners: ${listeners} | Buzz score: ${buzz}`,
        a.spotifyUrl ? `Spotify: ${a.spotifyUrl}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n\n---\n\n')
}
