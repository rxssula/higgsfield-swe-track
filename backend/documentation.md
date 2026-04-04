# AI Brainstorm Canvas — Backend Documentation

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Tech Stack](#tech-stack)
4. [Project Structure](#project-structure)
5. [Module 1: WebSocket Server & Real-Time Sync](#module-1-websocket-server--real-time-sync)
6. [Module 2: Canvas State Serializer](#module-2-canvas-state-serializer)
7. [Module 3: Claude API Integration](#module-3-claude-api-integration)
8. [Module 4: Agent Action System](#module-4-agent-action-system)
9. [Module 5: Agent Modes & Behavior Engine](#module-5-agent-modes--behavior-engine)
10. [Module 6: Session Management](#module-6-session-management)
11. [Module 7: Higgsfield Integration](#module-7-higgsfield-integration)
12. [API Contract with Frontend](#api-contract-with-frontend)
13. [Custom Canvas Shapes](#custom-canvas-shapes)
14. [Data Models & Type Definitions](#data-models--type-definitions)
15. [System Prompts](#system-prompts)
16. [Error Handling Strategy](#error-handling-strategy)
17. [Cloudflare Deployment](#cloudflare-deployment)
18. [Build Order & Milestones](#build-order--milestones)

---

## Overview

The backend is the brain of the AI brainstorming agent. It receives the current canvas state from the frontend (as tldraw native shapes), translates it into something Claude can reason about spatially, calls the Claude API, parses structured responses into canvas actions, and sends those actions back to the frontend for rendering via the tldraw Editor API.

The agent is NOT a chatbot. It is a spatial participant — it appears as a separate user (NPC) on the canvas with its own cursor and presence. It creates, moves, groups, and connects tldraw shapes. It also calls the Higgsfield API to generate images and videos and places the results as custom shapes on the canvas.

### Core Responsibilities

- Real-time WebSocket communication with all connected clients
- Canvas state ingestion from tldraw (`TLShape[]` + `TLBinding[]`)
- Spatial serialization of tldraw shapes → text Claude can reason about
- Claude API calls with context-rich prompts
- Parsing Claude's responses into structured tldraw canvas actions
- Agent behavior modes (observer, collaborator, facilitator)
- Session history and conversation memory
- Agent presence simulation (cursor position, "thinking" state)
- Higgsfield API proxy for image and video generation
- Placing generated media as custom shapes on the canvas

---

## Architecture

> **Starting point:** Use the [tldraw multiplayer starter kit](https://tldraw.dev/starter-kits/multiplayer). It ships a complete Cloudflare Worker + Durable Object that handles all canvas WebSocket sync via `TLSocketRoom`. You do NOT build a separate WebSocket server — you extend what the starter kit already gives you.

```
┌──────────────────────────────────────────────────────────────┐
│                     FRONTEND (React)                         │
│                                                              │
│   tldraw Canvas  +  Agent UI Controls  +  Higgsfield panel   │
│                                                              │
│   👤 User A  👤 User B  🤖 AI Agent (NPC cursor/presence)    │
└──────┬───────────────────────────────┬───────────────────────┘
       │ @tldraw/sync (WebSocket)       │ POST /agent/invoke
       │ (canvas CRDT sync)             │ (HTTP — trigger agent)
       ▼                                ▼
┌──────────────────────────────────────────────────────────────┐
│        CLOUDFLARE WORKER  (from tldraw starter kit)          │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐     │
│  │  TldrawDurableObject (one per room)                 │     │
│  │                                                     │     │
│  │  TLSocketRoom ← handles all WS sync automatically  │     │
│  │  SQLite        ← persists canvas state per room    │     │
│  │                                                     │     │
│  │  room.sendCustomMessage() ← agent pushes actions   │     │
│  └─────────────────────────────────────────────────────┘     │
│                                                              │
│  ┌────────────────────┐   ┌──────────────────────────────┐   │
│  │   Agent Engine     │   │    Higgsfield Proxy          │   │
│  │  (Claude API call, │   │  POST /generate/image        │   │
│  │   action parser,   │   │  POST /generate/video        │   │
│  │   mode logic)      │   └──────────────────────────────┘   │
│  └────────────────────┘                                      │
└──────────────────────────────────────────────────────────────┘
```

### Data Flow (single agent interaction cycle)

1. User triggers agent (`POST /agent/invoke` from frontend)
2. Frontend includes `{ shapes, bindings, message, mode }` in the POST body
3. Worker fetches the Durable Object for the room, calls agent engine
4. Serializer converts canvas snapshot → spatial text description
5. Agent engine builds prompt (system prompt + session history + canvas context)
6. Claude API called, response received
7. Action parser extracts tldraw actions from Claude's JSON response
8. Actions validated against current shape IDs
9. **`room.sendCustomMessage(sessionId, { event: "agent:actions", data: { actions } })`** — pushed to all clients through the existing `TLSocketRoom` WebSocket
10. Frontend receives the custom message, applies actions via `editor.createShape()`, etc.
11. Agent cursor position broadcast via another `sendCustomMessage()`

### How `TLSocketRoom.sendCustomMessage()` works

The starter kit's `TLSocketRoom` exposes `sendCustomMessage(sessionId, data)` to push arbitrary data to a specific client, or iterate `room.getSessions()` to broadcast to all. This means:

- **No second WebSocket server needed** — agent actions travel through the same connection tldraw already uses for CRDT sync
- **No frontend reconnection logic** — one WS connection handles both canvas sync and agent events
- The frontend distinguishes agent messages by checking `event` field in the custom message payload

---

## Tech Stack

| Component | Choice | Rationale |
|---|---|---|
| Runtime (dev) | Bun | Fast iteration, native TypeScript, native WebSocket |
| Runtime (prod) | Cloudflare Workers | Edge compute, global distribution |
| Framework | Elysia + `CloudflareAdapter` | Type-safe, Bun-native, Workers-compatible since v1.4.7 |
| Canvas sync | `@tldraw/sync` / `useSyncDemo` | tldraw's native CRDT multiplayer |
| Canvas lib | tldraw | Native AI agent support, NPC presence, custom shapes |
| Claude API | `@anthropic-ai/sdk` | Official Anthropic SDK |
| Image/video gen | Higgsfield API | Called from agent, result placed as custom shape |
| Validation | @sinclair/typebox (via Elysia) | Runtime type validation for agent actions — TypeBox ships with Elysia, no extra install |
| State (prod) | Cloudflare Durable Objects | Stateful WS rooms, SQLite per room, hibernatable |

### Install

```bash
bun add @anthropic-ai/sdk uuid elysia
bun add -d bun-types
```

> **Already installed:** `elysia` v1.4.28, `uuid`, `bun-types`, `@sinclair/typebox` (ships with Elysia — no separate install needed).
> **Not installed yet:** `@anthropic-ai/sdk` — run the command above to add it.
> **Not needed on backend:** `zod`, `tldraw`, `@tldraw/sync-core` — tldraw is frontend-only; TypeBox replaces Zod.

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "types": ["bun-types"],
    "skipLibCheck": true
  }
}
```

---

## Project Structure

```
backend/                          # (this repo — extends the tldraw starter kit worker)
├── worker/                       # FROM STARTER KIT — Cloudflare Worker
│   ├── worker.ts                 # Entry point — add agent HTTP routes here
│   └── TldrawDurableObject.ts    # FROM STARTER KIT — TLSocketRoom Durable Object
│
├── src/                          # YOUR CODE — agent logic
│   ├── config.ts                 # Env vars, constants
│   │
│   ├── canvas/
│   │   ├── serializer.ts         # CanvasSnapshot → text description for Claude
│   │   ├── spatial.ts            # Clustering, region labels (infinite canvas)
│   │   └── types.ts              # CanvasShape, CanvasBinding, CanvasSnapshot (local types)
│   │
│   ├── agent/
│   │   ├── engine.ts             # Main agent orchestrator
│   │   ├── modes.ts              # Observer / Collaborator / Facilitator logic
│   │   ├── prompts.ts            # System prompts and prompt builders
│   │   ├── claude.ts             # Claude API wrapper (@anthropic-ai/sdk)
│   │   └── proactive.ts          # Proactive contribution timer/logic
│   │
│   ├── actions/
│   │   ├── types.ts              # AgentAction TypeBox schemas
│   │   ├── parser.ts             # Parse Claude response → actions (Value.Parse)
│   │   └── validator.ts          # Validate action shape IDs against snapshot
│   │
│   ├── session/
│   │   ├── store.ts              # In-memory session state (per Durable Object)
│   │   └── history.ts            # Conversation history manager
│   │
│   ├── higgsfield/
│   │   └── client.ts             # Higgsfield API wrapper
│   │
│   └── utils/
│       ├── logger.ts             # Structured logging
│       └── ids.ts                # ID generation
│
├── wrangler.toml                 # FROM STARTER KIT — Cloudflare deployment config
├── package.json
└── tsconfig.json
```

> **Note:** There is no separate `ws/` directory. Canvas WebSocket sync lives entirely inside `TldrawDurableObject.ts` (starter kit). Your agent code lives in `src/` and is invoked via HTTP routes added to `worker/worker.ts`.

---

## Module 1: WebSocket Server & Real-Time Sync

**Status: Provided by tldraw multiplayer starter kit** — you do not build this.

The [tldraw multiplayer starter kit](https://tldraw.dev/starter-kits/multiplayer) ships a Cloudflare Worker (`worker/worker.ts`) with a Durable Object (`worker/TldrawDurableObject.ts`) that runs `TLSocketRoom` from `@tldraw/sync-core`. This handles all canvas CRDT sync automatically.

### What the starter kit already provides

- `TLSocketRoom` — manages all client WebSocket connections, conflict resolution, and document state
- `handleSocketConnect(sessionId, socket)` — registers a client
- `handleSocketMessage(sessionId, msg)` / `handleSocketClose(sessionId)` — message routing
- SQLite persistence via `DurableObjectSqliteSyncWrapper`
- One Durable Object instance per room — all users in a room connect to the same instance

### What you add: agent HTTP route + `sendCustomMessage`

You extend the existing worker with an HTTP route the frontend POSTs to when invoking the agent. The worker then calls the agent engine and pushes results back through the existing WebSocket using `TLSocketRoom.sendCustomMessage()`.

```typescript
// Extend worker/worker.ts (or worker/TldrawDurableObject.ts)

// HTTP route — frontend calls this to invoke the agent
app.post("/room/:roomId/agent/invoke", async ({ params, body }) => {
  const roomId = params.roomId;
  const { message, shapes, bindings, mode } = body as AgentInvokeRequest;

  // Get the Durable Object for this room
  const id = env.TLDRAW_DURABLE_OBJECT.idFromName(roomId);
  const room = env.TLDRAW_DURABLE_OBJECT.get(id);

  // Delegate to agent engine (see Module 5)
  const result = await agentEngine.handleInvoke(roomId, message, { shapes, bindings });
  if (!result) return { ok: false };

  // Push agent actions to ALL clients via the existing TLSocketRoom WebSocket
  for (const session of room.getSessions()) {
    room.sendCustomMessage(session.sessionId, {
      event: "agent:actions",
      data: { actions: result.actions, message: result.message, isTentative: false },
    });
  }

  return { ok: true };
});
```

### Message format (custom messages via TLSocketRoom)

Agent events piggyback on the existing tldraw WebSocket. The frontend listens for custom messages:

```typescript
// Frontend: detect agent messages inside the tldraw sync connection
editor.store.listen((entry) => { /* canvas changes */ });

// Custom agent messages come via a separate listener (tldraw exposes this)
// Shape: { event: string, data: object }
```

All agent event names:

| Event | Direction | Description |
|---|---|---|
| `agent:actions` | → Frontend | Agent canvas actions to apply |
| `agent:cursor` | → Frontend | Agent cursor position |
| `agent:thinking` | → Frontend | Loading indicator |
| `agent:mode-changed` | → Frontend | Mode switch confirmation |
| `agent:error` | → Frontend | Error details |

---

## Module 2: Canvas State Serializer

**Status: Not started** (`src/canvas/serializer.ts`, `src/canvas/spatial.ts`, `src/canvas/types.ts`)

> This is the most critical module. Claude cannot "see" a canvas. The serializer converts tldraw's native shape data into a structured natural-language description that preserves spatial relationships.

### Input: tldraw Snapshot

The frontend sends shapes and bindings directly from the tldraw editor:

```typescript
// src/canvas/types.ts
// Note: `tldraw` is frontend-only — don't import TLShape/TLBinding from it on the backend.
// Define minimal structural types that match what tldraw actually sends over the wire.

export interface CanvasShape {
  id: string;          // format: "shape:xxxxxxxx"
  type: string;        // "note" | "text" | "geo" | "arrow" | "frame" | "group" | "image" | "draw" | ...
  x: number;
  y: number;
  rotation: number;
  parentId: string;    // page ID or group/frame ID
  props: Record<string, any>;
}

export interface CanvasBinding {
  id: string;
  type: string;        // "arrow"
  fromId: string;      // arrow shape ID
  toId: string;        // target shape ID
  props: {
    terminal: "start" | "end";
    isExact: boolean;
    isPrecise: boolean;
    normalizedAnchor: { x: number; y: number };
  };
}

export interface CanvasSnapshot {
  shapes: CanvasShape[];     // editor.getCurrentPageShapes()
  bindings: CanvasBinding[]; // editor.getCurrentPageBindings()
}
```

**tldraw shape types used:**
- `note` — sticky note (props: `color`, `richText`)
- `text` — free text block (props: `richText`, `size`, `color`)
- `geo` — rectangle, ellipse, triangle, etc. (props: `geo`, `w`, `h`, `color`, `fill`, `richText`)
- `arrow` — connector between shapes (connected via `TLBinding` records)
- `frame` — named container (props: `name`, `w`, `h`)
- `group` — logical group (children identified by `shape.parentId === group.id`)
- `image` — embedded image
- `draw` — freehand drawing

**Text extraction note:** tldraw v3+ stores text as ProseMirror JSON (`richText`), not a plain string. The serializer must walk the JSON tree recursively to extract plain text:

```typescript
function extractText(shape: TLShape): string {
  if (shape.props?.richText) return extractRichText(shape.props.richText);
  if (shape.props?.text)     return shape.props.text;
  if (shape.props?.name)     return shape.props.name;
  return "";
}

function extractRichText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.text) return node.text;
  if (node.content) return node.content.map(extractRichText).join("");
  return "";
}
```

### Spatial helpers (infinite canvas)

tldraw uses an **infinite canvas** — there are no fixed dimensions. Region labels are based on coordinate quadrants + raw coordinates rather than percentages of a fixed size:

```typescript
// Infinite canvas: regions relative to coordinate origin
export function getRegionLabel(point: { x: number; y: number }): string {
  const xLabel = point.x < 0 ? "left" : "right";
  const yLabel = point.y < 0 ? "top" : "bottom";
  return `${yLabel}-${xLabel} (${Math.round(point.x)}, ${Math.round(point.y)})`;
}
```

Clustering uses 300px threshold (vs 200px in generic doc) because tldraw notes are ~200px wide.

### Output: Spatial description

Eight sections in the serialized output:

1. **CANVAS OVERVIEW** — element counts by type
2. **SPATIAL CLUSTERS** — groups of ≥2 notes within 300px, with region and text
3. **ISOLATED NOTES** — notes not in any cluster
4. **GEO SHAPES** — rectangles, ellipses, etc. with labels and positions
5. **TEXT BLOCKS** — free text elements
6. **CONNECTIONS** — arrows resolved via bindings (`"A" → "B"`)
7. **FRAMES** — named containers with their children listed
8. **GROUPS** — tldraw groups with their children listed

Arrow connections require a two-step lookup: find bindings where `fromId === arrow.id`, then find shapes by `binding.toId`. Start vs end terminal is in `binding.props.terminal`.

---

## Module 3: Claude API Integration

### Purpose

Wrap the Anthropic SDK. Handle prompt construction, streaming, error recovery, and rate limiting.

### Implementation

```typescript
// src/agent/claude.ts
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

export interface ClaudeRequest {
  systemPrompt: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
}

export async function callClaude(req: ClaudeRequest): Promise<string> {
  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: req.maxTokens || 4096,
      system: req.systemPrompt,
      messages: req.messages,
    });
    const textBlock = response.content.find((b) => b.type === "text");
    return textBlock?.text || "";
  } catch (error: any) {
    if (error?.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return callClaude(req);
    }
    throw error;
  }
}

// Streaming variant (for demo polish — shows agent "typing")
export async function callClaudeStream(
  req: ClaudeRequest,
  onChunk: (text: string) => void
): Promise<string> {
  const stream = client.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: req.maxTokens || 4096,
    system: req.systemPrompt,
    messages: req.messages,
  });

  let fullText = "";
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      fullText += event.delta.text;
      onChunk(event.delta.text);
    }
  }
  return fullText;
}
```

### Config

```typescript
// src/config.ts
export const config = {
  ANTHROPIC_API_KEY:    process.env.ANTHROPIC_API_KEY    || "",
  HIGGSFIELD_API_KEY:   process.env.HIGGSFIELD_API_KEY   || "",
  WS_PORT:              parseInt(process.env.WS_PORT      || "8080"),
  HTTP_PORT:            parseInt(process.env.HTTP_PORT    || "3001"),
  PROACTIVE_INTERVAL_MS: parseInt(process.env.PROACTIVE_INTERVAL_MS || "30000"),
};
```

---

## Module 4: Agent Action System

### Purpose

Define, parse, and validate the structured actions the agent can perform. All action types map directly to tldraw's Editor API. Both backend and frontend must agree on this schema exactly.

### Action Types (tldraw-mapped)

> **Validation library:** Uses `@sinclair/typebox` (already installed as an Elysia dependency). Import via `import { Type as t, Static } from "@sinclair/typebox"`. For runtime parsing use `import { Value } from "@sinclair/typebox/value"`.

```typescript
// src/actions/types.ts
import { Type as t, Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const TldrawColor = t.Union([
  t.Literal("black"), t.Literal("grey"), t.Literal("light-violet"), t.Literal("violet"),
  t.Literal("blue"), t.Literal("light-blue"), t.Literal("yellow"), t.Literal("orange"),
  t.Literal("green"), t.Literal("light-green"), t.Literal("light-red"), t.Literal("red"),
  t.Literal("white"),
]);

const TldrawGeo = t.Union([
  t.Literal("rectangle"), t.Literal("ellipse"), t.Literal("triangle"), t.Literal("diamond"),
  t.Literal("pentagon"), t.Literal("hexagon"), t.Literal("octagon"), t.Literal("star"),
  t.Literal("rhombus"), t.Literal("oval"), t.Literal("trapezoid"), t.Literal("cloud"),
  t.Literal("heart"), t.Literal("arrow-right"), t.Literal("arrow-left"), t.Literal("arrow-up"),
  t.Literal("arrow-down"), t.Literal("x-box"), t.Literal("check-box"),
]);

export const CreateNoteAction = t.Object({
  type: t.Literal("create_note"),
  text: t.String(),
  x: t.Number(),
  y: t.Number(),
  color: t.Optional(TldrawColor),
  // Frontend: editor.createShape({ type: 'note', x, y, props: { color, richText: toRichText(text) } })
});

export const CreateGeoAction = t.Object({
  type: t.Literal("create_geo"),
  geo: t.Optional(TldrawGeo),
  text: t.Optional(t.String()),
  x: t.Number(),
  y: t.Number(),
  w: t.Optional(t.Number()),
  h: t.Optional(t.Number()),
  color: t.Optional(TldrawColor),
  fill: t.Optional(t.Union([t.Literal("none"), t.Literal("semi"), t.Literal("solid"), t.Literal("pattern")])),
  // Frontend: editor.createShape({ type: 'geo', x, y, props: { geo, w, h, color, fill, richText } })
});

export const CreateTextAction = t.Object({
  type: t.Literal("create_text"),
  text: t.String(),
  x: t.Number(),
  y: t.Number(),
  size: t.Optional(t.Union([t.Literal("s"), t.Literal("m"), t.Literal("l"), t.Literal("xl")])),
  color: t.Optional(TldrawColor),
  // Frontend: editor.createShape({ type: 'text', x, y, props: { richText, size, color } })
});

export const CreateArrowAction = t.Object({
  type: t.Literal("create_arrow"),
  fromId: t.String(),  // tldraw shape ID (format: "shape:xxxxxxxx")
  toId: t.String(),
  label: t.Optional(t.String()),
  // Frontend: editor.createShape({ type: 'arrow' }) + editor.createBindings([...])
});

export const CreateFrameAction = t.Object({
  type: t.Literal("create_frame"),
  name: t.String(),
  x: t.Number(),
  y: t.Number(),
  w: t.Number(),
  h: t.Number(),
  // Frontend: editor.createShape({ type: 'frame', x, y, props: { w, h, name } })
});

export const UpdateShapeAction = t.Object({
  type: t.Literal("update_shape"),
  shapeId: t.String(),
  props: t.Optional(t.Record(t.String(), t.Any())),
  x: t.Optional(t.Number()),
  y: t.Optional(t.Number()),
  // Frontend: editor.updateShape({ id, type, x?, y?, props? })
});

export const DeleteShapeAction = t.Object({
  type: t.Literal("delete_shape"),
  shapeId: t.String(),
  // Frontend: editor.deleteShape(shapeId)
});

export const GroupShapesAction = t.Object({
  type: t.Literal("group_shapes"),
  shapeIds: t.Array(t.String()),
  // Frontend: editor.groupShapes(shapeIds)
});

export const ReparentAction = t.Object({
  type: t.Literal("reparent"),
  shapeIds: t.Array(t.String()),
  parentId: t.String(),  // frame or group ID
  // Frontend: editor.reparentShapes(shapeIds, parentId)
});

export const PlaceMediaAction = t.Object({
  type: t.Literal("place_media"),
  mediaType: t.Union([t.Literal("higgs-image"), t.Literal("higgs-video")]),
  url: t.String(),
  x: t.Number(),
  y: t.Number(),
  w: t.Optional(t.Number()),
  h: t.Optional(t.Number()),
  prompt: t.Optional(t.String()),
  // Frontend: editor.createShape({ type: 'higgs-image' | 'higgs-video', ... })
});

export const AgentAction = t.Union([
  CreateNoteAction,
  CreateGeoAction,
  CreateTextAction,
  CreateArrowAction,
  CreateFrameAction,
  UpdateShapeAction,
  DeleteShapeAction,
  GroupShapesAction,
  ReparentAction,
  PlaceMediaAction,
]);

export type AgentAction = Static<typeof AgentAction>;

export const AgentResponse = t.Object({
  thinking: t.Optional(t.String()),
  message: t.Optional(t.String()),
  actions: t.Array(AgentAction),
  cursorTarget: t.Optional(t.Object({ x: t.Number(), y: t.Number() })),
});

export type AgentResponse = Static<typeof AgentResponse>;
```

### Parser

```typescript
// src/actions/parser.ts
import { Value } from "@sinclair/typebox/value";
import { AgentResponse } from "./types";

export function parseAgentResponse(raw: string): AgentResponse | null {
  try {
    let cleaned = raw.trim();
    const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) cleaned = jsonMatch[1].trim();

    const parsed = JSON.parse(cleaned);
    return Value.Parse(AgentResponse, parsed);
  } catch (error) {
    console.error("Failed to parse agent response:", error);
    return {
      actions: [],
      message: "I encountered an issue processing that request. Could you try again?",
    };
  }
}
```

### Validator

```typescript
// src/actions/validator.ts
// Note: `tldraw` is a frontend-only package — do NOT install it on the backend.
// Use a minimal shape type that matches what the frontend sends.
import type { AgentAction } from "./types";
import type { CanvasShape } from "../canvas/types"; // { id: string; type: string; ... }

export function validateActions(
  actions: AgentAction[],
  shapes: CanvasShape[]
): { valid: AgentAction[]; rejected: { action: AgentAction; reason: string }[] } {
  const shapeIds = new Set(shapes.map((s) => s.id));
  const valid: AgentAction[] = [];
  const rejected: { action: AgentAction; reason: string }[] = [];

  for (const action of actions) {
    switch (action.type) {
      case "create_note":
      case "create_geo":
      case "create_text":
      case "create_frame":
      case "place_media":
        valid.push(action);
        break;

      case "create_arrow":
        if (!shapeIds.has(action.fromId) || !shapeIds.has(action.toId)) {
          rejected.push({ action, reason: "Arrow references nonexistent shape(s)" });
        } else {
          valid.push(action);
        }
        break;

      case "update_shape":
      case "delete_shape":
        if (!shapeIds.has(action.shapeId)) {
          rejected.push({ action, reason: `Shape ${action.shapeId} not found` });
        } else {
          valid.push(action);
        }
        break;

      case "group_shapes": {
        const missing = action.shapeIds.filter((id) => !shapeIds.has(id));
        if (missing.length > 0) {
          rejected.push({ action, reason: `Shapes not found: ${missing.join(", ")}` });
        } else {
          valid.push(action);
        }
        break;
      }

      case "reparent": {
        const missing = action.shapeIds.filter((id) => !shapeIds.has(id));
        if (missing.length > 0) {
          rejected.push({ action, reason: `Shapes not found: ${missing.join(", ")}` });
        } else if (!shapeIds.has(action.parentId)) {
          rejected.push({ action, reason: `Parent ${action.parentId} not found` });
        } else {
          valid.push(action);
        }
        break;
      }
    }
  }

  return { valid, rejected };
}
```

---

## Module 5: Agent Modes & Behavior Engine

### Modes

| Mode | Behavior | Proactive interval |
|---|---|---|
| **Observer** | Only responds when explicitly asked. Silent watcher. | Disabled |
| **Collaborator** | Offers suggestions when it notices patterns, gaps, or connections. | 45 seconds |
| **Facilitator** | Actively drives the session — groups ideas, asks probing questions, summarizes. | 25 seconds |

### Implementation

```typescript
// src/agent/modes.ts
export type AgentMode = "observer" | "collaborator" | "facilitator";

export interface ModeConfig {
  proactiveEnabled: boolean;
  intervalMs: number;
  aggressiveness: "low" | "medium" | "high";
  systemPromptAddendum: string;
}

export const MODE_CONFIGS: Record<AgentMode, ModeConfig> = {
  observer: {
    proactiveEnabled: false,
    intervalMs: Infinity,
    aggressiveness: "low",
    systemPromptAddendum: `You are in OBSERVER mode. Only respond when a user explicitly asks you something. Do NOT volunteer ideas, do NOT reorganize the canvas, do NOT add anything unprompted.`,
  },
  collaborator: {
    proactiveEnabled: true,
    intervalMs: 45000,
    aggressiveness: "medium",
    systemPromptAddendum: `You are in COLLABORATOR mode. Occasionally offer suggestions when you notice:
- A theme emerging across scattered notes that could be grouped
- An obvious gap or missing perspective
- A connection between ideas not yet drawn
Keep suggestions tentative. Max 1-2 actions per proactive contribution.`,
  },
  facilitator: {
    proactiveEnabled: true,
    intervalMs: 25000,
    aggressiveness: "high",
    systemPromptAddendum: `You are in FACILITATOR mode. Actively drive the session:
- Group and organize ideas into themes as they accumulate
- Ask probing questions via text notes ("What about the user's perspective?")
- Summarize progress periodically
- Suggest next directions when the team seems stuck
- Generate visual content (images/videos) via Higgsfield when relevant
Take 3-5 actions per contribution. Be bold.`,
  },
};
```

### Agent Engine

```typescript
// src/agent/engine.ts
import { callClaude } from "./claude";
import { buildPrompt } from "./prompts";
import { parseAgentResponse } from "../actions/parser";
import { validateActions } from "../actions/validator";
import { serializeCanvasState } from "../canvas/serializer";
import { SessionStore } from "../session/store";
import { AgentMode, MODE_CONFIGS } from "./modes";
import type { CanvasSnapshot } from "../canvas/types";
import type { AgentResponse } from "../actions/types";

export class AgentEngine {
  private mode: AgentMode = "observer";
  private sessionStore: SessionStore;

  constructor(sessionStore: SessionStore) {
    this.sessionStore = sessionStore;
  }

  setMode(mode: AgentMode) { this.mode = mode; }
  getMode(): AgentMode { return this.mode; }
  isProactiveEnabled(): boolean { return MODE_CONFIGS[this.mode].proactiveEnabled; }
  getProactiveInterval(): number { return MODE_CONFIGS[this.mode].intervalMs; }

  async handleInvoke(
    sessionId: string,
    userMessage: string,
    snapshot: CanvasSnapshot
  ): Promise<AgentResponse | null> {
    const serialized = serializeCanvasState(snapshot);
    const history = this.sessionStore.getHistory(sessionId);
    const modeConfig = MODE_CONFIGS[this.mode];

    const prompt = buildPrompt({
      canvasDescription: serialized,
      userMessage,
      history,
      modeAddendum: modeConfig.systemPromptAddendum,
      isProactive: false,
    });

    const rawResponse = await callClaude({
      systemPrompt: prompt.system,
      messages: prompt.messages,
    });

    const parsed = parseAgentResponse(rawResponse);
    if (!parsed) return null;

    const { valid, rejected } = validateActions(parsed.actions, snapshot.shapes as any);
    if (rejected.length > 0) console.warn("Rejected actions:", rejected);

    this.sessionStore.addToHistory(sessionId, { role: "user", content: userMessage });
    this.sessionStore.addToHistory(sessionId, { role: "assistant", content: rawResponse });

    return { ...parsed, actions: valid };
  }

  async handleProactive(
    sessionId: string,
    snapshot: CanvasSnapshot
  ): Promise<AgentResponse | null> {
    const serialized = serializeCanvasState(snapshot);
    const history = this.sessionStore.getHistory(sessionId);
    const modeConfig = MODE_CONFIGS[this.mode];

    const prompt = buildPrompt({
      canvasDescription: serialized,
      userMessage: "",
      history,
      modeAddendum: modeConfig.systemPromptAddendum,
      isProactive: true,
    });

    const rawResponse = await callClaude({
      systemPrompt: prompt.system,
      messages: prompt.messages,
    });

    const parsed = parseAgentResponse(rawResponse);
    if (!parsed) return null;
    if (parsed.actions.length === 0 && !parsed.message) return null;

    const { valid } = validateActions(parsed.actions, snapshot.shapes);
    return { ...parsed, actions: valid };
  }
}
```

---

## Module 6: Session Management

### Purpose

Track conversation history per session so the agent has memory within a brainstorming session. In Cloudflare production each Durable Object is its own session with its own SQLite. In local dev this is in-memory.

```typescript
// src/session/store.ts
interface Message {
  role: "user" | "assistant";
  content: string;
}

interface Session {
  id: string;
  mode: string;
  history: Message[];
  createdAt: Date;
  lastActivity: Date;
}

export class SessionStore {
  private sessions: Map<string, Session> = new Map();

  getOrCreate(sessionId: string): Session {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        id: sessionId,
        mode: "observer",
        history: [],
        createdAt: new Date(),
        lastActivity: new Date(),
      });
    }
    const session = this.sessions.get(sessionId)!;
    session.lastActivity = new Date();
    return session;
  }

  getHistory(sessionId: string): Message[] {
    return this.getOrCreate(sessionId).history.slice(-20); // last 20 messages
  }

  addToHistory(sessionId: string, message: Message) {
    const session = this.getOrCreate(sessionId);
    session.history.push(message);
    if (session.history.length > 50) {
      session.history = session.history.slice(-30);
    }
  }

  setMode(sessionId: string, mode: string) {
    this.getOrCreate(sessionId).mode = mode;
  }

  cleanup() {
    const oneHourAgo = new Date(Date.now() - 3_600_000);
    for (const [id, session] of this.sessions) {
      if (session.lastActivity < oneHourAgo) this.sessions.delete(id);
    }
  }
}
```

---

## Module 7: Higgsfield Integration

### Purpose

Proxy requests to the Higgsfield API for image and video generation. The agent can trigger generation by including a `place_media` action — but the actual API call happens server-side so the API key is never exposed to the browser.

### Flow

1. Agent returns a `place_media` action with `url: "pending"` and a `prompt`
2. Backend intercepts, calls Higgsfield API with the prompt
3. Higgsfield returns a URL
4. Backend replaces `url: "pending"` with the real URL
5. Action broadcast to frontend — frontend places the custom shape

### Implementation

```typescript
// src/higgsfield/client.ts
import { config } from "../config";

export interface HiggsImageRequest {
  prompt: string;
  width?: number;
  height?: number;
  style?: string;
}

export interface HiggsVideoRequest {
  prompt: string;
  duration?: number;
  fps?: number;
}

export interface HiggsMediaResult {
  url: string;
  type: "image" | "video";
}

export async function generateImage(req: HiggsImageRequest): Promise<HiggsMediaResult> {
  const response = await fetch("https://api.higgsfield.ai/v1/generate/image", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.HIGGSFIELD_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(req),
  });

  if (!response.ok) {
    throw new Error(`Higgsfield image generation failed: ${response.status}`);
  }

  const data = await response.json() as { url: string };
  return { url: data.url, type: "image" };
}

export async function generateVideo(req: HiggsVideoRequest): Promise<HiggsMediaResult> {
  const response = await fetch("https://api.higgsfield.ai/v1/generate/video", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.HIGGSFIELD_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(req),
  });

  if (!response.ok) {
    throw new Error(`Higgsfield video generation failed: ${response.status}`);
  }

  const data = await response.json() as { url: string };
  return { url: data.url, type: "video" };
}
```

### HTTP endpoints (via Elysia)

```typescript
// In index.ts or a dedicated routes file
app
  .post("/generate/image", async ({ body }) => {
    return generateImage(body as HiggsImageRequest);
  })
  .post("/generate/video", async ({ body }) => {
    return generateVideo(body as HiggsVideoRequest);
  });
```

---

## API Contract with Frontend

### Frontend → Backend (WebSocket events)

```typescript
// 1. Canvas state snapshot — sent on change or periodically
{
  event: "canvas:state",
  data: {
    shapes: TLShape[],         // editor.getCurrentPageShapes()
    bindings: TLBinding[],     // editor.getCurrentPageBindings()
  }
}

// 2. User explicitly invokes the agent
{
  event: "agent:invoke",
  data: {
    message: string,
    selectedShapeIds?: string[],  // editor.getSelectedShapeIds()
    shapes: TLShape[],
    bindings: TLBinding[],
  }
}

// 3. User changes agent mode
{
  event: "agent:set-mode",
  data: { mode: "observer" | "collaborator" | "facilitator" }
}

// 4. User approves/rejects a tentative suggestion
{
  event: "agent:suggestion-response",
  data: { suggestionId: string, approved: boolean }
}

// 5. User requests media generation directly
{
  event: "agent:generate-media",
  data: {
    prompt: string,
    mediaType: "image" | "video",
    x: number,
    y: number,
  }
}
```

### Backend → Frontend (WebSocket events)

```typescript
// 1. Agent performs actions on the canvas
{
  event: "agent:actions",
  data: {
    actions: AgentAction[],     // Frontend applies via editor API
    message?: string,
    isTentative: boolean,       // true = show as ghost, pending approval
    suggestionId?: string,
  }
}

// 2. Agent cursor — inject into tldraw presence system
{
  event: "agent:cursor",
  data: {
    x: number,
    y: number,
    name: "AI Agent",
    color: "#8B5CF6",           // distinctive purple
  }
}

// 3. Agent thinking indicator
{
  event: "agent:thinking",
  data: { isThinking: boolean }
}

// 4. Agent mode changed confirmation
{
  event: "agent:mode-changed",
  data: { mode: "observer" | "collaborator" | "facilitator" }
}

// 5. Connection established
{
  event: "connected",
  data: { clientId: string, sessionId: string }
}

// 6. Media generation result (agent places shape)
{
  event: "agent:actions",
  data: {
    actions: [{ type: "place_media", mediaType: "higgs-image", url: "...", x, y, w, h, prompt }],
    message: "Generated: [prompt]",
    isTentative: false,
  }
}

// 7. Error
{
  event: "agent:error",
  data: { message: string, code: string }
}
```

### Frontend action execution reference

```typescript
// How the frontend maps each action to tldraw Editor API:
import { Editor, createShapeId, toRichText } from "tldraw";

function applyAgentActions(editor: Editor, actions: AgentAction[]) {
  for (const action of actions) {
    switch (action.type) {
      case "create_note":
        editor.createShape({
          id: createShapeId(),
          type: "note",
          x: action.x,
          y: action.y,
          props: { color: action.color || "yellow", richText: toRichText(action.text) },
        });
        break;

      case "create_geo":
        editor.createShape({
          id: createShapeId(),
          type: "geo",
          x: action.x,
          y: action.y,
          props: {
            geo: action.geo || "rectangle",
            w: action.w || 200,
            h: action.h || 200,
            color: action.color || "black",
            fill: action.fill || "none",
            richText: action.text ? toRichText(action.text) : undefined,
          },
        });
        break;

      case "create_text":
        editor.createShape({
          id: createShapeId(),
          type: "text",
          x: action.x,
          y: action.y,
          props: { richText: toRichText(action.text), size: action.size || "m", color: action.color || "black" },
        });
        break;

      case "create_arrow": {
        const arrowId = createShapeId();
        editor.createShape({ id: arrowId, type: "arrow", x: 0, y: 0 });
        editor.createBindings([
          {
            fromId: arrowId,
            toId: action.fromId as any,
            type: "arrow",
            props: { terminal: "start", isExact: false, isPrecise: false, normalizedAnchor: { x: 0.5, y: 0.5 } },
          },
          {
            fromId: arrowId,
            toId: action.toId as any,
            type: "arrow",
            props: { terminal: "end", isExact: false, isPrecise: false, normalizedAnchor: { x: 0.5, y: 0.5 } },
          },
        ]);
        if (action.label) {
          editor.updateShape({ id: arrowId, type: "arrow", props: { richText: toRichText(action.label) } });
        }
        break;
      }

      case "create_frame":
        editor.createShape({
          id: createShapeId(),
          type: "frame",
          x: action.x,
          y: action.y,
          props: { w: action.w, h: action.h, name: action.name },
        });
        break;

      case "update_shape":
        editor.updateShape({
          id: action.shapeId as any,
          type: editor.getShape(action.shapeId as any)!.type,
          ...(action.x !== undefined && { x: action.x }),
          ...(action.y !== undefined && { y: action.y }),
          ...(action.props && { props: action.props }),
        });
        break;

      case "delete_shape":
        editor.deleteShape(action.shapeId as any);
        break;

      case "group_shapes":
        editor.groupShapes(action.shapeIds as any[]);
        break;

      case "reparent":
        editor.reparentShapes(action.shapeIds as any[], action.parentId as any);
        break;

      case "place_media":
        editor.createShape({
          id: createShapeId(),
          type: action.mediaType,  // 'higgs-image' or 'higgs-video'
          x: action.x,
          y: action.y,
          props: { url: action.url, w: action.w || 400, h: action.h || 300, prompt: action.prompt || "" },
        });
        break;
    }
  }
}
```

---

## Custom Canvas Shapes

The frontend registers two custom shape types for Higgsfield-generated media. These are full tldraw shapes — draggable, resizable, synced to all users via CRDT.

### HiggsImageShape

```tsx
// frontend/src/shapes/HiggsImageShape.tsx
import { BaseBoxShapeUtil, HTMLContainer, TLBaseShape } from "tldraw";

type HiggsImageShape = TLBaseShape<"higgs-image", {
  url: string;
  w: number;
  h: number;
  prompt: string;
  generatedBy: "ai" | "user";
}>;

export class HiggsImageShapeUtil extends BaseBoxShapeUtil<HiggsImageShape> {
  static override type = "higgs-image" as const;

  getDefaultProps() {
    return { url: "", w: 400, h: 300, prompt: "", generatedBy: "ai" as const };
  }

  component(shape: HiggsImageShape) {
    return (
      <HTMLContainer>
        <div style={{ position: "relative", width: "100%", height: "100%" }}>
          <img
            src={shape.props.url}
            style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 8 }}
            draggable={false}
          />
          {shape.props.generatedBy === "ai" && (
            <div style={{
              position: "absolute", top: 8, right: 8,
              background: "rgba(0,0,0,0.6)", color: "white",
              borderRadius: 4, padding: "2px 8px", fontSize: 11,
            }}>
              🤖 AI Generated
            </div>
          )}
          <div style={{
            position: "absolute", bottom: 0, left: 0, right: 0,
            background: "rgba(0,0,0,0.5)", color: "white",
            padding: "4px 8px", fontSize: 12, borderRadius: "0 0 8px 8px",
          }}>
            {shape.props.prompt}
          </div>
        </div>
      </HTMLContainer>
    );
  }

  indicator(shape: HiggsImageShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} />;
  }
}
```

### HiggsVideoShape

```tsx
// frontend/src/shapes/HiggsVideoShape.tsx
type HiggsVideoShape = TLBaseShape<"higgs-video", {
  url: string;
  w: number;
  h: number;
  prompt: string;
  autoplay: boolean;
}>;

