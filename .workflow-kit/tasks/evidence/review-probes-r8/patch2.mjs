import { readFileSync, writeFileSync } from "node:fs";
const dir = process.argv[2];
const log = [];

// ---- 1) probe-r4-undo-cancel: fix the two known fixture bugs (missing 3rd arg + missing dir is handled in shell)
{
  const src = `${dir}\\probe-r4-undo-cancel.mjs`;
  const dst = `${dir}\\probe-r5-undo-cancel-fixed.mjs`;
  let t = readFileSync(src, "utf8");
  const before = t;
  t = t.replace(
    'useFlowStore.getState().addNode("imageInputNode", { x: 320, y: 0 });',
    'useFlowStore.getState().addNode("imageInputNode", { x: 320, y: 0 }, { label: "in" });'
  );
  // also surface the pre-cancel marker value so the attribution is explicit
  t = t.replace(
    "  // 用户取消这个排队任务（QueuePanel 的真实入口）",
    "  console.log(`②b 取消之前（仅此一句为审查者加）：标记=${JSON.stringify(marker())} 活动任务=${active().length}`);\n  // 用户取消这个排队任务（QueuePanel 的真实入口）"
  );
  writeFileSync(dst, t, "utf8");
  log.push(`undo-cancel: changed=${before !== t} addNodeFixed=${t.includes('{ label: "in" }')}`);
}

// ---- 2) probe-r3-finally-churn: print the marker right before cancel (attribution for part (2))
{
  const src = `${dir}\\probe-r3-finally-churn.mjs`;
  const dst = `${dir}\\probe-r5-churn-attrib.mjs`;
  let t = readFileSync(src, "utf8");
  t = t.replace(
    'useQueueStore.getState().cancel("job-R");',
    'console.log(`  [审查者插入] cancel 调用之前：flowStore.queued=${JSON.stringify(useFlowStore.getState().nodes[0].data.queued)} 活动任务=${useQueueStore.getState().jobs.filter((j) => j.status === "queued" || j.status === "running").length}`);\n' +
    'useQueueStore.getState().cancel("job-R");\n' +
    'console.log(`  [审查者插入] cancel 调用之后（同一同步栈，未 await）：flowStore.queued=${JSON.stringify(useFlowStore.getState().nodes[0].data.queued)}`);'
  );
  writeFileSync(dst, t, "utf8");
  log.push(`churn: patched=${t.includes("审查者插入")}`);
}

// ---- 3) probe-r4-own: relax the two over-strict canvas assertions (=== false -> !== true)
{
  const src = `${dir}\\probe-r4-own.mjs`;
  const dst = `${dir}\\probe-r5-own-relaxed.mjs`;
  let t = readFileSync(src, "utf8");
  t = t.replace("const b1 = marker() === false && markerCanvas(A) === false;", "const b1 = marker() !== true && markerCanvas(A) !== true;");
  t = t.replace(
    "const b2b = marker() === false && markerCanvas(A) === false && markerCanvas(B) === false;",
    "const b2b = marker() !== true && markerCanvas(A) !== true && markerCanvas(B) !== true;"
  );
  writeFileSync(dst, t, "utf8");
  log.push(`own: relaxed=${t.includes("markerCanvas(A) !== true")}`);
}
console.log(log.join("\n"));
