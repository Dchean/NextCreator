#!/usr/bin/env node
// TASK-006 实机验收 CDP 驱动（只读产品代码；本脚本属工作流证据工具）
// 用法：
//   node nc-cdp.mjs targets                     列出 CDP 目标
//   node nc-cdp.mjs eval "<js>" [--await]       在页面执行 JS（returnByValue）
//   node nc-cdp.mjs shot <out.png>              截图
//   node nc-cdp.mjs click <x> <y> [count]       真实鼠标点击（count=2 为双击）
//   node nc-cdp.mjs key <Key> <vk> [ctrl|shift|alt|ctrlshift]  按键（含组合）
//   node nc-cdp.mjs wheel <x> <y> <dy>          滚动
import { writeFileSync } from "node:fs";

const CDP_HTTP = "http://127.0.0.1:9222";
const APP_URL_HINT = "localhost:1420";

const [, , cmd, ...rest] = process.argv;

function fail(msg) { console.error("CDP-ERROR: " + msg); process.exit(2); }

async function pickTarget() {
  const res = await fetch(CDP_HTTP + "/json/list").catch(() => null);
  if (!res) fail("CDP HTTP 端点不可达（应用未启动或 9222 未开）");
  const list = await res.json();
  const pages = list.filter((t) => t.type === "page");
  if (!pages.length) fail("无 page 目标: " + JSON.stringify(list.map(t => ({ type: t.type, url: t.url }))));
  return pages.find((t) => t.url.includes(APP_URL_HINT)) ?? pages[0];
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res2, rej2) => {
          const mid = ++id;
          pending.set(mid, { res2, rej2 });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      close() { try { ws.close(); } catch {} },
    });
    ws.onerror = (e) => reject(new Error("ws error"));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res2, rej2 } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej2(new Error(JSON.stringify(m.error))) : res2(m.result);
      }
    };
    setTimeout(() => reject(new Error("ws connect timeout")), 8000);
  });
}

async function withPage(fn) {
  const t = await pickTarget();
  const page = await connect(t.webSocketDebuggerUrl);
  try { return await fn(page); } finally { page.close(); }
}

async function evalJs(page, expr, awaitPromise) {
  const r = await page.send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error("页面异常: " + JSON.stringify(r.exceptionDetails).slice(0, 600));
  }
  return r.result.value;
}

const MODS = { ctrl: 2, shift: 8, alt: 1, ctrlshift: 10 };
const KEY_DEFS = {
  z: { vk: 90, code: "KeyZ" }, y: { vk: 89, code: "KeyY" },
  a: { vk: 65, code: "KeyA" }, escape: { vk: 27, code: "Escape" },
  enter: { vk: 13, code: "Enter" }, delete: { vk: 46, code: "Delete" },
};

switch (cmd) {
  case "targets": {
    const res = await fetch(CDP_HTTP + "/json/list");
    for (const t of await res.json())
      console.log(`${t.type} | ${t.title} | ${t.url} | ${t.webSocketDebuggerUrl}`);
    break;
  }
  case "eval": {
    const expr = rest[0];
    const awaitPromise = rest.includes("--await");
    if (!expr) fail("eval 需要 JS 表达式");
    const out = await withPage((p) => evalJs(p, expr, awaitPromise));
    console.log(typeof out === "string" ? out : JSON.stringify(out));
    break;
  }
  case "shot": {
    const file = rest[0];
    if (!file) fail("shot 需要输出路径");
    const b64 = await withPage(async (p) => {
      await p.send("Page.enable");
      const r = await p.send("Page.captureScreenshot", { format: "png" });
      return r.data;
    });
    writeFileSync(file, Buffer.from(b64, "base64"));
    console.log("saved " + file);
    break;
  }
  case "click": {
    const [x, y, count] = rest.map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) fail("click 需要 x y");
    const n = count || 1;
    await withPage(async (p) => {
      for (let i = 1; i <= n; i++) {
        for (const type of ["mousePressed", "mouseReleased"]) {
          await p.send("Input.dispatchMouseEvent", {
            type, x, y, button: "left", clickCount: n === 2 ? 2 : i, buttons: type === "mousePressed" ? 1 : 0,
          });
        }
      }
    });
    console.log(`clicked x=${x} y=${y} count=${n}`);
    break;
  }
  case "key": {
    const [key, vkStr, modStr] = rest;
    const def = KEY_DEFS[(key || "").toLowerCase()];
    const vk = Number(vkStr) || def?.vk;
    if (!key || !vk) fail("key 需要 <key> <vk>（z=90 y=89 a=65 enter=13 escape=27 delete=46）");
    const mods = MODS[modStr || ""] || 0;
    const code = def?.code ?? `Key${key.toUpperCase()}`;
    await withPage(async (p) => {
      await p.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, windowsVirtualKeyCode: vk, code, modifiers: mods });
      await p.send("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: vk, code, modifiers: mods });
    });
    console.log(`key ${key} vk=${vk} mods=${mods}`);
    break;
  }
  case "wheel": {
    const [x, y, dy] = rest.map(Number);
    await withPage((p) => p.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: dy }));
    console.log(`wheel at ${x},${y} dy=${dy}`);
    break;
  }
  default:
    fail("未知命令 " + cmd);
}