export class HiggsVideoShapeUtil extends BaseBoxShapeUtil<HiggsVideoShape> {
  static override type = "higgs-video" as const;

  getDefaultProps() {
    return { url: "", w: 480, h: 270, prompt: "", autoplay: true };
  }

  component(shape: HiggsVideoShape) {
    return (
      <HTMLContainer>
        <video
          src={shape.props.url}
          autoPlay={shape.props.autoplay}
          loop
          muted
          controls
          style={{ width: "100%", height: "100%", borderRadius: 8, objectFit: "cover" }}
        />
      </HTMLContainer>
    );
  }

  indicator(shape: HiggsVideoShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} />;
  }
}
```

### Registering custom shapes

```tsx
// frontend/src/App.tsx
import { Tldraw } from "tldraw";
import { HiggsImageShapeUtil } from "./shapes/HiggsImageShape";
import { HiggsVideoShapeUtil } from "./shapes/HiggsVideoShape";

const customShapes = [HiggsImageShapeUtil, HiggsVideoShapeUtil];

export default function App() {
  return <Tldraw shapeUtils={customShapes} />;
}
```

---

## Data Models & Type Definitions

### Shared types (give to frontend)

```typescript
// shared/types.ts
// Re-export the backend's own CanvasShape/CanvasSnapshot types.
// The frontend imports TLShape from tldraw and casts to these before sending.
export type { CanvasShape, CanvasBinding, CanvasSnapshot } from "../canvas/types";

