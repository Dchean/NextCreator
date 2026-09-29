import { readFileSync, writeFileSync } from "node:fs";
const f = "probe-r4-undo-cancel.mjs";
let s = readFileSync(f, "utf8");
const before = s;
s = s.replace('addNode("imageInputNode", { x: 320, y: 0 })', 'addNode("imageInputNode", { x: 320, y: 0 }, {})');
if (s === before) throw new Error("patch anchor missed");
writeFileSync(f, s, "utf8");
console.log("patched addNode third arg");
