import { connect, findPageTarget, waitFor, PAGE_HELPERS } from './tools/t059_cdp.mjs';
const t = await findPageTarget();
const cdp = await connect(t.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Page.reload', { ignoreCache: true });
await waitFor(cdp, `!!document.querySelector('.nav-tab-item')`, { label: 'nav' });
await cdp.evaluate(PAGE_HELPERS);
await cdp.evaluate(`window.__t059.clickText('.nav-tab-item', '设置中心')`);
await waitFor(cdp, `!!document.querySelector('.settings-modal')`);
await cdp.evaluate(`window.__t059.clickText('.settings-nav-item', '同步')`);
await waitFor(cdp, `!!window.__t059.endpointCard()`);
// 各卡片标题 + 其 input 的 placeholder，看清楚哪张卡是哪个框
console.log(await cdp.evaluate(`JSON.stringify([...document.querySelectorAll('.setting-card')].map(c => ({
  title: (c.querySelector('h5')||{}).textContent, ph: (c.querySelector('input')||{}).placeholder, val: (c.querySelector('input')||{}).value
})), null, 2)`));
console.log('set endpoint ->', await cdp.evaluate(`window.__t059.setCardInput('后端 Endpoint', 'http://127.0.0.1:8899')`));
console.log('set username ->', await cdp.evaluate(`window.__t059.setCardInput('用户名', 'demo')`));
console.log('set password ->', await cdp.evaluate(`window.__t059.setCardInput('密码', 'demo-pass')`));
console.log('values ->', await cdp.evaluate(`JSON.stringify([...document.querySelectorAll('.setting-card input')].map(i => ({ph: i.placeholder, val: i.value})))`));
console.log('click ->', await cdp.evaluate(`window.__t059.clickAction('测试连接')`));
for (let i = 0; i < 20; i++) {
  const toasts = await cdp.evaluate(`JSON.stringify(window.__t059.toasts())`);
  if (toasts !== '[]') { console.log('toast@' + (i*150) + 'ms ->', toasts); break; }
  await new Promise(r => setTimeout(r, 150));
}
console.log('final toasts ->', await cdp.evaluate(`JSON.stringify(window.__t059.toasts())`));
console.log('pill nodes ->', await cdp.evaluate(`document.querySelectorAll('[class*=toast]').length`));
cdp.close();
