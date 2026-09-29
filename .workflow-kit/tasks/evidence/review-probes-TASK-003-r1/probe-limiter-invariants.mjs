/**
 * 审查者探针 P-limiter（TASK-003 r1 独立审查用；只读，不修改任何产品代码）
 *
 * 目的：不依赖门禁脚本，独立核对 REQ-005 的额度记账不变量：
 *   I1 归还恰好一次：重复调用同一个 release 只扣一次（防"额度被放大"）
 *   I2 不存在泄漏：N 次 acquire 后 N 次 release -> inFlight 回到 0
 *   I3 不超额发放：limit=1 且 1 个持有者 + 2 个等待者时，一次归还原子地只放行一个等待者，
 *                  任一时刻 inFlight <= limit
 *   I4 复位代数：reset 之前发出的许可在被归还时**不得**扣减新一轮计数
 *   I5 等待中 abort：返回 null 且**不**占用额度、不残留等待者
 *   I6 公平性：存在等待者时 tryAcquireGlobalSlot 必须返回 null（队列不得插队饿死工作流）
 *   I7 setGlobalConcurrencyLimit 的钳制与唤醒
 *
 * 运行：node --experimental-strip-types .workflow-kit/tasks/evidence/review-probes-TASK-003-r1/probe-limiter-invariants.mjs
 */
import { pathToFileURL } from "node:url";
import path from "node:path";

const SRC = path.resolve(process.cwd(), "src");
const L = await import(pathToFileURL(path.join(SRC, "services/concurrencyLimiter.ts")).href);

