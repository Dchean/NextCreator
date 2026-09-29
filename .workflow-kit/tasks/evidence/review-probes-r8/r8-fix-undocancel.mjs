// 修正 probe-r4-undo-cancel.mjs 的两个已知夹具缺陷（仅改 %TEMP% 副本，不动仓库）：
//   ① addNode 缺必需第三参 data（会在 flowStore.ts:82 crash）
//   ② 状态文件写在可能不存在的 %TEMP%\review-r4
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
const SRC = new URL("./probe-r4-undo-cancel.mjs", import.meta.url);
const DST = new URL("./r8-undo-cancel-fixed.mjs", import.meta.url);
let s = readFileSync(SRC, "utf8");
const from = `useFlowStore.getState().addNode("imageInputNode", { x: 320, y: 0 });`;
const to = `useFlowStore.getState().addNode("imageInputNode", { x: 320, y: 0 }, { label: "输入", status: "idle" });`;
if (!s.includes(from)) throw new Error("addNode 锚点未命中");
s = s.replace(from, to);
const dirAnchor = `const STATE_FILE = path.join(process.env.TEMP, "review-r4", "undo-cancel-state.json");`;
if (!s.includes(dirAnchor)) throw new Error("STATE_FILE 锚点未命中");
s = s.replace(dirAnchor, dirAnchor + `\nmkdirSync(path.dirname(STATE_FILE), { recursive: true });`);
if (!/^import .*mkdirSync/.test(s) && !s.includes("mkdirSync")) throw new Error("需要 mkdirSync");
// 确保 mkdirSync 已导入
s = s.replace(/import \{([^}]*)\} from "node:fs";/, (m, g) => (g.includes("mkdirSync") ? m : `import {${g.trimEnd()}, mkdirSync } from "node:fs";`));
writeFileSync(DST, s, "utf8");
console.log("written r8-undo-cancel-fixed.mjs; mkdirSync imported =", /import \{[^}]*mkdirSync[^}]*\} from "node:fs"/.test(s));