// === Canvas Snapshot (what frontend sends) ===
// Defined in src/canvas/types.ts — see Module 2.

// === Agent Actions ===
export type AgentAction =
  | { type: "create_note"; text: string; x: number; y: number; color?: string }
  | { type: "create_geo"; geo?: string; text?: string; x: number; y: number; w?: number; h?: number; color?: string; fill?: string }
  | { type: "create_text"; text: string; x: number; y: number; size?: string; color?: string }
  | { type: "create_arrow"; fromId: string; toId: string; label?: string }
  | { type: "create_frame"; name: string; x: number; y: number; w: number; h: number }
  | { type: "update_shape"; shapeId: string; props?: Record<string, any>; x?: number; y?: number }
  | { type: "delete_shape"; shapeId: string }
  | { type: "group_shapes"; shapeIds: string[] }
  | { type: "reparent"; shapeIds: string[]; parentId: string }
  | { type: "place_media"; mediaType: "higgs-image" | "higgs-video"; url: string; x: number; y: number; w?: number; h?: number; prompt?: string };

// === Agent Response ===
export interface AgentResponse {
  thinking?: string;
  message?: string;
  actions: AgentAction[];
  cursorTarget?: { x: number; y: number };
}

// === Agent Modes ===
export type AgentMode = "observer" | "collaborator" | "facilitator";
```

---

## System Prompts

```typescript
// src/agent/prompts.ts

