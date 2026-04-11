'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import type { StreamEvent, ArtistCard } from '@/lib/agent'

// ─── Session ID ───────────────────────────────────────────────────────────────

function getOrCreateSessionId(): string {
  if (typeof window === 'undefined') return 'ssr'
  const key = 'sonar_session_id'
  let id = localStorage.getItem(key)
  if (!id) {
    id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    localStorage.setItem(key, id)
  }
  return id
}

// ─── Feed Event Types ─────────────────────────────────────────────────────────

type FeedItem =
  | { kind: 'text'; id: string; content: string }
  | { kind: 'tool_call'; id: string; name: string; input: Record<string, unknown>; done: boolean }
  | { kind: 'tool_result'; id: string; toolName: string; content: string; isError: boolean }
  | { kind: 'error'; id: string; message: string }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

function toolLabel(name: string): string {
  if (name === 'web_search') return 'web_search'
  if (name === 'create_artist_card') return 'create_artist_card'
  if (name.includes('__')) {
    const [server, tool] = name.split('__')
    return `${server}:${tool}`
  }
  return name
}

function toolColor(name: string): string {
  if (name === 'web_search') return 'text-cyan-400'
  if (name === 'create_artist_card') return 'text-emerald-400'
  if (name.startsWith('spotify')) return 'text-green-400'
  if (name.startsWith('reddit')) return 'text-orange-400'
  if (name.startsWith('slack')) return 'text-purple-400'
  return 'text-zinc-400'
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function FeedRow({ item }: { item: FeedItem }) {
  if (item.kind === 'text') {
    return (
      <div className="text-zinc-300 text-sm leading-relaxed whitespace-pre-wrap">
        {item.content}
      </div>
    )
  }

  if (item.kind === 'tool_call') {
    const color = toolColor(item.name)
    const label = toolLabel(item.name)
    const preview = item.name === 'web_search'
      ? (item.input.query as string)
      : item.name === 'create_artist_card'
        ? (item.input.name as string)
        : JSON.stringify(item.input).slice(0, 60)

    return (
      <div className="flex items-start gap-2 font-mono text-xs">
        <span className={`shrink-0 mt-0.5 ${color}`}>▶</span>
        <div className="min-w-0">
          <span className={color}>{label}</span>
          {preview && (
            <span className="text-zinc-500 ml-2 truncate block">
              {preview}
            </span>
          )}
        </div>
        {!item.done && (
          <span className="ml-auto shrink-0 text-zinc-600 animate-pulse">···</span>
        )}
      </div>
    )
  }

  if (item.kind === 'tool_result') {
    const color = item.isError ? 'text-red-500' : 'text-zinc-600'
    const icon = item.isError ? '✗' : '✓'
    return (
      <div className={`font-mono text-xs ${color} flex items-center gap-2`}>
        <span>{icon}</span>
        <span className="truncate">
          {item.isError ? item.content.slice(0, 80) : `${toolLabel(item.toolName)} done`}
        </span>
      </div>
    )
  }

  if (item.kind === 'error') {
    return (
      <div className="text-red-400 text-xs font-mono border border-red-900 bg-red-950/30 rounded px-2 py-1">
        Error: {item.message}
      </div>
    )
  }

  return null
}

function BuzzBar({ score }: { score: number }) {
  const pct = Math.min(100, Math.max(0, score))
  const color =
    pct >= 75 ? 'bg-emerald-500' : pct >= 50 ? 'bg-yellow-500' : 'bg-zinc-500'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs font-mono text-zinc-400 w-6 text-right">{pct}</span>
    </div>
  )
}

