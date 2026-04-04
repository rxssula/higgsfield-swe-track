// Extends the global Env interface (declared in worker-configuration.d.ts)
// with agent-specific secrets. Set these via:
//   - Local dev: .dev.vars file
//   - Production: `wrangler secret put KEY`
interface Env {
	OPENROUTER_API_KEY: string
	OPENROUTER_MODEL: string
	HIGGSFIELD_API_KEY: string
	HIGGSFIELD_API_SECRET: string
	HIGGSFIELD_MODEL: string
	HIGGSFIELD_MODEL_IMAGE_TO_TEXT: string
}