const CORE_SYSTEM_PROMPT = `You are an AI brainstorming agent that lives on a collaborative tldraw canvas. You are NOT a chatbot. You are a spatial participant — like another person sitting at a whiteboard.

## Your Identity
- You have a cursor on the canvas. You move, create, and organize things spatially.
- You see the entire canvas: every sticky note, every connection, every cluster, every frame.
- You think about WHERE things should go, not just WHAT to say.
- You can generate images and videos via Higgsfield by returning a place_media action with a prompt.

## How You Respond
You MUST respond with a valid JSON object:
{
  "thinking": "your internal reasoning (optional)",
  "message": "a brief message to the team (optional)",
  "actions": [ /* array of canvas actions */ ],
  "cursorTarget": { "x": number, "y": number }
}

## Action Types (tldraw Editor API)
- create_note: { type: "create_note", text: string, x: number, y: number, color?: "yellow"|"blue"|"green"|"light-green"|"orange"|"light-red"|"red"|"violet"|"light-violet"|"grey"|"light-blue"|"black"|"white" }
- create_geo: { type: "create_geo", geo?: "rectangle"|"ellipse"|"triangle"|"diamond"|"cloud"|"star"|"heart", text?: string, x: number, y: number, w?: number, h?: number, color?: string, fill?: "none"|"semi"|"solid"|"pattern" }
- create_text: { type: "create_text", text: string, x: number, y: number, size?: "s"|"m"|"l"|"xl", color?: string }
- create_arrow: { type: "create_arrow", fromId: string, toId: string, label?: string }
- create_frame: { type: "create_frame", name: string, x: number, y: number, w: number, h: number }
- update_shape: { type: "update_shape", shapeId: string, props?: object, x?: number, y?: number }
- delete_shape: { type: "delete_shape", shapeId: string }
- group_shapes: { type: "group_shapes", shapeIds: string[] }
- reparent: { type: "reparent", shapeIds: string[], parentId: string }
- place_media: { type: "place_media", mediaType: "higgs-image"|"higgs-video", url: "pending", x: number, y: number, w?: number, h?: number, prompt: string }

## tldraw-Specific Rules
1. Shape IDs follow the format "shape:xxxxxxxx" — reference them exactly as given in the canvas description.
2. Sticky notes (type "note") are ~200x200px. Space them at least 250px apart.
3. Arrows connect via bindings — just provide fromId and toId, tldraw handles routing.
4. Use reparent to move shapes into an existing frame instead of creating a new one.
5. group_shapes creates a tldraw group — children stay individually editable but move together.
6. For place_media, set url to "pending" — the backend will call Higgsfield and fill in the real URL.

## Spatial Rules
1. NEVER stack elements on top of each other. Space notes at least 250px apart.
2. Place related ideas NEAR each other. Use proximity to show relationships.
3. When creating a cluster of new notes, arrange them in a grid or arc pattern.
4. When grouping existing notes, calculate a frame that encompasses them with 50px padding.
5. Use color to encode meaning (green for solutions, light-red for problems, blue for questions, yellow for ideas).

## Behavioral Rules
1. Be concise on sticky notes — 3-12 words max per note.
2. Don't repeat what's already on the canvas.
3. When grouping, use a short, evocative label (2-4 words).
4. Use arrows sparingly — only for causal or sequential relationships.
5. Always respond with valid JSON. No markdown, no explanations outside the JSON.
6. When visual content would help (mood boards, concepts, references), use place_media with a descriptive prompt.
`;

