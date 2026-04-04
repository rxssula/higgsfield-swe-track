# API Endpoints & WebSocket Contract

All real-time communication uses WebSocket. HTTP endpoints are used for generation requests (Higgsfield proxy) and health checks.

---

## Table of Contents

1. [WebSocket — Frontend → Backend](#websocket--frontend--backend)
2. [WebSocket — Backend → Frontend](#websocket--backend--frontend)
3. [HTTP Endpoints](#http-endpoints)
4. [Data Types Reference](#data-types-reference)

---

## WebSocket — Frontend → Backend

### Existing events

---

#### `canvas:state`
Sent periodically or on every canvas change. Gives the agent a fresh snapshot to reason about.

```ts
{
  event: "canvas:state",
  data: {
    shapes:   TLShape[],     // editor.getCurrentPageShapes()
    bindings: TLBinding[],   // editor.getCurrentPageBindings()
  }
}
```

---

#### `agent:invoke`
User explicitly sends a text prompt to the agent.

```ts
{
  event: "agent:invoke",
  data: {
    message:          string,
    selectedShapeIds?: string[],   // editor.getSelectedShapeIds()
    shapes:           TLShape[],
    bindings:         TLBinding[],
  }
}
```

---

<!-- #### `agent:set-mode`
Switch between observer / collaborator / facilitator.

```ts
{
  event: "agent:set-mode",
  data: {
    mode: "observer" | "collaborator" | "facilitator"
  }
}
```

---

#### `agent:suggestion-response`
User approves or rejects a tentative agent suggestion.

```ts
{
  event: "agent:suggestion-response",
  data: {
    suggestionId: string,
    approved:     boolean,
  }
}
``` -->

---

### New events

---

#### `agent:set-ignore-zone`
User draws/selects a rectangular area on the canvas that the agent must not touch — no shapes created, moved, or deleted inside this region.

```ts
{
  event: "agent:set-ignore-zone",
  data: {
    zoneId: string,          // client-generated ID so it can be removed later
    x:      number,
    y:      number,
    width:  number,
    height: number,
    label?: string,          // optional user label, e.g. "My work in progress"
  }
}
```

**Backend behaviour:** stores the zone in session state. Before broadcasting any `agent:actions`, filter out actions whose target coordinates fall inside any active ignore zone.

---

#### `agent:clear-ignore-zone`
Remove a previously set ignore zone.

```ts
{
  event: "agent:clear-ignore-zone",
  data: {
    zoneId: string,   // "all" clears every zone for the session
  }
}
```

---

#### `agent:generate-in-area`
User selects an area on the canvas and types a prompt. The agent generates content (notes, image, video, shapes) and places it inside that bounding box.

```ts
{
  event: "agent:generate-in-area",
  data: {
    prompt:  string,
    x:       number,
    y:       number,
    width:   number,
    height:  number,
    mediaType?: "text" | "image" | "video",  // hint; agent decides if omitted
    shapes:   TLShape[],     // current canvas context
    bindings: TLBinding[],
  }
}
```

**Backend behaviour:** serialises canvas, builds a constrained prompt instructing the agent to place all output within `[x, y, x+width, y+height]`. If `mediaType` is `"image"` or `"video"`, calls Higgsfield and returns a `place_media` action pointing into the area.

---

#### `agent:voice-input`
Transcript from the user's microphone, sent after speech-to-text (browser Web Speech API or Whisper).

```ts
{
  event: "agent:voice-input",
  data: {
    transcript: string,
    shapes:     TLShape[],
    bindings:   TLBinding[],
    isFinal:    boolean,     // false = interim result, true = committed utterance
  }
}
```

**Backend behaviour:** only process when `isFinal: true`. Treat the transcript as a regular `agent:invoke` message.

---

#### `agent:set-focus-area`
User selects a region or specific shapes that the agent should prioritise when making proactive contributions.

```ts
{
  event: "agent:set-focus-area",
  data: {
    // Option A — bounding box
    area?: {
      x:      number,
      y:      number,
      width:  number,
      height: number,
    },
    // Option B — specific shape IDs
    shapeIds?: string[],
    // Pass null to clear focus
    clear?: boolean,
  }
}
```

**Backend behaviour:** stores focus in session state. When building the system prompt, prepend the focused region's serialised content before the full canvas description so the model pays more attention to it.

---

#### `agent:set-contribution-level`
Fine-grained control over how much the agent contributes, independent of mode. A number from `0` (silent) to `100` (maximum).

```ts
{
  event: "agent:set-contribution-level",
  data: {
    level: number,   // 0–100
    // 0        = never contribute proactively (same as observer)
    // 1–33     = low  — only contribute on clear opportunities
    // 34–66    = medium — collaborator behaviour
    // 67–100   = high — facilitator behaviour
  }
}
```

**Backend behaviour:** maps level to proactive interval and aggressiveness. Overrides the mode's default interval:

| Level | Proactive interval | Actions per contribution |
|---    |---                 |---                       |
| 0     | disabled           | 0                        |
| 1–33  | 90s                | 1                        |
| 34–66 | 45s                | 1–2                      |
| 67–100| 20s                | 3–5                      |

---

## WebSocket — Backend → Frontend

### Existing events

---

#### `connected`
```ts
{
  event: "connected",
  data: { clientId: string, sessionId: string }
}
```

---

#### `agent:actions`
Agent performs canvas operations. Frontend applies each action via the tldraw Editor API.

```ts
{
  event: "agent:actions",
  data: {
    actions:      AgentAction[],
    message?:     string,
    isTentative:  boolean,      // true = show as ghost, needs approval
    suggestionId?: string,      // present when isTentative is true
  }
}
```

---

#### `agent:thinking`
```ts
{
  event: "agent:thinking",
  data: { isThinking: boolean }
}
```

---

<!-- #### `agent:cursor`
Agent presence — inject into tldraw's awareness/presence system so users see the AI cursor.

```ts
{
  event: "agent:cursor",
  data: {
    x:     number,
    y:     number,
    name:  "AI Agent",
    color: "#8B5CF6",
  }
}
``` -->

---

#### `agent:mode-changed`
```ts
{
  event: "agent:mode-changed",
  data: { mode: "observer" | "collaborator" | "facilitator" }
}
```

---

#### `agent:error`
```ts
{
  event: "agent:error",
  data: { message: string, code: string }
}
```

---

### New events

---

#### `agent:suggestion`
Agent proposes a text suggestion (not a canvas action — just a message in the UI, e.g. "Should I group these three ideas?"). User can dismiss, approve, or act on it.

```ts
{
  event: "agent:suggestion",
  data: {
    suggestionId: string,
    text:         string,
    actionPreview?: AgentAction[],  // what will happen if approved
  }
}
```

---

#### `agent:ignore-zone-ack`
Confirms a zone was registered or cleared.

```ts
{
  event: "agent:ignore-zone-ack",
  data: {
    zoneId:  string,
    action:  "set" | "cleared",
    active:  IgnoreZone[],    // current list of all active zones
  }
}
```

---

#### `agent:focus-area-ack`
Confirms focus area was updated.

```ts
{
  event: "agent:focus-area-ack",
  data: {
    active: boolean,   // false = focus was cleared
  }
}
```

---

#### `agent:contribution-level-ack`
Confirms contribution level was applied.

```ts
{
  event: "agent:contribution-level-ack",
  data: {
    level:    number,
    interval: number,   // resulting proactive interval in ms (0 = disabled)
  }
}
```

---

#### `agent:media-generating`
Sent immediately when a Higgsfield job starts, so the frontend can show a loading placeholder at the target coordinates.

```ts
{
  event: "agent:media-generating",
  data: {
    jobId:     string,
    mediaType: "image" | "video",
    prompt:    string,
    x:         number,
    y:         number,
    w:         number,
    h:         number,
  }
}
```

---

#### `agent:voice-ack`
Confirms the voice transcript was received and is being processed.

```ts
{
  event: "agent:voice-ack",
  data: { transcript: string }
}
```

---

## HTTP Endpoints

All HTTP routes are handled by Elysia. For Cloudflare deployment, generation calls are proxied here so API keys stay server-side.

---

### `POST /generate/image`

Call Higgsfield to generate an image. Returns a URL the frontend (or agent) can use to place a `higgs-image` shape.

**Request**
```ts
{
  // prompt:  string,
  // width?:  number,   // default 512
  // height?: number,   // default 512
  // style?:  string,

  model specification
  curl -X POST 'https://platform.higgsfield.ai/higgsfield-ai/soul/standard' \
  --header 'Authorization: Key {your_api_key}:{your_api_key_secret}' \
  --data {
    "prompt": "your prompt here",
    "aspect_ratio": "16:9",
    "resolution": "720p"
  }
}
```

**Response**
<!-- ```ts
{
  url:    string,
  jobId:  string,
}
``` -->

Queue
```ts
{
  "status": "queued",
  "request_id": "d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff",
  "status_url": "https://platform.higgsfield.ai/requests/d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff/status",
  "cancel_url": "https://platform.higgsfield.ai/requests/d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff/cancel"
}
```

Complete
```ts
{
  "status": "completed",
  "request_id": "d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff",
  "status_url": "https://platform.higgsfield.ai/requests/d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff/status",
  "cancel_url": "https://platform.higgsfield.ai/requests/d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff/cancel",
  "images": [
    {
      "url": "https://image.url/example.jpg"
    }
  ],
  "video": {
    "url": "https://video.url/example.mp4"
  }
}
```

**Error** `500`
```ts
{ error: string, code: "HIGGSFIELD_ERROR" }
```

---

### `POST /generate/video`

Call Higgsfield to generate a video.

**Request**
```ts
{
  prompt:     string,
  duration?:  number,   // seconds, default 4
  fps?:       number,   // default 24
}
```

**Response**
```ts
{
  url:    string,
  jobId:  string,
}
```

**Error** `500`
```ts
{ error: string, code: "HIGGSFIELD_ERROR" }
```

---

### `GET /health`

Health check for load balancer / uptime monitoring.

**Response** `200`
```ts
{ status: "ok", ts: number }
```

---

## Data Types Reference

```ts
interface IgnoreZone {
  zoneId: string,
  x:      number,
  y:      number,
  width:  number,
  height: number,
  label?: string,
}

interface FocusArea {
  area?: { x: number, y: number, width: number, height: number },
  shapeIds?: string[],
}

// All AgentAction types — see documentation.md Module 4
type AgentAction =
  | { type: "create_note";   text: string; x: number; y: number; color?: string }
  | { type: "create_geo";    geo?: string; text?: string; x: number; y: number; w?: number; h?: number; color?: string; fill?: string }
  | { type: "create_text";   text: string; x: number; y: number; size?: string; color?: string }
  | { type: "create_arrow";  fromId: string; toId: string; label?: string }
  | { type: "create_frame";  name: string; x: number; y: number; w: number; h: number }
  | { type: "update_shape";  shapeId: string; props?: Record<string, any>; x?: number; y?: number }
  | { type: "delete_shape";  shapeId: string }
  | { type: "group_shapes";  shapeIds: string[] }
  | { type: "reparent";      shapeIds: string[]; parentId: string }
  | { type: "place_media";   mediaType: "higgs-image" | "higgs-video"; url: string; x: number; y: number; w?: number; h?: number; prompt?: string };
```
