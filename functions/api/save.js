// Cloudflare Pages Function: POST /api/save
// Receives the full goat list (and optionally one new photo) from /admin
// and commits it to the GitHub repo in a single commit. Pages then redeploys.
//
// Required Pages environment variables (set in the Cloudflare dashboard):
//   GITHUB_TOKEN  - fine-grained token, Contents: read & write, only on this repo
//   GITHUB_REPO   - e.g. "freakyfish42/goat-site"
//   GITHUB_BRANCH - optional, defaults to "main"
//
// Access to /admin and /api/* is restricted by Cloudflare Access. This function
// also refuses requests that do not carry the Access identity header.

const MAX_PHOTO_CHARS = 6 * 1024 * 1024; // base64 characters
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;
const SEXES = ["doe", "buck"];
const STATUSES = ["herd", "passed"];

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function validate(goats) {
  if (!Array.isArray(goats) || goats.length === 0) return "No goats supplied.";
  const seen = new Set();
  for (const g of goats) {
    if (!g || typeof g.id !== "string" || !ID_PATTERN.test(g.id)) return `Invalid id: ${g && g.id}`;
    if (seen.has(g.id)) return `Duplicate id: ${g.id}`;
    seen.add(g.id);
    if (typeof g.name !== "string" || !g.name.trim()) return `Missing name for ${g.id}`;
    if (!SEXES.includes(g.sex)) return `Invalid sex for ${g.id}`;
    if (!STATUSES.includes(g.status)) return `Invalid status for ${g.id}`;
  }
  // Parent references must point to goats that exist (or be null)
  for (const g of goats) {
    for (const key of ["sire", "dam"]) {
      if (g[key] && !seen.has(g[key])) return `${g.id} has unknown ${key} "${g[key]}"`;
    }
  }
  return null;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function gh(env, path, options = {}) {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "goat-site-admin",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}: ${data.message || "unknown error"}`);
  return data;
}

export async function onRequestPost({ request, env }) {
  if (!request.headers.get("Cf-Access-Authenticated-User-Email")) {
    return json(403, { error: "Not signed in through Cloudflare Access." });
  }
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    return json(500, { error: "Server is missing GITHUB_TOKEN or GITHUB_REPO." });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Body must be JSON." });
  }

  const problem = validate(body.goats);
  if (problem) return json(400, { error: problem });

  let photo = null;
  if (body.photo) {
    const { id, base64 } = body.photo;
    if (!ID_PATTERN.test(id || "")) return json(400, { error: "Invalid photo id." });
    if (typeof base64 !== "string" || base64.length > MAX_PHOTO_CHARS) {
      return json(400, { error: "Photo is missing or too large." });
    }
    if (!body.goats.some((g) => g.id === id)) return json(400, { error: "Photo belongs to an unknown goat." });
    photo = { id, base64 };
  }

  const branch = env.GITHUB_BRANCH || "main";
  const user = request.headers.get("Cf-Access-Authenticated-User-Email");

  try {
    // 1. Current head of the branch
    const ref = await gh(env, `/git/ref/heads/${branch}`);
    const parentSha = ref.object.sha;
    const parentCommit = await gh(env, `/git/commits/${parentSha}`);

    // 2. Blobs: the goats file, plus the photo if one was uploaded
    const blobs = [];
    const goatsBlob = await gh(env, "/git/blobs", {
      method: "POST",
      body: JSON.stringify({
        content: btoa(unescape(encodeURIComponent(JSON.stringify(body.goats, null, 2) + "\n"))),
        encoding: "base64",
      }),
    });
    blobs.push({ path: "data/goats.json", mode: "100644", type: "blob", sha: goatsBlob.sha });

    if (photo) {
      const photoBlob = await gh(env, "/git/blobs", {
        method: "POST",
        body: JSON.stringify({ content: photo.base64, encoding: "base64" }),
      });
      blobs.push({ path: `photos/${photo.id}.webp`, mode: "100644", type: "blob", sha: photoBlob.sha });
    }

    // 3. New tree on top of the current one
    const tree = await gh(env, "/git/trees", {
      method: "POST",
      body: JSON.stringify({ base_tree: parentCommit.tree.sha, tree: blobs }),
    });

    // 4. Commit and move the branch forward
    const message = `Update goats${photo ? ` (photo: ${photo.id})` : ""} via admin by ${user}`;
    const commit = await gh(env, "/git/commits", {
      method: "POST",
      body: JSON.stringify({ message, tree: tree.sha, parents: [parentSha] }),
    });
    await gh(env, `/git/refs/heads/${branch}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: commit.sha }),
    });

    return json(200, { ok: true, commit: commit.sha });
  } catch (err) {
    return json(502, { error: err.message });
  }
}
