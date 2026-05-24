// MCP-Server-Entry. stdio-Transport, bridge_* Tools (9 default; +read_raw if gated on).
// stdout/stderr sind während des MCP-Protokolls reserviert für SDK-Frames;
// alle Diagnose-Ausgaben gehen in ~/.bridge-clis/bridge-mcp.log.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { SessionInfo } from '@bridge-clis/shared';

import { DaemonClient, writeLog } from './daemon-client.js';
import { createHandlers } from './tools.js';
import { buildToolDescriptors, readToolGates } from './tool-schemas.js';

const SERVER_NAME = 'bridge';
const SERVER_VERSION = '0.1.0';

async function main(): Promise<void> {
  const gates = readToolGates();
  const descriptors = buildToolDescriptors(gates);

  writeLog(
    `startup bridge-mcp ${SERVER_VERSION} | gates: allowForce=${gates.allowForce} allowRaw=${gates.allowRaw} | tools=${descriptors.map(d => d.name).join(',')}`,
  );

  const client = new DaemonClient();
  const handlers = createHandlers(client, gates);

  // Eager connect so the daemon-version is in the log before any tool call.
  // If the daemon isn't up the client falls back to spawn-and-retry; failure
  // here just means we log it and keep going (handlers will retry on demand).
  client.ensureConnected().then(() => {
    const v = client.getDaemonVersion();
    writeLog(`daemon handshake OK | daemonVersion=${v ?? 'unknown'}`);
  }).catch(err => {
    writeLog(`initial daemon connect failed (will retry on first tool call): ${(err as Error).message}`);
  });

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // tools/list
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: descriptors.map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: d.inputSchema,
    })),
  }));

  // Phase E status-footer: every tool response gets a compact bridge-status
  // line appended so master sees the current session landscape on every call
  // without having to ask. The text format is grep-friendly and short
  // (token-budget conscious).
  async function buildStatusFooter(): Promise<string> {
    try {
      // bridge_list is the cheapest call and returns SessionInfo[].
      const list = await handlers['bridge_list']!({}) as { sessions: SessionInfo[] };
      if (!list.sessions || list.sessions.length === 0) {
        return '<bridge-status>0 sessions</bridge-status>';
      }
      const parts = list.sessions.map(s => {
        const ageSec = Math.floor((Date.now() - s.lastActivityAt) / 1000);
        return `${s.label}·${s.status}·${ageSec}s`;
      });
      return `<bridge-status>${list.sessions.length} sessions: ${parts.join(', ')}</bridge-status>`;
    } catch {
      // Footer is best-effort — never let it break the actual tool response.
      return '';
    }
  }

  // tools/call
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const handler = handlers[name];
    if (!handler) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      };
    }
    try {
      const result = await handler(args);
      // bridge_list and bridge_notifications already contain the current
      // session landscape — appending a status footer would be redundant.
      const skipFooter = name === 'bridge_list' || name === 'bridge_notifications';
      const content: Array<{ type: 'text'; text: string }> = [
        { type: 'text', text: JSON.stringify(result) },
      ];
      if (!skipFooter) {
        const footer = await buildStatusFooter();
        if (footer) content.push({ type: 'text', text: footer });
      }
      return { content };
    } catch (err) {
      const msg = (err as Error).message || String(err);
      writeLog(`tool '${name}' failed: ${msg}`);
      return {
        isError: true,
        content: [{ type: 'text', text: msg }],
      };
    }
  });

  // Sauberes Shutdown.
  const shutdown = (sig: string): void => {
    writeLog(`shutdown on ${sig}`);
    client.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Unhandled — niemals laut auf stdio.
  process.on('uncaughtException', (e) => writeLog(`uncaught: ${e.stack ?? e.message}`));
  process.on('unhandledRejection', (e) =>
    writeLog(`unhandledRejection: ${e instanceof Error ? e.stack ?? e.message : String(e)}`),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  writeLog(`bridge-mcp ${SERVER_VERSION} connected via stdio`);
}

main().catch((err) => {
  // Pre-handshake-Fehler: stderr ist okay (Claude Code zeigt es in MCP-Logs).
  process.stderr.write(`bridge-mcp fatal: ${(err as Error).message}\n`);
  writeLog(`fatal: ${(err as Error).stack ?? (err as Error).message}`);
  process.exit(1);
});
