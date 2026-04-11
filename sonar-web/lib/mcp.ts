import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Tool as AnthropicTool } from '@anthropic-ai/sdk/resources/messages'

export interface MCPToolCall {
  serverId: string
  toolName: string
  input: Record<string, unknown>
}

interface ConnectedServer {
  client: Client
  tools: AnthropicTool[]
}

// Survive HMR in Next.js dev
declare global {
  // eslint-disable-next-line no-var
  var _mcpServers: Map<string, ConnectedServer> | undefined
}

const servers = global._mcpServers ?? (global._mcpServers = new Map())

interface ServerConfig {
  id: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

function getServerConfigs(): ServerConfig[] {
  const configs: ServerConfig[] = []

  // Spotify MCP — set SPOTIFY_MCP_COMMAND to enable, e.g. "npx mcp-server-spotify"
  if (process.env.SPOTIFY_MCP_COMMAND) {
    const [command, ...args] = process.env.SPOTIFY_MCP_COMMAND.split(' ')
    configs.push({
      id: 'spotify',
      command,
      args,
      env: {
        SPOTIFY_CLIENT_ID: process.env.SPOTIFY_CLIENT_ID ?? '',
        SPOTIFY_CLIENT_SECRET: process.env.SPOTIFY_CLIENT_SECRET ?? '',
        SPOTIFY_REDIRECT_URI:
          process.env.SPOTIFY_REDIRECT_URI ?? 'http://localhost:3000/callback',
      },
    })
  }

  // Reddit MCP — set REDDIT_MCP_COMMAND to enable, e.g. "npx mcp-server-reddit"
  if (process.env.REDDIT_MCP_COMMAND) {
    const [command, ...args] = process.env.REDDIT_MCP_COMMAND.split(' ')
    configs.push({
      id: 'reddit',
      command,
      args,
      env: {
        REDDIT_CLIENT_ID: process.env.REDDIT_CLIENT_ID ?? '',
        REDDIT_CLIENT_SECRET: process.env.REDDIT_CLIENT_SECRET ?? '',
        REDDIT_USERNAME: process.env.REDDIT_USERNAME ?? '',
        REDDIT_PASSWORD: process.env.REDDIT_PASSWORD ?? '',
      },
    })
  }

  // Slack MCP — set SLACK_MCP_COMMAND to enable, e.g. "npx @modelcontextprotocol/server-slack"
  if (process.env.SLACK_MCP_COMMAND) {
    const [command, ...args] = process.env.SLACK_MCP_COMMAND.split(' ')
    configs.push({
      id: 'slack',
      command,
      args,
      env: {
        SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN ?? '',
        SLACK_TEAM_ID: process.env.SLACK_TEAM_ID ?? '',
      },
    })
  }

  return configs
}

async function connectServer(config: ServerConfig): Promise<ConnectedServer> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
    stderr: 'pipe',
  })

  const client = new Client(
    { name: 'sonar', version: '1.0.0' },
    { capabilities: {} },
  )

  await client.connect(transport)

  const { tools } = await client.listTools()

  const anthropicTools: AnthropicTool[] = tools.map((t) => ({
    name: `${config.id}__${t.name}`,
    description: `[${config.id.toUpperCase()}] ${t.description ?? ''}`,
    input_schema: (t.inputSchema ?? {
      type: 'object',
      properties: {},
    }) as AnthropicTool['input_schema'],
  }))

  return { client, tools: anthropicTools }
}

export async function initMCPServers(): Promise<void> {
  const configs = getServerConfigs()
  await Promise.all(
    configs.map(async (config) => {
      if (servers.has(config.id)) return
      try {
        const server = await connectServer(config)
        servers.set(config.id, server)
        console.log(
          `[MCP] Connected to ${config.id} (${server.tools.length} tools)`,
        )
      } catch (err) {
        console.warn(`[MCP] Failed to connect to ${config.id}:`, err)
      }
    }),
  )
}

export function getMCPTools(): AnthropicTool[] {
  return Array.from(servers.values()).flatMap((s) => s.tools)
}

export async function callMCPTool(
  toolName: string,
  input: Record<string, unknown>,
): Promise<string> {
  // Tool names are prefixed: "serverId__toolName"
  const separatorIndex = toolName.indexOf('__')
  if (separatorIndex === -1) {
    throw new Error(`Invalid MCP tool name format: ${toolName}`)
  }

  const serverId = toolName.slice(0, separatorIndex)
  const actualToolName = toolName.slice(separatorIndex + 2)

  const server = servers.get(serverId)
  if (!server) {
    throw new Error(`MCP server "${serverId}" is not connected`)
  }

  const result = await server.client.callTool({
    name: actualToolName,
    arguments: input,
  })

  // Flatten content blocks to a string
  if (Array.isArray(result.content)) {
    return result.content
      .map((block: { type: string; text?: string }) =>
        block.type === 'text' ? (block.text ?? '') : JSON.stringify(block),
      )
      .join('\n')
  }

  return String(result.content ?? '')
}

export function isMCPTool(toolName: string): boolean {
  return toolName.includes('__')
}
