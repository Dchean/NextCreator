// 审查者工具：打印 REQ-004 行为矩阵中差异场景的显式对比（供报告引用）
// 用法：node summarize-req004-diffs.mjs <before.json> <candidate.json> <out.txt>
import { readFileSync, writeFileSync } from "node:fs";

const [bp, cp, out] = process.argv.slice(2);
const b = JSON.parse(readFileSync(bp, "utf8"));
const c = JSON.parse(readFileSync(cp, "utf8"));
const lines = [];
lines.push("REQ-004 行为差异明细（驱动层 = nodeExecutor.executeNode；同一组 provider/fileStorage 替身）");
lines.push(`before 源码根 = ${b.root}`);
lines.push(`candidate 源码根 = ${c.root}`);
lines.push("");

const keys = [...new Set([...Object.keys(b.results), ...Object.keys(c.results)])].sort();
const interesting = keys.filter((k) => {
  const x = b.results[k], y = c.results[k];
  return JSON.stringify(x && x.node) !== JSON.stringify(y && y.node) ||
         JSON.stringify(x && x.result) !== JSON.stringify(y && y.result);
});

for (const k of interesting) {
  const x = b.results[k], y = c.results[k];
  lines.push(`--- ${k} ---`);
  lines.push(`  before    result = ${JSON.stringify(x.result)}`);
  lines.push(`  candidate result = ${JSON.stringify(y.result)}`);
  lines.push(`  before    node.status=${JSON.stringify(x.node.status)} node.error=${JSON.stringify(x.node.error)} queued=${JSON.stringify(x.node.queued)} runRecords=${JSON.stringify(x.node.runRecords)}`);
  lines.push(`  candidate node.status=${JSON.stringify(y.node.status)} node.error=${JSON.stringify(y.node.error)} queued=${JSON.stringify(y.node.queued)} runRecords=${JSON.stringify(y.node.runRecords)}`);
  lines.push("");
}

lines.push("=== 结论分类 ===");
lines.push("A. 期望的变化（REQ-004 要求统一实现，故错误文案沿用唯一实现的口径）：");
lines.push("   - S3_empty_prompt：'缺少必需的提示词输入'（旧 nodeExecutor 文案） -> '请连接提示词节点'（执行器文案）");
lines.push("     两者语义相同（都指没有可用提示词），且都在节点 status=error / error 字段上可见。");
lines.push("");
lines.push("B. 缺陷修复带来的变化（REQ-004 的收益，不是回归）：");
lines.push("   - S5_provider_no_image：浏览器 provider 返回成功但没有图片数据时，");
lines.push("     旧 nodeExecutor 判 success=true 并把 undefined 写入 outputImage（节点显示成功但无图）；");
lines.push("     统一实现判 success=false, error='未返回图片数据'（节点显示 error）。");
lines.push("     注意真实 gemini provider 在这条路径上会自己先返回 error（gemini.ts:191-208，文案 'API 返回成功但未包含图片数据'），");
lines.push("     所以真实运行时本来就走 error 分支；S5 是替身绕开 provider 校验后的直接对照。");
lines.push("");
lines.push("C. REQ-006 的目标修复（取消落在落盘阶段不再写回）：");
lines.push("   - S9_cancel_during_save：before success=true / status=success；candidate cancelled / status=idle。");
lines.push("");
lines.push("D. 附带的一致性变化（同一节点在两条路径上的字段语义对齐）：");
lines.push(`   - queued 字段：before=${JSON.stringify(b.results.S1_success_no_canvas.node.queued)} -> candidate=${JSON.stringify(c.results.S1_success_no_canvas.node.queued)}`);
lines.push("     执行器启动时写 queued:false（imageGenerationExecution.ts:276-283）；旧工作流实现从不碰 queued。");
lines.push("     UI 影响：ImageGeneratorNode.canRun 依赖 !isQueued，把陈旧的 queued:true 纠正为 false 是放宽而非收紧；");
lines.push("     工作流路径不会写下 queued:true（那是 hook 在入队成功后写的），因此该分支在实际工作流运行中不会有值可改。");
writeFileSync(out, lines.join("\n"), "utf8");
console.log(lines.join("\n"));
