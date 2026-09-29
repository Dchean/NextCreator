/**
 * 独立审查探针 R6-F（round 6）：核对注释里两处**机制性**声明。
 *
 *  A. 「本文件不声明 `import.meta.hot.accept`（全仓库都没有任何一处）」—— 全仓库搜索核对。
 *  B. 「queueStore 的 23 个传递静态依赖里 0 条回边」—— 静态图谱核对（是否恰好 23、是否有回边）。
 *  C. 「flowStore 不 import queueStore」。
 *
 * 纯文件分析，不加载应用模块。用法：node r6-static-claims.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const REPO = "D:\\NextCreator";
const SRC = path.join(REPO, "src");

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}
const files = walk(SRC);

console.log("========== A. 全仓库 import.meta.hot 搜索 ==========");
const hotHits = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  if (/import\.meta\.hot/.test(src)) {
    src.split(/\r?\n/).forEach((l, i) => { if (/import\.meta\.hot/.test(l)) hotHits.push(`${path.relative(REPO, f)}:${i + 1}: ${l.trim()}`); });
  }
}
console.log(`  命中 ${hotHits.length} 处`);
for (const h of hotHits) console.log(`    ${h}`);
console.log(`  ⇒ 注释称「全仓库都没有任何一处」${hotHits.length === 0 ? "成立（核对通过）" : "不成立"}`);

console.log("");
console.log("========== B/C. 静态依赖图：queueStore 的传递依赖数 & 是否存在回边 ==========");
const impRe = /^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm;
const impSideRe = /^\s*import\s+["']([^"']+)["']/gm;
function deps(file) {
  const src = readFileSync(file, "utf8");
  const out = new Set();
  for (const m of src.matchAll(impRe)) out.add(m[1]);
  for (const m of src.matchAll(impSideRe)) out.add(m[1]);
  return [...out];
}
function resolveSpec(spec, fromFile) {
  if (spec.startsWith("@/")) {
    for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      const p = path.join(SRC, spec.slice(2)) + (ext.startsWith("/") ? ext : ext);
      if (existsSync(p) && statSync(p).isFile()) return p;
    }
    const base = path.join(SRC, spec.slice(2));
    for (const ext of [".ts", ".tsx"]) if (existsSync(base + ext)) return base + ext;
    if (existsSync(path.join(base, "index.ts"))) return path.join(base, "index.ts");
    return null;
  }
  if (spec.startsWith(".")) {
    const base = path.resolve(path.dirname(fromFile), spec);
    for (const ext of [".ts", ".tsx"]) if (existsSync(base + ext)) return base + ext;
    if (existsSync(base + ".ts")) return base + ".ts";
    return null;
  }
  return null; // bare specifier（外部包）
}

const entry = path.join(SRC, "stores/queueStore.ts");
const seen = new Set();
const externals = new Set();
const queue = [entry];
const edges = new Map();
while (queue.length) {
  const cur = queue.pop();
  if (seen.has(cur)) continue;
  seen.add(cur);
  const ds = [];
  for (const spec of deps(cur)) {
    const r = resolveSpec(spec, cur);
    if (r) { ds.push(r); if (!seen.has(r)) queue.push(r); } else externals.add(spec);
  }
  edges.set(cur, ds);
}
const inRepo = [...seen].filter((f) => f !== entry);
console.log(`  queueStore 的传递静态依赖（仓库内文件数，不含自身）= ${inRepo.length}`);
console.log(`  外部裸模块依赖 = ${[...externals].sort().join(", ")}`);
const backEdge = inRepo.filter((f) => edges.get(f)?.includes(entry) || deps(f).some((s) => resolveSpec(s, f) === entry));
console.log(`  回边（某个依赖反向 import queueStore）= ${backEdge.length === 0 ? "0 条（核对通过）" : backEdge.map((f) => path.relative(REPO, f)).join(", ")}`);
console.log(`  ⇒ 注释称「23 个传递静态依赖里 0 条回边」：回边部分${backEdge.length === 0 ? "成立" : "不成立"}；数目部分实测 ${inRepo.length}（注释写 23）`);

const flow = path.join(SRC, "stores/flowStore.ts");
const flowDeps = deps(flow).map((s) => resolveSpec(s, flow)).filter(Boolean);
const flowImportsQueue = flowDeps.some((f) => f === entry);
console.log(`  flowStore 静态 import queueStore = ${flowImportsQueue}`);
console.log(`  ⇒ 注释称「flowStore 不 import queueStore」${flowImportsQueue ? "不成立" : "成立（核对通过）"}`);