function ArtistCardComp({
  card,
  onBrief,
  onOutreach,
}: {
  card: ArtistCard
  onBrief: (card: ArtistCard) => void
  onOutreach: (card: ArtistCard) => void
}) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col gap-3 hover:border-zinc-700 transition-colors">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold text-white text-base truncate">{card.name}</h3>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            {card.genre.slice(0, 3).map((g) => (
              <span
                key={g}
                className="text-xs bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded-full"
              >
                {g}
              </span>
            ))}
          </div>
        </div>
        {card.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={card.imageUrl}
            alt={card.name}
            className="w-12 h-12 rounded-lg object-cover shrink-0 bg-zinc-800"
            onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
          />
        )}
      </div>

      {/* Location */}
      {card.location && (
        <p className="text-xs text-zinc-500">{card.location}</p>
      )}

      {/* Buzz score */}
      {card.buzzScore != null && (
        <div>
          <p className="text-xs text-zinc-500 mb-1">Buzz Score</p>
          <BuzzBar score={card.buzzScore} />
        </div>
      )}

      {/* Stats row */}
      {(card.monthlyListeners != null || (card.socialFollowing?.length ?? 0) > 0) && (
        <div className="flex gap-3 flex-wrap">
          {card.monthlyListeners != null && (
            <div className="text-center">
              <p className="text-xs text-zinc-500">Monthly Listeners</p>
              <p className="text-sm font-mono text-white">{formatNumber(card.monthlyListeners)}</p>
            </div>
          )}
          {card.socialFollowing?.map((s) => (
            <div key={s.platform} className="text-center">
              <p className="text-xs text-zinc-500 capitalize">{s.platform}</p>
              <p className="text-sm font-mono text-white">{formatNumber(s.count)}</p>
            </div>
          ))}
        </div>
      )}

      {/* Summary */}
      <p className="text-sm text-zinc-400 leading-relaxed line-clamp-3">{card.summary}</p>

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <button
          onClick={() => onBrief(card)}
          className="flex-1 text-xs py-1.5 rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors"
        >
          Full Brief
        </button>
        <button
          onClick={() => onOutreach(card)}
          className="flex-1 text-xs py-1.5 rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors"
        >
          Draft Outreach
        </button>
        {card.spotifyUrl && (
          <a
            href={card.spotifyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 text-xs py-1.5 rounded-lg bg-[#1DB954]/10 text-[#1DB954] hover:bg-[#1DB954]/20 transition-colors"
          >
            ▶
          </a>
        )}
      </div>
    </div>
  )
}

