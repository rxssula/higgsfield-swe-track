// Test script: connects to the WebSocket, then fires the agent invoke HTTP request.
// Run with: node test-ws.mjs
//
// Make sure `npm run dev` is running first.

const ROOM_ID = 'test-room'
const BASE = 'http://localhost:5173'
const WS_BASE = 'ws://localhost:5173'
const SESSION_ID = 'test-session-' + Date.now()

// 1. Connect to the WebSocket room (same as the frontend does)
const ws = new WebSocket(`${WS_BASE}/api/connect/${ROOM_ID}?sessionId=${SESSION_ID}`)

ws.addEventListener('open', async () => {
  console.log('[ws] connected\n')

  // Send the tldraw connect handshake so TLSocketRoom keeps the connection alive
  ws.send(JSON.stringify({ type: 'connect', connectRequestId: SESSION_ID, schema: { schemaVersion: 2, sequences: {} }, protocolVersion: 6 }))

  // Small delay to let the handshake complete before firing the invoke
  await new Promise((r) => setTimeout(r, 500))

  // 2. Fire the agent invoke — results come back via the WebSocket above
  const res = await fetch(`${BASE}/api/rooms/${ROOM_ID}/agent/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'find the strongest idea',
      shapes: [
        {
          id: 'shape:abc123',
          type: 'note',
          x: 120,
          y: 340,
          rotation: 0,
          parentId: 'page:page1',
          props: {
            color: 'yellow',
            richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Users hate onboarding' }] }] },
          },
        },
        {
          id: 'shape:def456',
          type: 'note',
          x: 380,
          y: 360,
          rotation: 0,
          parentId: 'page:page1',
          props: {
            color: 'green',
            richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Gamify first 5 minutes' }] }] },
          },
        },
        {
          id: 'shape:ghi789',
          type: 'note',
          x: 900,
          y: 120,
          rotation: 0,
          parentId: 'page:page1',
          props: {
            color: 'violet',
            richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Pricing is confusing' }] }] },
          },
        },
      ],
      bindings: [],
    }),
  })

  const json = await res.json()
  console.log('[http] invoke response:', json, '\n')
  console.log('[ws] waiting for agent events...\n')
})

ws.addEventListener('message', (event) => {
  try {
    const msg = JSON.parse(event.data)

    // tldraw sends its own sync protocol messages — filter to agent events only
    if (msg.type === 'custom') {
      const data = msg.data
      if (data.type === 'agent:status') {
        console.log(`[agent:status] ${data.status}`)
      } else if (data.type === 'agent:done') {
        console.log(`[agent:done]`)
        console.log(`  synthesis: ${data.synthesis}`)
        console.log(`  prompt:    ${data.prompt}`)
        console.log(`  imageUrl:  ${data.imageUrl}`)
        ws.close()
      } else if (data.type === 'agent:error') {
        console.error(`[agent:error] ${data.message}`)
        ws.close()
      }
    }
  } catch {
    // ignore non-JSON messages from tldraw sync protocol
  }
})

ws.addEventListener('error', (e) => console.error('[ws] error:', e.message))
ws.addEventListener('close', () => console.log('\n[ws] disconnected'))
