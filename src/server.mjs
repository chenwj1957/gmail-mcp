import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { config, credentials } from './config.mjs';
import { Gmail } from './gmail.mjs';
import { Calendar, DEFAULT_TIME_ZONE } from './calendar.mjs';
import { tools } from './tools.mjs';

const cfg = config();
try {
  const creds = await credentials(cfg);
  const gmail = new Gmail(creds, cfg.downloadDir);
  const calendar = new Calendar(creds, { timeZone: process.env.CALENDAR_TIME_ZONE || DEFAULT_TIME_ZONE });
  // `npm run auth` rewrites the token file, but this process read the old refresh
  // token at startup and keeps it in memory; SIGHUP re-reads it in place so a
  // re-authorization does not need the child to be killed and respawned.
  // Errors are logged to stderr only: the stdio channel belongs to MCP.
  const reloadCredentials = async () => {
    try {
      const fresh = await credentials(cfg);
      gmail.reload(fresh);
      calendar.reload(fresh);
      console.error('Credentials reloaded from ' + cfg.tokenFile);
    } catch (error) {
      console.error('Credential reload failed: ' + String((error && error.message) || error).slice(0, 200));
    }
  };
  process.on('SIGHUP', reloadCredentials);
  await serveStdio(() => {
    const server = new McpServer({ name: 'gmail-mcp', version: '1.2.0' });
    for (const tool of tools(gmail, calendar)) server.registerTool(tool.name, {
      description: tool.description, inputSchema: tool.schema,
      annotations: { readOnlyHint: tool.readOnly, destructiveHint: Boolean(tool.destructive), idempotentHint: tool.readOnly, openWorldHint: true },
    }, async args => {
      try { return { content: [{ type: 'text', text: JSON.stringify(await tool.run(args)) }] }; }
      catch (error) {
        // Never expose raw network exceptions, request headers or token responses.
        const safe = /^(Gmail |Calendar |OAuth |Invalid |Attachment |Email headers|Event |Provide)/.test(error.message || '') ? error.message : 'Operation failed. Check connectivity and local configuration.';
        return { isError: true, content: [{ type: 'text', text: safe }] };
      }
    });
    return server;
  });
} catch {
  console.error('Gmail/Calendar MCP failed to start. Check credential configuration and run npm run auth if needed.');
  process.exitCode = 1;
}
