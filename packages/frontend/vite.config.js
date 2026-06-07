import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

/**
 * Frontend vite config — SvelteKit + Cloudflare.
 *
 * 关键：`@cloudflare/vite-plugin` 让 vite 启一个统一的 miniflare 实例，
 * 跑 frontend (Pages) + do-worker (TickerHub) 两个 worker，
 * service binding `SOL_DCA_WORKER` 自动联通。
 *
 * 不装这个 plugin 的话，platformProxy 模拟 service binding 时找不到 do-worker，
 * `/api/state` 会报 503 "Worker not found"。
 *
 * `vite.config.js` 里不再放 `wrangler` config — 全部从 `wrangler.toml` 读。
 */
export default defineConfig({
	plugins: [sveltekit(), cloudflare()]
});