const PROACTIVE_ADDENDUM = `
## Proactive Evaluation
You are evaluating the canvas to decide if you should contribute unprompted.

Analyze and decide:
1. Are there ungrouped notes sharing a clear theme? → Group them with create_frame or group_shapes.
2. Is there a gap or blind spot? → Add a note pointing it out.
3. Are there implicit connections not drawn? → Add arrows.
4. Is the canvas getting disorganized? → Reorganize with reparent or move.
5. Would visual content (image/video) enrich the brainstorm? → Use place_media.

If nothing valuable to contribute right now:
{ "actions": [], "message": null }

Do NOT contribute just for the sake of it. Quality over quantity.
`;

export function buildPrompt(input: {
  canvasDescription: string;
  userMessage: string;
  history: { role: "user" | "assistant"; content: string }[];
  modeAddendum: string;
  isProactive: boolean;
}): { system: string; messages: { role: "user" | "assistant"; content: string }[] } {
  let system = CORE_SYSTEM_PROMPT + "\n\n" + input.modeAddendum;
  if (input.isProactive) system += "\n\n" + PROACTIVE_ADDENDUM;

  const messages = [...input.history.slice(-10)];

  let currentMessage = `## Current Canvas State\n${input.canvasDescription}`;
  if (input.userMessage) currentMessage += `\n\n## User Request\n${input.userMessage}`;
  currentMessage += input.isProactive
    ? `\n\n## Task\nEvaluate the canvas and decide whether to contribute. Respond with JSON only.`
    : `\n\n## Task\nRespond to the user's request with canvas actions. Respond with JSON only.`;

  messages.push({ role: "user", content: currentMessage });
  return { system, messages };
}
```

---

## Error Handling Strategy

| Category | Example | Response |
|---|---|---|
| Claude API failure | Timeout, 500, rate limit | Retry once with 2s backoff. Send `agent:error` if still failing. |
| Invalid JSON from Claude | Malformed response | Fallback to `{ actions: [], message: "..." }`. Log raw response. |
| Invalid shape references | Arrow to nonexistent shape | Silently drop invalid action, proceed with valid ones. |
| Higgsfield failure | API error, timeout | Send `agent:error` with code `HIGGSFIELD_ERROR`. |
| WebSocket disconnect | Client drops | Clean up client entry. Session persists for reconnection. |
| Canvas state missing | invoke without shapes | Respond with error `MISSING_CANVAS_STATE`. |

### Error codes

```typescript
export const ERROR_CODES = {
  CLAUDE_API_ERROR: "CLAUDE_API_ERROR",
  PARSE_ERROR: "PARSE_ERROR",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  MISSING_CANVAS_STATE: "MISSING_CANVAS_STATE",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  HIGGSFIELD_ERROR: "HIGGSFIELD_ERROR",
} as const;
```

---

## Cloudflare Deployment

### Why Cloudflare Workers + Durable Objects

| Need | Solution |
|---|---|
| Stateful WebSocket per room | Durable Object (one per `roomId`) |
| REST API routes | Elysia with `CloudflareAdapter` |
| AI agent as separate presence | Agent calls backend, pushes shapes via WS |
| Hibernatable WebSockets | Built into Durable Objects — sleeps between messages, no idle billing |
| Per-room SQLite | Each Durable Object has built-in SQLite for history/state |

### Free tier

| Resource | Free | Paid ($5/mo) |
|---|---|---|
| Requests | 100k/day | 1M included |
| Compute | 13,000 GB-s/day | 400,000 GB-s included |
| SQLite storage | 5 GB total | 10 GB per object |

Hibernatable WebSockets (used by tldraw sync) do **not** bill for idle duration — rooms with inactive users cost nothing.

### Architecture with Durable Objects

The tldraw starter kit already provides the Durable Object and WebSocket plumbing. You extend `worker/worker.ts` to add agent HTTP routes alongside the existing tldraw sync routes.

```typescript
// worker/worker.ts — extend the starter kit's existing worker
// (the starter kit already exports the Durable Object class and handles /room/:roomId/ws)

