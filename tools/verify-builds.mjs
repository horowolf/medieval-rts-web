#!/usr/bin/env node
// Proves the English and Chinese builds are the same game.
//
//   node tools/verify-builds.mjs
//
// Both are driven headlessly for the same number of simulation ticks from the
// same seed, with the AI running, and the entire world is reduced to one
// fingerprint: positions, health, stock, resource nodes. If translating the
// interface had touched any string the simulation itself compares, the two
// numbers would differ.
//
// Requires Chrome; it drives the real page over the DevTools Protocol rather
// than importing the code, so what is measured is what ships.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9444;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/cdp-rts-verify', 'about:blank'], { stdio: 'ignore' });

async function getWS() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const pg = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (pg) return pg.webSocketDebuggerUrl;
    } catch {}
    await sleep(100);
  }
  throw new Error('no CDP');
}

const FP = `(()=>{let h=0;const mix=x=>{h=(Math.imul(h^(Math.round((x||0)*100)|0),0x01000193))>>>0;};
  mix(t);mix(seed);
  for(const k in stock){mix(stockOf(0)[k]);mix(stockOf(1)[k]);}
  for(const u of units){mix(u.x);mix(u.y);mix(u.hp);mix(u.side);}
  for(const v of villagers){mix(v.x);mix(v.y);mix(v.hp);mix(v.carry);}
  for(const b of buildings){mix(b.x);mix(b.y);mix(b.hp);mix(b.side);}
  for(const n of nodes)mix(n.amt);
  return {h,t:+t.toFixed(2),u:units.length,v:villagers.length,b:buildings.length,
          s0:Math.round(stockOf(0).food),s1:Math.round(stockOf(1).food)};})()`;

async function run(url, steps) {
  const ws = new WebSocket(await getWS());
  await new Promise((r) => { ws.onopen = r; });
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) pending.get(d.id)(d); };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  // Freeze the animation loop *before* the page's own script runs. Killing it
  // after load lets a variable number of frames tick first, which is a different
  // starting world for each build -- the classic false positive here.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.requestAnimationFrame=function(){return 0;};',
  });
  await send('Page.navigate', { url });
  for (let i = 0; i < 120; i++) { if (await evalJs('typeof dbg!=="undefined"').catch(() => false)) break; await sleep(100); }
  await evalJs(`for(let i=0;i<${steps};i++)step(1/30);`);
  const out = await evalJs(FP);
  ws.close();
  return out;
}

const base = `file://${resolve(dirname(fileURLToPath(import.meta.url)), '..')}`;
const STEPS = 3000;
const zh = await run(`${base}/zh/index.html?seed=20260709`, STEPS);
const en = await run(`${base}/index.html?seed=20260709`, STEPS);
console.log('zh', JSON.stringify(zh));
console.log('en', JSON.stringify(en));
console.log(zh.h === en.h && zh.u === en.u && zh.v === en.v
  ? '\nIDENTICAL — translation did not change simulation behaviour'
  : '\nDIVERGED — the English build behaves differently');
chrome.kill();
process.exit(zh.h === en.h ? 0 : 1);
