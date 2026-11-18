// Cloudflare Pages Function: GET /visits
// Returns the home page visitor count from GoatCounter as { "count": "123" }.
// The browser calls this on our own domain, so ad and privacy blockers (which block
// goatcounter.com and gc.zgo.at) do not hide the counter. The count is cached for
// 5 minutes at the edge so GoatCounter is not asked on every page view.
//
// This route is deliberately outside /api, which is protected by Cloudflare Access.
// GoatCounter must have "Allow adding visitor counts on your website" turned on.

const UPSTREAM = "https://freakyfish.goatcounter.com/counter/%2F.json";
const CACHE_SECONDS = 300;

function reply(body, maxAge) {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${maxAge}`,
    },
  });
}

export async function onRequestGet(context) {
  const cache = caches.default;
  const cacheKey = new Request(new URL("/visits", context.request.url).toString());
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  try {
    const res = await fetch(UPSTREAM, { headers: { "User-Agent": "lomsland-site-visit-counter/1.0" } });
    if (!res.ok) return reply({ count: null }, 60);
    const data = await res.json();
    const response = reply({ count: String(data.count ?? "") || null }, CACHE_SECONDS);
    context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    return reply({ count: null }, 60);
  }
}
