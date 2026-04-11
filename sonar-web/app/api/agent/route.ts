import { runAgent } from '@/lib/agent'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const encoder = new TextEncoder()

function sseChunk(data: object): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
}

export async function POST(request: Request) {
  let query: string
  let sessionId: string

  try {
    const body = await request.json()
    query = body.query
    sessionId = body.sessionId
    if (!query || typeof query !== 'string') {
      return Response.json({ error: 'query is required' }, { status: 400 })
    }
    if (!sessionId || typeof sessionId !== 'string') {
      return Response.json({ error: 'sessionId is required' }, { status: 400 })
    }
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of runAgent(query, sessionId)) {
          controller.enqueue(sseChunk(event))
        }
      } catch (err) {
        controller.enqueue(
          sseChunk({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          }),
        )
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
