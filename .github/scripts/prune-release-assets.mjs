/**
 * CI helper: delete release assets that do NOT belong to the current version.
 *
 * Why: when a tag is re-pushed (re-release of the same tag), tauri-action uploads the new
 * assets alongside the old ones, so the release page ends up shipping both
 * `NextCreator_0.2.10_*.exe` and `NextCreator_0.3.0_*.exe` — the exact confusion this
 * whole change is fixing. Pruning keeps the release page showing one consistent version.
 *
 * Requires GITHUB_TOKEN with contents:write. Tolerates "release not found" (first release
 * of a brand-new tag) by exiting 0.
 */
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const tag = process.env.GITHUB_REF_NAME || "";
const version = tag.replace(/^v/, "");

if (!token || !repo) {
  console.log("[prune] GITHUB_TOKEN/GITHUB_REPOSITORY missing; nothing to do");
  process.exit(0);
}
if (!version) {
  console.log("[prune] no tag ref; nothing to do");
  process.exit(0);
}

const api = (p, init = {}) =>
  fetch(`https://api.github.com/repos/${repo}${p}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "nextcreator-release-workflow",
      ...(init.headers || {}),
    },
  });

console.log(`[prune] tag=${tag} version=${version} repo=${repo}`);

const relRes = await api(`/releases/tags/${tag}`);
if (relRes.status === 404) {
  console.log("[prune] release does not exist yet (new tag) — nothing to prune");
  process.exit(0);
}
if (!relRes.ok) {
  console.log(`[prune] could not read release (HTTP ${relRes.status}); skipping`);
  process.exit(0);
}
const release = await relRes.json();

const assetsRes = await api(`/releases/${release.id}/assets?per_page=100`);
if (!assetsRes.ok) {
  console.log(`[prune] could not list assets (HTTP ${assetsRes.status}); skipping`);
  process.exit(0);
}
const assets = await assetsRes.json();
console.log(`[prune] release has ${assets.length} asset(s)`);

let deleted = 0;
for (const asset of assets) {
  if (asset.name.includes(version)) continue;         // current version → keep
  const del = await api(`/releases/assets/${asset.id}`, { method: "DELETE" });
  if (del.ok || del.status === 204) {
    console.log(`[prune] deleted stale asset: ${asset.name}`);
    deleted++;
  } else {
    console.log(`[prune] failed to delete ${asset.name} (HTTP ${del.status})`);
  }
}
console.log(`[prune] done — deleted ${deleted} stale asset(s), kept ${assets.length - deleted}`);
