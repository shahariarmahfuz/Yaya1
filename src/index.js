// index.js - Cloudflare Worker with robust error handling + D1 usage + cache
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    const jsonHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

    // Small helper to return JSON with proper headers
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: jsonHeaders });

    try {
      // Health
      if (path === "/" && method === "GET") {
        return new Response("D1 API Worker OK", { headers: { "Content-Type": "text/plain" }});
      }

      // Diagnostics: quick DB connectivity check
      if (path === "/diag" && method === "GET") {
        if (!env.DB) return json({ ok: false, error: "D1 binding (env.DB) not found" }, 500);
        try {
          // simple test query
          const { results } = await env.DB.prepare("SELECT 1 AS ok").all();
          return json({ ok: true, results });
        } catch (e) {
          console.error("D1 diag query error:", e);
          return json({ ok: false, error: String(e) }, 500);
        }
      }

      // GET single item with edge cache (id param)
      if (path === "/item" && method === "GET") {
        const id = url.searchParams.get("id");
        if (!id) return json({ error: "missing id parameter" }, 400);

        // Try edge cache first
        const cache = caches.default;
        const cacheKey = new Request(url.toString(), { method: "GET" });
        const cached = await cache.match(cacheKey);
        if (cached) {
          // Return cached response (already has correct headers)
          return cached;
        }

        if (!env.DB) return json({ error: "D1 binding not configured" }, 500);
        try {
          const stmt = env.DB.prepare("SELECT id, title, value, created_at FROM perf_items WHERE id = ? LIMIT 1").bind(id);
          const { results } = await stmt.all();
          const data = results && results.length ? results[0] : null;
          const resp = json({ ok: true, data });
          // cache for 30 seconds on edge (adjust TTL as needed)
          resp.headers.set("Cache-Control", "public, max-age=30");
          // waitUntil so put is async and doesn't delay response
          ctx.waitUntil(cache.put(cacheKey, resp.clone()));
          return resp;
        } catch (e) {
          console.error("D1 select error (/item):", e);
          return json({ ok: false, error: String(e) }, 500);
        }
      }

      // GET items (list) with limit param
      if (path === "/items" && method === "GET") {
        const limitRaw = url.searchParams.get("limit") || "20";
        let limit = parseInt(limitRaw, 10);
        if (Number.isNaN(limit) || limit <= 0) limit = 20;
        if (limit > 500) limit = 500; // safety cap

        if (!env.DB) return json({ error: "D1 binding not configured" }, 500);
        try {
          // avoid string injection via prepared statements: use numeric limit only
          const q = `SELECT id, title, value, created_at FROM perf_items ORDER BY created_at DESC LIMIT ${limit}`;
          const { results } = await env.DB.prepare(q).all();
          return json({ ok: true, rows: results });
        } catch (e) {
          console.error("D1 list error (/items):", e);
          return json({ ok: false, error: String(e) }, 500);
        }
      }

      // POST insert item: body { title, value }
      if (path === "/items" && method === "POST") {
        if (!env.DB) return json({ error: "D1 binding not configured" }, 500);
        let body;
        try {
          body = await request.json();
        } catch (e) {
          return json({ error: "invalid json body" }, 400);
        }
        const title = typeof body.title === "string" ? body.title : "item";
        const value = Number.isFinite(Number(body.value)) ? Number(body.value) : 0;

        try {
          // Use run() for INSERT (no large return)
          const res = await env.DB.prepare("INSERT INTO perf_items (id, title, value, created_at) VALUES (?, ?, ?, ?)").bind(
            crypto.randomUUID(),
            title,
            value,
            Date.now()
          ).run();
          // Optionally return last info (res)
          return json({ ok: true, result: res });
        } catch (e) {
          console.error("D1 insert error (/items POST):", e);
          return json({ ok: false, error: String(e) }, 500);
        }
      }

      // DELETE item by id: /items/<id>
      if (path.startsWith("/items/") && method === "DELETE") {
        if (!env.DB) return json({ error: "D1 binding not configured" }, 500);
        const parts = path.split("/").filter(Boolean); // ["items", "<id>"]
        if (parts.length < 2) return json({ error: "missing id in path" }, 400);
        const id = parts[1];
        try {
          await env.DB.prepare("DELETE FROM perf_items WHERE id = ?").bind(id).run();
          // invalidate cache for /item?id=...
          const cache = caches.default;
          const itemUrl = new URL(request.url);
          itemUrl.pathname = "/item";
          itemUrl.searchParams.set("id", id);
          ctx.waitUntil(cache.delete(new Request(itemUrl.toString(), { method: "GET" })));
          return json({ ok: true });
        } catch (e) {
          console.error("D1 delete error:", e);
          return json({ ok: false, error: String(e) }, 500);
        }
      }

      // Benchmark endpoint: /benchmark?n=20&mode=select|insert
      if (path === "/benchmark" && method === "GET") {
        const n = Math.min(1000, Math.max(1, Number(url.searchParams.get("n") || 20)));
        const mode = (url.searchParams.get("mode") || "select").toLowerCase();

        if (!env.DB) return json({ error: "D1 binding not configured" }, 500);

        const timings = [];
        for (let i = 0; i < n; i++) {
          const t0 = Date.now();
          try {
            if (mode === "insert") {
              await env.DB.prepare("INSERT INTO perf_items (id, title, value, created_at) VALUES (?, ?, ?, ?)").bind(
                crypto.randomUUID(),
                `bench-${Date.now()}-${i}`,
                i,
                Date.now()
              ).run();
            } else {
              // cheap select
              await env.DB.prepare("SELECT id FROM perf_items LIMIT 1").all();
            }
          } catch (e) {
            console.error("D1 benchmark operation error:", e);
            // record as -1 to indicate failure
            timings.push(-1);
            continue;
          }
          const t1 = Date.now();
          timings.push(t1 - t0);
        }
        // compute stats (ignore -1 failures for stats)
        const valid = timings.filter(x => x >= 0);
        const avg = valid.length ? (valid.reduce((s, x) => s + x, 0) / valid.length) : null;
        valid.sort((a, b) => a - b);
        const p50 = valid.length ? valid[Math.floor(valid.length * 0.5)] : null;
        const p95 = valid.length ? valid[Math.floor(valid.length * 0.95)] : null;

        return json({ ok: true, n, mode, avg_ms: avg, p50_ms: p50, p95_ms: p95, all_ms: timings });
      }

      // If no matching route
      return json({ error: "Not found" }, 404);
    } catch (err) {
      // Catch-all: log and return safe error
      console.error("Unhandled worker error:", err);
      // Avoid exposing secrets - show only message + small stack skeleton
      const stack = err && err.stack ? err.stack.split("\n").slice(0, 5) : null;
      return json({ ok: false, error: String(err), stack }, 500);
    }
  }
};
