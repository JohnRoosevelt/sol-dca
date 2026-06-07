import adapter from '@sveltejs/adapter-cloudflare';

/**
 * SvelteKit config — Cloudflare Pages output.
 *
 * Pages mode 由 `wrangler.toml` 里的 `pages_build_output_dir` 触发
 * (adapter 读 wrangler config 自动判别)。
 *
 * dev 用 `platformProxy: { remote: false }` 让 wrangler getPlatformProxy 走本地
 * 模拟 (miniflare) — 默认走 remote 模式要 OAuth login, dev 不便
 */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => filename.split(/[/\\]/).includes('node_modules') ? undefined : true
	},
	kit: {
		adapter: adapter({
			platformProxy: {
				remoteBindings: false
			}
		})
  },
  vitePlugin: {
    inspector: {
      showToggleButton: "always",
    },
  },
};

export default config;
