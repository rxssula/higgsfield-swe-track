// Extends the global Env interface (declared in worker-configuration.d.ts)
// with agent-specific secrets. Set these via:
//   - Local dev: .dev.vars file
//   - Production: `wrangler secret put ANTHROPIC_API_KEY`
interface Env {
	ANTHROPIC_API_KEY: string
	HIGGSFIELD_API_KEY: string
}
