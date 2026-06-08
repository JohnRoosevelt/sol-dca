# DO CRUD 例子

Cloudflare Durable Object 的 SQLite-backed storage (`ctx.storage.sql`) 完整 CRUD。

## 跑起来

```bash
cd examples/do-crud
wrangler dev
```

## 试一下

```bash
# CREATE
curl -X POST http://localhost:8787/users \
  -H 'content-type: application/json' \
  -d '{"id":"alice","name":"Alice","email":"alice@example.com","age":30,"meta":{"city":"Berlin"}}'

# READ 单条
curl http://localhost:8787/users/alice

# READ 列表 + 过滤
curl 'http://localhost:8787/users?limit=10&name=Ali'

# UPDATE
curl -X PUT http://localhost:8787/users/alice \
  -H 'content-type: application/json' \
  -d '{"age":31}'

# DELETE
curl -X DELETE http://localhost:8787/users/alice
```

## 关键点

1. **建表用 `blockConcurrencyWhile`** — 启动时建表, 拒绝请求直到建完。
2. **SQL API 是同步的** — `ctx.storage.sql.exec()` 不返回 Promise, 直接 `.toArray()`。
3. **事务用 `transactionSync()`** — 失败自动回滚, 适合批量写。
4. **DO 通过 `stub.fetch(request)` 接收请求** — DO 内部自己实现 `fetch()` 路由。
5. **多个 DO 实例** = `idFromName(name)` 给不同 name, 名字相同 → 同一实例。

## 跟老 KV API 对照

```js
// 老 KV 风格 (ctx.storage.put/get/delete/list)
await ctx.storage.put("user:alice", { name: "Alice" });
const user = await ctx.storage.get("user:alice");
await ctx.storage.delete("user:alice");
const list = await ctx.storage.list({ prefix: "user:" });

// 新 SQL 风格 (推荐, 2024+)
// 上面 examples/do-crud/src/index.js 里全是
```

KV 简单但弱 (无索引、无复杂查询、值是任意 JS); SQL 支持 JOIN/WHERE/ORDER BY,
关系型查询更强。**新项目直接用 SQL API**。
