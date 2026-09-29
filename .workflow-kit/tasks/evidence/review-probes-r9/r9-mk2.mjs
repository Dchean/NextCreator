// 拼接器：r8-armN.mjs 的 preamble（真实的单实例 loader + 插桩）+ r9-body.mjs，插入上限处真值采集
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const lines = readFileSync(path.join(dir, "r8-armN.mjs"), "utf8").split(/\r?\n/);
const cut = lines.findIndex((l) => l.startsWith("console.log(`模块来源"));
if (cut < 120) throw new Error("preamble 边界异常：" + cut);
let preamble = lines.slice(0, cut).join("\n");

const anchor = '  s = s.replace("      if (passes >= MAX_HEAL_PASSES) {", "      if (passes >= MAX_HEAL_PASSES) { globalThis.__R8_EXIT__ = \'cap\';");';
if (!preamble.includes(anchor)) throw new Error("instrument 锚点未命中");
const extra = [
  '  s = s.replace(',
  '    "        const stillClearable = candidates.filter(",',
  '    "        globalThis.__R9_ALLTRUE__ = useFlowStore.getState().nodes.filter((n) => n.data?.queued === true).length;" +',
  '      "globalThis.__R9_TRUTH__ = useFlowStore.getState().nodes.filter((n) => n.data?.queued === true && !useQueueStore.getState().jobs.some((j) => j.nodeId === n.id && (j.status === \'queued\' || j.status === \'running\'))).length;" +',
  '      "globalThis.__R9_PASSES__ = passes;" +',
  '      "        const stillClearable = candidates.filter("',
  '  );',
].join("\n");
preamble = preamble.replace(anchor, anchor + "\n" + extra);

const body = readFileSync(path.join(dir, process.argv[2] || "r9-body.mjs"), "utf8");
writeFileSync(path.join(dir, process.argv[3] || "r9-gate.mjs"), preamble + "\n" + body, "utf8");
console.log("written", process.argv[3] || "r9-gate.mjs", "preamble lines =", cut);
