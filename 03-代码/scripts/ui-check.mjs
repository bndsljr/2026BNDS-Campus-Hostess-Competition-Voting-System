/**
 * 浏览器交互检查（开发/验收用）：验证后台按钮「点击后不跳转、原地反馈」。
 * 用法：BASE=http://127.0.0.1:3100 ADMIN_PASS=xxx node scripts/ui-check.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'LocalTest123';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9334;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  ✔ ${name}`);
  } else {
    fail++;
    console.log(`  ✘ ${name}  ${detail}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


/* 安全护栏：本脚本最后一步会清空投票/打分数据，默认只允许对本地环境运行 */
{
  const host = new URL(BASE).hostname;
  const isLocal = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!isLocal && process.env.UI_ALLOW_DESTRUCTIVE !== '1') {
    console.error('\n✘ 已中止：目标不是本机环境，而本脚本会清空投票与打分数据。');
    console.error(`  目标地址：${BASE}`);
    console.error('  如确认要在该环境执行，请显式设置 UI_ALLOW_DESTRUCTIVE=1 后重试。\n');
    process.exit(2);
  }
}

/* 登录拿 cookie */
const loginRes = await fetch(BASE + '/manage/login', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS }).toString(),
  redirect: 'manual',
});
const sid = (loginRes.headers.getSetCookie() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('hv_sid='))?.split('=')[1];
if (!sid) {
  console.error('管理员登录失败，无法进行 UI 检查');
  process.exit(1);
}

/* 启动 Chrome */
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-proxy-server',
    '--proxy-bypass-list=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=/tmp/hv-chrome-ui',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

let list = null;
for (let i = 0; i < 40; i++) {
  await sleep(400);
  try {
    list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    if (list.some((t) => t.type === 'page')) break;
  } catch {
    /* wait */
  }
}
const target = list.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', rej);
});

let seq = 0;
const pending = new Map();
const waiters = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  } else if (m.method) {
    const l = waiters.get(m.method) || [];
    waiters.set(m.method, []);
    l.forEach((r) => r(m.params));
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error('CDP 超时 ' + method))), 20000);
  });
const once = (method) =>
  new Promise((r) => {
    const l = waiters.get(method) || [];
    l.push(r);
    waiters.set(method, l);
  });

async function goto(url) {
  const loaded = once('Page.loadEventFired');
  await send('Page.navigate', { url });
  await Promise.race([loaded, sleep(6000)]);
  await sleep(700);
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'JS 执行错误');
  return r.result.value;
}

await send('Network.enable');
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Network.setCookie', { name: 'hv_sid', value: sid, domain: new URL(BASE).hostname, path: '/' });

console.log(`\n=== 后台交互检查 @ ${BASE} ===\n`);

/* 1. 一键生成密码条：不跳转 + 浮层提示 + 列表原地更新 */
{
  await goto(`${BASE}/manage/codes`);
  const before = await evaluate(`({
    url: location.href,
    rows: document.querySelectorAll('#codesList tbody tr').length,
    hasAjax: !!document.querySelector('#genForm[data-ajax]')
  })`);
  check('密码条页加载且生成表单已标记为原地提交', before.hasAjax, JSON.stringify(before));

  await evaluate(`
    (function(){
      var f = document.getElementById('genForm');
      f.querySelector('input[name="publicCount"]').value = '2';
      f.querySelector('input[name="proCount"]').value = '0';
      f.requestSubmit();
      return true;
    })()
  `);
  await sleep(2200);
  const after = await evaluate(`({
    url: location.href,
    toast: (document.getElementById('hvToastHost')||{}).innerText || '',
    toastType: (document.querySelector('#hvToastHost [data-toast-type]')||{}).dataset ? document.querySelector('#hvToastHost [data-toast-type]').dataset.toastType : '',
    rows: document.querySelectorAll('#codesList tbody tr').length
  })`);
  check('点击「一键生成」后页面未跳转（URL 不变）', after.url === before.url, `${before.url} → ${after.url}`);
  check('生成结果以成功浮层提示反馈', after.toastType === 'ok' && /已生成/.test(after.toast), `${after.toastType} ${JSON.stringify(after.toast)}`);
  check('密码条列表原地刷新（行数增加）', after.rows > before.rows, `${before.rows} → ${after.rows}`);
}

