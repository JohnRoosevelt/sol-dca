# REASONIX.md — sol-dca-dashboard

## Stack

- **Runtime**: Cloudflare Workers + SvelteKit (Pages) — edge-deployed, no Node.js server
- **Language**: JavaScript (`.js`, `.svelte`) — **no TypeScript** (strict: false, checkJs: false)
- **Package manager**: bun (workspaces monorepo in `packages/*`)
- **Key deps**: Svelte 5 (runes mode), `@sveltejs/adapter-cloudflare`, wrangler, Durable Objects (SQLite storage)

## Layout

```
packages/do-worker/     — Cloudflare Worker: TickerHub DO, OKX WS bridge, strategy engine
packages/frontend/      — SvelteKit 5 app deployed to Cloudflare Pages
docs/                   — ARCHITECTURE.md, DEPLOYMENT.md, backtest/strategy docs
examples/do-crud/       — Standalone CRUD example (not part of the dashboard)
```

## Commands

| Command | What it does |
|---------| ------------ |
| `bun run dev` | Starts both frontend (`:5173`) + worker (`:8787`) concurrently |
| `bun run build` | Builds frontend (vite) + worker (wrangler bundles on deploy) |
| `bun run deploy` | Deploys both to Cloudflare |
| `bun run check` | (frontend only) `svelte-check` — the sole type/lint check |
| `bun run dev:frontend` | Frontend only (Vite dev server, port 5173) |
| `bun run dev:worker` | Worker only (wrangler dev, port 8787) |

## Conventions

- **No TypeScript** — all code is `.js` / `.svelte`; svelte-check is the only validation
- **ESM** everywhere (`"type": "module"` in all `package.json`s)
- **No tests exist** — no test runner, no `*.test.*` or `*.spec.*` files found
- **JSDoc** used for module-level docblocks in worker source (`src/index.js`, `src/ticker-hub.js`)
- **Export style** — worker exports a Durable Object class `TickerHub` for wrangler binding; frontend uses SvelteKit `+page.svelte` / `+page.server.js` / `hooks.server.js` routing conventions
- **DO naming** — demo/live isolation via `idFromName('sol-usdt-demo' | 'sol-usdt-live')`
- **No lint/format config** — no eslint, no prettier, no biome

## Watch out for

- **Worker has no build step** — `bun run build` echoes a no-op; wrangler bundles on deploy
- **Browser WS must connect to worker URL directly** — Cloudflare Pages Functions don't support WebSocket upgrade; the frontend connects to `PUBLIC_WS_URL` (default `ws://localhost:8787/ws` in dev)
- **`svelte-check` is the only static analysis** — `checkJs: false` means no JS type-checking; only Svelte template / runes errors surface
- **DO storage is SQLite** — `state.storage.sql` is the hot-data path; migration tags in `wrangler.toml` (`[[migrations]]`) must be updated when DO schema changes
