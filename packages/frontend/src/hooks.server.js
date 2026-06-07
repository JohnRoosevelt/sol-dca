/**
 * SvelteKit server hooks
 *
 * 当前是 passthrough（不拦截请求）。
 *
 * 注意：TickerHub DO class **不在** 这里 export。
 * 之前 mavis 试过 module-level export DO 解决 wrangler 找不到 class 的问题，
 * 但这是错的方案（SvelteKit hooks 被 tree-shake 掉；adapter 也不认）。
 * 现在 TickerHub 在独立 worker `packages/do-worker/src/index.js` 顶部 export，
 * wrangler 直接识别，不需要 SvelteKit 这边做 hack。
 */

/** @type {import('@sveltejs/kit').Handle} */
export async function handle({ event, resolve }) {
	return resolve(event);
}
