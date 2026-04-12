import { getHistory } from '@/lib/redis'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  ctx: RouteContext<'/api/sessions/[id]'>,
) {
  try {
    const { id } = await ctx.params
    const messages = await getHistory(id)
    return Response.json({ messages })
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
