/**
 * 生成队列回归脚本（TASK-004 / TASK-005）
 *
 * 用途：把已验证探针固化成正式回归门禁，覆盖两个业务缺陷：
 *   - REQ-001：应用重启后，持久化里遗留的 queued 任务永远卡在 queued（启动路径不恢复），
 *              且对应节点会一直显示"排队中"
 *   - REQ-002：同一节点连续触发（含连点、并发点击、重试、批量拆分）会重复入队，
 *              产生并发任务写同一 node.data
 *
 * 来源探针（只读基线，本脚本未修改它们）：
 *   docs/adr/（历史探针，已随工作流系统移除）          （REQ-001 现象）
 *   docs/adr/（历史探针，已随工作流系统移除）（partialize / persist API 事实）
 *   docs/adr/（历史探针，已随工作流系统移除）          （REQ-002 红状态；registerHooks 与 STUBS 蓝本）
 *
 * 运行：
 *   node --experimental-strip-types scripts/queue-regression.mjs
 *       默认模式：断言"修复后应有的行为"。业务缺陷未修时用例 FAIL，退出码 1（修复任务的门禁）。
 *   node --experimental-strip-types scripts/queue-regression.mjs --expect-red
 *       红状态自检：断言"这些缺陷目前确实存在"。用例都如预期 FAIL → 退出码 0（说明基础设施有效）；
 *       任一用例意外 PASS（预期红但实际绿）或基础设施出错 → 退出码非 0。
 *
 * 断言强度（为什么不能只看"瞬时活动任务数"和"job 状态"）：
 *   用例 A 同时断言 job 被处置 **和** 对应节点的 data.queued 被清除——只断言 job 状态会漏掉
 *   "job 处置了、节点却永久显示排队中"（ImageGeneratorNode.tsx:215 的 canRun 依赖该标记）。
 *   用例 B 以**同节点 job 总数**为主断言（时间无关：3 次连点后必须仍为 1），辅以峰值采样——
 *   只靠"每次 await 之后的瞬时采样"会在 executeImageGeneration 快速失败时假绿。
 *   用例 C 覆盖 useImageGeneratorExecution.ts:61-74 的**批量分支**（n>1；默认数据 n=1 走不到）：
 *   首点必须恰好拆分出 batchCount 个 job，连点不得增长，且上一批结束后必须能再次生成。
 *   批量场景下"同节点 job 数=4"是合法行为，所以判据不是"必须为 1"，而是"首点等于 batchCount
 *   且后续不增长"。
 *   用例 D 覆盖"该节点已有 **queued**（而非 running）任务"——只有让并发额度被**其他节点**占满，
 *   "仅 running"这种残缺守卫才会暴露（照 taskManager.ts 的 isTaskRunning 字面移植就会这样）。
 *   用例 E 覆盖**并发点击**：连续触发 3 次 handleGenerate() 而不 await，让三次调用在
 *   "handleGenerate 首行 → 第一个 await"之间重叠。串行 await 的用例永远进不到这段窗口，
 *   因此无法区分"守卫放在 handleGenerate 顶部"（入口级）与"守卫放在 store 层"。
 *   用例 F 覆盖 **retry 路径**（QueuePanel.tsx:221 → queueStore.retry → enqueue）：
 *   retry 完全不经过 handleGenerate，任何入口级守卫都拦不住它。
 *   用例 E 与 F 合起来指向同一结论：**去重必须下沉到 queueStore.enqueue**，
 *   因为 store 层判定是同步的（不受 await 窗口影响）且 retry 也走 enqueue。
 *
 * 只使用 Node 内置模块，不引入 vitest/jest/jsdom；断言对象都是可观察行为
 * （store 的公开状态与 hook 的公开返回值），不断言内部变量或私有函数。
 *
 * ⚠ 关键不变量：**默认模式（不带 --self-check）的行为不受任何环境变量影响。**
 *   本脚本从不从 process.env 读取变异开关；变异只能由下面的 CLI 参数开启。
 *   该不变量由 scripts/queue-regression.selfcheck.mjs 自动验证。
 *
 * 变异自检（仅显式传 CLI 参数时启用；只改"被测对象"，绝不改断言）：
 *   node --experimental-strip-types scripts/queue-regression.mjs --self-check=<name[,name...]>
 *     exec-instant-fail        executeImageGeneration 在首个 await 前即失败（复现 B 的瞬时采样假绿路径）
 *     exec-slow                每个 job 6s 才结束（验证用例 C 超窗判 ERROR 而非 FAIL）
 *     partial-fix-job-only     水合后只把 job 置 error、保留节点 queued 标记（复现 A 的假绿路径）
 *     full-fix                 绿色对照：store 层"按点击"去重 + 整批原子化的正确修复模型
 *     guard-active             store 层 queued||running 守卫（正确语义；对照用）
 *     guard-inside-batch-loop  同 guard-active（store 层判定天然不会被批量循环拆散）
 *     guard-running-only       store 层"仅 running"守卫（残缺陷版本）
 *     guard-queued-only        store 层"仅 queued"守卫
 *     guard-global-single      store 层全局单飞（任何节点有活动 job 就拒绝，与 concurrency 1..4 冲突）
 *     store-dedupe-any         store 层按 nodeId 任意去重（含历史 job）
 *     any-history-dedupe       同上（锁死节点重生成）
 *     entry-guard-active       入口级守卫（只在 handleGenerate 顶部按 queued||running 判定）
 *     entry-guard-running-only 入口级守卫（只在 handleGenerate 顶部按 running 判定）
 *   除 full-fix / guard-active 外，其余变异体都必须让本脚本判 FAIL，否则说明判绿条件仍然过松。
 *
 *   未知键名会直接报错并以退出码 2 结束——因为"静默退化为默认模式"会让自检项空过
 *   （这比失败更危险：会让人误以为判红能力已经验证过）。
 */
import { registerHooks } from "node:module";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// ---------------------------------------------------------------------------
// 模式（只读 process.argv；**绝不读 process.env**，保证默认模式不被环境变量影响）
// ---------------------------------------------------------------------------
const MODE = process.argv.includes("--expect-red") ? "expect-red" : "default";

// 变异自检：仅当显式传入 --self-check=<name[,name...]> 时启用。
// 不提供任何环境变量入口——否则 TASK-001 的默认模式门禁可被一个环境变量伪造成"已修复"。
const SELF_CHECK_ARG = process.argv.find((a) => a.startsWith("--self-check"));
const MUTANTS = new Set(
  (SELF_CHECK_ARG ? SELF_CHECK_ARG.split("=")[1] || "" : "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const hasMutant = (name) => MUTANTS.has(name);

// ---------------------------------------------------------------------------
// 自检键名的唯一权威列表。
// 为什么要显式校验：历史上文档里写过 guard-inside-batch-loop，但它没被注册进注入表，
// 于是该键名"静默退化为默认模式"——对应的自检项恒真通过（空过验证比失败更危险，
// 会让人误以为判红能力已验证过）。因此未知键名一律直接报错并以非 0 退出。
// ---------------------------------------------------------------------------
const SELF_CHECK_KEYS = new Set([
  // 被测对象替换
  "exec-instant-fail",
  "exec-slow",
  // 用例 A 的状态改写
  "partial-fix-job-only",
  // 绿色对照
  "full-fix",
  // store 层（enqueue 内）守卫形态
  "guard-active",
  "guard-inside-batch-loop",
  "guard-running-only",
  "guard-queued-only",
  "guard-global-single",
  "store-dedupe-any",
  "any-history-dedupe",
  // 入口级（handleGenerate 顶部判定）守卫形态
  "entry-guard-active",
  "entry-guard-running-only",
]);

const UNKNOWN_MUTANTS = [...MUTANTS].filter((m) => !SELF_CHECK_KEYS.has(m));
if (UNKNOWN_MUTANTS.length > 0) {
  console.error("");
  console.error(`[自检参数错误] --self-check 收到未知键名：${UNKNOWN_MUTANTS.join(", ")}`);
  console.error(`有效键名（${SELF_CHECK_KEYS.size} 个）：${[...SELF_CHECK_KEYS].join(", ")}`);
  console.error("说明：未知键名会静默退化为默认模式，使自检项空过，因此这里直接失败（退出码 2）。");
  console.error("");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 0) 路径与运行时 stub
//    root 由脚本自身位置推导（scripts/ 的上一级），避免依赖 cwd。
// ---------------------------------------------------------------------------
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "src");

// tauriStorage.ts:100 顶层调用 window.addEventListener，必须先于任何 import 打好 stub
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };

// 用例 A 的"重启前持久化数据"：plugin-store stub 从该对象读取，模拟磁盘上已存在的 generation-queue 记录
globalThis.__NC_STORE_SEED__ = {};

// ---------------------------------------------------------------------------
// 变异体：hook 副本（入口级守卫 / 绿色对照）
// 做法：读取**真实 hook 源码**，只插入最少的一行，其余逐字保留。
// 合成模块（load 钩子直接返回 source）不会被 --experimental-strip-types 处理，
// 所以必须落一个真实 .ts 文件。
// 位置：放在 scripts/ 下的临时目录（**必须**在项目内，否则副本里的 `react` 等
// bare specifier 会从系统临时目录向上查找 node_modules 而解析失败）。
// 运行结束时会递归删除该目录。
// ---------------------------------------------------------------------------
const MUTANT_DIR = mkdtempSync(path.join(root, "scripts", ".nc-mutants-"));
const REAL_HOOK_PATH = path.join(SRC, "hooks/useImageGeneratorExecution.ts");
const REAL_HOOK_SRC = readFileSync(REAL_HOOK_PATH, "utf8");
const HOOK_MARKER = "const handleGenerate = useCallback(async () => {";
const BATCH_LOOP = "for (let i = 0; i < batchCount; i++) {";
let MUTANT_HOOK_PATH = null;

if (hasMutant("entry-guard-active") || hasMutant("entry-guard-running-only")) {
  if (!REAL_HOOK_SRC.includes(HOOK_MARKER)) {
    console.error("[自检参数错误] 入口级守卫变异失败：真实 hook 中未找到 handleGenerate 定义");
    process.exit(2);
  }
  const guardLine = hasMutant("entry-guard-running-only")
    ? `const __sameNode = useQueueStore.getState().jobs.filter((j) => j.nodeId === id);
    if (__sameNode.some((j) => j.status === "running")) return;`
    : `const __sameNode = useQueueStore.getState().jobs.filter((j) => j.nodeId === id);
    if (__sameNode.some((j) => j.status === "queued" || j.status === "running")) return;`;
  writeFileSync(path.join(MUTANT_DIR, "package.json"), '{"type":"module"}', "utf8");
  MUTANT_HOOK_PATH = path.join(MUTANT_DIR, "useImageGeneratorExecution.entry-guard.ts");
  writeFileSync(
    MUTANT_HOOK_PATH,
    REAL_HOOK_SRC.replace(
      HOOK_MARKER,
      `${HOOK_MARKER}\n    // ---- 变异注入：守卫置于 handleGenerate 顶部（模拟"入口级守卫"形态）----\n    ${guardLine}`
    ),
    "utf8"
  );
}

