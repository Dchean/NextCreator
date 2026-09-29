/**
 * Independent check of the global concurrency limiter's own logic (REQ-005).
 * Exercises the numbered acceptance criteria directly on the module, without the
 * app or the gate harness. Runs with --experimental-strip-types.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const SRC = "D:\\NextCreator\\src";
const limiter = await import(pathToFileURL(path.join(SRC, "services/concurrencyLimiter.ts")).href);

let checks = 0, failures = 0;
const check = (name, ok, detail) => {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "[OK]  " : "[FAIL]"} ${name}${detail ? " :: " + detail : ""}`);
};

// 1) default limit is queryable and equals the UI maximum (4)
check("默认上限可查询且等于 UI 上限 4", limiter.getGlobalConcurrencyLimit() === 4, `limit=${limiter.getGlobalConcurrencyLimit()}`);

// 2) tryAcquire never exceeds the limit
limiter.resetGlobalConcurrencyLimiter();
limiter.setGlobalConcurrencyLimit(2);
const held = [limiter.tryAcquireGlobalSlot(), limiter.tryAcquireGlobalSlot(), limiter.tryAcquireGlobalSlot()];
check("tryAcquire 不超过上限", held.filter(Boolean).length === 2 && held[2] === null,
  `取得 ${held.filter(Boolean).length} 个（上限 2），第 3 次为 null`);

// 3) in-flight reflects the limit
check("在途计数正确", limiter.getInFlightCount() === 2, `inFlight=${limiter.getInFlightCount()}`);

// 4) release is idempotent (double release must not inflate capacity)
held[0]();
held[0]();
check("重复归还不放大额度", limiter.getInFlightCount() === 1, `inFlight=${limiter.getInFlightCount()}（期望 1）`);

// 5) acquireGlobalSlot queues when full, resolves on release
limiter.resetGlobalConcurrencyLimiter();
limiter.setGlobalConcurrencyLimit(1);
const first = limiter.tryAcquireGlobalSlot();
let resolved = null;
const waiting = limiter.acquireGlobalSlot().then((rel) => { resolved = rel; return rel; });
await new Promise((r) => setTimeout(r, 50));
check("满额时 acquire 排队（未立即解决）", resolved === null && limiter.getWaiterCount() === 1,
  `waiter=${limiter.getWaiterCount()}, resolved=${resolved === null ? "pending" : "early"}`);
first();
const got = await waiting;
check("归还后排队者被唤醒并取得许可", typeof got === "function" && limiter.getInFlightCount() === 1,
  `inFlight=${limiter.getInFlightCount()}`);

// 6) abort while waiting returns null and does not consume capacity
limiter.resetGlobalConcurrencyLimiter();
limiter.setGlobalConcurrencyLimit(1);
const blocker = limiter.tryAcquireGlobalSlot();
const ac = new AbortController();
const abortedWait = limiter.acquireGlobalSlot(ac.signal);
await new Promise((r) => setTimeout(r, 30));
ac.abort();
const abortedResult = await abortedWait;
check("等待期间 abort 返回 null 且不占额度", abortedResult === null && limiter.getInFlightCount() === 1,
  `result=${abortedResult === null ? "null" : "release"}, inFlight=${limiter.getInFlightCount()}, waiters=${limiter.getWaiterCount()}`);

// 7) already-aborted signal returns null immediately
const ac2 = new AbortController(); ac2.abort();
check("已 abort 的信号立即返回 null", (await limiter.acquireGlobalSlot(ac2.signal)) === null);

// 8) raising the limit drains waiters
limiter.resetGlobalConcurrencyLimiter();
limiter.setGlobalConcurrencyLimit(1);
const b2 = limiter.tryAcquireGlobalSlot();
const w2 = limiter.acquireGlobalSlot();
await new Promise((r) => setTimeout(r, 30));
limiter.setGlobalConcurrencyLimit(3);
const got2 = await w2;
check("调大额度立即唤醒等待者", typeof got2 === "function" && limiter.getInFlightCount() === 2,
  `inFlight=${limiter.getInFlightCount()}（期望 2）`);

// 9) release listener fires (this is what wakes queueStore.pump)
limiter.resetGlobalConcurrencyLimiter();
let notified = 0;
const off = limiter.onGlobalSlotReleased(() => { notified++; });
const r9 = limiter.tryAcquireGlobalSlot();
r9();
off();
check("归还时触发订阅者（队列据此重新调度）", notified >= 1, `notified=${notified}`);

// 10) FIFO order
limiter.resetGlobalConcurrencyLimiter();
limiter.setGlobalConcurrencyLimit(1);
const hold = limiter.tryAcquireGlobalSlot();
const order = [];
const p1 = limiter.acquireGlobalSlot().then((r) => { order.push("first"); r && r(); });
const p2 = limiter.acquireGlobalSlot().then((r) => { order.push("second"); r && r(); });
await new Promise((r) => setTimeout(r, 30));
hold();
await Promise.all([p1, p2]);
check("等待者按 FIFO 唤醒（不饿死）", order.join(",") === "first,second", `order=${order.join(",")}`);

limiter.resetGlobalConcurrencyLimiter();
console.log(`\n汇总：${checks - failures}/${checks} 通过`);
process.exit(failures === 0 ? 0 : 1);