const results = [];
const check = (id, ok, detail) => {
  results.push({ id, ok: Boolean(ok), detail });
  console.log(`${ok ? "OK  " : "VIOL"}  ${id}  ${detail}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- I1 重复归还幂等 ---------------------------------------------------------
L.resetGlobalConcurrencyLimiter();
L.setGlobalConcurrencyLimit(2);
{
  const r1 = L.tryAcquireGlobalSlot();
  const r2 = L.tryAcquireGlobalSlot();
  const before = L.getInFlightCount();
  r1(); r1(); r1();
  const afterTriple = L.getInFlightCount();
  r2();
  const afterAll = L.getInFlightCount();
  check("I1-double-release", before === 2 && afterTriple === 1 && afterAll === 0,
    `inFlight: 取2个=${before} -> 同一个 release 连调3次=${afterTriple}（期望1） -> 另一个 release=${afterAll}（期望0）`);
}

// --- I2 无泄漏 ---------------------------------------------------------------
L.resetGlobalConcurrencyLimiter();
L.setGlobalConcurrencyLimit(4);
{
  const rels = [];
  for (let i = 0; i < 4; i++) rels.push(L.tryAcquireGlobalSlot());
  const full = L.getInFlightCount();
  const overflow = L.tryAcquireGlobalSlot();
  rels.forEach((r) => r());
  check("I2-no-leak", full === 4 && overflow === null && L.getInFlightCount() === 0,
    `取满4个=${full}；第5个=${overflow === null ? "null（正确拒绝）" : "非null（超额！）"}；全部归还后 inFlight=${L.getInFlightCount()}`);
}

// --- I3 不超额发放 / 不重复唤醒 ----------------------------------------------
L.resetGlobalConcurrencyLimiter();
L.setGlobalConcurrencyLimit(1);
{
  const holder = L.tryAcquireGlobalSlot();
  const p1 = L.acquireGlobalSlot();
  const p2 = L.acquireGlobalSlot();
  const waitersNow = L.getWaiterCount();
  const inFlightWhileBlocked = L.getInFlightCount();
  const queuePreempt = L.tryAcquireGlobalSlot(); // 有等待者时队列不得插队（I6 同一次观测）
  holder();
  await sleep(0);
  const s1 = await p1;
  const inFlightAfterFirstWake = L.getInFlightCount();
  const s2pending = L.getWaiterCount();
  const freeAfterFirstWake = L.tryAcquireGlobalSlot();
  const t1 = L.tryAcquireGlobalSlot();
  s1();
  await sleep(0);
  const s2 = await p2;
  const inFlightAfterSecondWake = L.getInFlightCount();
  s2();
  check("I3-no-overissue",
    waitersNow === 2 && inFlightWhileBlocked === 1 && s1 !== null && s2 !== null &&
    inFlightAfterFirstWake === 1 && inFlightAfterSecondWake === 1 && L.getInFlightCount() === 0,
    `等待者=${waitersNow}；占满时 inFlight=${inFlightWhileBlocked}；第一次归还后 inFlight=${inFlightAfterFirstWake}（期望1，不得同时放行两个）；第二次归还后 inFlight=${inFlightAfterSecondWake}（期望1）；全部结束后=${L.getInFlightCount()}`);
  check("I6-no-preemption", queuePreempt === null,
    `有等待者时 tryAcquireGlobalSlot()=${queuePreempt === null ? "null（不插队）" : "非null（插队，工作流可能被饿死）"}；另有等待者时又取一次=${freeAfterFirstWake === null ? "null" : "非null"}；第三个=${t1 === null ? "null" : "非null"}`);
  if (s1) s1(); // s1 已在上面归还，这里验证幂等不破坏计数
}

// --- I4 复位代数 -------------------------------------------------------------
L.resetGlobalConcurrencyLimiter();
L.setGlobalConcurrencyLimit(2);
{
  const stale = L.tryAcquireGlobalSlot();          // 属于第 N 代
  L.resetGlobalConcurrencyLimiter();                // 代数 +1，计数归零
  const fresh = L.tryAcquireGlobalSlot();           // 第 N+1 代
  const before = L.getInFlightCount();
  stale();                                          // 陈旧许可归还：必须作废
  const afterStale = L.getInFlightCount();
  const stillAvailable = L.tryAcquireGlobalSlot();   // 若陈旧归还误扣，这里就不该成功
  fresh();
  check("I4-generation-stale-release", before === 1 && afterStale === 1 && stillAvailable !== null,
    `复位后 inFlight=${before}；陈旧许可归还后=${afterStale}（期望仍为1，不得被误扣）；此时仍能取到额度=${stillAvailable !== null}`);
  if (stillAvailable) stillAvailable();
}

// --- I5 等待中 abort ---------------------------------------------------------
L.resetGlobalConcurrencyLimiter();
L.setGlobalConcurrencyLimit(1);
{
  const holder = L.tryAcquireGlobalSlot();
  const ac = new AbortController();
  const p = L.acquireGlobalSlot(ac.signal);
  const waitersBefore = L.getWaiterCount();
  ac.abort();
  const got = await p;
  const waitersAfter = L.getWaiterCount();
  const inFlight = L.getInFlightCount();
  holder();
  const reacquired = L.tryAcquireGlobalSlot();
  check("I5-abort-while-waiting",
    got === null && waitersBefore === 1 && waitersAfter === 0 && inFlight === 1 && reacquired !== null,
    `abort 前等待者=${waitersBefore}；返回值=${got}（期望 null）；abort 后等待者=${waitersAfter}（期望0）；inFlight=${inFlight}（期望1，未占用新额度）；随后仍可取得额度=${reacquired !== null}`);
  if (reacquired) reacquired();
}

// --- I5b 已 abort 的 signal --------------------------------------------------
L.resetGlobalConcurrencyLimiter();
{
  const ac = new AbortController();
  ac.abort();
  const got = await L.acquireGlobalSlot(ac.signal);
  check("I5b-preaborted-signal", got === null && L.getInFlightCount() === 0,
    `预先 abort 的 signal：返回=${got}（期望 null），inFlight=${L.getInFlightCount()}（期望0）`);
}

// --- I7 钳制与唤醒 -----------------------------------------------------------
L.resetGlobalConcurrencyLimiter();
{
  L.setGlobalConcurrencyLimit(0);
  const lo = L.getGlobalConcurrencyLimit();
  L.setGlobalConcurrencyLimit(999);
  const hi = L.getGlobalConcurrencyLimit();
  L.setGlobalConcurrencyLimit(3);
  const mid = L.getGlobalConcurrencyLimit();
  check("I7-clamp", lo === 1 && hi === 16 && mid === 3,
    `set(0)->${lo}（期望1）；set(999)->${hi}（期望16）；set(3)->${mid}（期望3）；默认值=${L.DEFAULT_GLOBAL_CONCURRENCY_LIMIT}`);
}
{
  // 调大额度必须唤醒等待者，否则等待者会一直挂着
  L.resetGlobalConcurrencyLimiter();
  L.setGlobalConcurrencyLimit(1);
  const holder = L.tryAcquireGlobalSlot();
  const p = L.acquireGlobalSlot();
  const waitersBefore = L.getWaiterCount();
  L.setGlobalConcurrencyLimit(3);       // 调大 -> 应主动 drain
  const got = await p;
  const wokeByResize = got !== null;
  if (got) got();
  holder();
  check("I7-resize-drains-waiters", waitersBefore === 1 && wokeByResize,
    `调大额度前等待者=${waitersBefore}；调大后等待者被唤醒并取得许可=${wokeByResize}`);
}

// --- I8 释放监听器（队列靠它重新 pump） --------------------------------------
L.resetGlobalConcurrencyLimiter();
{
  let notified = 0;
  const off = L.onGlobalSlotReleased(() => { notified += 1; });
  const r = L.tryAcquireGlobalSlot();
  r();
  const afterRelease = notified;
  off();
  const r2 = L.tryAcquireGlobalSlot();
  r2();
  check("I8-release-listener", afterRelease >= 1 && notified === afterRelease,
    `归还后通知次数=${afterRelease}（期望>=1）；注销后不再增加=${notified === afterRelease}`);
}

L.resetGlobalConcurrencyLimiter();
const violated = results.filter((r) => !r.ok);
console.log("");
console.log(`P-limiter 汇总：${results.length - violated.length}/${results.length} 条不变量成立`);
if (violated.length > 0) {
  console.log("违反的不变量：" + violated.map((v) => v.id).join(", "));
}
process.exitCode = violated.length > 0 ? 1 : 0;
console.log(`EXIT CODE: ${process.exitCode}`);