if (hasMutant("full-fix")) {
  // 绿色对照：正确修复必须让"一次点击的整批拆分"原子提交，
  // 否则 store 层在整批的第 2 个 job 上就会看到"该节点已有 queued 任务"而把批量截断为 1。
  // 因此真实修复需要 hook 与 store 协同：hook 在批量分支前声明本次点击的批量大小。
  // 这里用**真实 hook 源码**加一行 __beginBatch 来模拟该协同（其余逐字保留）。
  if (!REAL_HOOK_SRC.includes(BATCH_LOOP)) {
    console.error("[自检参数错误] full-fix 变异失败：真实 hook 中未找到批量循环");
    process.exit(2);
  }
  writeFileSync(path.join(MUTANT_DIR, "package.json"), '{"type":"module"}', "utf8");
  MUTANT_HOOK_PATH = path.join(MUTANT_DIR, "useImageGeneratorExecution.fullfix.ts");
  writeFileSync(
    MUTANT_HOOK_PATH,
    REAL_HOOK_SRC.replace(
      BATCH_LOOP,
      `// ---- 变异注入：声明本次点击的批量大小，使整批在 store 层原子判定 ----\n      queue.__beginBatch?.(batchCount);\n      ${BATCH_LOOP}`
    ),
    "utf8"
  );
}

// ---------------------------------------------------------------------------
// 1) STUBS —— 照搬 probe-dup-enqueue.mjs
//    必须在这一层 stub @xyflow/react：react-dom 内部的 CJS require 拦不住
// ---------------------------------------------------------------------------
const STUBS = {
  "@xyflow/react": `export const ReactFlow=()=>null;export const Background=()=>null;export const Controls=()=>null;
    export const MiniMap=()=>null;export const Panel=()=>null;export const Handle=()=>null;export const useReactFlow=()=>({});
    export const applyNodeChanges=(c,n)=>n;export const applyEdgeChanges=(c,e)=>e;export const addEdge=(e,es)=>es;
    export const MarkerType={};export const Position={};export const ConnectionLineType={};export const SelectionMode={};
    export const useStore=()=>({});export const getBezierPath=()=>["","",0,0];export const BaseEdge=()=>null;
    export const EdgeLabelRenderer=()=>null;export const useNodes=()=>[];export const useEdges=()=>[];export default {};`,
  "@tauri-apps/api/core": `export const invoke=async()=>{throw new Error("stub invoke");};
    export const Channel=class{};export const convertFileSrc=(p)=>p;export default {};`,
  "@tauri-apps/api/event": `export const listen=async()=>()=>{};export const emit=async()=>{};export default {};`,
  // 与探针唯一差异：get() 读取 globalThis.__NC_STORE_SEED__，用于给用例 A 注入"重启前已持久化的数据"
  "@tauri-apps/plugin-store": `export class Store{static async load(){return new Store();}
    async get(k){return (globalThis.__NC_STORE_SEED__||{})[k] ?? null;}
    async set(){}async save(){}async delete(){}async keys(){return [];}}
    export const load=async()=>new Store();export default {load};`,
  "@tauri-apps/plugin-fs": `export const readFile=async()=>new Uint8Array();export const writeFile=async()=>{};export const exists=async()=>false;export const mkdir=async()=>{};export const remove=async()=>{};export const stat=async()=>({});export default {};`,
  "@tauri-apps/plugin-dialog": `export const open=async()=>null;export const save=async()=>null;export const message=async()=>{};export const ask=async()=>false;export const confirm=async()=>false;export default {};`,
  "@tauri-apps/plugin-opener": `export const openUrl=async()=>{};export const openPath=async()=>{};export const revealItemInDir=async()=>{};export default {};`,
};

// 无扩展名导入补 .ts/.tsx（只能对真实存在的文件 shortCircuit，否则会破坏 node_modules 里的 CJS 解析）
function withTs(p) {
  if (existsSync(p) && path.extname(p)) return p;
  for (const c of [p + ".ts", p + ".tsx", path.join(p, "index.ts"), path.join(p, "index.tsx")]) {
    if (existsSync(c)) return c;
  }
  return p;
}

