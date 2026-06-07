import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	// Svelte dev tools: source maps + 快重载
	build: {
		sourcemap: true
	},
	server: {
		fs: {
			// 允许从 packages/ 读类型
			allow: ['..']
		}
	}
});
