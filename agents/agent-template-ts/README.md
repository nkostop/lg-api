# lg-agent-sdk-ts

A minimal TypeScript library that handles the agent protocol for [lg-api](../../README.md). Supports both **CLI** (stdin/stdout) and **HTTP** (API server) modes. You provide a handler function — it takes care of the rest.

## Prerequisites

- Node.js v18+
- TypeScript 5+
- `tsx` (optional — for running .ts files directly during development)

## Install

### Option 1: Local tarball

Build the SDK once, then install the tarball in any project:

```bash
# Build and pack (from the agent-template directory)
cd agents/agent-template
npm install
npm run build
npm pack                # produces lg-agent-sdk-1.0.0.tgz

# Install in your agent project
cd /path/to/your-agent
npm install /path/to/lg-agent-sdk-1.0.0.tgz
```

### Option 2: npm link (for development)

```bash
# Register the SDK globally
cd agents/agent-template
npm install
npm run build
npm link

# Link it into your agent project
cd /path/to/your-agent
npm link lg-agent-sdk
```

### Option 3: npm registry (when published)

```bash
npm install lg-agent-sdk
```

## Usage

The SDK exposes two runner functions that share the same `AgentHandler` signature:

| Function | Mode | Transport |
|----------|------|-----------|
| `runAgent(handler)` | CLI | stdin/stdout JSON |
| `runAgentHttp(handler, options?)` | HTTP | POST endpoint returning JSON |

### CLI mode — `runAgent`

Create an entrypoint file in your project:

```ts
import { runAgent, type AgentRequest, type AgentResponse } from "lg-agent-sdk-ts";

runAgent(async (request: AgentRequest): Promise<AgentResponse> => {
  // request.messages  — conversation history
  // request.documents — optional attached documents
  // request.state     — state carried across runs in the same thread
  // request.metadata  — optional metadata from the caller

  return {
    thread_id: request.thread_id,
    run_id: request.run_id,
    messages: [{ role: "assistant", content: "Hello from my agent" }],
    state: { ...request.state, myKey: "computed value" },
  };
});
```

Then register it in `agent-registry.yaml`:

```yaml
# Development (tsx, no build step)
my-agent:
  command: npx
  args: ["tsx", "path/to/my-entrypoint.ts"]
  cwd: "."
  description: "My custom agent"
  timeout: 60000

# Production (pre-compiled)
my-agent:
  command: node
  args: ["path/to/dist/my-entrypoint.js"]
  cwd: "."
  description: "My custom agent"
  timeout: 60000
```

### HTTP mode — `runAgentHttp`

Swap `runAgent` for `runAgentHttp` — the handler stays the same:

```ts
import { runAgentHttp, type AgentRequest, type AgentResponse } from "lg-agent-sdk-ts";

runAgentHttp(async (request: AgentRequest): Promise<AgentResponse> => {
  return {
    thread_id: request.thread_id,
    run_id: request.run_id,
    messages: [{ role: "assistant", content: "Hello from my agent" }],
    state: { ...request.state, myKey: "computed value" },
  };
});
```

This starts an HTTP server with two endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/invoke` | Receives `AgentRequest` JSON, returns `AgentResponse` JSON |
| `GET` | `/health` | Returns `{ "status": "ok" }` |

#### Options

`runAgentHttp` accepts an optional second argument:

```ts
interface HttpRunnerOptions {
  port?: number;   // default: PORT env var or 4000
  host?: string;   // default: "0.0.0.0"
  path?: string;   // default: "/invoke"
}
```

```ts
runAgentHttp(handler, { port: 5000, path: "/run" });
```

#### agent-registry.yaml

Register as an `api` type agent:

```yaml
my-agent:
  type: api
  url: "http://localhost:4000/invoke"
  method: POST
  description: "My custom agent (HTTP)"
  timeout: 120000
```

The lg-api `ApiAgentConnector` sends a POST with the `AgentRequest` JSON body and expects an `AgentResponse` JSON response.

## What it does

### `runAgent(handler)` — CLI mode

1. Redirects `console.log` to stderr (so library code that logs doesn't corrupt the stdout JSON)
2. Reads a JSON `AgentRequest` from **stdin**
3. Validates required fields (`thread_id`, `run_id`, `assistant_id`, `messages`)
4. Calls your `handler` function with the parsed request
5. Writes the returned `AgentResponse` as JSON to **stdout**
6. Exits with code 0 on success, 1 on error (with the error message on stderr)

### `runAgentHttp(handler, options?)` — HTTP mode

1. Starts an HTTP server on the configured port
2. On `POST /invoke`: parses the JSON body as `AgentRequest`, validates required fields, calls your `handler`, and returns the `AgentResponse` as JSON (200 on success, 500 on error)
3. On `GET /health`: returns `{ "status": "ok" }`
4. Returns 404 for all other routes

## Types

```ts
interface AgentMessage {
  role: "user" | "assistant" | "system";
  content: string;
  response_metadata?: Record<string, unknown>;
}

interface AgentDocument {
  id: string;
  title?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

interface AgentRequest {
  thread_id: string;
  run_id: string;
  assistant_id: string;
  messages: AgentMessage[];
  documents?: AgentDocument[];
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface AgentResponse {
  thread_id: string;
  run_id: string;
  messages: AgentMessage[];
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
```

## Protocol contract

Your agent can be written in any language as long as it follows this contract:

| Requirement | Detail |
|-------------|--------|
| Input | Single JSON object on stdin |
| Output | Single JSON object on stdout |
| Errors | Write to stderr only, never stdout |
| Exit code | 0 = success, non-zero = failure |
| Required response fields | `thread_id`, `run_id`, `messages` (array) |
| Timeout | Configured per-agent in `agent-registry.yaml` |

This library implements the contract for TypeScript — for other languages, follow the same protocol.

## HTTP protocol contract

When using `runAgentHttp`, the agent acts as an HTTP server compatible with the lg-api `ApiAgentConnector`:

| Requirement | Detail |
|-------------|--------|
| Input | JSON `AgentRequest` body on `POST /invoke` |
| Output | JSON `AgentResponse` body (200) |
| Errors | JSON `{ "error": "message" }` (500) |
| Required response fields | `thread_id`, `run_id`, `messages` (array) |
| Health check | `GET /health` → `{ "status": "ok" }` |
| Timeout | Configured per-agent in `agent-registry.yaml` (enforced by lg-api via `AbortSignal`) |