// ---------------------------------------------------------------------------
// 2) 加载器：照搬 probe-dup-enqueue.mjs
//    - @/ 别名 → src/
//    - 无扩展名相对导入 → 补 .ts
//    - stub: 协议承载被替换的包
// ---------------------------------------------------------------------------
registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    // 入口级守卫 / 绿色对照：解析到上面写好的真实 hook 副本
    if (MUTANT_HOOK_PATH && spec === "@/hooks/useImageGeneratorExecution") {
      return { url: pathToFileURL(MUTANT_HOOK_PATH).href, shortCircuit: true };
    }
    if (hasMutant("exec-instant-fail") && spec === "@/services/imageGenerationExecution") {
      return { url: "mutant:exec-instant-fail", shortCircuit: true };
    }
    if (hasMutant("exec-slow") && spec === "@/services/imageGenerationExecution") {
      return { url: "mutant:exec-slow", shortCircuit: true };
    }
    if (hasMutant("full-fix") && spec === "@/services/imageGenerationExecution") {
      return { url: "mutant:exec-ok", shortCircuit: true };
    }
    // 用例 H 专用：把 fileStorageService 换成"真实模块 + 可控落盘延迟"的包装。
    // 为什么需要它：真实的 saveImage 走 Tauri IPC（本门禁里被 stub 成抛错），落盘阶段会在
    // catch 分支里瞬间结束，取消根本来不及落进"provider 已返回、结果尚未写回"的窗口 ——
    // 那样用例 H 会**空过**（把修复移除也照样 PASS）。这个包装保留真实 saveImage 的行为，
    // 只在其前后插入一段可等待的时间，使该窗口确定存在（并由用例主动 abort）。
    if (spec === "@/services/fileStorageService") {
      return { url: "mutant:filestorage-gated-save", shortCircuit: true };
    }
    // 用例 H 专用：让 provider 立刻成功（真实 provider 会走 IPC 并被 stub 抛错，
    // 于是执行器在 provider 之前的取消检查就返回 cancelled，取消落不进落盘窗口）。
    // 仅当用例设置了 globalThis.__NC_CANCEL_H_PROVIDER__ 时生效，其余时刻完全透传。
    if (spec === "@/services/imageGeneration") {
      return { url: "mutant:imagegen-cancel-h", shortCircuit: true };
    }
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const base = fileURLToPath(new URL(spec, context.parentURL));
      const t = withTs(base);
      if (existsSync(t)) return { url: pathToFileURL(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    // 用例 H 的落盘闸门：saveImage 先等 globalThis.__NC_SAVE_GATE__ 放行，再调用真实实现。
    // 未设置闸门时是纯透传，不影响任何其它用例。
    if (url === "mutant:filestorage-gated-save") {
      const realPath = JSON.stringify(pathToFileURL(path.join(SRC, "services/fileStorageService.ts")).href);
      return {
        format: "module",
        source: `
          import { saveImage as realSaveImage } from ${realPath};
          export * from ${realPath};
          export async function saveImage(...args) {
            const gate = globalThis.__NC_SAVE_GATE__;
            if (!gate) return realSaveImage(...args);
            gate.markEntered();
            await gate.wait;
            return realSaveImage(...args);
          }
        `,
        shortCircuit: true,
      };
    }
    // 用例 H 的 provider 替身：仅在 __NC_CANCEL_H_PROVIDER__ 存在时返回一个立刻成功的响应，
    // 否则逐字转发真实实现（其它用例完全不受影响）。
    if (url === "mutant:imagegen-cancel-h") {
      const realPath = JSON.stringify(pathToFileURL(path.join(SRC, "services/imageGeneration/index.ts")).href);
      return {
        format: "module",
        source: `
          import { generateImage as realGenerateImage, editImage as realEditImage } from ${realPath};
          export * from ${realPath};
          const fake = { imageData: "data:image/png;base64,iVBORw0KGgo=", imageDataList: ["data:image/png;base64,iVBORw0KGgo="] };
          export const generateImage = async (...args) =>
            globalThis.__NC_CANCEL_H_PROVIDER__ ? fake : realGenerateImage(...args);
          export const editImage = async (...args) =>
            globalThis.__NC_CANCEL_H_PROVIDER__ ? fake : realEditImage(...args);
        `,
        shortCircuit: true,
      };
    }
    // 入队即失败（pump 置 running 后立刻在 .then 里落 error），用于验证用例 B 的断言不依赖时序窗口。
    // getImageBatchCount 必须与真实实现同语义（否则用例 C 会因为"没走批量分支"而误报 ERROR）。
    if (url === "mutant:exec-instant-fail") {
      return {
        format: "module",
        source: `export const executeImageGeneration = async () => ({ success: false, cancelled: false, error: "mutant: instant failure" });
                 export const getImageBatchCount = (data) => (data?.apiProtocol === "openai-images" ? 1 : Math.min(Math.max(data?.n || 1, 1), 4));`,
        shortCircuit: true,
      };
    }
    // 慢速执行：每个 job 6s 才结束，超过用例 C 的 SETTLE_TIMEOUT_MS(5000ms)。
    // 用途：验证"实现正确但执行很慢"时用例 C 判 ERROR（基础设施无法评估）而不是 FAIL（假红）。
    if (url === "mutant:exec-slow") {
      return {
        format: "module",
        source: `export const executeImageGeneration = async () => {
                   await new Promise((r) => setTimeout(r, 6000));
                   return { success: true, cancelled: false };
                 };
                 export const getImageBatchCount = (data) => (data?.apiProtocol === "openai-images" ? 1 : Math.min(Math.max(data?.n || 1, 1), 4));`,
        shortCircuit: true,
      };
    }
    // 绿色对照用的执行服务桩：模拟一次"需要时间的真实生成"（300ms 后才成功），
    // 这样连点发生在任务仍在活动的窗口内，才能区分"正确去重"与"任务恰好已结束"。
    // 它刻意不修改 flowStore/canvasStore 的节点数据，避免干扰用例 A 的 queued 判定。
    if (url === "mutant:exec-ok") {
      return {
        format: "module",
        source: `export const executeImageGeneration = async () => {
                   await new Promise((r) => setTimeout(r, 300));
                   return { success: true, cancelled: false };
                 };
                 export const getImageBatchCount = (data) => (data?.apiProtocol === "openai-images" ? 1 : Math.min(Math.max(data?.n || 1, 1), 4));`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

// 用例里 import hook 时必须走这个函数：直接拼真实文件路径会**绕过** resolve 钩子，
// 导致 hook 副本永远不生效（自检会因此空过——这类"看起来在测、其实没注入"的坑正是要避免的）。
function hookModuleUrl() {
  return pathToFileURL(MUTANT_HOOK_PATH || REAL_HOOK_PATH).href;
}

// ---------------------------------------------------------------------------
// 3) 小工具
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待条件成立，返回是否在超时前成立 */
async function waitFor(predicate, timeoutMs = 1500, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

function summarizeJobs(jobs) {
  if (!jobs || jobs.length === 0) return "(无 job)";
  return jobs.map((j) => `${j.id}:${j.status}`).join(", ");
}

// ---------------------------------------------------------------------------
// 4) 用例 A —— REQ-001 重启恢复
//
// "重启语义"的选择：不用 setState 硬塞内存状态（那只是"有人手动改了 store"），
// 而是把"重启前磁盘上的持久化数据"写进 storage stub，再**首次** import queueStore。
// 真实重启时正是这条路径：模块加载 → zustand persist 立即 getItem("generation-queue")
// → 反序列化 → set(state, true) → onRehydrateStorage 回调。
// （显式调用 persist.rehydrate() 也能驱动水合，但那会在 store 已经水合过一次之后
//   再次用磁盘数据覆盖内存状态，语义上偏离"冷启动"；此处选更贴近真实重启的首次水合。）
//
// 注意：本用例只驱动 **store 自身的水合路径**。若后续修复把"启动时 pump"放在
// App.tsx 之类的 UI 层 useEffect 里，而不在 store 的水合链路里，本用例不会观察到
// 推进，仍会判红——这一点已在交付说明的"不确定处"里标注。
//
// 关于"静默丢弃"的判定方向：若种子任务在水合后消失（既没被处置、也没留下记录），
// 本用例判 ERROR 而不是 PASS。宁可报"基础设施无法评估"，也不让"任务被静默丢弃"
// 伪装成通过；副作用是"任务跑完即出队"的实现也会报 ERROR，这属于已知且可接受的
// 误报方向（不产生假绿）。
// ---------------------------------------------------------------------------
const REQ001_JOB_ID = "regression-stale-queued-1";
const REQ001_NODE_ID = "regression-node-1";

async function caseRestartRecovery() {
  const name = "用例 A：重启后遗留 queued 任务必须被处置且节点不再显示排队中（REQ-001）";
  const impl = "把包含 1 个 status=queued 任务的持久化 JSON 注入 storage stub，在 flowStore 中建立同 nodeId 的节点\n" +
    "         （其 data.queued=true，即重启前 useImageGeneratorExecution 写下的排队标记），再首次 import queueStore，\n" +
    "         走真实冷启动水合路径（persist.getItem → 反序列化 → onRehydrateStorage），随后最多等 1500ms。";
  const expectation = "① 该 job 不再停留在 queued；② 对应节点 data.queued 被清除（falsy），不再永久显示\"排队中\"";

  globalThis.__NC_STORE_SEED__ = {
    "generation-queue": JSON.stringify({
      state: {
        jobs: [
          {
            id: REQ001_JOB_ID,
            nodeId: REQ001_NODE_ID,
            canvasId: null,
            nodeLabel: "回归用例A",
            modelLabel: "regression-model",
            promptPreview: "persisted queued job before restart",
            status: "queued",
            createdAt: Date.now(),
          },
        ],
        concurrency: 2,
      },
      version: 0,
    }),
  };

  // 重启后的节点状态：flowStore 里已有该节点（App.tsx setNodes 的等价物），
  // 且 data.queued=true —— 这是 useImageGeneratorExecution.ts:86-90 在重启前写下的标记，
  // ImageGeneratorNode.tsx:215 的 canRun 依赖它来决定是否禁用"生成"按钮。
  const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
  const { getDefaultImageGeneratorData } = await import(
    pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
  );
  useFlowStore.setState({
    nodes: [
      {
        id: REQ001_NODE_ID,
        type: "imageGeneratorNode",
        position: { x: 0, y: 0 },
        data: { ...getDefaultImageGeneratorData(), prompt: "queued before restart", queued: true },
      },
    ],
    edges: [],
  });

  const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);

  const hydrated = await waitFor(() => useQueueStore.persist.hasHydrated(), 3000);
  const seeded = useQueueStore.getState().jobs.find((j) => j.id === REQ001_JOB_ID);
  if (!seeded) {
    return {
      name, impl, expectation,
      actual: `水合完成=${hydrated}，但种子任务未出现在 store 中（jobs: ${summarizeJobs(useQueueStore.getState().jobs)}）`,
      verdict: "ERROR",
      note: "基础设施异常：持久化数据没有被读入，用例无效（不是业务缺陷的红状态）",
    };
  }

  // 节点读的是 store 的公开状态（不是局部变量），确保断言的是真实可观察结果
  const nodeQueued = () =>
    useFlowStore.getState().nodes.find((n) => n.id === REQ001_NODE_ID)?.data?.queued;

  const statusAfterHydration = seeded.status;
  const queuedFlagAfterHydration = nodeQueued();

  // 变异 partial-fix-job-only：模拟"只修了 job 状态、没清节点标记"的半吊子修复。
  // 它必须让本用例判 FAIL（节点仍显示排队中），否则说明"节点标记"这条断言没有真正起作用。
  if (hasMutant("partial-fix-job-only")) {
    useQueueStore.setState({
      jobs: useQueueStore.getState().jobs.map((j) =>
        j.id === REQ001_JOB_ID ? { ...j, status: "error", error: "应用重启导致中断，可重试", finishedAt: Date.now() } : j
      ),
    });
  }

  // 变异 full-fix（绿色对照）：模拟一次正确修复——处置 job 并且清除节点排队标记。
  // 它必须让本用例判 PASS，否则说明断言永假、会把 TASK-001 的正确修复也误杀。
  if (hasMutant("full-fix")) {
    useQueueStore.setState({
      jobs: useQueueStore.getState().jobs.map((j) =>
        j.id === REQ001_JOB_ID ? { ...j, status: "error", error: "应用重启导致中断，可重试", finishedAt: Date.now() } : j
      ),
    });
    useFlowStore.getState().updateNodeData(REQ001_NODE_ID, { queued: false });
  }

  // 等 job 被处置（进入非 queued 的终态/运行态）
  const jobReleased = await waitFor(() => {
    const j = useQueueStore.getState().jobs.find((x) => x.id === REQ001_JOB_ID);
    return !j || j.status !== "queued";
  }, 1500);
  const finalStatus = useQueueStore.getState().jobs.find((j) => j.id === REQ001_JOB_ID)?.status ?? "(任务已消失)";

  // 等节点排队标记被清除（可能晚于 job 状态更新一拍，所以单独再等一个窗口）
  const flagCleared = await waitFor(() => !nodeQueued(), 1000);
  const finalQueuedFlag = nodeQueued();

  const pass = jobReleased && flagCleared;
  const problems = [];
  if (!jobReleased) problems.push(`job 仍停留在 ${finalStatus}`);
  if (!flagCleared) {
    problems.push(
      `节点 ${REQ001_NODE_ID}.data.queued 仍为 ${JSON.stringify(finalQueuedFlag)}（ImageGeneratorNode 的 canRun 会一直为 false，按钮禁用并显示"排队中"）`
    );
  }

  return {
    name, impl, expectation,
    actual:
      `水合完成=${hydrated}；水合后 job.status=${statusAfterHydration}、节点 data.queued=${JSON.stringify(queuedFlagAfterHydration)}；` +
      `等待后 job.status=${finalStatus}、节点 data.queued=${JSON.stringify(finalQueuedFlag)}`,
    verdict: pass ? "PASS" : "FAIL",
    note: pass ? "" : `未满足：${problems.join("；")}（REQ-001）`,
  };
}

// ---------------------------------------------------------------------------
// 5) 用例 B —— REQ-002 重复入队（串行连点）
//    用 react-dom/server 的 renderToStaticMarkup 驱动**真实** useImageGeneratorExecution，
//    对同一节点连续 await handleGenerate() 3 次。
//
//    断言设计（为什么不只用"每次调用后的瞬时活动数"）：
//    瞬时采样依赖"job 从 queued/running 转为终态"的时序。若 executeImageGeneration 快速失败
//    （首个 await 前就返回），瞬时值可能是 0/1/1 而看起来"没有增长"，但同一节点其实已被
//    重复入队 3 次——这是实测可达的假绿路径。因此主断言改为**时间无关**的量：
//    3 次连点后，队列中属于该节点的 job 总数必须仍为 1。
//    峰值采样只作为辅助证据一并报告。
//
//    ⚠ 覆盖边界（快照限制，实测确认）：renderToStaticMarkup 只调用 Probe **一次**，
//    hook 收到的 data 是渲染期快照（useFlowStore.getState().nodes[0].data），
//    hook 内部后续的 updateNodeData 不会回流到这个快照。因此：
//      - 本用例覆盖**基于 queueStore 真实队列状态**的守卫（REQ-002 的正确实现位置）；
//      - **不覆盖**基于节点 data 快照的守卫（例如 `if (data.queued) return`，即
//        ImageGeneratorNode.tsx:174/215 的 canRun 所依赖的现成标记）——这类实现会让
//        本用例判 FAIL，因为快照里的 queued 永远是初始值 false，守卫不会生效。
//    结论：本用例对"快照型守卫"会假红（不是假绿）。
// ---------------------------------------------------------------------------
async function caseDuplicateEnqueue() {
  const name = "用例 B：同一节点连续点击生成不得重复入队（REQ-002）";
  const impl = "renderToStaticMarkup 挂载真实 useImageGeneratorExecution(\"gen-1\")，取到公开返回的 handleGenerate，\n" +
    "         对同一节点连续 await 调用 3 次；统计该节点的 job 总数（时间无关量）与全程峰值活动数。";
  const expectation = "3 次连点后同节点 job 数恒为 1，且全程活动任务数（queued + running）峰值不超过 1";

  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");

  const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
  const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
  const { useImageGeneratorExecution } = await import(hookModuleUrl());
  const { getDefaultImageGeneratorData } = await import(
    pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
  );

  const NODE_ID = "gen-1";
  useQueueStore.setState({ jobs: [], paused: false, concurrency: 2 });
  useFlowStore.setState({
    nodes: [
      {
        id: NODE_ID,
        type: "imageGeneratorNode",
        position: { x: 0, y: 0 },
        data: { ...getDefaultImageGeneratorData(), prompt: "hello" },
      },
    ],
    edges: [],
  });

  let handle = null;
  function Probe() {
    const { handleGenerate } = useImageGeneratorExecution(NODE_ID, useFlowStore.getState().nodes[0].data);
    handle = handleGenerate;
    return null;
  }
  renderToStaticMarkup(React.createElement(Probe));

  if (typeof handle !== "function") {
    return {
      name, impl, expectation,
      actual: `renderToStaticMarkup 后未拿到可调用的 handleGenerate（typeof=${typeof handle}）`,
      verdict: "ERROR",
      note: "基础设施异常：真实 hook 未被驱动，用例无效",
    };
  }

  const activeCount = () =>
    useQueueStore.getState().jobs.filter((j) => j.status === "queued" || j.status === "running").length;
  const nodeJobCount = () => useQueueStore.getState().jobs.filter((j) => j.nodeId === NODE_ID).length;

  let peakActive = 0;
  const sample = () => {
    peakActive = Math.max(peakActive, activeCount());
  };

  const counts = [];
  for (let i = 1; i <= 3; i++) {
    sample(); // 入队前
    await handle();
    counts.push(activeCount()); // 入队后瞬时（保留为证据，不作为唯一判据）
    sample();
  }

  const totalJobs = useQueueStore.getState().jobs.length;
  const nodeJobs = nodeJobCount();
  if (totalJobs === 0) {
    return {
      name, impl, expectation,
      actual: "3 次 handleGenerate 后队列仍为空（未产生任何 job）",
      verdict: "ERROR",
      note: "基础设施异常：hook 没有走到入队分支，用例无效",
    };
  }

  // 主断言：同节点 job 数（时间无关）；辅助断言：峰值活动数
  const duplicated = nodeJobs > 1;
  const peakExceeded = peakActive > 1;

  return {
    name, impl, expectation,
    actual:
      `同节点(${NODE_ID}) job 数=${nodeJobs}；队列内 job 总数=${totalJobs}；` +
      `瞬时活动数（每次调用后）=${counts.join("/")}；全程活动数峰值=${peakActive}`,
    verdict: duplicated || peakExceeded ? "FAIL" : "PASS",
    note: duplicated
      ? `同一节点被重复入队 ${nodeJobs} 次（连点各自创建了独立任务，会并发写同一 node.data）（REQ-002）` +
        (peakExceeded ? `；活动任务数峰值 ${peakActive}` : "；注意：瞬时采样未捕捉到峰值，仅同节点 job 数暴露了缺陷")
      : peakExceeded
        ? `同节点 job 数正常，但活动任务数峰值 ${peakActive} > 1（REQ-002）`
        : "",
  };
}

// ---------------------------------------------------------------------------
// 6) 用例 C —— REQ-002 批量分支（useImageGeneratorExecution.ts:61-74）
//
// 背景：默认数据 n=1 → getImageBatchCount 恒为 1 → 永远走单图分支，批量分支没有任何门禁。
// 这会让"只在单图分支加去重、批量分支不动"的补丁骗过门禁，而 n=4 时同节点 job 数可达 12。
//
// 判据（批量下 4 是合法值，所以不能说"必须为 1"）：
//   ① 首点后同节点 job 数 == batchCount(4)：整批必须被完整拆分（批量是特性，不能被去重截断）
//   ② 第 2/3 次点击后不增长：仍在活动的这一批不得被重复提交
//   ③ 该批全部结束后再点一次，必须再产生完整的一批（4 个）：去重只能针对"活动任务"，
//      不得按历史 job 锁死节点重生成
// 这三条同时覆盖：(a) 批量无保护（② 失败）、(b) 守卫误置于批量循环内（① 失败）、
// (c) store 层任意去重（① 失败）、(d) 任意历史 job 去重（① 与 ③ 失败）。
//
// ⚠ 覆盖边界（快照限制，与用例 B 相同）：renderToStaticMarkup 只渲染一次，hook 拿到的
// data 是渲染期快照，hook 内部的 updateNodeData 不会回流。因此本用例同样**不覆盖**
// 基于节点 data 快照的守卫（如 `if (data.queued) return`），那类实现会被判 FAIL（假红，非假绿）。
// ---------------------------------------------------------------------------
const BATCH_N = 4;
// 批量用例第 ③ 条等待该批结束的窗口。超窗判 ERROR（基础设施无法评估）而不是 FAIL，
// 因为真实生成远慢于测试桩，正确修复不应该仅因耗时而变红。
const SETTLE_TIMEOUT_MS = 5000;

async function caseBatchEnqueue() {
  const name = "用例 C：批量（n=4）必须完整拆分且连点不增长（REQ-002 批量分支）";
  const impl = `renderToStaticMarkup 挂载真实 useImageGeneratorExecution("gen-batch")，节点数据 n=${BATCH_N}（gemini 协议 → batchCount=${BATCH_N}，\n` +
    "         走 useImageGeneratorExecution.ts:61-74 的批量分支）；连点 3 次后等该批全部结束，再点第 4 次。";
  const expectation =
    `① 首点后同节点 job 数 == ${BATCH_N}（整批完整拆分）；② 第 2/3 次点击后不再增长；③ 该批结束后再点一次仍能产生新的完整一批`;

  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");

  const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
  const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
  const { useImageGeneratorExecution } = await import(hookModuleUrl());
  const { getDefaultImageGeneratorData } = await import(
    pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
  );
  const { getImageBatchCount } = await import(
    pathToFileURL(path.join(SRC, "services/imageGenerationExecution.ts")).href
  );

  const NODE_ID = "gen-batch";
  const nodeData = { ...getDefaultImageGeneratorData(), prompt: "batch hello", n: BATCH_N };

  // 前置事实核对：确认 n=4 确实会走批量分支（否则用例无效，判 ERROR 而不是静默通过）
  const batchCount = getImageBatchCount(nodeData);
  if (batchCount !== BATCH_N) {
    return {
      name, impl, expectation,
      actual: `getImageBatchCount(n=${BATCH_N}) 返回 ${batchCount}，未走批量分支`,
      verdict: "ERROR",
      note: "基础设施异常：批量分支未被覆盖，用例无效（不是业务缺陷的红状态）",
    };
  }

  useQueueStore.setState({ jobs: [], paused: false, concurrency: 2 });
  useFlowStore.setState({
    nodes: [{ id: NODE_ID, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: nodeData }],
    edges: [],
  });

  let handle = null;
  function Probe() {
    const { handleGenerate } = useImageGeneratorExecution(NODE_ID, useFlowStore.getState().nodes[0].data);
    handle = handleGenerate;
    return null;
  }
  renderToStaticMarkup(React.createElement(Probe));

  if (typeof handle !== "function") {
    return {
      name, impl, expectation,
      actual: `renderToStaticMarkup 后未拿到可调用的 handleGenerate（typeof=${typeof handle}）`,
      verdict: "ERROR",
      note: "基础设施异常：真实 hook 未被驱动，用例无效",
    };
  }

  const activeCount = () =>
    useQueueStore.getState().jobs.filter((j) => j.status === "queued" || j.status === "running").length;
  const nodeJobCount = () => useQueueStore.getState().jobs.filter((j) => j.nodeId === NODE_ID).length;

  const click = async () => {
    await handle();
  };

  await click();
  const after1 = nodeJobCount();
  // 前提核对：真正的"连点"要求上一批仍在活动。若执行快到已全部结束，本用例就无法区分
  // "连点保护"与"合法的下一批"，此时判 ERROR 而不是猜一个 PASS/FAIL。
  const premiseOk = activeCount() > 0;
  await click();
  const after2 = nodeJobCount();
  await click();
  const after3 = nodeJobCount();

  // ③ 需要等这一批真正结束（否则"重生成"与"连点保护"无法区分）
  const settled = await waitFor(() => activeCount() === 0, SETTLE_TIMEOUT_MS, 25);
  const beforeRegen = nodeJobCount();
  await click();
  const afterRegen = nodeJobCount();

  if (after1 === 0) {
    return {
      name, impl, expectation,
      actual: "首点后未产生任何 job（未走批量入队分支）",
      verdict: "ERROR",
      note: "基础设施异常：hook 没有走到批量入队分支，用例无效",
    };
  }
  if (!premiseOk) {
    return {
      name, impl, expectation,
      actual: `首点后同节点 job 数=${after1}，但第 2 次点击前该批已全部结束（活动数=0）`,
      verdict: "ERROR",
      note: "基础设施异常：连点前提未建立（上一批已跑完），本用例无法区分\"连点保护\"与\"合法的下一批\"，需要放慢/加快执行时序后重试",
    };
  }

  const firstBatchExact = after1 === BATCH_N;
  const noGrowth = after3 === after1; // 第 2/3 次点击不得再新增
  const canRegenerate = settled && afterRegen - beforeRegen === BATCH_N;

  // 第 ③ 条依赖"该批在窗口内结束"。若实现正确但执行很慢（真实生成远慢于桩），
  // 超窗只是"基础设施无法评估"，不是"业务缺陷未修"——必须判 ERROR 而非 FAIL，
  // 否则同一份正确修复会仅因耗时而变红，并被误读为 REQ-002 仍未修复。
  if (!settled) {
    return {
      name, impl, expectation,
      actual:
        `batchCount=${batchCount}；首点后同节点 job 数=${after1}；连点后=${after1}/${after2}/${after3}；` +
        `该批在 ${SETTLE_TIMEOUT_MS}ms 内未结束（仍有 ${activeCount()} 个活动 job）`,
      verdict: "ERROR",
      note: `基础设施无法评估：第 ③ 条需要该批跑完，但 ${SETTLE_TIMEOUT_MS}ms 内未结束。这不是业务缺陷的判定，需要调大 SETTLE_TIMEOUT_MS 或改用更快的执行环境后重跑`,
    };
  }

  const problems = [];
  if (!firstBatchExact) {
    problems.push(
      `首点只产生 ${after1} 个 job，应为完整的 ${BATCH_N} 个（批量拆分被截断：守卫误置于批量循环内/store 层任意去重）`
    );
  }
  if (!noGrowth) problems.push(`第 2/3 次点击把同节点 job 数从 ${after1} 推高到 ${after3}（批量分支没有重复入队保护）`);
  if (!canRegenerate) {
    problems.push(`该批结束后再点一次只新增 ${afterRegen - beforeRegen} 个 job，应为 ${BATCH_N} 个（去重锁死了节点重生成）`);
  }

  return {
    name, impl, expectation,
    actual:
      `batchCount=${batchCount}；首点后同节点 job 数=${after1}；连点后=${after1}/${after2}/${after3}；` +
      `该批结束=${settled}；结束后再点一次新增=${afterRegen - beforeRegen}（累计 ${afterRegen}）`,
    verdict: problems.length === 0 ? "PASS" : "FAIL",
    note: problems.length === 0 ? "" : `未满足：${problems.join("；")}（REQ-002 批量分支）`,
  };
}

// ---------------------------------------------------------------------------
// 6b) 用例 D —— "该节点已有 queued（但非 running）任务"场景
//
// 为什么必须有这条：REQ-002 的验收文本是"同一节点已有 **queued 或 running** 任务时，再次触发
// 不再产生并发任务"。若实现者照 taskManager.ts 的 isTaskRunning 字面移植为"仅 running"，
// 用例 B/C 结构上抓不到——因为在单节点场景里，enqueue 会在同一次同步调用内把 job 置为 running，
// 所以"该节点已有 running job"与"该节点已有 queued job"永远同时成立，两种守卫无法区分。
//
// 构造方式：把并发额度（concurrency=1）用**另一个节点 Z** 的 running job 占满，
// 这样对节点 B 的点击只会产生 queued job（永远不会被 pump 派发），于是
// "该节点已有 queued 任务"这一状态第一次变得可观测。
// （Z 的 job 直接注入 store 状态，而不是靠执行耗时来维持占用——否则时序一变，
//   B 的任务就可能抢到额度变成 running，用例又会失去区分力。）
//
// 判据：
//   ① 首点后节点 B 的 queued 数 == 1：B 是**另一个节点**，不得被连带拒绝
//      （否则就是"全局单飞"守卫，会禁止不同节点并发生成，与 queueStore 的 concurrency 1..4 冲突）
//   ② 第 2/3 次点击后 B 的 queued 数不增长：仅 running 守卫会放行这两次
// ---------------------------------------------------------------------------
async function caseQueuedNotRunning() {
  const name = "用例 D：该节点已有 queued（非 running）任务时也不得重复入队（REQ-002）";
  const impl = "concurrency=1，先用**另一节点** Z 的 running job 占满额度；再对节点 B 用 renderToStaticMarkup 挂载真实\n" +
    "         useImageGeneratorExecution 并连点 3 次；断言 B 的 queued 数（时间无关量）。";
  const expectation = "① 首点后节点 B 的 queued 数 == 1（不得被其他节点的占用连带拒绝）；② 第 2/3 次点击后不再增长";

  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");

  const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
  const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
  const { useImageGeneratorExecution } = await import(hookModuleUrl());
  const { getDefaultImageGeneratorData } = await import(
    pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
  );

  const NODE_B = "gen-queued-b"; // 被判定的节点
  const NODE_Z = "gen-slot-z"; // 额度占位节点

  // 节点 Z：直接注入一个 running job，把 concurrency=1 的额度占满
  useQueueStore.setState({
    concurrency: 1,
    paused: false,
    jobs: [
      {
        id: "regression-slot-holder",
        nodeId: NODE_Z,
        canvasId: null,
        nodeLabel: "回归用例D占位",
        modelLabel: "regression-model",
        promptPreview: "occupy the only concurrency slot",
        status: "running",
        createdAt: Date.now(),
        startedAt: Date.now(),
      },
    ],
  });
  useFlowStore.setState({
    nodes: [
      {
        id: NODE_B,
        type: "imageGeneratorNode",
        position: { x: 0, y: 0 },
        data: { ...getDefaultImageGeneratorData(), prompt: "queued behind slot holder" },
      },
    ],
    edges: [],
  });

  let handle = null;
  function Probe() {
    const { handleGenerate } = useImageGeneratorExecution(NODE_B, useFlowStore.getState().nodes[0].data);
    handle = handleGenerate;
    return null;
  }
  renderToStaticMarkup(React.createElement(Probe));

  if (typeof handle !== "function") {
    return {
      name, impl, expectation,
      actual: `renderToStaticMarkup 后未拿到可调用的 handleGenerate（typeof=${typeof handle}）`,
      verdict: "ERROR",
      note: "基础设施异常：真实 hook 未被驱动，用例无效",
    };
  }

  // 前提核对：额度必须确实被 Z 占满，否则 B 的任务会直接变成 running，本用例失去区分力
  const runningCount = () => useQueueStore.getState().jobs.filter((j) => j.status === "running").length;
  if (runningCount() < useQueueStore.getState().concurrency) {
    return {
      name, impl, expectation,
      actual: `并发额度未被占满（running=${runningCount()}，concurrency=${useQueueStore.getState().concurrency}）`,
      verdict: "ERROR",
      note: "基础设施异常：未建立\"额度被其他节点占满\"的前提，用例无效",
    };
  }

  const queuedOf = (nodeId) =>
    useQueueStore.getState().jobs.filter((j) => j.nodeId === nodeId && j.status === "queued").length;

  await handle();
  const after1 = queuedOf(NODE_B);
  await handle();
  const after2 = queuedOf(NODE_B);
  await handle();
  const after3 = queuedOf(NODE_B);

  const bRunning = useQueueStore
    .getState()
    .jobs.filter((j) => j.nodeId === NODE_B && j.status === "running").length;

  const problems = [];
  if (after1 !== 1) {
    problems.push(
      after1 === 0
        ? "节点 B 的首次点击被拒绝（0 个 queued job）——守卫没有按 nodeId 区分，把\"其他节点占满额度\"误当成\"B 已有任务\"，会禁止不同节点并发生成（全局单飞）"
        : `首点后节点 B 的 queued 数=${after1}，应为 1`
    );
  }
  if (after3 !== after1) {
    problems.push(
      `第 2/3 次点击把节点 B 的 queued 数从 ${after1} 推高到 ${after3}（仅 running 的守卫放行了"已有 queued 任务"的重复入队；这些 job 会在占位任务结束后被派发，并发写同一 node.data）`
    );
  }

  return {
    name, impl, expectation,
    actual:
      `额度占位：节点 ${NODE_Z} running=1 / concurrency=${useQueueStore.getState().concurrency}；` +
      `节点 ${NODE_B} queued 数：首点后=${after1}，连点后=${after1}/${after2}/${after3}；B 的 running 数=${bRunning}（应恒为 0）`,
    verdict: problems.length === 0 ? "PASS" : "FAIL",
    note: problems.length === 0 ? "" : `未满足：${problems.join("；")}（REQ-002）`,
  };
}

// ---------------------------------------------------------------------------
// 6c) 用例 E —— 并发点击（不 await 上一次调用就再次点击）
//
// 为什么必须有这条：用例 B/C/D 都是"await 完上一次才点下一次"，因此**从不进入**
// handleGenerate 首行到第一个 await（getConnectedInputDataAsync）之间的窗口。
// 守卫若放在 handleGenerate 顶部（"入口级守卫"），在这段窗口里重入时看到的队列状态
// 与真正入队时刻不同——现实连点（各自独立宏任务）仍会产生同节点多个并发 job。
//
// 做法：连续触发 3 次 handleGenerate() 但**不 await**（收集 promise 后一起 await）。
// 这样三次调用都从各自的同步段进入，重叠窗口真实存在。
// 同时把输入解析路径放慢 60ms：真实场景里节点连了带 imagePath 的图片输入节点时，
// flowStore.ts:1140/1153 → readImage → invoke("read_image") 是真实 IPC 往返，
// 窗口会明显更长。这里用固定延迟稳定复现该窗口（这是"被测环境"而非"被测逻辑"）。
// 判据仍是时间无关量：同节点 job 数。
// ---------------------------------------------------------------------------
async function caseConcurrentClicks() {
  const name = "用例 E：并发点击（不 await 上一次调用）不得重复入队（REQ-002）";
  const impl = "连续触发 3 次 handleGenerate() 但**不 await**（收集 promise 后一起 await），并在输入解析路径注入 60ms\n" +
    "         延迟以拉长\"守卫通过后、尚未入队\"的窗口（贴近真实 IPC 往返）；断言同节点 job 数。";
  const expectation = "3 次重叠点击后同节点 job 数 == 1（时间无关量）";

  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");

  const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
  const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
  const { useImageGeneratorExecution } = await import(hookModuleUrl());
  const { getDefaultImageGeneratorData } = await import(
    pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
  );

  const NODE_ID = "gen-concurrent";
  useQueueStore.setState({ jobs: [], paused: false, concurrency: 2 });
  useFlowStore.setState({
    nodes: [
      {
        id: NODE_ID,
        type: "imageGeneratorNode",
        position: { x: 0, y: 0 },
        data: { ...getDefaultImageGeneratorData(), prompt: "concurrent clicks" },
      },
    ],
    edges: [],
  });

  // 拉长"守卫通过 → 真正入队"的窗口（模拟真实 IPC 往返；见上方注释）
  const originalResolveInputs = useFlowStore.getState().getConnectedInputDataAsync;
  useFlowStore.setState({
    getConnectedInputDataAsync: async (nodeId) => {
      await sleep(60);
      return originalResolveInputs(nodeId);
    },
  });

  let handle = null;
  function Probe() {
    const { handleGenerate } = useImageGeneratorExecution(NODE_ID, useFlowStore.getState().nodes[0].data);
    handle = handleGenerate;
    return null;
  }
  renderToStaticMarkup(React.createElement(Probe));

  if (typeof handle !== "function") {
    return {
      name, impl, expectation,
      actual: `renderToStaticMarkup 后未拿到可调用的 handleGenerate（typeof=${typeof handle}）`,
      verdict: "ERROR",
      note: "基础设施异常：真实 hook 未被驱动，用例无效",
    };
  }

  const nodeJobCount = () => useQueueStore.getState().jobs.filter((j) => j.nodeId === NODE_ID).length;

  // 关键：三次调用都不 await，让它们在"首行 → 第一个 await"之间重叠
  const pending = [handle(), handle(), handle()];
  await Promise.allSettled(pending);

  const nodeJobs = nodeJobCount();
  if (nodeJobs === 0) {
    return {
      name, impl, expectation,
      actual: "3 次重叠点击后未产生任何 job（未走到入队分支）",
      verdict: "ERROR",
      note: "基础设施异常：hook 没有走到入队分支，用例无效",
    };
  }

  return {
    name, impl, expectation,
    actual: `3 次重叠点击（不 await）后同节点(${NODE_ID}) job 数=${nodeJobs}`,
    verdict: nodeJobs === 1 ? "PASS" : "FAIL",
    note:
      nodeJobs === 1
        ? ""
        : `重叠窗口内重复入队：同节点产生了 ${nodeJobs} 个 job（守卫若只在 handleGenerate 顶部判定，` +
          `在这段窗口里看到的队列状态与入队时刻不一致；store 层判定是同步的，不受窗口影响）（REQ-002）`,
  };
}

// ---------------------------------------------------------------------------
// 6d) 用例 F —— retry 路径（QueuePanel.tsx:221 → queueStore.retry → enqueue）
//
// retry（queueStore.ts:93）直接调用 enqueue，**完全不经过 handleGenerate**。
// 因此任何放在 handleGenerate 入口的守卫都拦不住它：同一节点失败后反复点重试，
// 会让该节点的并发生成任务持续增长。判据仍是时间无关量（同节点 job 数）。
// ---------------------------------------------------------------------------
async function caseRetry() {
  const name = "用例 F：重试（QueuePanel 入口）不得让同节点并发任务增长（REQ-002）";
  const impl = "直接调用 useQueueStore.getState().retry(id)（QueuePanel.tsx:221 的真实入口）连续重试 3 次；\n" +
    "         断言同节点 job 数与活动任务数不增长（retry 不经过 handleGenerate，入口级守卫拦不住）。";
  const expectation = "连续重试只应产生 1 个新任务，不得让同节点的并发任务累积增长";

  const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
  const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
  const { getDefaultImageGeneratorData } = await import(
    pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
  );

  const NODE_ID = "gen-retry";
  useFlowStore.setState({
    nodes: [
      {
        id: NODE_ID,
        type: "imageGeneratorNode",
        position: { x: 0, y: 0 },
        data: { ...getDefaultImageGeneratorData(), prompt: "retry path" },
      },
    ],
    edges: [],
  });

  // 用一个终态（error）job 作为重试对象——这正是 QueuePanel 上"重试"按钮的场景
  const failedId = "regression-retry-failed";
  useQueueStore.setState({
    jobs: [
      {
        id: failedId,
        nodeId: NODE_ID,
        canvasId: null,
        nodeLabel: "回归用例F",
        modelLabel: "regression-model",
        promptPreview: "failed job to retry",
        status: "error",
        createdAt: Date.now(),
        finishedAt: Date.now(),
        error: "regression: simulated failure",
      },
    ],
    paused: false,
    concurrency: 2,
  });

  const nodeJobCount = () => useQueueStore.getState().jobs.filter((j) => j.nodeId === NODE_ID).length;
  const activeCount = () =>
    useQueueStore.getState().jobs.filter((j) => j.status === "queued" || j.status === "running").length;

  const before = nodeJobCount();
  const activeBefore = activeCount();
  const failedJobWasError = useQueueStore.getState().jobs.find((j) => j.id === failedId)?.status === "error";

  // QueuePanel 的真实入口：连续重试 3 次（同步循环，3 次之间没有 await，
  // 所以第 2/3 次调用时第 1 次产生的任务是"活动"状态——与用户快速连点重试一致）
  for (let i = 0; i < 3; i++) {
    useQueueStore.getState().retry(failedId);
  }
  const after = nodeJobCount();
  const activeAfter = activeCount();

  // 情形一：重试完全没有产生新 job。这可能是两种截然不同的情况，必须区分：
  //   (a) 原任务被就地重新排队（retry 复用了它）→ 重试有效且没有增长，应当 PASS；
  //   (b) 重试被守卫整个吞掉（什么都没发生）→ 这是真实缺陷（用户点重试无反应），必须 FAIL。
  if (after === before) {
    if (activeAfter > activeBefore || failedJobWasError) {
      const requeued = useQueueStore.getState().jobs.find((j) => j.id === failedId)?.status;
      if (requeued === "queued" || requeued === "running") {
        return {
          name, impl, expectation,
          actual: `重试前后同节点 job 数均为 ${before}；原任务被就地重新排队（status=${requeued}），活动数 ${activeBefore}→${activeAfter}`,
          verdict: "PASS",
          note: "",
        };
      }
    }
    return {
      name, impl, expectation,
      actual: `重试前同节点 job 数=${before}（活动 ${activeBefore}）；连续重试 3 次后=${after}，且原任务仍为 ${failedJobWasError ? "error" : "非活动"} 状态`,
      verdict: "FAIL",
      note:
        "重试被守卫整个吞掉：连续重试 3 次既没有产生新任务、也没有把原任务重新排队，" +
        "用户在 QueuePanel 点\"重试\"不会有任何反应（去重只能针对活动任务，不能按历史 job 锁死重试）（REQ-002）",
    };
  }

  const newJobs = after - before;
  return {
    name, impl, expectation,
    actual:
      `重试前：同节点 job 数=${before}（活动 ${activeBefore}）；连续 retry 3 次后：同节点 job 数=${after}（活动 ${activeAfter}），` +
      `本次新增=${newJobs}`,
    verdict: newJobs === 1 ? "PASS" : "FAIL",
    note:
      newJobs === 1
        ? ""
        : `连续重试在同节点累积了 ${newJobs} 个新 job（活动任务 ${activeBefore}→${activeAfter}）：` +
          `retry 走 queueStore.retry → enqueue，不经过 handleGenerate，入口级守卫拦不住；` +
          `去重必须下沉到 store 层（REQ-002）`,
  };
}

// ---------------------------------------------------------------------------
// 6e) 用例 G —— REQ-005 全局单一并发上限
//
// 修复前的缺陷：两条路径各自持有互不知情的独立上限 —— queueStore.concurrency（默认 2，
// UI 可设 1..4）与 workflowEngine.maxParallelNodes（默认 3）。叠加最坏 5 路同时打同一个
// API Key，而且全项目没有任何地方能查询"现在几路在途"。
//
// 本用例断言修复后应有的行为，判据全部落在**真实出口**上，而不是只看计数器：
//   ① 全局额度的唯一来源可查询、可设置；
//   ② 额度被外部（模拟工作流路径）占满时，队列任务**留在 queued**（不置 running、不发出请求）；
//   ③ 外部归还额度后，队列被**唤醒**并真的把任务发出去（证明不会"停车后没人叫"）；
//   ④ 既有的 6 条用例（A–F）继续全绿，证明 REQ-005 没有破坏 REQ-001/002 的守卫与恢复语义。
//
// 为什么必须新增这条：既有 A–F 全部是单节点、且没有全局额度竞争，结构上抓不到"两条路径
// 各自为政"。而 ④ 由本门禁的其余用例承担，因此本用例只需专注②③这两个新边界。
// ---------------------------------------------------------------------------
async function caseGlobalConcurrencyLimit() {
  const name = "用例 G：全局并发上限是唯一来源，超限排队且归还后被唤醒（REQ-005）";
  const impl = "加载真实 concurrencyLimiter 与 queueStore：把全局额度设为 1，先由**外部**（模拟工作流路径）\n" +
    "         占住唯一额度，再让队列有 2 个 queued 任务，观察是否停车；随后外部归还，观察是否被唤醒执行。";
  const expectation = "① 额度被外部占满时队列任务必须留在 queued（不置 running）；② 外部归还后队列被唤醒并开始执行；③ 全局在途数任一时刻不超过上限";

  // concurrencyLimiter 是零依赖模块，可直接按真实路径加载
  const limiter = await import(
    pathToFileURL(path.join(SRC, "services/concurrencyLimiter.ts")).href
  );
  const required = [
    "getGlobalConcurrencyLimit",
    "setGlobalConcurrencyLimit",
    "getInFlightCount",
    "getWaiterCount",
    "tryAcquireGlobalSlot",
    "acquireGlobalSlot",
    "onGlobalSlotReleased",
    "resetGlobalConcurrencyLimiter",
  ];
  const missing = required.filter((k) => typeof limiter[k] !== "function" && k !== "DEFAULT_GLOBAL_CONCURRENCY_LIMIT");
  if (missing.length > 0) {
    return {
      name, impl, expectation,
      actual: `src/services/concurrencyLimiter.ts 缺少导出：${missing.join(", ")}`,
      verdict: "FAIL",
      note: "REQ-005 要求存在唯一可查询、可设置的全局并发额度来源；该模块缺失或 API 不完整" +
        "（修复前根本不存在这个模块，因此本用例在修复前必然判 FAIL）",
    };
  }

  const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);

  // 隔离：先清空队列并等一拍，让**前面用例**留下的在途任务收尾。
  // 不这样做会有真实的串扰：用例 F 结束时仍有一个 job 在跑，它稍后收尾时会归还额度、
  // 并触发 onGlobalSlotReleased 唤醒队列 —— 那会在本用例"占满额度"之后把额度让出来，
  // 使本用例的前提失效（表现为刚拿到的额度凭空消失、被占满的假设不成立）。
  useQueueStore.setState({ jobs: [] });
  await sleep(250);

  // 干净的起点
  limiter.resetGlobalConcurrencyLimiter();
  limiter.setGlobalConcurrencyLimit(1);
  useQueueStore.setState({
    paused: false,
    concurrency: 4, // 队列自己愿意开 4 个（UI 上限），但全局只有 1 个额度
    jobs: [
      { id: "g-a", nodeId: "g-node-a", canvasId: null, nodeLabel: "G-A", modelLabel: "m", promptPreview: "a", status: "queued", createdAt: Date.now() },
      { id: "g-b", nodeId: "g-node-b", canvasId: null, nodeLabel: "G-B", modelLabel: "m", promptPreview: "b", status: "queued", createdAt: Date.now() + 1 },
    ],
  });

  // 外部（模拟工作流路径的节点执行）占住唯一额度
  const externalRelease = limiter.tryAcquireGlobalSlot();
  if (!externalRelease) {
    limiter.resetGlobalConcurrencyLimiter();
    useQueueStore.setState({ jobs: [] });
    return {
      name, impl, expectation,
      actual: "把全局额度设为 1 后，外部 tryAcquireGlobalSlot() 仍返回 null",
      verdict: "ERROR",
      note: "基础设施异常：无法建立\"额度被占满\"的前提，用例无效",
    };
  }

  const runningCount = () => useQueueStore.getState().jobs.filter((j) => j.status === "running").length;
  const queuedCount = () => useQueueStore.getState().jobs.filter((j) => j.status === "queued").length;

  useQueueStore.getState().pump();
  await sleep(120);

  const runningWhileBlocked = runningCount();
  const queuedWhileBlocked = queuedCount();
  const inFlightWhileBlocked = limiter.getInFlightCount();

  // 外部归还 → 队列必须被唤醒（不依赖本队列自己的任务收尾）
  externalRelease();
  const wokeUp = await waitFor(() => runningCount() > 0 || queuedCount() < 2, 3000, 20);

  const runningAfterRelease = runningCount();
  const inFlightAfterRelease = limiter.getInFlightCount();

  // 收尾：清空并复位，避免影响后续用例
  useQueueStore.setState({ jobs: [] });
  limiter.resetGlobalConcurrencyLimiter();

  const okNoStart = runningWhileBlocked === 0 && queuedWhileBlocked === 2;
  const okCap = inFlightWhileBlocked <= 1;
  const okWake = wokeUp === true;
  const okAll = okNoStart && okCap && okWake;

  return {
    name, impl, expectation,
    actual:
      `额度占满时：队列 running=${runningWhileBlocked}（期望 0）、仍 queued=${queuedWhileBlocked}（期望 2）、全局在途=${inFlightWhileBlocked}（上限 1）；` +
      `外部归还后：被唤醒=${okWake}、队列 running=${runningAfterRelease}、全局在途=${inFlightAfterRelease}`,
    verdict: okAll ? "PASS" : "FAIL",
    note: okAll
      ? ""
      : [
          okNoStart ? "" : "额度被占满时队列仍把任务置为 running（等于超限发出请求，REQ-005 未生效）",
          okCap ? "" : `全局在途 ${inFlightWhileBlocked} 超过上限 1`,
          okWake ? "" : "外部归还额度后队列没有被唤醒（任务会永远停在 queued —— 停车后必须有人叫醒它）",
        ].filter(Boolean).join("；"),
  };
}

// ---------------------------------------------------------------------------
// 6f) 用例 H —— REQ-006 取消后不得写回结果
//
// 修复前的缺陷：执行器只在"发起前"与"请求刚返回后"检查 signal.aborted，而两者之间、以及
// 返回之后到成功写回之间还有多处真实 await（persistInputImages、Promise.all(saveImage) 等
// IPC 往返）。取消恰好落进那些 await 时，代码会继续走成功分支：把 status:"success" 与
// outputImage/outputImagePath 写进节点数据，并把 runRecords 记为成功 —— 用户点了取消却看到
// "生成成功"，而且该结果会被画布持久化进 app-data.json。
//
// 为什么必须新增这条：既有 A–F 无一条涉及取消后的写回（probe-cancel-abort-lock.mjs 尽管
// 名字相像，断言的是 REQ-001 的 queued 标记锁，不是"结果不得落盘"）。
//
// 判据（时间无关）：取消后节点 status 不得为 "success"，且不得出现本次的 outputImagePath/
// outputImagePaths；同时执行器必须返回 cancelled 而不是把取消当成成功。
// ---------------------------------------------------------------------------
async function caseCancelDoesNotWriteBack() {
  const name = "用例 H：取消落在落盘阶段时不得把结果写回节点（REQ-006）";
  const impl = "真实 executeImageGeneration + 确定性窗口：provider 立刻成功（标志位触发的透传替身），\n" +
    "         落盘 saveImage 被闸门停住，在该窗口内 abort 后再放行；断言结果不得写回节点。";
  const expectation = "取消后：执行器返回 cancelled=true，节点 status !== \"success\"，且未写入本次 outputImage/outputImagePath/outputImages/outputImagePaths";

  const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
  const { getDefaultImageGeneratorData } = await import(
    pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
  );
  const { executeImageGeneration } = await import(
    pathToFileURL(path.join(SRC, "services/imageGenerationExecution.ts")).href
  );

  const NODE = "cancel-node-h";
  const CANVAS = "cancel-canvas-h";
  useFlowStore.setState({
    nodes: [
      {
        id: NODE,
        type: "imageGeneratorNode",
        position: { x: 0, y: 0 },
        data: { ...getDefaultImageGeneratorData(), prompt: "cancel regression h" },
      },
    ],
    edges: [],
  });
  // canvasId 不能为 null：执行器只在"有画布"时才走 persistInputImages/saveImage 落盘分支
  // （否则结果只走 base64 回退，落盘窗口根本不存在，本用例会空过）。
  // 这里建立一个真实画布并设为活动画布，让落盘分支确定被执行。
  const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
  useCanvasStore.setState({
    activeCanvasId: CANVAS,
    canvases: [
      {
        id: CANVAS,
        name: "cancel-regression",
        nodes: [
          {
            id: NODE,
            type: "imageGeneratorNode",
            position: { x: 0, y: 0 },
            data: { ...getDefaultImageGeneratorData(), prompt: "cancel regression h" },
          },
        ],
        edges: [],
      },
    ],
  });

  // 打开两个确定性开关：
  //   __NC_CANCEL_H_PROVIDER__  → provider 立刻返回图片（无需 IPC）
  //   __NC_SAVE_GATE__          → saveImage 进入后停住，直到用例放行
  let resolveEntered;
  const entered = new Promise((resolve) => { resolveEntered = resolve; });
  let releaseSave;
  const saveMayProceed = new Promise((resolve) => { releaseSave = resolve; });
  globalThis.__NC_CANCEL_H_PROVIDER__ = true;
  globalThis.__NC_SAVE_GATE__ = { markEntered: () => resolveEntered(), wait: saveMayProceed };

  const controller = new AbortController();
  let result;
  let windowOpened = false;
  try {
    const run = executeImageGeneration(NODE, {
      canvasId: CANVAS,
      withRunRecords: false,
      signal: controller.signal,
    });

    // 等到 saveImage 真的进入（说明 provider 已返回、正处于落盘阶段）
    windowOpened = await Promise.race([
      entered.then(() => true),
      sleep(5000).then(() => false),
    ]);

    if (!windowOpened) {
      releaseSave();
      await run.catch(() => {});
      return {
        name, impl, expectation,
        actual: "未能进入落盘窗口（saveImage 未被调用）",
        verdict: "ERROR",
        note: "基础设施异常：用例 H 依赖\"provider 已返回、正在落盘\"这一窗口；窗口未建立时不得判 PASS（否则会空过）",
      };
    }

    // 关键时序：取消发生在窗口内，然后才放行落盘
    controller.abort();
    releaseSave();
    result = await run;
  } catch (error) {
    try { releaseSave(); } catch {}
    return {
      name, impl, expectation,
      actual: `执行器在取消路径上抛出异常：${error && error.message ? error.message : String(error)}`,
      verdict: "ERROR",
      note: "基础设施异常：取消路径应返回 {success:false, cancelled:true}，不应抛错",
    };
  } finally {
    delete globalThis.__NC_CANCEL_H_PROVIDER__;
    delete globalThis.__NC_SAVE_GATE__;
  }

  const node = useFlowStore.getState().nodes.find((n) => n.id === NODE);
  const data = (node && node.data) || {};
  const wroteSuccess = data.status === "success";
  const wrotePaths =
    Boolean(data.outputImage) ||
    Boolean(data.outputImagePath) ||
    Boolean(data.outputImages && data.outputImages.length) ||
    Boolean(data.outputImagePaths && data.outputImagePaths.length);

  const ok = windowOpened && result.cancelled === true && !wroteSuccess && !wrotePaths;
  return {
    name, impl, expectation,
    actual:
      `落盘窗口已建立=${windowOpened}；执行器返回 cancelled=${String(result.cancelled)}、success=${String(result.success)}；` +
      `节点 status=${JSON.stringify(data.status)}、outputImage=${JSON.stringify(data.outputImage || null)}、` +
      `outputImagePath=${JSON.stringify(data.outputImagePath || null)}、outputImagePaths=${JSON.stringify(data.outputImagePaths || null)}`,
    verdict: ok ? "PASS" : "FAIL",
    note: ok
      ? ""
      : "取消后仍把结果写回：节点被标记为成功或写入了本次产物 —— 用户点了取消却看到生成成功，" +
        "该结果还会被画布持久化进 app-data.json。必须在每个 await 之后（尤其成功写回之前）复查 signal.aborted（REQ-006）",
  };
}



// ---------------------------------------------------------------------------
// 6g) 用例 I —— REQ-004 复用不得改变工作流路径对 `data.queued` 的行为
//
// 背景（独立审查 r1 实测到的真实缺陷）：把工作流路径的图片执行改为复用
// executeImageGeneration 之后，执行器启动时**无条件**写 `queued:false`，于是工作流路径
// 开始写它以前从不碰的字段；当该节点的队列任务**仍停在 queued**（队列被暂停、额度被别人占满、
// 或 concurrency 小于该节点排队任务数）时，一次工作流运行会抹掉一份**合法**的排队标记：
// 节点显示"未排队"、生成按钮重新可点，而任务其实还在等 —— 正是 queueStore 自己列为缺陷类的
// 「不该清却清了」。
//
// 判据：在"该节点确有一个 queued 队列任务"的前提下调用执行器（模拟工作流路径的调用方式，
// 即不传 clearQueuedMarker），断言 `data.queued` **保持 true**；同时断言队列路径的调用方式
// （clearQueuedMarker:true）仍然会清掉它 —— 后者是既有语义，不能被这次修复弄丢。
// ---------------------------------------------------------------------------
async function caseWorkflowPreservesQueuedMarker() {
  const name = "用例 I：工作流路径复用执行器时不得抹掉合法的 queued 标记（REQ-004）";
  const impl = "节点上存在一个真实 queued 队列任务；分别以【工作流路径】（不传 clearQueuedMarker）\n" +
    "         与【队列路径】（clearQueuedMarker:true）调用 executeImageGeneration，比较 data.queued 的终态。";
  const expectation = "① 工作流路径：data.queued 必须保持 true（不得抹掉合法标记）；② 队列路径：仍会把它清为 falsy（既有语义不丢）";

  const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
  const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
  const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
  const { getDefaultImageGeneratorData } = await import(
    pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
  );
  const { executeImageGeneration } = await import(
    pathToFileURL(path.join(SRC, "services/imageGenerationExecution.ts")).href
  );

  const NODE = "queued-marker-i";
  const CANVAS = "queued-marker-canvas-i";
  const makeNodeData = () => ({
    ...getDefaultImageGeneratorData(),
    prompt: "queued marker regression i",
    queued: true, // 合法标记：下面同时让它确有一个 queued 队列任务
  });

  // ⚠ 顺序很重要：必须先建立"该 nodeId 确有活动任务"，再写节点数据。
  // queueStore 的自愈订阅会在 flowStore 的 nodes **换身份**时复核标记，而它只清不置位；
  // 若先写节点数据（queued:true）再建 job，那次换身份发生时活动任务还不存在，
  // 自愈会把标记当成陈旧项清掉 —— 那是**正确**行为，却会让本用例的前提不成立（假 FAIL）。
  useQueueStore.setState({
    paused: true,
    concurrency: 1,
    jobs: [
      {
        id: "i-job",
        nodeId: NODE,
        canvasId: CANVAS,
        nodeLabel: "I",
        modelLabel: "m",
        promptPreview: "p",
        status: "queued",
        createdAt: Date.now(),
      },
    ],
  });

  useFlowStore.setState({
    nodes: [{ id: NODE, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: makeNodeData() }],
    edges: [],
  });
  useCanvasStore.setState({
    activeCanvasId: CANVAS,
    canvases: [
      {
        id: CANVAS,
        name: "queued-marker",
        nodes: [{ id: NODE, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: makeNodeData() }],
        edges: [],
      },
    ],
  });

  // 前提核对：标记必须确实存在，否则本用例没有区分力
  const preflight = (() => {
    const flow = useFlowStore.getState().nodes.find((n) => n.id === NODE);
    return flow && flow.data ? flow.data.queued : undefined;
  })();
  if (preflight !== true) {
    useQueueStore.setState({ jobs: [] });
    useFlowStore.setState({ nodes: [], edges: [] });
    return {
      name, impl, expectation,
      actual: `前提未建立：写节点数据后 data.queued=${JSON.stringify(preflight)}（期望 true；很可能是自愈订阅把先写的标记清掉了，属用例夹具顺序问题）`,
      verdict: "ERROR",
      note: "基础设施异常：夹具必须先建活动任务再写节点数据，否则测不到目标行为",
    };
  }

  const readQueued = () => {
    const flow = useFlowStore.getState().nodes.find((n) => n.id === NODE);
    const canvas = useCanvasStore.getState().canvases.find((c) => c.id === CANVAS);
    const canvasNode = canvas && canvas.nodes.find((n) => n.id === NODE);
    return {
      flow: flow && flow.data ? flow.data.queued : undefined,
      canvas: canvasNode && canvasNode.data ? canvasNode.data.queued : undefined,
    };
  };

  // provider 用立刻成功的替身（其余 provider/落盘都走真实代码路径）。
  // ⚠ 不能一开始就 abort：执行器在 signal 已 aborted 时会**提前 return**，根本走不到启动时的
  // 节点写入，本用例就会空过（把修复移除也照样 PASS）。所以这里让它正常跑完，
  // 真正要观察的是"启动写入"那一步对 data.queued 的影响。
  globalThis.__NC_CANCEL_H_PROVIDER__ = true;

  let workflowQueued;
  let queuePathQueued;
  try {
    // ---- ① 工作流路径的调用方式：withRunRecords:false，且**不传** clearQueuedMarker ----
    await executeImageGeneration(NODE, { canvasId: CANVAS, withRunRecords: false });
    workflowQueued = readQueued();

    // ---- ② 队列路径的调用方式：clearQueuedMarker:true ----
    useFlowStore.setState({
      nodes: [{ id: NODE, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: makeNodeData() }],
    });
    useCanvasStore.setState({
      canvases: [
        {
          id: CANVAS,
          name: "queued-marker",
          nodes: [{ id: NODE, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: makeNodeData() }],
          edges: [],
        },
      ],
    });
    await executeImageGeneration(NODE, {
      canvasId: CANVAS,
      withRunRecords: true,
      clearQueuedMarker: true,
    });
    queuePathQueued = readQueued();
  } finally {
    delete globalThis.__NC_CANCEL_H_PROVIDER__;
    useQueueStore.setState({ jobs: [] });
    useFlowStore.setState({ nodes: [], edges: [] });
    useCanvasStore.setState({ canvases: [] });
  }

  const preserves = workflowQueued.flow === true;
  const stillClears = !queuePathQueued.flow;
  const ok = preserves && stillClears;

  return {
    name, impl, expectation,
    actual:
      `工作流路径后 data.queued=${JSON.stringify(workflowQueued.flow)}（期望 true，画布副本=${JSON.stringify(workflowQueued.canvas)}）；` +
      `队列路径后 data.queued=${JSON.stringify(queuePathQueued.flow)}（期望 falsy）`,
    verdict: ok ? "PASS" : "FAIL",
    note: ok
      ? ""
      : [
          preserves ? "" : "工作流路径抹掉了一份合法的 queued 标记：该节点确有 queued 队列任务，却把标记清成 false，" +
            "于是 UI 显示未排队、生成按钮重新可点（用户点了只会被入队守卫拦下）。" +
            "`data.queued` 属队列路径专有状态，工作流不经 enqueue、必须原样保留（REQ-004 验收第 3 条）",
          stillClears ? "" : "队列路径不再清除 queued 标记：既有语义被这次修复弄丢（队列任务启动时应消费掉该标记）",
        ].filter(Boolean).join("；"),
  };
}

// ---------------------------------------------------------------------------
// 7) 守卫形态的模拟（仅 --self-check 时启用）
//     把"守卫"装到 queueStore.enqueue 上：这是真实补丁最可能的位置，且能完整复现
//     "批量被截断""仅 running 漏判 queued""全局单飞禁止多节点并发"等可观察后果。
//     rule 取值：
//       active        queued||running（REQ-002 正确语义）
//       running-only  仅 running —— 照 taskManager.ts 的 isTaskRunning 字面移植的残缺陷版本
//       queued-only   仅 queued
//       global-single 全局单飞：任何节点有活动 job 就拒绝（与 concurrency 1..4 冲突）
//       any           任意历史 job（会锁死重生成）
//     入口级守卫则由 hook 副本承载（见文件头部的变异体构造）。
// ---------------------------------------------------------------------------
const GUARD_RULES = {
  "guard-active": "active",
  "guard-inside-batch-loop": "active", // 与 guard-active 同语义：store 层判定不会被批量循环拆散
  "guard-running-only": "running-only",
  "guard-queued-only": "queued-only",
  "guard-global-single": "global-single",
  "store-dedupe-any": "any",
  "any-history-dedupe": "any",
};

/** 该 rule 是否应拒绝这次入队（纯判定，供注入与文档共用一份语义） */
function guardBlocks(rule, sameNode, anyActive) {
  switch (rule) {
    case "active":
      return sameNode.some((j) => j.status === "queued" || j.status === "running");
    case "running-only":
      return sameNode.some((j) => j.status === "running");
    case "queued-only":
      return sameNode.some((j) => j.status === "queued");
    case "global-single":
      return anyActive;
    case "any":
      return sameNode.length > 0;
    default:
      return false;
  }
}

function installEnqueueGuard(useQueueStore) {
  const rule = Object.keys(GUARD_RULES).find((m) => hasMutant(m));
  if (!rule) return null;
  const mode = GUARD_RULES[rule];

  const original = useQueueStore.getState().enqueue;
  const stats = { rule: mode, rejected: 0, detail: "(未拒绝任何入队)" };
  useQueueStore.setState({
    enqueue: (job) => {
      const jobs = useQueueStore.getState().jobs;
      const sameNode = jobs.filter((j) => j.nodeId === job.nodeId);
      const anyActive = jobs.some((j) => j.status === "queued" || j.status === "running");
      if (guardBlocks(mode, sameNode, anyActive)) {
        stats.rejected += 1;
        stats.detail = `已拒绝 ${stats.rejected} 次入队（rule=${mode}，节点 ${job.nodeId}）`;
        return `mutant-rejected-${stats.rejected}`;
      }
      return original(job);
    },
  });
  return stats;
}

// ---------------------------------------------------------------------------
// 绿色对照模型：store 层"按点击"去重 + 批量原子化
//
// 正确的修复必须放在 store 层（enqueue 内判定），这样：
//   ① 判定是同步的，不受 handleGenerate 首行到第一个 await 之间的窗口影响（并发点击也拦得住）；
//   ② retry（queueStore.ts:93 → enqueue）同样被覆盖。
// 同时"一次点击的整批拆分"必须原子：4 个 job 要么都进、要么都不进——否则批量会被截断为 1。
// 实现方式：hook 侧在批量分支前声明"本次点击的批量大小"（__beginBatch），
// store 在整批的第一个 job 进来时按"该节点是否已有活动任务"判定一次，然后放行整批。
// ---------------------------------------------------------------------------
function installFullFixModel(useQueueStore) {
  const original = useQueueStore.getState().enqueue;
  const stats = { rule: "full-fix(store-layer, click-scoped)", rejected: 0, detail: "(未拒绝任何入队)" };
  let batchPending = null; // hook 已声明批量大小、但整批尚未判定
  let batchRemaining = 0; // 本次点击内还需放行的 job 数

  useQueueStore.setState({
    // 供 hook 副本使用的"声明本批大小"入口（测试模型用，非生产 API）
    __beginBatch: (n) => {
      batchPending = n;
    },
    enqueue: (job) => {
      const jobs = useQueueStore.getState().jobs;
      const sameNode = jobs.filter((j) => j.nodeId === job.nodeId);
      const hasActive = sameNode.some((j) => j.status === "queued" || j.status === "running");

      if (batchPending !== null) {
        // 整批只判定一次：该节点已有活动任务 → 整批拒绝（不是逐个判，否则会把批量截断为 1）
        batchRemaining = hasActive ? 0 : batchPending;
        batchPending = null;
      }
      if (batchRemaining > 0) {
        batchRemaining -= 1;
        return original(job);
      }
      if (hasActive) {
        stats.rejected += 1;
        stats.detail = `已整批拒绝 ${stats.rejected} 次入队（节点 ${job.nodeId} 已有活动任务）`;
        return `fullfix-rejected-${stats.rejected}`;
      }
      return original(job);
    },
  });
  return stats;
}

// ---------------------------------------------------------------------------
// 8) 主流程与报告
// ---------------------------------------------------------------------------
function printCase(r, index) {
  const tag = r.verdict === "PASS" ? "PASS" : r.verdict === "FAIL" ? "FAIL" : "ERROR";
  console.log(`【${index}】${r.name}`);
  console.log(`     实现：${r.impl}`);
  console.log(`     期望：${r.expectation}`);
  console.log(`     实际：${r.actual}`);
  if (r.note) console.log(`     说明：${r.note}`);
  console.log(`     判定：${tag}`);
  console.log("");
}

console.log("=".repeat(78));
console.log("生成队列回归：REQ-001（重启恢复） / REQ-002（重复入队 + 批量分支 + 并发点击 + 重试）");
console.log("              / REQ-005（全局单一并发上限） / REQ-006（取消后不写回结果）");
console.log(`MODE: ${MODE}${MODE === "expect-red" ? "（红状态自检：用例都应当 FAIL）" : "（默认：断言修复后应有的行为）"}`);
if (MUTANTS.size > 0) {
  console.log(`SELF-CHECK: ${[...MUTANTS].join(",")}（变异自检：被测行为被人为改造，仅用于验证断言强度，不代表真实结论）`);
}
// 自证：默认模式不受任何环境变量影响（本脚本从不读 process.env）
if (MODE === "default" && MUTANTS.size === 0) {
  console.log("NOTE: 本次为真实门禁运行；脚本不读取任何环境变量，结论不可被环境变量改变。");
}
console.log("=".repeat(78));
console.log("");

// 用例 A 必须是 queueStore 的**首次** import（种子在此之前写入），所以共享 store 的导入放在它之后。
const results = [];
try {
  results.push(await caseRestartRecovery());
} catch (e) {
  results.push({
    name: "用例 A",
    impl: "(抛出异常)",
    expectation: "(见上文用例定义)",
    actual: `${e && e.message ? e.message : String(e)}`,
    verdict: "ERROR",
    note: "基础设施异常：用例执行中断",
  });
}

// 守卫模型的注入：在用例 B/C/D/E/F 驱动 store 之前，对已加载的 queueStore 安装守卫。
// full-fix 是绿色对照（store 层按点击去重 + 整批原子判定），与缺陷形态互斥。
const { useQueueStore: sharedQueueStore } = await import(
  pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href
);
const guardStats = hasMutant("full-fix")
  ? installFullFixModel(sharedQueueStore)
  : installEnqueueGuard(sharedQueueStore);
if (guardStats) {
  console.log(`SELF-CHECK 注入：enqueue 守卫（rule=${guardStats.rule}）`);
  console.log("");
}

// 用例 G/H/I 追加在既有 A–F 之后：selfcheck 里有若干按**下标**读取用例结果的断言
// （p1Cases[1..5] / slCases[1..5]），把新用例插在中间会让那些下标指向错的用例。
for (const run of [caseDuplicateEnqueue, caseBatchEnqueue, caseQueuedNotRunning, caseConcurrentClicks, caseRetry, caseGlobalConcurrencyLimit, caseCancelDoesNotWriteBack, caseWorkflowPreservesQueuedMarker]) {
  try {
    results.push(await run());
  } catch (e) {
    results.push({
      name: run.name,
      impl: "(抛出异常)",
      expectation: "(见上文用例定义)",
      actual: `${e && e.message ? e.message : String(e)}`,
      verdict: "ERROR",
      note: "基础设施异常：用例执行中断",
    });
  }
}
if (guardStats && guardStats.rejected > 0) {
  console.log(`SELF-CHECK 注入统计：${guardStats.detail}`);
  console.log("");
}

results.forEach((r, i) => printCase(r, i + 1));

const passes = results.filter((r) => r.verdict === "PASS");
const fails = results.filter((r) => r.verdict === "FAIL");
const errors = results.filter((r) => r.verdict === "ERROR");

// 清理变异体临时目录（仅自检运行时会创建内容）
try {
  rmSync(MUTANT_DIR, { recursive: true, force: true });
} catch {
  /* 清理失败不影响门禁结论 */
}

console.log("-".repeat(78));
console.log(`汇总：PASS ${passes.length} / FAIL ${fails.length} / ERROR ${errors.length}（共 ${results.length} 个用例）`);

let exitCode;
if (MODE === "expect-red") {
  if (errors.length > 0) {
    console.log(`预期红但基础设施出错 ${errors.length} 个：${errors.map((r) => r.name).join("；")}`);
    console.log("=> 红状态未被有效确认（用例本身没跑通），退出码 1");
    exitCode = 1;
  } else if (passes.length > 0) {
    console.log(`预期红但实际绿 ${passes.length} 个：${passes.map((r) => r.name).join("；")}`);
    console.log("=> 缺陷可能已被修复，红状态不再成立，退出码 1");
    exitCode = 1;
  } else {
    console.log("=> 缺陷均按预期复现（红状态符合预期），退出码 0");
    exitCode = 0;
  }
} else {
  if (errors.length > 0) {
    // ERROR 只是"基础设施无法评估"，不能与 FAIL 混为一谈——
    // 混在一起会被误读为"业务缺陷未修"，也会让"正确但慢"的实现被当成失败。
    console.log(`=> 有 ${errors.length} 个用例无法评估（基础设施/时序问题，非业务缺陷判定）：`);
    for (const e of errors) console.log(`   - ${e.name}`);
    if (fails.length > 0) console.log(`   另有 ${fails.length} 个用例确认未满足期望（业务缺陷）；`);
    console.log("退出码 1（门禁不通过：存在无法评估或未满足的用例）");
    exitCode = 1;
  } else if (fails.length > 0) {
    console.log("=> 存在未满足的期望：这表示业务缺陷尚未修复（红状态），退出码 1");
    exitCode = 1;
  } else {
    console.log("=> 全部用例通过，退出码 0");
    exitCode = 0;
  }
}
console.log(`EXIT CODE: ${exitCode}`);
process.exitCode = exitCode;

// 可选的机器可读报告（供 scripts/queue-regression.selfcheck.mjs 精确核对每个用例的判定）。
// 默认不写任何文件；只有显式传 --report-json=<path> 时才落盘，因此不影响门禁本身的行为。
const reportArg = process.argv.find((a) => a.startsWith("--report-json="));
if (reportArg) {
  writeFileSync(
    reportArg.slice("--report-json=".length),
    JSON.stringify(
      {
        mode: MODE,
        mutants: [...MUTANTS],
        exitCode,
        pass: passes.length,
        fail: fails.length,
        error: errors.length,
        cases: results.map((r) => ({ name: r.name, verdict: r.verdict, actual: r.actual })),
      },
      null,
      2
    ),
    "utf8"
  );
}
