// 消融工具（审查者自写，只在仓库外副本运行；绝不写回真实仓库）
// 用法: node ablate.mjs <baseDir> <which: G|H|I>
// 每个消融只做一处最小改动，改完打印 before/after 片段供人核对。
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [, , baseDir, which] = process.argv;

function patch(rel, from, to) {
  const file = path.join(baseDir, rel);
  const src = readFileSync(file, "utf8");
  const count = src.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`[${which}] 期望 ${rel} 中恰好命中 1 次，实际 ${count} 次\n---\n${from}\n---`);
  }
  writeFileSync(file, src.replace(from, to), "utf8");
  console.log(`[${which}] patched ${rel}`);
  console.log(`  - FROM: ${JSON.stringify(from.slice(0, 160))}`);
  console.log(`  + TO  : ${JSON.stringify(to.slice(0, 160))}`);
}

if (which === "G") {
  // 消融 1：中和全局额度 —— tryAcquireGlobalSlot 恒发许可且不记账（inFlight 永不增长）。
  patch(
    "src/services/concurrencyLimiter.ts",
    `export function tryAcquireGlobalSlot(): (() => void) | null {
  if (waiters.length > 0) return null;
  if (inFlight >= limit) return null;
  inFlight += 1;
  return makeRelease();
}`,
    `export function tryAcquireGlobalSlot(): (() => void) | null {
  // ABLATION-G: 恒发许可、不记账 —— 队列永远不会因额度不足而停车
  return () => {};
}`
  );
} else if (which === "H") {
  // 消融 2：删掉"成功写回之前的最后一次 abort 复查"（保留其余三处复查与 catch 分支）。
  patch(
    "src/services/imageGenerationExecution.ts",
    `    if (signal?.aborted) {
      updateNodeDataWithCanvas<ImageGeneratorNodeData>(nodeId, canvasId, { status: "idle" });
      upsertRecord({ finishedAt: Date.now(), status: "error", error: "已取消" });
      return { success: false, cancelled: true };
    }

    const finishedAt = Date.now();
    updateNodeDataWithCanvas<ImageGeneratorNodeData>(nodeId, canvasId, {
      status: "success",`,
    `    // ABLATION-H: 成功写回之前的最后一次 abort 复查已被删除

    const finishedAt = Date.now();
    updateNodeDataWithCanvas<ImageGeneratorNodeData>(nodeId, canvasId, {
      status: "success",`
  );
} else if (which === "I") {
  // 消融 3：执行器恢复为无条件清 queued（即 r1 的缺陷形态）。
  patch(
    "src/services/imageGenerationExecution.ts",
    `  const queuedMarkerPatch = clearQueuedMarker ? { queued: false as const } : {};`,
    `  // ABLATION-I: 无条件清 queued，退回 r1 的缺陷形态
  const queuedMarkerPatch = { queued: false as const };`
  );
} else {
  throw new Error("which 必须是 G|H|I");
}
console.log(`[${which}] done`);
