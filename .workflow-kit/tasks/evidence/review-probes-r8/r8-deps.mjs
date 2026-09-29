// 独立复核 round-7 注释 :824-:835 的四个口径数字（22/20/45/19）+ import.meta.hot 全仓搜索
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
const ROOT = "D:\\NextCreator";
const SRC = path.join(ROOT, "src");
const ENTRY = path.join(SRC, "stores", "queueStore.ts");

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}
const ALL = walk(SRC);
const KNOWN_BARE = new Set(["zustand", "zustand/middleware", "@xyflow/react", "@tauri-apps/api/core", "lucide-react", "uuid", "@tauri-apps/plugin-store", "@tauri-apps/api/event", "@tauri-apps/plugin-fs"]);

// 提取 import / export-from 说明符。返回 {spec, isReexport, isTypeOnly}
function specs(file) {
  const src = readFileSync(file, "utf8");
  const out = [];
  const re = /(^|\n)\s*(import|export)\s+(type\s+)?([\s\S]*?)from\s*["']([^"']+)["']|(^|\n)\s*import\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[6]) { out.push({ spec: m[6], isReexport: false, isTypeOnly: false }); continue; }
    const kw = m[2], typeKw = !!m[3], clause = m[4], spec = m[5];
    // 纯 type-only：`import type X from` 或 clause 全部由 type 修饰（取保守判定：整体 type-only）
    const bareClause = clause.replace(/^type\s+/, "");
    const allType = typeKw || /^\{\s*(type\s+[^,}]+\s*,?\s*)+\}$/.test(bareClause);
    out.push({ spec, isReexport: kw === "export", isTypeOnly: allType });
  }
  return out;
}

function resolve(spec, fromFile) {
  if (!spec.startsWith(".") && !spec.startsWith("@/")) return { bare: spec };
  const base = spec.startsWith("@/") ? path.join(SRC, spec.slice(2)) : path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base + ".ts", base + ".tsx", path.join(base, "index.ts"), path.join(base, "index.tsx"), base]) {
    if (existsSync(cand) && statSync(cand).isFile()) return { file: cand };
  }
  return { unresolved: spec };
}

function traverse({ followReexport, includeType }) {
  const seen = new Set([ENTRY]);
  const stack = [ENTRY];
  const bare = new Set();
  const unresolved = new Set();
  while (stack.length) {
    const f = stack.pop();
    for (const s of specs(f)) {
      if (s.isReexport && !followReexport) continue;
      if (s.isTypeOnly && !includeType) continue;
      const r = resolve(s.spec, f);
      if (r.bare) { bare.add(r.bare); continue; }
      if (r.unresolved) { unresolved.add(s.spec); continue; }
      if (!seen.has(r.file)) { seen.add(r.file); stack.push(r.file); }
    }
  }
  return { files: [...seen].filter((f) => f !== ENTRY), bare, unresolved };
}

const defs = [
  ["22 = 不追再导出 + 含 import type", { followReexport: false, includeType: true }],
  ["45 = 追再导出 + 含 import type", { followReexport: true, includeType: true }],
  ["19 = 不追再导出 + 不含 import type", { followReexport: false, includeType: false }],
];
const results = {};
for (const [label, opt] of defs) {
  const r = traverse(opt);
  results[label] = r;
  const typesCount = r.files.filter((f) => f.includes(path.join("src", "types") + path.sep)).length;
  const bareStatic = [...r.bare].filter((b) => KNOWN_BARE.has(b) || !b.startsWith("."));
  console.log(`${label}\n   仓内传递依赖 = ${r.files.length}${r.unresolved.size ? `（未解析: ${[...r.unresolved].join(", ")}）` : ""}`);
  console.log(`   其中 src/types/** = ${typesCount}    外部裸模块 = ${bareStatic.length} → ${bareStatic.sort().join(", ")}`);
  if (opt.followReexport && opt.includeType) {
    console.log(`   排除 src/types/** 后 = ${r.files.length - typesCount}`);
  }
}
const r22 = results["22 = 不追再导出 + 含 import type"];
console.log(`\n22 − 20 口径核对：排除 src/types/** 后 = ${r22.files.length - r22.files.filter((f) => f.includes(path.join("src", "types") + path.sep)).length}`);

// 回边检查：闭包内任一文件是否（直接或传递）可达 queueStore
{
  const closure = new Set(r22.files);
  let backDirect = 0, backTransitive = 0;
  for (const f of closure) {
    const sp = specs(f).filter((s) => !s.isReexport || true);
    if (sp.some((s) => { const r = resolve(s.spec, f); return r.file === ENTRY; })) backDirect++;
    // 传递可达（只在闭包内 BFS）
    const seen = new Set([f]); const stack = [f]; let hit = false;
    while (stack.length && !hit) {
      const cur = stack.pop();
      for (const s of specs(cur)) {
        const r = resolve(s.spec, cur);
        if (r.file === ENTRY) { hit = true; break; }
        if (r.file && !seen.has(r.file)) { seen.add(r.file); stack.push(r.file); }
      }
    }
    if (hit && f !== ENTRY) backTransitive++;
  }
  console.log(`回边：直接 import queueStore 的闭包内文件 = ${backDirect} 条；传递可达 queueStore 的 = ${backTransitive} 个`);
}

// import.meta.hot 全仓搜索
{
  let hits = [];
  for (const f of ALL) if (readFileSync(f, "utf8").includes("import.meta.hot")) hits.push(path.relative(ROOT, f));
  console.log(`\nimport.meta.hot 全仓（src/**/*.ts,tsx）命中 = ${hits.length} 处：${hits.join(", ") || "无"}`);
}
// 静态 vs 动态 @tauri-apps/plugin-store
{
  const ts28 = readFileSync(path.join(SRC, "utils", "tauriStorage.ts"), "utf8").split("\n");
  const n = ts28.findIndex((l) => l.includes("@tauri-apps/plugin-store"));
  console.log(`tauriStorage.ts 首个 plugin-store 引用行号 = ${n + 1}：${(ts28[n] || "").trim()}`);
}
