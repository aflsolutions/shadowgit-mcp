import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildServer } from './server.js';

serveStdio(buildServer, {
  onerror: (error) => process.stderr.write(`shadowgit-mcp-server: ${error.message}\n`),
});