import { AgentEngine } from "../src/agent/engine";
import { SessionStore } from "../src/session/store";
import { generateImage, generateVideo } from "../src/higgsfield/client";

const sessionStore = new SessionStore();
const agentEngine = new AgentEngine(sessionStore);

// Add these routes to the existing worker fetch handler:

// Agent invocation — frontend POSTs here instead of opening a second WS
export async function handleAgentInvoke(request: Request, env: Env): Promise<Response> {
  const { roomId } = /* parse from URL */ {} as any;
  const body = await request.json() as AgentInvokeRequest;

  // Get the Durable Object stub for this room
  const id = env.TLDRAW_DURABLE_OBJECT.idFromName(roomId);
  const roomStub = env.TLDRAW_DURABLE_OBJECT.get(id);

  // Run the agent
  const result = await agentEngine.handleInvoke(roomId, body.message, body);
  if (!result) return Response.json({ ok: false });

  // Push results via TLSocketRoom.sendCustomMessage() to all connected clients
  await roomStub.broadcastAgentActions(result); // see TldrawDurableObject.ts extension below

  return Response.json({ ok: true });
}
```

```typescript
// worker/TldrawDurableObject.ts — add a helper method to the existing class
// (don't replace the class — just add this method alongside TLSocketRoom)

broadcastAgentActions(result: AgentResponse) {
  for (const session of this.room.getSessions()) {
    this.room.sendCustomMessage(session.sessionId, {
      event: "agent:actions",
      data: { actions: result.actions, message: result.message, isTentative: false },
    });
  }
}
```

### wrangler.jsonc

```jsonc
{
  "name": "canvas-backend",
  "main": "src/index.ts",
  "compatibility_date": "2025-06-01",
  "durable_objects": {
    "bindings": [{ "name": "CANVAS_ROOM", "class_name": "CanvasRoom" }]
  },
  "vars": {
    "HIGGSFIELD_API_KEY": "",
    "ANTHROPIC_API_KEY": ""
  }
}
```

**Note:** `Elysia.file` and the Static Plugin do not work on Cloudflare Workers (no `fs` module). Serve the React frontend via Cloudflare Pages or Workers Assets — standard pattern anyway.

---

## Build Order & Milestones

### Milestone 1: Starter Kit + Agent Route Stub

- [x] Clone / scaffold from [tldraw multiplayer starter kit](https://tldraw.dev/starter-kits/multiplayer)
- [x] `worker/TldrawDurableObject.ts` — `TLSocketRoom` with SQLite persistence, fully wired
- [x] `worker/worker.ts` — `itty-router` with `/api/connect/:roomId`, asset upload/download, unfurl
- [x] `client/pages/Room.tsx` — `useSync` connected to worker, canvas syncs between tabs
- [x] `wrangler dev` confirmed working (`.wrangler/state` has live DO SQLite data)
- [x] `src/config.ts` — constants (model, intervals, thresholds); secrets come from `env` param, not process.env
- [x] `src/env.d.ts` — extends global `Env` with `ANTHROPIC_API_KEY` and `HIGGSFIELD_API_KEY`
- [x] `.dev.vars` — local dev secrets file (gitignored); production secrets via `wrangler secret put`
- [x] `POST /api/rooms/:roomId/agent/invoke` — stub in `worker/worker.ts`, validates body, logs, returns `{ ok: true }`
- [x] `POST /api/rooms/:roomId/agent/set-mode` — stub, validates mode enum, returns `{ ok: true, mode }`
- [ ] Verify: `wrangler dev`, POST to agent routes, confirm stub responses

### Milestone 2: Canvas Serializer

- [ ] `CanvasSnapshot` type (`CanvasShape[]` + `CanvasBinding[]`) — local types, no tldraw import
- [ ] `findClusters()` — proximity clustering (300px threshold for tldraw note size)
- [ ] `getRegionLabel()` — infinite canvas (coordinate quadrant + raw coords)
- [ ] `serializeCanvasState()` — 8-section output
- [ ] `richText` ProseMirror extraction
- [ ] Arrow resolution via bindings
- [ ] `index.ts` updated to store snapshot per session

### Milestone 3: Claude Integration

- [ ] `claude.ts` — Anthropic SDK wrapper, `callClaude()` + `callClaudeStream()`, retry on 429
- [ ] `config.ts` — `ANTHROPIC_API_KEY` from env
- [ ] `prompts.ts` — `CORE_SYSTEM_PROMPT` with tldraw action types + spatial rules
- [ ] `buildPrompt()` composing system + history + canvas description
- [ ] Test: hardcoded canvas snapshot → Claude returns valid JSON with tldraw actions
- [ ] Verify: response parses into `AgentResponse` without TypeBox errors (`Value.Parse`)

### Milestone 4: End-to-End Loop

- [ ] `actions/types.ts` — all tldraw action TypeBox schemas (`@sinclair/typebox`)
- [ ] `actions/parser.ts` — parse Claude response, strip markdown fences
- [ ] `actions/validator.ts` — validate shape IDs against snapshot
- [ ] Wire `agent:invoke` handler to real Claude call
- [ ] Broadcast `agent:actions` to all clients in session
- [ ] Verify: frontend sends invoke → backend returns actions → shapes appear on canvas

### Milestone 5: Agent Modes

- [ ] `modes.ts` with `MODE_CONFIGS`
- [ ] `engine.ts` — `AgentEngine` class with `handleInvoke` and `handleProactive`
- [ ] `session/store.ts` — in-memory history, 50 message cap, 1hr TTL cleanup
- [ ] Wire `agent:set-mode` handler to real mode switching
- [ ] Proactive timer per session in `index.ts`
- [ ] Verify: collaborator mode fires every 45s and adds a suggestion

### Milestone 6: Higgsfield Integration

- [ ] `higgsfield/client.ts` — `generateImage()` and `generateVideo()` wrappers
- [ ] Handle `place_media` actions with `url: "pending"` — call Higgsfield, fill real URL
- [ ] HTTP routes `POST /generate/image` and `POST /generate/video` via Elysia
- [ ] Verify: agent returns `place_media` → backend resolves URL → frontend places custom shape

### Milestone 7: Polish

- [ ] Agent cursor broadcasting after each action response
- [ ] `agent:thinking` indicator (broadcast before/after Claude call)
- [ ] Tentative suggestion flow with approve/reject
- [ ] Error handling edge cases with `ERROR_CODES`
- [ ] Session history trimming and cleanup interval
- [ ] Cloudflare Workers deployment with Durable Objects

### Definition of "Demo Ready"

- [ ] User types a request → agent places notes on canvas
- [ ] Agent groups scattered notes by theme when asked
- [ ] Mode switch works: observer → collaborator shows proactive behavior
- [ ] Agent cursor visible on canvas (purple, labeled "AI Agent")
- [ ] "Generate an image of X" → Higgsfield image appears as custom shape on canvas
- [ ] No crashes during a 10-minute collaborative session