function Modal({
  title,
  content,
  onClose,
}: {
  title: string
  content: string
  onClose: () => void
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
          <h2 className="font-semibold text-white text-lg">{title}</h2>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-white text-xl leading-none transition-colors"
          >
            ×
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-4 flex-1">
          <pre className="text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed font-sans">
            {content}
          </pre>
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Home() {
  const [query, setQuery] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [feedItems, setFeedItems] = useState<FeedItem[]>([])
  const [artistCards, setArtistCards] = useState<ArtistCard[]>([])
  const [modal, setModal] = useState<{ title: string; content: string } | null>(null)
  const feedEndRef = useRef<HTMLDivElement>(null)
  const textBufferRef = useRef<string>('')
  const textIdRef = useRef<string>('')
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [feedItems])

  const flushTextBuffer = useCallback(() => {
    if (!textBufferRef.current) return
    const content = textBufferRef.current
    const id = textIdRef.current
    textBufferRef.current = ''
    textIdRef.current = ''
    setFeedItems((prev) => {
      const existing = prev.find((i) => i.id === id)
      if (existing && existing.kind === 'text') {
        return prev.map((i) => (i.id === id ? { ...i, content } : i))
      }
      return [...prev, { kind: 'text', id, content }]
    })
  }, [])

  const handleSubmit = useCallback(
    async (e: React.SyntheticEvent<HTMLFormElement>) => {
      e.preventDefault()
      if (!query.trim() || isStreaming) return

      // Abort any existing stream
      abortRef.current?.abort()
      const abort = new AbortController()
      abortRef.current = abort

      setIsStreaming(true)
      setFeedItems([])
      setArtistCards([])
      textBufferRef.current = ''
      textIdRef.current = ''

      const sessionId = getOrCreateSessionId()

      try {
        const response = await fetch('/api/agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: query.trim(), sessionId }),
          signal: abort.signal,
        })

        if (!response.ok || !response.body) {
          throw new Error(`HTTP ${response.status}`)
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            let event: StreamEvent
            try {
              event = JSON.parse(line.slice(6))
            } catch {
              continue
            }

            if (event.type === 'text') {
              // Coalesce text chunks into a single feed item
              if (!textIdRef.current) {
                textIdRef.current = `text-${Date.now()}`
              }
              textBufferRef.current += event.content
              // Debounce: update every ~16ms naturally via the read loop
              const id = textIdRef.current
              const content = textBufferRef.current
              setFeedItems((prev) => {
                const existing = prev.find((i) => i.id === id)
                if (existing && existing.kind === 'text') {
                  return prev.map((i) => (i.id === id ? { ...i, content } : i))
                }
                return [...prev, { kind: 'text', id, content }]
              })
            } else if (event.type === 'tool_call') {
              // Seal any open text buffer as a new text item
              textBufferRef.current = ''
              textIdRef.current = ''
              setFeedItems((prev) => [
                ...prev,
                {
                  kind: 'tool_call',
                  id: event.id,
                  name: event.name,
                  input: event.input,
                  done: false,
                },
              ])
            } else if (event.type === 'tool_result') {
              // Mark the corresponding tool_call as done
              setFeedItems((prev) =>
                prev.map((i) =>
                  i.kind === 'tool_call' && i.id === event.id
                    ? { ...i, done: true }
                    : i,
                ),
              )
              setFeedItems((prev) => [
                ...prev,
                {
                  kind: 'tool_result',
                  id: `result-${event.id}`,
                  toolName: event.name,
                  content: event.content,
                  isError: event.isError,
                },
              ])
            } else if (event.type === 'artist_card') {
              setArtistCards((prev) => {
                const exists = prev.find((c) => c.id === event.data.id)
                return exists ? prev : [...prev, event.data]
              })
            } else if (event.type === 'error') {
              flushTextBuffer()
              setFeedItems((prev) => [
                ...prev,
                { kind: 'error', id: `err-${Date.now()}`, message: event.message },
              ])
            } else if (event.type === 'done') {
              flushTextBuffer()
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setFeedItems((prev) => [
            ...prev,
            {
              kind: 'error',
              id: `err-${Date.now()}`,
              message: err instanceof Error ? err.message : String(err),
            },
          ])
        }
      } finally {
        flushTextBuffer()
        setIsStreaming(false)
      }
    },
    [query, isStreaming, flushTextBuffer],
  )

  const handleNewSession = () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('sonar_session_id')
    }
    setFeedItems([])
    setArtistCards([])
    setQuery('')
  }

  return (
    <div className="flex flex-col h-screen bg-black text-white overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-zinc-900 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-xl font-bold tracking-widest text-white">SONAR</span>
          <span className="text-xs text-zinc-600 uppercase tracking-wider">A&R Intelligence</span>
        </div>
        <div className="flex items-center gap-3">
          {isStreaming && (
            <span className="flex items-center gap-1.5 text-xs text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              scanning
            </span>
          )}
          <button
            onClick={handleNewSession}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            New Session
          </button>
        </div>
      </header>

      {/* Main panels */}
      <div className="flex flex-1 min-h-0 divide-x divide-zinc-900">
        {/* Left: Agent Feed */}
        <div className="w-[42%] flex flex-col min-h-0">
          <div className="px-4 py-2 border-b border-zinc-900 shrink-0">
            <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">
              Agent Feed
            </h2>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2 font-mono">
            {feedItems.length === 0 && !isStreaming && (
              <p className="text-zinc-700 text-xs text-center mt-8">
                Run a search to see the agent work in real time.
              </p>
            )}
            {feedItems.map((item) => (
              <FeedRow key={item.id} item={item} />
            ))}
            <div ref={feedEndRef} />
          </div>
        </div>

        {/* Right: Discoveries */}
        <div className="flex-1 flex flex-col min-h-0">
          <div className="px-4 py-2 border-b border-zinc-900 shrink-0 flex items-center justify-between">
            <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">
              Discoveries
            </h2>
            {artistCards.length > 0 && (
              <span className="text-xs text-zinc-600 font-mono">
                {artistCards.length} artist{artistCards.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {artistCards.length === 0 && !isStreaming && (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
                <div className="text-5xl opacity-20">◎</div>
                <p className="text-zinc-600 text-sm max-w-xs">
                  Artist cards appear here as SONAR completes its research.
                </p>
              </div>
            )}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {artistCards.map((card) => (
                <ArtistCardComp
                  key={card.id}
                  card={card}
                  onBrief={(c) => setModal({ title: `${c.name} — Full Brief`, content: c.fullBrief })}
                  onOutreach={(c) =>
                    setModal({ title: `Outreach: ${c.name}`, content: c.outreachEmail })
                  }
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Search Bar */}
      <div className="shrink-0 border-t border-zinc-900 px-4 py-3">
        <form onSubmit={handleSubmit} className="flex gap-3 items-center max-w-5xl mx-auto">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. Find emerging indie artists in London with under 50K monthly listeners…"
            disabled={isStreaming}
            className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-600 disabled:opacity-50 transition-colors"
          />
          <button
            type="submit"
            disabled={isStreaming || !query.trim()}
            className="px-5 py-3 rounded-xl bg-white text-black text-sm font-semibold hover:bg-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
          >
            {isStreaming ? 'Scanning…' : 'Scan'}
          </button>
          {isStreaming && (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="px-4 py-3 rounded-xl border border-zinc-800 text-zinc-400 text-sm hover:border-zinc-600 hover:text-zinc-200 transition-colors shrink-0"
            >
              Stop
            </button>
          )}
        </form>
      </div>

      {/* Modal */}
      {modal && (
        <Modal
          title={modal.title}
          content={modal.content}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  )
}
