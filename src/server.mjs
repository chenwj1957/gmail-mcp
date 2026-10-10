import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { config, credentials } from './config.mjs';
import { Gmail } from './gmail.mjs';
import { tools } from './tools.mjs';

const cfg = config();
try {
  const gmail = new Gmail(await credentials(cfg), cfg.downloadDir);
  await serveStdio(() => {
    const server = new McpServer({ name: 'gmail-mcp', version: '1.0.0' });
    for (const tool of tools(gmail)) server.registerTool(tool.name, {
      description: tool.description, inputSchema: tool.schema,
      annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, idempotentHint: tool.readOnly, openWorldHint: true },
    }, async args => {
      try { return { content: [{ type: 'text', text: JSON.stringify(await tool.run(args)) }] }; }
      catch (error) {
        // Never expose raw network exceptions, request headers or token responses.
        const safe = /^(Gmail |OAuth |Invalid Gmail|Attachment |Email headers|Provide attachment)/.test(error.message || '') ? error.message : 'Operation failed. Check connectivity and local configuration.';
        return { isError: true, content: [{ type: 'text', text: safe }] };
      }
    });
    return server;
  });
} catch { console.error('Gmail MCP failed to start. Check credential configuration and run npm run auth if needed.'); process.exitCode = 1; }
