import { defineConfig } from 'drizzle-kit';

/**
 * 配置策略：本地生成 SQL migration 文件，再用 wrangler CLI apply 到 D1
 * 优点：不需要 CLOUDFLARE_ACCOUNT_ID / D1_TOKEN（wrangler 用 OAuth 自动鉴权）
 * 流程：
 *   1. bun run db:generate        生成 SQL 到 ./drizzle/migrations/
 *   2. wrangler d1 create sol-dca-dashboard
 *   3. 把 database_id 填到 wrangler.toml
 *   4. bun run db:migrate:remote  wrangler apply 到远端 D1
 */
export default defineConfig({
	schema: './src/db/schema.js',
	out: './drizzle/migrations',
	dialect: 'sqlite',
	verbose: true,
	strict: true
});
