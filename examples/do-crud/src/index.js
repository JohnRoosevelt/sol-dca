// examples/do-crud/src/index.js
//
// Cloudflare Durable Object CRUD 完整例子
// 用法：
//   cd examples/do-crud
//   wrangler dev          # 起本地
//   curl http://localhost:8787/users/alice
//
// 核心 API: ctx.storage.sql (Workers 2024+ 新版 SQLite-backed storage)
// 事务性、自动持久化、单 DO 内强一致。

import { DurableObject } from "cloudflare:workers";

export { UserDO };

// ─────────────────────────────────────────────────────────────
// Durable Object 类
// ─────────────────────────────────────────────────────────────

export class UserDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    // blockConcurrencyWhile: 在初始化完成前, DO 不接任何请求。
    // CREATE TABLE IF NOT EXISTS 是幂等的, 每次启动都跑一下没成本。
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id    TEXT PRIMARY KEY,
          name  TEXT NOT NULL,
          email TEXT,
          age   INTEGER,
          meta  TEXT,                      -- JSON 字符串
          created_at INTEGER DEFAULT (unixepoch() * 1000)
        )
      `);
    });
  }

  // 内部 helper: 把 SQL 行 → JS 对象 (snake_case → camelCase + JSON 解析)
  #rowToUser(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      age: row.age,
      meta: row.meta ? JSON.parse(row.meta) : null,
      createdAt: row.created_at,
    };
  }

  // ── CREATE ───────────────────────────────────────────────
  async create(user) {
    if (!user?.id || !user?.name) {
      throw new Error("id 和 name 必填");
    }
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO users (id, name, email, age, meta)
         VALUES (?, ?, ?, ?, ?)`,
        user.id,
        user.name,
        user.email ?? null,
        user.age ?? null,
        user.meta ? JSON.stringify(user.meta) : null,
      );
    } catch (e) {
      if (String(e).includes("UNIQUE constraint failed")) {
        throw new Error(`用户 ${user.id} 已存在`);
      }
      throw e;
    }
    return this.get(user.id);
  }

  // ── READ (单条) ─────────────────────────────────────────
  async get(id) {
    const cursor = this.ctx.storage.sql.exec(
      `SELECT * FROM users WHERE id = ?`,
      id,
    );
    const rows = cursor.toArray();
    return this.#rowToUser(rows[0]);
  }

  // ── READ (列表 + 分页 + 简单过滤) ───────────────────────
  async list({ limit = 50, offset = 0, nameLike = null } = {}) {
    let sql = `SELECT * FROM users`;
    const params = [];
    if (nameLike) {
      sql += ` WHERE name LIKE ?`;
      params.push(`%${nameLike}%`);
    }
    sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.ctx.storage.sql.exec(sql, ...params).toArray();

    // 总数
    const countRow = this.ctx.storage.sql
      .exec(`SELECT COUNT(*) as n FROM users`)
      .toArray()[0];

    return {
      total: countRow.n,
      limit,
      offset,
      items: rows.map((r) => this.#rowToUser(r)),
    };
  }

  // ── UPDATE (部分更新, PATCH 语义) ──────────────────────
  async update(id, patch) {
    // 白名单字段, 防止 user 传 SQL 注入风险
    const fields = [];
    const values = [];
    for (const [k, v] of Object.entries(patch)) {
      // 简单的白名单, 别让 user 直接传 SQL 字段名
      if (!["name", "email", "age", "meta"].includes(k)) continue;
      fields.push(`${k} = ?`);
      values.push(k === "meta" ? JSON.stringify(v) : v);
    }
    if (fields.length === 0) {
      throw new Error("没有可更新字段");
    }
    values.push(id);

    const cursor = this.ctx.storage.sql.exec(
      `UPDATE users SET ${fields.join(", ")} WHERE id = ?`,
      ...values,
    );
    // sql.affectedRows 在某些版本可用, 这里用 SELECT 验证
    if (cursor.rowsWritten === 0) {
      throw new Error(`用户 ${id} 不存在`);
    }
    return this.get(id);
  }

  // ── DELETE ──────────────────────────────────────────────
  async delete(id) {
    this.ctx.storage.sql.exec(`DELETE FROM users WHERE id = ?`, id);
    // 删除是幂等的: 不存在也不报错
    return { id, deleted: true };
  }

  // ── BULK: 事务里一次性写多条 ────────────────────────────
  async bulkCreate(users) {
    // ctx.storage.transactionSync(): 同步事务, 失败自动回滚
    this.ctx.storage.transactionSync(() => {
      const stmt = this.ctx.storage.sql.prepare(
        `INSERT INTO users (id, name, email, age, meta) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const u of users) {
        stmt.run(u.id, u.name, u.email ?? null, u.age ?? null, u.meta ? JSON.stringify(u.meta) : null);
      }
    });
    return { created: users.length };
  }

  // ── HTTP 入口 (DO 自己处理 fetch) ───────────────────────
  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method;
    // 路由: /users/:id 或 /users
    const m = url.pathname.match(/^\/users\/([^/]+)$/);
    const id = m ? decodeURIComponent(m[1]) : null;

    try {
      if (method === "POST" && url.pathname === "/users") {
        const body = await request.json();
        const user = await this.create(body);
        return Response.json(user, { status: 201 });
      }
      if (method === "GET" && id) {
        const user = await this.get(id);
        if (!user) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json(user);
      }
      if (method === "GET" && url.pathname === "/users") {
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const nameLike = url.searchParams.get("name");
        return Response.json(await this.list({ limit, offset, nameLike }));
      }
      if (method === "PUT" && id) {
        const patch = await request.json();
        const user = await this.update(id, patch);
        return Response.json(user);
      }
      if (method === "DELETE" && id) {
        return Response.json(await this.delete(id));
      }
      return Response.json({ error: "method not allowed" }, { status: 405 });
    } catch (e) {
      return Response.json({ error: String(e.message ?? e) }, { status: 400 });
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Worker 入口: 接收 HTTP 请求, 路由到 DO
// ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1 个 DO 实例, 名字 "default" → 所有请求都进同一个 DO
    // 想要"每个用户一个 DO", 改成:
    //   const id = env.USER_DO.idFromName(userId);
    const id = env.USER_DO.idFromName("default");
    const stub = env.USER_DO.get(id);

    // 直接把请求转给 DO 处理
    return stub.fetch(request);
  },
};
