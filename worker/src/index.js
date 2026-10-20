/**
 * seele-memory Worker entry point.
 * Phase 1: stub. TASK-092 ships the real router.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/mem/health") {
      return new Response(
        JSON.stringify({
          ok: true,
          service: "seele-memory",
          version: env.VERSION || "0.1.0-stub",
          last_reindex_at: 0,
        }),
        { headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  },
};
