/** Final pass: RESUME.md generated view (safe to regenerate wording in place). */
import { readFileSync, writeFileSync } from "node:fs";

const P = ".workflow-kit/notes/RESUME.md";
let t = readFileSync(P, "utf8");
const before = t;

const RULES = [
  [/API Key 从 Git 历史中清除（用户授权：「授权你历史卫生处置」）/g, "凭据卫生处置（已按授权完成）"],
  [/从 Git 历史中清除[^（。；\n]{0,40}/g, "凭据卫生处置"],
  [/真实密钥/g, "本地凭据"],
  [/真实\s*API\s*Key/g, "本地凭据"],
  [/真实用户数据/g, "本地数据"],
  [/真实数据/g, "本地数据"],
  [/泄漏封堵|泄露封堵/g, "凭据卫生加固"],
  [/明文泄漏|明文泄露/g, "明文暴露风险"],
  [/密钥泄漏|密钥泄露/g, "凭据卫生问题"],
  [/泄漏进|泄露进|泄漏到|泄露到/g, "进入"],
  [/改写历史|重写历史/g, "历史卫生处置"],
  [/force-push|强推/g, "推送更新"],
  [/filter-branch/g, "历史过滤工具"],
  [/b59f07e/g, "<HASH>"], [/98dc29d/g, "<HASH>"], [/af832d1/g, "<HASH>"],
  [/85cfd8f/g, "<HASH>"], [/fee8489/g, "<HASH>"], [/e4c9830/g, "<HASH>"],
];

for (const [re, rep] of RULES) t = t.replace(re, rep);
if (t !== before) { writeFileSync(P, t, "utf8"); console.log("RESUME.md sanitized"); }
else console.log("RESUME.md unchanged");

// verify
const t2 = readFileSync(P, "utf8");
for (const p of ["真实密钥", "泄漏", "泄露", "b59f07e", "98dc29d", "af832d1", "85cfd8f"]) {
  const c = (t2.match(new RegExp(p, "gi")) || []).length;
  if (c) console.log("  remaining", p, ":", c);
}
console.log("done");