/* 2. 赛程开关：不跳转 */
{
  await goto(`${BASE}/manage/schedule`);
  const before = await evaluate(`location.href`);
  await evaluate(`
    (function(){
      var f = document.querySelector('form[action="/manage/schedule/toggle"]');
      f.requestSubmit();
      return true;
    })()
  `);
  await sleep(2000);
  const after = await evaluate(`({
    url: location.href,
    toast: (document.getElementById('hvToastHost')||{}).innerText || '',
    toastType: (function(){var a=document.querySelectorAll('#hvToastHost [data-toast-type]');return a.length?a[a.length-1].dataset.toastType:'';})()
  })`);
  check('点击赛程开关后页面未跳转', after.url === before, `${before} → ${after.url}`);
  check('赛程开关为成功提示（动作真实生效）', after.toastType === 'ok' && /已开启|已截止|已重新开启|已清除/.test(after.toast), `${after.toastType} ${JSON.stringify(after.toast)}`);
  // 复原
  await evaluate(`
    (function(){
      var f = document.querySelector('form[action="/manage/schedule/toggle"] input[name="action"]');
      f.value = 'close';
      f.closest('form').requestSubmit();
      return true;
    })()
  `);
  await sleep(1500);
}

/* 3. 数据清空：密码错误时不跳转、有错误提示、数据未变 */
{
  await goto(`${BASE}/manage/reset`);
  const before = await evaluate(`({ url: location.href, votes: document.querySelectorAll('.stat .value')[0].innerText })`);
  await evaluate(`
    (function(){
      var f = document.getElementById('resetForm');
      f.querySelector('input[name="password"]').value = 'wrong-password-123';
      f.requestSubmit();
      return true;
    })()
  `);
  await sleep(2000);
  const after = await evaluate(`({
    url: location.href,
    toastType: (function(){var a=document.querySelectorAll('#hvToastHost [data-toast-type]');return a.length?a[a.length-1].dataset.toastType:'';})(),
    toast: (document.getElementById('hvToastHost')||{}).innerText || '',
    votes: document.querySelectorAll('.stat .value')[0].innerText
  })`);
  check('数据清空页密码错误时未跳转', after.url === before.url, `${before.url} → ${after.url}`);
  check('密码错误给出错误提示', /密码不正确/.test(after.toast) && after.toastType === 'error', `${after.toastType} ${JSON.stringify(after.toast)}`);
  check('密码错误时数据未被改动', after.votes.trim() === before.votes.trim(), `${before.votes} → ${after.votes}`);
}

/* 4. 数据清空：正确密码时也留在原页并提示结果 */
{
  const before = await evaluate(`location.href`);
  await evaluate(`
    (function(){
      var f = document.getElementById('resetForm');
      f.querySelector('input[name="password"]').value = ${JSON.stringify(ADMIN_PASS)};
      f.requestSubmit();
      return true;
    })()
  `);
  await sleep(2200);
  const after = await evaluate(`({
    url: location.href,
    toastType: (function(){var a=document.querySelectorAll('#hvToastHost [data-toast-type]');return a.length?a[a.length-1].dataset.toastType:'';})(),
    toast: (document.getElementById('hvToastHost')||{}).innerText || ''
  })`);
  check('清空成功后仍停留在当前页', after.url === before, `${before} → ${after.url}`);
  check('清空成功有结果提示', after.toastType === 'ok' && /已清空|没有需要清空/.test(after.toast), `${after.toastType} ${JSON.stringify(after.toast)}`);
}

/* 5. 手动赋分预览：不跳转、原地出结果 */
{
  await goto(`${BASE}/manage/manual?c=group`);
  await evaluate(`
    (function(){
      var f = document.getElementById('manualForm');
      f.querySelectorAll('input[name="player"]')[0].checked = true;
      document.getElementById('previewBtn').click();
      return true;
    })()
  `);
  await sleep(2000);
  const after = await evaluate(`({
    url: location.href,
    preview: document.querySelector('#previewResult') ? document.querySelector('#previewResult').innerText.slice(0,60) : ''
  })`);
  check('手动赋分预览原地出结果（未跳转）', after.url.includes('/manage/manual') && /预览完成|改前/.test(after.preview), JSON.stringify(after));
}

console.log(`\n=== 结果：${pass} 项通过，${fail} 项失败 ===\n`);
ws.close();
chrome.kill();
await sleep(600);
try { fs.rmSync('/tmp/hv-chrome-ui', { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
