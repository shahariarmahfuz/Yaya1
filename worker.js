// worker.js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // health
    if (path === "/") return new Response("D1 API OK");

    // Insert: POST /items  with JSON { title, value }
    if (path === "/items" && request.method === "POST") {
      const body = await request.json();
      const title = body.title || "item";
      const value = Number(body.value || 0);
      const res = await env.DB.prepare("INSERT INTO perf_items (title, value) VALUES (?, ?)").bind(title, value).run();
      return new Response(JSON.stringify({ ok: true, result: res }), { headers: { "Content-Type": "application/json" }});
    }

    // Select: GET /items?limit=10
    if (path === "/items" && request.method === "GET") {
      const limit = Number(url.searchParams.get("limit") || 20);
      const q = `SELECT id, title, value, created_at FROM perf_items ORDER BY created_at DESC LIMIT ${limit}`;
      const { results } = await env.DB.prepare(q).all();
      return new Response(JSON.stringify({ rows: results }), { headers: { "Content-Type": "application/json" }});
    }

    // Delete: DELETE /items/:id
    if (path.startsWith("/items/") && request.method === "DELETE") {
      const id = path.split("/")[2];
      await env.DB.prepare("DELETE FROM perf_items WHERE id = ?").bind(id).run();
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" }});
    }

    // Benchmark: GET /benchmark?n=20&mode=select
    if (path === "/benchmark" && request.method === "GET") {
      const n = Number(url.searchParams.get("n") || 20);
      const mode = url.searchParams.get("mode") || "select";
      const timings = [];
      for (let i=0;i<n;i++) {
        const t0 = Date.now();
        if (mode === "insert") {
          await env.DB.prepare("INSERT INTO perf_items (title, value) VALUES (?, ?)").bind(`bench-${Date.now()}-${i}`, i).run();
        } else {
          await env.DB.prepare("SELECT id FROM perf_items LIMIT 1").all();
        }
        timings.push(Date.now() - t0);
      }
      timings.sort((a,b)=>a-b);
      const avg = timings.reduce((s,x)=>s+x,0)/timings.length;
      const p50 = timings[Math.floor(timings.length*0.5)];
      const p95 = timings[Math.floor(timings.length*0.95)];
      return new Response(JSON.stringify({ n, mode, avg, p50, p95, timings }), { headers: { "Content-Type":"application/json" }});
    }

    return new Response("Not found", { status: 404 });
  }
}
