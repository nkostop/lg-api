import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AgentHandler, AgentRequest } from './types.js';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function parseRequest(raw: string): AgentRequest {
  if (!raw.trim()) {
    throw new Error('Empty request body. Expected a JSON AgentRequest.');
  }

  let request: AgentRequest;
  try {
    request = JSON.parse(raw) as AgentRequest;
  } catch {
    throw new Error(`Failed to parse body as JSON: ${raw.substring(0, 200)}`);
  }

  if (!request.thread_id) throw new Error("Missing required field 'thread_id'.");
  if (!request.run_id) throw new Error("Missing required field 'run_id'.");
  if (!request.assistant_id) throw new Error("Missing required field 'assistant_id'.");
  if (!request.messages || request.messages.length === 0) {
    throw new Error("Missing or empty 'messages'.");
  }

  return request;
}

export interface HttpRunnerOptions {
  port?: number;
  host?: string;
  path?: string;
}

/**
 * Start an HTTP server that accepts AgentRequest POSTs and returns AgentResponse.
 *
 * Compatible with the lg-api ApiAgentConnector. Register in agent-registry.yaml as:
 *
 *   my-agent:
 *     type: api
 *     url: "http://localhost:<port><path>"
 *     method: POST
 *     timeout: 120000
 */
export function runAgentHttp(handler: AgentHandler, options?: HttpRunnerOptions): void {
  const port = options?.port ?? parseInt(process.env.PORT ?? '4000', 10);
  const host = options?.host ?? '0.0.0.0';
  const invokePath = options?.path ?? '/invoke';

  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (req.method === 'POST' && req.url === invokePath) {
      try {
        const body = await readBody(req);
        const request = parseRequest(body);
        const response = await handler(request);
        sendJson(res, 200, response);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('Agent error:', message);
        sendJson(res, 500, { error: message });
      }
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  });

  server.listen(port, host, () => {
    console.log(`Agent HTTP server listening on http://${host}:${port}`);
    console.log(`  POST ${invokePath}  — agent endpoint`);
    console.log(`  GET  /health        — health check`);
  });
}
