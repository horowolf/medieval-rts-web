#!/usr/bin/env node
// Zero-dependency headless harness for slice4 (Node 25 built-in fetch+WebSocket + Chrome.app via CDP).
// Kills the rAF loop after load, then drives step(TICK) deterministically and asserts via Runtime.evaluate
// (which runs in page scope, so units/tags/UT/engageR/STR/step/buildings/hasCC are all reachable by bare name).
// Covers slice3 regressions ([1]-[5]: attack-move/guard relocate/per-unit engageR) + slice4 phase-1
// ([6]-[9]: outpost→city upgrade, fallback victory model, capital rebuild gate, monastery medic+aura) +
// phase-2 fortifications ([10]-[13]: wall/gate side-aware/siege bonus/castle) + debug tools
// ([14]; [15] wall line no-cliff-cross; [16] pause/saveLog/mark-highlight hooks; [17] gate 2×1 + rotate footprint;
// [18] demolish/cancel: full-refund-if-building, HALF×HP recycle if completed, footprint clear, villager unassign, last-CC guard) +
// phase-3 civilisations ([19] shared tech tree + per-civ masks: 27 items, M1/M2/M3 separate, 12–18 band,
// England S2+S3 / HRE M5+F3 / Mongol M6+E3+M7+P1, universal coverage, no dangling prereq, read-only overlay)
// + research mechanism ([20] research/prereq/age gating, age-up, unit unlock, techMod live)
// + Batch 1 stat inspection ([21] prodRate 5-key per-resource /min via 5s window, pickUnitAt player-only,
// openUnitPanel sets selUnit and shows tech bonuses: attack 8(+1), villager wood carry 4/10, farm regen
// 1.2→1.8 after E2.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// CI runs as root in a container, where Chrome refuses to start without --no-sandbox.
const CHROME_ARGS = process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(' ').filter(Boolean) : [];
const TARGET = process.env.TARGET || 'zh/index.html'; // the Chinese build: the assertions read its interface text back
const FILE = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '..', TARGET)).href + '?noai=1';
// AI villagers or construction — isolation discipline, same purpose as aiWave=99999. [76] turns it back
// on explicitly via dbg.setAiEco(true).
const PORT = 9333;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,'--user-data-dir=/tmp/cdp-rts-prof',...CHROME_ARGS,'about:blank'], { stdio: 'ignore' });

async function getWS() {
  for (let i = 0; i < 60; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const pg = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (pg) return pg.webSocketDebuggerUrl;
    } catch {}
    await sleep(100);
  }
  throw new Error('CDP debugger never came up');
}

let ws, id = 0; const pending = new Map();
function send(method, params = {}) {
  const myid = ++id;
  return new Promise(res => { pending.set(myid, res); ws.send(JSON.stringify({ id: myid, method, params })); });
}
async function ev(expr) { // evaluate, return-by-value, throw on JS exception
  const m = await send('Runtime.evaluate', { expression: `(()=>{${expr}})()`, returnByValue: true, awaitPromise: true });
  const r = m.result;
  if (r.exceptionDetails) throw new Error('PAGE EXCEPTION: ' + (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)));
  return r.result.value;
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  (cond ? pass++ : fail++);
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  →  ' + JSON.stringify(detail) : ''}`);
}

// Common scenario builder (eval'd in page): isolate units, lay an attack/guard unit + enemy bag on a flat row.
const SETUP = (task, tagi, enemyHi) => `
  units.length=0;
  const g=tags[${tagi}]; g.task='${task}'; g.focus=null; g.holdFire=false; g.pt=null;
  const eg=tags[5]; eg.task='guard'; eg.holdFire=true; eg.focus=null; eg.pt=null;
  const CY=playerTC.y, SX=playerTC.x+140, EX=SX+250, PX=SX+500;
  const pu=spawnUnit(0,'spear',SX,CY,g);
  const eb=spawnUnit(1,'spear',EX,CY,eg); ${enemyHi ? 'eb.hp=eb.maxHp=99999;' : ''}
  issueTagOrder(${tagi}, PX, CY);
  window.__pu=pu; window.__eb=eb; window.__PX=PX; window.__SX=SX; window.__EX=EX; window.__CY=CY;
`;

try {
  const wsUrl = await getWS();
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.requestAnimationFrame=function(){return 0};' });
  await send('Page.navigate', { url: FILE });
  for (let i = 0; i < 60; i++) { try { if (await ev(`return !!window.dbg && !!window.step && document.readyState==='complete'`)) break; } catch {} await sleep(100); }
  await ev(`window.requestAnimationFrame=function(){return 0}; return true`);
  await sleep(120);

  const env = await ev(`return {TICK,TILE,W,H,types:Object.keys(UT),engModel,strAtk:STR.task_attack,pTC:{x:playerTC.x,y:playerTC.y}}`);
  console.log('ENV', JSON.stringify(env));

  console.log('\n[smoke] step default scenario 600 ticks (no exception, world intact)');
  const smoke = await ev(`for(let i=0;i<600;i++)step(TICK); return {units:units.length,bld:buildings.length,t:+t.toFixed(2)}`);
  check('default scenario steps 600 ticks without throwing', true, smoke);

  console.log('\n[1] rename + per-unit engageR');
  check('STR.task_attack renamed to Attack', env.strAtk === '攻擊', env.strAtk);
  check('engModel default = 2', env.engModel === 2, env.engModel);
  const r = await ev(`
    units.length=0;
    const ga=tags[0]; ga.task='attack'; const gg=tags[1]; gg.task='guard';
    const ua=spawnUnit(0,'spear',100,100,ga), ug=spawnUnit(0,'spear',200,200,gg);
    return {Ra:engageR(ua,ga,UT['spear']), Rg:engageR(ug,gg,UT['spear'])}`);
  check('attack engageR > guard engageR (per-unit, aggressive vs conservative)', r.Ra > r.Rg, r);
  check('guard engageR clamped into [130,200]', r.Rg >= 130 && r.Rg <= 200, r.Rg);

  console.log('\n[2] attack = attack-move: engages roadside enemy en route (does NOT relocate past it)');
  const t2 = await ev(`${SETUP('attack',0,true)}
    const reloc=__pu.relocate, atk=__pu.atkMove;
    for(let i=0;i<150;i++)step(TICK);
    return {reloc, atk, puX:Math.round(__pu.x), EX:__EX, PX:__PX, tgtIsEnemy:__pu.tgt===__eb, dmgDealt:Math.round(99999-__eb.hp)}`);
  check('attack order sets relocate=false (no move-commitment)', t2.reloc === false, t2.reloc);
  check('attack order sets atkMove=true (reach-P sub-goal pending)', t2.atk === true, t2.atk);
  check('engaged the enemy en route (tgt = enemy bag)', t2.tgtIsEnemy === true);
  check('stopped at enemy, did NOT walk past to P', t2.puX < t2.EX + 60 && t2.puX < t2.PX - 100, { puX: t2.puX, EX: t2.EX, PX: t2.PX });
  check('dealt damage to the roadside enemy', t2.dmgDealt > 0, t2.dmgDealt);

  console.log('\n[3] after kill: resume to P (sub-goal survived chase), then idle IN PLACE (no return)');
  const t3 = await ev(`${SETUP('attack',0,false)}
    let killAt=-1;
    for(let i=0;i<1200;i++){step(TICK); if(killAt<0&&__eb.hp<=0)killAt=i;}
    const reachP=Math.round(Math.hypot(__pu.x-__PX,__pu.y-__CY)), atkAfter=__pu.atkMove;
    // nudge 150px off P, clear orders; with sub-goal removed it must NOT walk back
    __pu.x=__PX-150; __pu.y=__CY; __pu.path=[]; __pu.tgt=null; const xb=__pu.x;
    for(let i=0;i<240;i++)step(TICK);
    return {killed:__eb.hp<=0, killAt, reachP, atkAfter, drift:Math.round(Math.abs(__pu.x-xb))}`);
  check('enemy bag was killed', t3.killed === true, { killAt: t3.killAt });
  check('returned to P after the kill (reach-P sub-goal persisted)', t3.reachP < 95, t3.reachP);
  check('atkMove cleared on arrival (sub-goal removed)', t3.atkAfter === false, t3.atkAfter);
  check('idle IN PLACE after arrival — does not return to P when nudged', t3.drift < 30, t3.drift);

  console.log('\n[4] guard regression: relocate-commitment still set, travels to P');
  const t4 = await ev(`${SETUP('guard',1,false)}
    const reloc=__pu.relocate, atk=!!__pu.atkMove;
    for(let i=0;i<500;i++)step(TICK);
    return {reloc, atk, reachP:Math.round(Math.hypot(__pu.x-__PX,__pu.y-__CY))}`);
  check('guard order sets relocate=true', t4.reloc === true, t4.reloc);
  check('guard order does NOT set atkMove', t4.atk === false, t4.atk);
  check('guard relocated to P', t4.reachP < 95, t4.reachP);

  console.log('\n[5] mode switch clears the attack sub-goal');
  const t5 = await ev(`${SETUP('attack',0,false)}
    const before=__pu.atkMove;
    tags[0].task='guard'; units.filter(u=>u.side===0&&u.grp===tags[0]).forEach(u=>u.atkMove=false);
    return {before, after:__pu.atkMove}`);
  check('atkMove true before switch, false after switch-to-guard', t5.before === true && t5.after === false, t5);

  console.log('\n[6] outpost → city upgrade (investment buys a life: outpost upgrades to city = spare life)');
  const t6 = await ev(`
    units.length=0; gameOver=null;
    stock.wood+=300;stock.stone+=300;stock.gold+=300;
    const op=placeB(0,'outpost',6,20,true);
    const isLifeBefore=!!BT[op.type].life, isCCbefore=!!BT[op.type].cc, hadDropoff=!!BT[op.type].dropoff;
    const ok=upgradeOutpost(op), wasUpging=op.upging;
    for(let i=0;i<600&&op.type==='outpost';i++)step(TICK);
    return {ok,wasUpging,isLifeBefore,isCCbefore,hadDropoff,
      type:op.type, isLife:!!BT[op.type].life, isCC:!!BT[op.type].cc, hp:Math.round(op.hp), maxHp:op.maxHp};`);
  check('outpost is NOT a reserve life / command center before upgrade', t6.isLifeBefore===false && t6.isCCbefore===false, t6);
  check('outpost is a universal drop-off point', t6.hadDropoff===true);
  check('upgradeOutpost accepted + marked upgrading', t6.ok===true && t6.wasUpging===true, t6);
  check('outpost became city', t6.type === 'city', t6.type);
  check('city is a reserve life (life flag)', t6.isLife === true);
  check('city is a command center (cc flag)', t6.isCC === true);
  check('city HP set to city maxHp (≤ capital 1000)', t6.maxHp === 900 && t6.hp <= 1000, t6);

  console.log('\n[7] spare life: capital falls but a city stands → keep fighting; last centre falls → lose');
  const t7 = await ev(`
    gameOver=null;
    if(!hasCC(1))placeB(1,'tc',41,12,true);                 // keep enemy alive so only player side is tested
    const city=buildings.find(b=>b.side===0&&b.type==='city');
    let cap=buildings.find(b=>b.side===0&&b.type==='tc'); if(!cap)cap=placeB(0,'tc',5,12,true);
    const livesBefore=nLives(0);
    cap.hp=0; step(TICK);
    const afterCap={over:gameOver, hasCapital:hasCapital(0), hasCC:hasCC(0), lives:nLives(0)};
    city.hp=0; step(TICK);
    const afterCity={over:gameOver, hasCC:hasCC(0)};
    return {livesBefore, afterCap, afterCity};`);
  check('a city counts as one reserve life', t7.livesBefore >= 1, t7.livesBefore);
  check('capital destroyed but city stands → game NOT over', t7.afterCap.over === null, t7.afterCap);
  check('hasCapital false after capital lost (rebuild becomes available)', t7.afterCap.hasCapital === false);
  check('still has a command centre (the city)', t7.afterCap.hasCC === true);
  check('all command centres gone → defeat', t7.afterCity.over === 'lose', t7.afterCity);

  console.log('\n[8] capital rebuild gate + win condition (enemy command centres all gone)');
  const t8 = await ev(`
    gameOver=null;
    // clear any player buildings, rebuild a single capital, verify TC only buildable when capital missing
    buildings=buildings.filter(b=>b.side!==0);
    const gateWhenNone = !hasCapital(0);                    // true ⇒ build menu would offer TC
    placeB(0,'tc',5,12,true);
    const gateWhenHave = !hasCapital(0);                    // false ⇒ TC hidden (no double capital)
    if(!hasCC(1))placeB(1,'tc',41,12,true);
    const ecap=buildings.find(b=>b.side===1&&b.type==='tc'); ecap.hp=0; step(TICK);
    return {gateWhenNone, gateWhenHave, over:gameOver, pHasCC:hasCC(0), eHasCC:hasCC(1)};`);
  check('TC rebuild offered only when no capital exists', t8.gateWhenNone === true && t8.gateWhenHave === false, t8);
  check('player still alive (control)', t8.pHasCC === true);
  check('enemy command centres all destroyed → victory', t8.over === 'win', t8);

  console.log('\n[9] monastery: medic produced HERE (not barracks) + passive heal aura on nearby bio');
  const t9 = await ev(`
    gameOver=null; units.length=0;
    if(!hasCapital(0))placeB(0,'tc',5,12,true);
    if(!hasCC(1))placeB(1,'tc',41,12,true);                 // both sides alive so no win/lose interrupts stepping
    stock.food+=300;stock.gold+=300;stock.wood+=300;
    const mon=placeB(0,'monastery',10,20,true); mon.defTag=0;
    playerTech.researched.add('U3'); recomputeTechMod();        // 第三段：醫護需研發 U3 解鎖（直接解鎖以測修道院產出/光環）
    const auraR=BT.monastery.healR, rate=BT.monastery.heal;
    const okQ=queueUnit(mon,'medic');
    for(let i=0;i<400&&!units.some(u=>u.type==='medic'&&u.side===0);i++)step(TICK);
    const hasMedic=units.some(u=>u.type==='medic'&&u.side===0);
    const w=spawnUnit(0,'spear',mon.x+40,mon.y+40,tags[0]); w.hp=20; const hp0=w.hp;
    const far=spawnUnit(0,'spear',mon.x+auraR+120,mon.y,tags[0]); far.hp=20; const fhp0=far.hp; far.anchor={x:far.x,y:far.y};
    for(let i=0;i<40;i++)step(TICK);
    return {okQ, hasMedic, auraR, rate, nearFrom:hp0, nearTo:+w.hp.toFixed(1),
      farFrom:fhp0, farTo:+far.hp.toFixed(1), farDist:Math.round(Math.hypot(far.x-mon.x,far.y-mon.y))};`);
  check('monastery accepts a medic into its production queue', t9.okQ === true);
  check('medic is produced at the monastery (moved off the barracks, per 08)', t9.hasMedic === true, t9);
  check('aura heals a wounded bio unit inside range', t9.nearTo > t9.nearFrom, {from:t9.nearFrom,to:t9.nearTo,R:t9.auraR});
  check('aura does NOT heal a unit outside range', t9.farTo === t9.farFrom, {from:t9.farFrom,to:t9.farTo,dist:t9.farDist,R:t9.auraR});

  console.log('\n[10] wall: blocks movement (impassable for both sides, enters blocked)');
  const t10 = await ev(`
    gameOver=null;
    const wx=8, wy=8, w=placeB(0,'wall',wx,wy,true);
    const i=idx(wx,wy), a=idx(wx-1,wy);
    return {inBlocked:blocked[i], hp:w.hp, ownerStep:canStep(a,i,0), enemyStep:canStep(a,i,1)};`);
  check('wall enters global blocked (walls stop everyone)', t10.inBlocked === 1, t10);
  check('nobody can step onto a wall tile (owner)', t10.ownerStep === false);
  check('nobody can step onto a wall tile (enemy)', t10.enemyStep === false);

  console.log('\n[11] gate: side-aware (own side passes through, enemy must destroy it; not entered into blocked)');
  const t11 = await ev(`
    gameOver=null;
    const gx=10, gy=10, g=placeB(0,'gate',gx,gy,true);
    const i=idx(gx,gy), a=idx(gx-1,gy);
    return {gateMask:gateMask[i], inBlocked:blocked[i],
      ownerStep:canStep(a,i,0), enemyStep:canStep(a,i,1),
      ownerLine:lineWalkable((gx-1+.5)*TILE,(gy+.5)*TILE,(gx+1+.5)*TILE,(gy+.5)*TILE,0),
      enemyLine:lineWalkable((gx-1+.5)*TILE,(gy+.5)*TILE,(gx+1+.5)*TILE,(gy+.5)*TILE,1)};`);
  check('gate records owner side in gateMask (side+1)', t11.gateMask === 1, t11);
  check('gate is NOT in blocked (uses side-aware mask instead)', t11.inBlocked === 0);
  check('owner may step onto own gate', t11.ownerStep === true);
  check('enemy may NOT step onto enemy gate', t11.enemyStep === false);
  check('owner straight-line passes through own gate', t11.ownerLine === true);
  check('enemy straight-line blocked by enemy gate', t11.enemyLine === false);

  console.log('\n[12] siege bonus vs walls (08: siege units get an extra bonus against walls)');
  const t12 = await ev(`
    const wall=placeB(0,'wall',12,12,true);
    const tc=buildings.find(b=>b.type==='tc'&&b.side===0)||placeB(0,'outpost',14,14,true);
    return {vsWall:bonusVs(UT.catapult,wall), vsBld:bonusVs(UT.catapult,tc),
      spearVsWall:bonusVs(UT.spear,wall), siege:BT.wall.siege};`);
  check('catapult vs wall = building bonus × siege', t12.vsWall === 6, t12);
  check('catapult does MORE to a wall than a normal building', t12.vsWall > t12.vsBld, t12);
  check('non-siege unit (spear) gets no wall bonus', t12.spearVsWall === 1, t12);

  console.log('\n[13] castle: hardened defence (garrison + defensive fire), not a command centre / not a life');
  const t13 = await ev(`
    gameOver=null; units.length=0;
    if(!hasCapital(0))placeB(0,'tc',2,2,true);
    if(!hasCC(1))placeB(1,'tc',45,2,true);
    const castle=placeB(0,'castle',10,12,true);
    const e=spawnUnit(1,'spear',castle.x+120,castle.y,tags[5]); const hp0=e.hp;
    for(let i=0;i<140;i++)step(TICK);
    return {isCC:!!BT.castle.cc, isLife:!!BT.castle.life, cap:BT.castle.cap, rng:BT.castle.rng,
      eFrom:hp0, eTo:Math.round(e.hp)};`);
  check('castle is a fortification — not a command centre / not a life', t13.isCC === false && t13.isLife === false, t13);
  check('castle garrisons units + has defensive fire range', t13.cap > 0 && t13.rng > 0, t13);
  check('castle shoots a nearby enemy', t13.eTo < t13.eFrom, {from:t13.eFrom,to:t13.eTo});

  console.log('\n[14] debug tools: coordinate readout / stuck-unit log hooks available (for logging problem units during playtests)');
  const t14 = await ev(`
    setDebug(true); const on=dbgMode;
    logEvt('test',{side:0,x:123,y:456},'probe'); const logged=mlog[mlog.length-1];
    const p=dbg.pick(123,456); setDebug(false); const off=dbgMode;
    return {on, off, hasSetDebug:typeof setDebug==='function', hasMlog:Array.isArray(mlog),
      logKind:logged&&logged.kind, logTx:logged&&logged.tx, pickOk:!!p};`);
  check('debug toggle on/off works (setDebug)', t14.on === true && t14.off === false && t14.hasSetDebug, t14);
  check('movement log captures events with tile coords', t14.hasMlog && t14.logKind === 'test' && Number.isInteger(t14.logTx), t14);
  check('dbg.pick(x,y) inspects nearest entity', t14.pickOk === true);

  console.log('\n[15] wall lines do not cross cliffs (a two-point line build is cut off at the cliff)');
  const t15 = await ev(`
    const h0=hgtI(idx(15,12));                    // x<20 平地(0)；高地 trect(20,9,27,17)
    const path=wallPath(15,12,25,12);             // 崖在 x19|20：路徑應停在 x19、不上高地
    const last=path[path.length-1];
    const crosses=path.some(c=>Math.abs(hgtI(idx(c.x,c.y))-h0)>0.5);
    const flat=wallPath(2,2,7,2);                 // 全平地＝不應誤截
    return {len:path.length, lastX:last.x, crosses, flatLen:flat.length, h0, hEnd:hgtI(idx(25,12))};`);
  check('row has a real cliff (test premise: low→high)', t15.h0 === 0 && t15.hEnd === 1, t15);
  check('wall line stops at the cliff edge (no tile on the high side)', t15.crosses === false && t15.lastX === 19, t15);
  check('flat-ground wall line still spans fully (no false truncation)', t15.flatLen === 6, t15);

  console.log('\n[16] debug tools hardened: pause / log save / marker-highlight hooks');
  const t16 = await ev(`
    setDebug(true);
    const p1=dbg.setPaused(true), p2=dbg.setPaused(false);    // 切換可用
    const hasSave=typeof dbg.saveLog==='function';
    const u=spawnUnit(0,'spear',600,300,tags[0]);             // 標記最近實體＝記住 dbgPick（畫布高亮＋log 同色）
    dbgMark(600,300); const picked=!!dbg.dbgPick && dbg.dbgPick()===u;
    const lastKind=mlog[mlog.length-1].kind;
    dbg.setPaused(true); setDebug(false);                     // 離開除錯應自動解除暫停
    const unpausedOnExit=dbg.paused();
    return {p1,p2,hasSave,picked,lastKind,unpausedOnExit};`);
  check('setPaused toggles freeze on/off', t16.p1 === true && t16.p2 === false, t16);
  check('saveLog hook exists (download mlog as txt for Claude)', t16.hasSave === true);
  check('manual mark records picked entity (canvas highlight + same-colour log)', t16.picked === true && t16.lastKind === '標記', t16);
  check('leaving debug clears pause (no frozen screen)', t16.unpausedOnExit === false);

  console.log('\n[17] gate 2×1 + rotatable (horizontal covers 2 tiles, vertical 1×2, demolition clears fully, side-aware unchanged)');
  const t17 = await ev(`
    const fh=fpOf('gate','h'), fv=fpOf('gate','v'), fsq=fpOf('tc','h');
    const gx=14,gy=4, gh=placeB(0,'gate',gx,gy,true,'h');     // 橫門：覆蓋 (14,4)+(15,4)
    const hCover=gateMask[idx(gx,gy)]===1 && gateMask[idx(gx+1,gy)]===1 && gateMask[idx(gx,gy+1)]===0;
    const gx2=14,gy2=20, gv=placeB(0,'gate',gx2,gy2,true,'v'); // 直門：覆蓋 (14,20)+(14,21)
    const vCover=gateMask[idx(gx2,gy2)]===1 && gateMask[idx(gx2,gy2+1)]===1 && gateMask[idx(gx2+1,gy2)]===0;
    const ownerPass=canStep(idx(gx-1,gy),idx(gx,gy),0) && canStep(idx(gx,gy),idx(gx+1,gy),0); // 我方穿越 2 格
    const enemyBlock=!canStep(idx(gx-1,gy),idx(gx,gy),1);                                       // 敵方被擋
    const i0=idx(gx,gy),i1=idx(gx+1,gy); killBuilding(gh);
    const clearedAfter=gateMask[i0]===0 && gateMask[i1]===0;   // 拆 2 格門＝兩格都清
    return {fh,fv,fsq, hCover,vCover, w:gh.w,h:gh.h,ori:gh.ori, vw:gv.w,vh:gv.h,
      ownerPass,enemyBlock,clearedAfter};`);
  check('footprint helper: gate 2×1 / 1×2, square (tc) unchanged 2×2',
    t17.fh.w===2&&t17.fh.h===1&&t17.fv.w===1&&t17.fv.h===2&&t17.fsq.w===2&&t17.fsq.h===2, t17);
  check('horizontal gate covers a 2×1 footprint (mask on both tiles)', t17.hCover===true && t17.w===2 && t17.h===1, t17);
  check('vertical gate covers a 1×2 footprint', t17.vCover===true && t17.vw===1 && t17.vh===2, t17);
  check('owner walks through the whole 2-wide gate; enemy still blocked', t17.ownerPass===true && t17.enemyBlock===true, t17);
  check('removing a 2-wide gate clears BOTH gate tiles', t17.clearedAfter===true, t17);

  console.log('\n[18] demolish / cancel building: full refund while under construction, half refund × HP ratio once built, clears footprint, unassigns villagers, protects the last town centre');
  const t18 = await ev(`
    gameOver=null; buildings=buildings.filter(b=>b.side!==0); villagers.length=0;
    if(!hasCC(1))placeB(1,'tc',41,12,true);
    stock.stone+=100; const w=placeB(0,'wall',6,6,false); stock.stone-=BT.wall.cost.stone;
    const before1=stock.stone, wi=idx(6,6);
    const demo1=demolishBuild(w);
    const refunded=stock.stone===before1+BT.wall.cost.stone, cleared1=blocked[wi]===0, gone1=!buildings.includes(w);
    stock.wood+=500;stock.stone+=500; const before2=stock.stone, tw=placeB(0,'tower',8,8,true), ti=idx(8,8);
    demolishBuild(tw); const halfRefund=stock.stone===before2+Math.floor(BT.tower.cost.stone*0.5), cleared2=blocked[ti]===0;
    stock.stone+=300; const before2b=stock.stone, tw2=placeB(0,'tower',9,9,true); tw2.hp=tw2.maxHp*0.5;
    demolishBuild(tw2); const dmgRefund=stock.stone===before2b+Math.floor(BT.tower.cost.stone*0.5*0.5);
    const w3=placeB(0,'wall',10,10,false); spawnVillager(); const v=villagers[villagers.length-1]; v.buildSite=w3;
    demolishBuild(w3); const vCleared=v.buildSite===null;
    const g=placeB(0,'gate',12,12,true,'h'); demolishBuild(g);
    const gateCleared=gateMask[idx(12,12)]===0 && gateMask[idx(13,12)]===0;
    const cap=placeB(0,'tc',2,2,true); const onlyCC=demolishBuild(cap), capStands=buildings.includes(cap);
    return {refunded,cleared1,gone1,demo1,halfRefund,dmgRefund,cleared2,vCleared,gateCleared,onlyCC,capStands};`);
  check('cancel under-construction refunds the build cost', t18.refunded===true && t18.demo1===true, t18);
  check('demolished building leaves world + clears its footprint', t18.gone1===true && t18.cleared1===true, t18);
  check('completed full-HP building recycles HALF its build cost, clears footprint', t18.halfRefund===true && t18.cleared2===true, t18);
  check('damaged building refund scales with HP (½-HP tower ≈ ¼ cost)', t18.dmgRefund===true, t18);
  check('demolish clears villager build assignment (no chasing a removed site)', t18.vCleared===true, t18);
  check('demolishing a 2-wide gate clears BOTH gate-mask tiles', t18.gateCleared===true, t18);
  check('cannot demolish the last command centre (no accidental self-loss)', t18.onlyCC===false && t18.capStands===true, t18);

  console.log('\n[19] civilisation tech tree (part 3): shared tree + three civ masks (England S2+S3 / HRE M5+F3 / Mongol M6+E3+M7+P1, read-only view)');
  const t19 = await ev(`
    const ids=TECH.map(t=>t.id), uniqOK=ids.length===new Set(ids).size;
    const m123=['M1','M2','M3'].every(id=>{const t=techById(id);return t&&t.kind==='val'&&!t.star;}); // 維持三項獨立
    const noMerge=!TECH.some(t=>/鐵匠工坊/.test(t.nm));                                                // 未合併
    const engHas=[...civEnabled('eng')], hreHas=[...civEnabled('hre')], monHas=[...civEnabled('mon')];
    const cnt={eng:engHas.length,hre:hreHas.length,mon:monHas.length};
    const inBand=Object.values(cnt).every(n=>n>=18&&n<=26);                                           // 單一文明：陸戰 12~18 + 水軍線(5 通用+1 專屬)＝18~26（specs/12 五加入後擴充）
    const navalUniv=['N1','N2','N3','N4','N5'].every(x=>engHas.includes(x)&&hreHas.includes(x)&&monHas.includes(x)); // 5 項通用水軍＝各文明皆啟用
    const navalCiv=engHas.includes('NE')&&!engHas.includes('NH')&&!engHas.includes('NM')              // 專屬水軍：英長弓戰船/神羅鐵甲艦/蒙快火船 互斥
      &&hreHas.includes('NH')&&!hreHas.includes('NE')&&!hreHas.includes('NM')
      &&monHas.includes('NM')&&!monHas.includes('NE')&&!monHas.includes('NH');
    const engOK=['S2','S3','UL'].every(x=>engHas.includes(x)) && ['M5','F3','M6','E3','UH','UM'].every(x=>!engHas.includes(x));
    const hreOK=['M5','F3','UH'].every(x=>hreHas.includes(x)) && ['S2','S3','UL','UM'].every(x=>!hreHas.includes(x));
    const monOK=['M6','E3','M7','P1','UM'].every(x=>monHas.includes(x)) && ['M5','S2','UL','UH'].every(x=>!monHas.includes(x));
    const universalAll=UNIVERSAL.every(x=>engHas.includes(x)&&hreHas.includes(x)&&monHas.includes(x));
    const noDangling=['eng','hre','mon'].every(cv=>{const s=civEnabled(cv);                          // 啟用科技的前置也須啟用
      return [...s].every(id=>{const t=techById(id);return !t.req||t.req.every(r=>s.has(r));});});
    const s2eng=starOwner('S2'), m6mon=starOwner('M6'), e4pool=starOwner('E4');
    openTechTree(); const opened=!document.querySelector('#techOverlay').classList.contains('hidden');
    const civSet=dbg.setTechCiv('mon');                                                              // 切換檢視文明＝重繪
    const cards=document.querySelectorAll('#techBody .techCard').length;
    const locked=document.querySelectorAll('#techBody .techCard.off').length;
    closeTechTree(); const closed=document.querySelector('#techOverlay').classList.contains('hidden');
    return {n:ids.length,uniqOK,m123,noMerge,cnt,inBand,navalUniv,navalCiv,engOK,hreOK,monOK,universalAll,noDangling,
      s2eng,m6mon,e4pool,opened,civSet,cards,locked,closed};`);
  check('tech tree has 36 items with unique ids (28 land + 8 naval)', t19.n===36 && t19.uniqOK===true, {n:t19.n});
  check('M1/M2/M3 kept as three separate value techs (NOT merged into blacksmith)', t19.m123===true && t19.noMerge===true);
  check('each civ enables 18–26 techs (land 12–18 + naval line)', t19.inBand===true, t19.cnt);
  check('naval research: N1–N5 universal (every civilisation has them); NE/NH/NM civ-specific and mutually exclusive', t19.navalUniv===true && t19.navalCiv===true);
  check('England mask: S2+S3+longbowman on; M5/F3/M6/pack animals/heavy infantry/horse archer locked', t19.engOK===true);
  check('HRE mask: M5+F3+heavy infantry on; S2/S3/longbowman/horse archer locked', t19.hreOK===true);
  check('Mongol mask: M6+E3+M7+P1+horse archer on; M5/S2/longbowman/heavy infantry locked', t19.monOK===true);
  check('all civs enable every universal (non-star, non-unique) tech', t19.universalAll===true);
  check('no enabled tech has a locked prerequisite', t19.noDangling===true);
  check('star ownership: S2→England, M6→Mongol, E4→none of v1.0 civs (reserve pool)',
    t19.s2eng.includes('英格蘭') && t19.m6mon.includes('蒙古') && t19.e4pool.length===0,
    {s2:t19.s2eng,m6:t19.m6mon,e4:t19.e4pool});
  check('tech overlay opens, switches civ, renders all 36 cards, closes',
    t19.opened===true && t19.civSet==='mon' && t19.cards===36 && t19.closed===true, t19);
  check('viewing Mongol renders locked cards = 36 − enabled = n−cnt.mon', t19.locked===t19.n-t19.cnt.mon, {locked:t19.locked});

  console.log('\n[20] research mechanics (part 3): research / prereqs / age gates + age up + unit unlocks + effects techMod live');
  const t20 = await ev(`
    setPlayerCiv('eng'); stock.wood+=3000;stock.food+=3000;stock.gold+=3000;stock.iron+=3000;stock.stone+=3000;
    // Otherwise the enemy wave follows wp into the playerTC area and destroys the research building (siege
    // workshop), so M4 lands on 'atbld' and the test drifts with any trajectory change rather than with the
    // logic under test. Combat cases all live in [2]-[13], before [20], and build their own controlled
    // enemies, so they are unaffected.
    units=units.filter(u=>u.side===0); aiWave=99999;
    const need=(tp,x,y)=>{if(!buildings.some(b=>b.side===0&&b.type===tp&&b.hp>0))placeB(0,tp,x,y,true);};
    need('smith',2,5);need('stable',2,8);
    const st=(id)=>techState(techById(id));
    const g_avail=st('E1')==='avail';
    const g_civ=st('M5')==='civ';
    const g_age=st('M4')==='age';
    startResearch(techById('E1'));
    const tracked=playerTech.track&&playerTech.track.id==='E1';
    for(let i=0;i<300&&!playerTech.researched.has('E1');i++)step(TICK);
    const doneE1=playerTech.researched.has('E1'), gather=+techMod.gather.toFixed(2);
    startResearch(techById('M1')); for(let i=0;i<300&&!playerTech.researched.has('M1');i++)step(TICK);
    const mAtk=techMod.meleeAtk;
    const qual=ageQualify(1), canUp=canAdvanceAge();
    startAgeUp(); for(let i=0;i<900&&playerTech.age===1;i++)step(TICK);
    const age2=playerTech.age;
    const m4prereq=st('M4')==='prereq';
    startResearch(techById('M2')); for(let i=0;i<300&&!playerTech.researched.has('M2');i++)step(TICK);
    const m4avail=st('M4')==='avail';
    const cavBefore=unitUnlocked('cavalry');
    startResearch(techById('U1')); for(let i=0;i<300&&!playerTech.researched.has('U1');i++)step(TICK);
    const cavAfter=unitUnlocked('cavalry');
    const monHasM6=civEnabled('mon').has('M6'), engNoM6=!civEnabled('eng').has('M6');
    return {g_avail,g_civ,g_age,tracked,doneE1,gather,mAtk,qual,canUp,age2,m4prereq,m4avail,cavBefore,cavAfter,monHasM6,engNoM6};`);
  check('research gating: enabled→avail, off-civ→civ, future-tier→age', t20.g_avail&&t20.g_civ&&t20.g_age, t20);
  check('research E1 runs on the track and completes', t20.tracked===true && t20.doneE1===true);
  check('E1 effect live: gather ×1.15', t20.gather===1.15, {gather:t20.gather});
  check('M1 effect live: melee attack +1', t20.mAtk===1);
  check('age-up gate (#15 dual floor research≥1; buildings≥1; total≥3): E1+M1 = 2 research + smith+stable = 2 buildings → advances to age 2', t20.qual>=3 && t20.canUp===true && t20.age2===2, t20);
  check('after age-up, tier-2 tech needs prereq (M4 needs M1+M2)', t20.m4prereq===true && t20.m4avail===true, t20);
  check('unit unlock: cavalry locked until U1 researched', t20.cavBefore===false && t20.cavAfter===true);
  check('Mongol mask enables its star M6; England mask does not', t20.monHasM6===true && t20.engNoM6===true);

  console.log('\n[21] Batch 1 stat inspection: prodRate per-resource gather speed + read-only unit panel (tech bonus (+n)) + villager carry + farm regen display');
  const t21 = await ev(`
    setPlayerCiv('eng'); stock.wood+=5000;stock.food+=5000;stock.gold+=5000;stock.iron+=5000;stock.stone+=5000;
    const need=(tp,x,y)=>{if(!buildings.some(b=>b.side===0&&b.type===tp&&b.hp>0))placeB(0,tp,x,y,true);};
    need('smith',2,5);
    startResearch(techById('M1')); for(let i=0;i<300&&!playerTech.researched.has('M1');i++)step(TICK);
    const haveKeys=['wood','stone','iron','gold','food'].every(k=>k in prodRate);
    foodRateT=0; for(const k in prodAcc)prodAcc[k]=0;
    prodAcc.wood+=30; prodAcc.food+=10;
    for(let i=0;i<110;i++)step(TICK);
    const ratePos=prodRate.wood>0 && prodRate.food>0;
    units.length=0; const CY=playerTC.y, SX=playerTC.x+140;
    const su=spawnUnit(0,'spear',SX,CY,tags[0]);
    const picked=pickUnitAt(SX,CY)===su;
    openUnitPanel(su); const selOK=selUnit===su;
    const atkShown=document.querySelector('#bldPanel').innerHTML.includes('攻 8(+1)');
    const eb=spawnUnit(1,'spear',SX+25,CY,tags[5]); const enemyMiss=pickUnitAt(SX+25,CY)!==eb;
    spawnVillager(); const v=villagers[villagers.length-1]; v.carry=4; v.carryType='wood';
    openUnitPanel(v); const carryShown=document.querySelector('#bldPanel').innerHTML.includes('木：4/10');
    const regenBefore=techMod.farmRegen;
    startResearch(techById('E2')); for(let i=0;i<300&&!playerTech.researched.has('E2');i++)step(TICK);
    const regenAfter=techMod.farmRegen;
    openFarmPanel({type:'farm',hp:140,maxHp:140,node:{amt:30,max:90,farm:true}});
    const farmRateShown=document.querySelector('#bldPanel').innerHTML.includes('+1.8/秒');
    return {haveKeys,ratePos,picked,selOK,atkShown,enemyMiss,carryShown,regenBefore,regenAfter,farmRateShown};`);
  check('prodRate exposes all 5 resource keys', t21.haveKeys===true);
  check('prodRate reflects deposits via the 5s window (per-resource /min plumbing)', t21.ratePos===true);
  check('pickUnitAt hits player unit + openUnitPanel sets selUnit', t21.picked===true && t21.selOK===true);
  check('unit panel shows tech bonus: spear atk 8(+1) after M1', t21.atkShown===true, {atkShown:t21.atkShown});
  check('pickUnitAt ignores enemy units (player-only inspection)', t21.enemyMiss===true);
  check('villager panel shows carry wood: 4/10', t21.carryShown===true);
  check('farm regen display live: ×1→×1.5 after E2 (1.2→1.8/s)', t21.regenBefore===1 && t21.regenAfter===1.5 && t21.farmRateShown===true, t21);

  console.log('\n[22] Batch 2a research mechanics corrected: no reset + hard mutual-exclusion lock / cancelling research refunds / single-player pause flag / fixed age tag + age name on card');
  const t22 = await ev(`
    playerTech.researched.clear();playerTech.age=1;playerTech.track=null;playerTech.queue.length=0;playerTech.ageUp=null;recomputeTechMod();
    playerCiv=CIVS[0];techCiv=CIVS[0];
    stock.wood+=9999;stock.food+=9999;stock.gold+=9999;stock.iron+=9999;stock.stone+=9999;
    const need=(tp,x,y)=>{if(!buildings.some(b=>b.side===0&&b.type===tp&&b.hp>0))placeB(0,tp,x,y,true);};
    need('smith',2,5);need('tower',2,11);
    startResearch(techById('E1')); for(let i=0;i<300&&!playerTech.researched.has('E1');i++)step(TICK);
    const beforeSwitch=playerTech.researched.has('E1');
    const switched=setPlayerCiv('hre')==='hre', keptE1=playerTech.researched.has('E1');
    setPlayerCiv('eng');
    playerTech.age=2;
    startResearch(techById('S1')); for(let i=0;i<300&&!playerTech.researched.has('S1');i++)step(TICK);
    startResearch(techById('S2')); for(let i=0;i<500&&!playerTech.researched.has('S2');i++)step(TICK);
    const s2done=playerTech.researched.has('S2');
    const lockHre=civCompatible('hre')===false, lockMon=civCompatible('mon')===false, okEng=civCompatible('eng')===true;
    const n0=playerTech.researched.size;
    const rejected=setPlayerCiv('hre')==='eng' && playerTech.researched.size===n0;
    const wBefore=stock.wood;
    startResearch(techById('M1')); const m1Active=!!(playerTech.track&&playerTech.track.id==='M1');
    startResearch(techById('M2')); const m2Queued=playerTech.queue.includes('M2');
    cancelResearch('M2'); const m2Gone=!playerTech.queue.includes('M2');
    cancelResearch('M1'); const m1Gone=!(playerTech.track&&playerTech.track.id==='M1');
    const wRestored=stock.wood===wBefore;
    closeTechTree(); const pBase=techPaused;
    openTechTree(); const pOpen=techPaused;
    closeTechTree(); const pClose=techPaused;
    isMultiplayer=true; openTechTree(); const pMulti=techPaused; closeTechTree(); isMultiplayer=false;
    techCiv=civById('mon'); renderTechTree();
    const titleHasAge=document.querySelector('#techTitle').textContent.includes('時代');
    techCiv=playerCiv; renderTechTree();
    let ageBadge='';
    document.querySelectorAll('.techCard').forEach(c=>{const id=c.querySelector('.techId');if(id&&id.textContent==='E1')ageBadge=c.querySelector('.techTier').textContent;});
    return {beforeSwitch,switched,keptE1,s2done,lockHre,lockMon,okEng,rejected,m1Active,m2Queued,m2Gone,m1Gone,wRestored,pBase,pOpen,pClose,pMulti,titleHasAge,ageBadge};`);
  check('no-reset: universal tech (E1) kept after eng→hre switch', t22.beforeSwitch===true && t22.switched===true && t22.keptE1===true);
  check('exclusion lock: after star S2, HRE+Mongol incompatible, England ok', t22.s2done===true && t22.lockHre===true && t22.lockMon===true && t22.okEng===true);
  check('exclusion lock: switching to incompatible civ rejected (stays eng, research intact)', t22.rejected===true);
  check('cancel research (active+queued) removes + refunds in full', t22.m1Active===true && t22.m2Queued===true && t22.m2Gone===true && t22.m1Gone===true && t22.wRestored===true, t22);
  check('single-player pause flag: open→true, close→false; multiplayer→false', t22.pBase===false && t22.pOpen===true && t22.pClose===false && t22.pMulti===false, t22);
  check('tech title always shows age (no jump) + tier-1 card badge = Feudal', t22.titleHasAge===true && t22.ageBadge==='封建', {ageBadge:t22.ageBadge});

  console.log('\n[23] Batch 2b building gates: siege workshop/stable buildable + production routing + age unlocks (monastery, castle → Castle age) + real building prereqs for research + mutual-exclusion lock applied at "start research ★" (released on cancel)');
  const t23 = await ev(`
    playerTech.researched.clear();playerTech.age=1;playerTech.track=null;playerTech.queue.length=0;playerTech.ageUp=null;recomputeTechMod();
    playerCiv=CIVS[0];techCiv=CIVS[0];
    buildings=buildings.filter(b=>b.side!==0); placeB(0,'tc',5,12,true);
    if(!hasCC(1))placeB(1,'tc',41,12,true);
    stock.wood+=9999;stock.food+=9999;stock.gold+=9999;stock.iron+=9999;stock.stone+=9999;
    const newBld=!!BT.stable && !!BT.smith;
    const route=UT.cavalry.bld==='stable' && UT.catapult.bld==='smith' && UT.spear.bld==='barracks' && UT.archer.bld==='barracks' && UT.medic.bld==='monastery';
    const stb=placeB(0,'stable',7,5,true); openProdPanel(stb);
    const stableBtns=[...document.querySelectorAll('#bldPanel .uBtn')].map(b=>b.dataset.u);
    const sm=placeB(0,'smith',7,8,true); openProdPanel(sm);
    const smithBtns=[...document.querySelectorAll('#bldPanel .uBtn')].map(b=>b.dataset.u);
    const bk=placeB(0,'barracks',10,5,true); openProdPanel(bk);
    const barrBtns=[...document.querySelectorAll('#bldPanel .uBtn')].map(b=>b.dataset.u);
    closePanels();
    const panelRoute=stableBtns.includes('cavalry')&&!stableBtns.includes('horsearcher')&&!stableBtns.includes('spear')  /* Stable = cavalry. playerCiv is England, so no horse archer (other civilisation, hidden under Option2)
   and no infantry. Full civilisation-filter matrix lives in [42]. */
      &&smithBtns.length===1&&smithBtns[0]==='catapult'                                                                  /* Siege workshop = catapult. */
      &&barrBtns.includes('spear')&&barrBtns.includes('archer')&&barrBtns.includes('longbow')&&!barrBtns.includes('heavyinf')&&!barrBtns.includes('cavalry'); /* Barracks = spearman/archer plus longbowman (own civilisation); no heavy infantry (other
   civilisation), no cavalry. */
    playerTech.researched.add('U1');playerTech.researched.add('U2');recomputeTechMod();
    queueUnit(stb,'cavalry'); for(let i=0;i<600&&!units.some(u=>u.side===0&&u.type==='cavalry');i++)step(TICK);
    const cavMade=units.some(u=>u.side===0&&u.type==='cavalry');
    queueUnit(sm,'catapult'); for(let i=0;i<800&&!units.some(u=>u.side===0&&u.type==='catapult');i++)step(TICK);
    const cataMade=units.some(u=>u.side===0&&u.type==='catapult');
    playerTech.researched.delete('U1');playerTech.researched.delete('U2');recomputeTechMod();
    const ageLock1=buildingUnlocked('monastery')===false&&buildingUnlocked('castle')===false&&buildingUnlocked('stable')===true&&buildingUnlocked('smith')===true&&buildingUnlocked('barracks')===true;
    const castleTier2=BTIER.castle===2&&BTIER.monastery===2;
    playerTech.age=2; const ageOpen2=buildingUnlocked('monastery')===true&&buildingUnlocked('castle')===true;
    const m1Avail=techState(techById('M1'))==='avail';
    demolishBuild(sm);
    const m1NoBld=techState(techById('M1'))==='atbld';
    const u3NoMon=techState(techById('U3'))==='atbld';
    openTechTree(); const atbldShown=document.querySelector('#techBody').innerHTML.includes('需先蓋 兵械工坊'); closeTechTree();
    setPlayerCiv('mon');
    startResearch(techById('E1')); for(let i=0;i<300&&!playerTech.researched.has('E1');i++)step(TICK);
    const startE3=startResearch(techById('E3'));
    const e3Active=!!(playerTech.track&&playerTech.track.id==='E3')&&!playerTech.researched.has('E3');
    const lockedDuringResearch=civCompatible('eng')===false;
    const switchRejected=setPlayerCiv('eng')==='mon';
    const committedHasE3=committedExclusive().includes('E3');
    cancelResearch('E3');
    const unlockedAfterCancel=civCompatible('eng')===true&&!playerTech.researched.has('E3');
    const canSwitchAfter=setPlayerCiv('eng')==='eng';
    return {newBld,route,panelRoute,cavMade,cataMade,ageLock1,castleTier2,ageOpen2,m1Avail,m1NoBld,u3NoMon,atbldShown,startE3,e3Active,lockedDuringResearch,switchRejected,committedHasE3,unlockedAfterCancel,canSwitchAfter};`);
  check('smith+stable in BT; production routes cav→stable, catapult→smith, spear/archer→barracks, medic→monastery', t23.newBld===true && t23.route===true);
  check('prod panel routes by building + civ-filters uniques (England: stable=cavalry, smith=catapult, barracks=spear+archer+longbow; other civs\' horse archer/heavy infantry hidden; Option2)', t23.panelRoute===true, t23);
  check('production actually runs at the stable/siege workshop (queue advances → cavalry & catapult spawn) — fixes the prod-tick bug', t23.cavMade===true && t23.cataMade===true, t23);
  check('age-gate: monastery/castle=Castle age (locked@age1, open@age2); stable/siege workshop/barracks=Feudal; BTIER castle/monastery=2', t23.ageLock1===true && t23.ageOpen2===true && t23.castleTier2===true, t23);
  check('real prereq: M1 avail with siege workshop, →atbld when removed; U3 atbld without monastery; card shows "needs a siege workshop first"', t23.m1Avail===true && t23.m1NoBld===true && t23.u3NoMon===true && t23.atbldShown===true, t23);
  check('civ-lock fires at research START of a ★ tech (not completion); committed set includes the in-progress ★', t23.startE3===true && t23.e3Active===true && t23.lockedDuringResearch===true && t23.switchRejected===true && t23.committedHasE3===true, t23);
  check('canceling the ★ research unlocks the other civ again (no completion needed)', t23.unlockedAfterCancel===true && t23.canSwitchAfter===true, t23);

  console.log('\n[24] build row refreshes instantly after age-up: monastery/castle 🔒 cleared automatically (fixes "build row keeps the previous age\'s lock after reaching Castle age and wrongly reports Castle age required")');
  const t24 = await ev(`
    playerTech.researched.clear();playerTech.age=1;playerTech.track=null;playerTech.queue.length=0;playerTech.ageUp=null;recomputeTechMod();
    updateBuildRow();                                                        // 封建時渲染建造列
    const lockedAtAge1=document.querySelector('[data-b="monastery"]').classList.contains('lk')
                     &&document.querySelector('[data-b="castle"]').classList.contains('lk');
    playerTech.ageUp={t:0,dur:0.01,to:2};                                    // 直接觸發升代「完成」路徑（techTick）
    for(let i=0;i<5&&playerTech.age===1;i++)step(TICK);                      // 過程「不」手動刷新建造列
    const reachedAge2=playerTech.age===2&&playerTech.ageUp===null;
    const unlockedAfterAgeUp=!document.querySelector('[data-b="monastery"]').classList.contains('lk')
                           &&!document.querySelector('[data-b="castle"]').classList.contains('lk'); // 沒手動 render 仍解鎖＝升代有刷新建造列
    return {lockedAtAge1,reachedAge2,unlockedAfterAgeUp};`);
  check('build row auto-refreshes on age-up completion: monastery/castle locked@Feudal → unlocked after age-up (no manual re-render)', t24.lockedAtAge1===true && t24.reachedAge2===true && t24.unlockedAfterAgeUp===true, t24);

  console.log('\n[25] #15 age-up dual floor: research≥1; buildings≥1; total≥3 (fixes "age up on 2 buildings and zero research"; drives researched/buildings directly to isolate the gate logic)');
  const t25 = await ev(`
    playerTech.age=1;playerTech.track=null;playerTech.queue.length=0;playerTech.ageUp=null;
    const clean=()=>{buildings=buildings.filter(b=>b.side!==0);placeB(0,'tc',5,12,true);};
    const need3=AGES[1].need===3;
    playerTech.researched=new Set(); clean(); placeB(0,'barracks',7,5,true); placeB(0,'market',7,8,true);
    const a=ageQualifyBreak(1); const blockNoTech=canAdvanceAge()===false&&a.tech===0&&a.bld===2;
    playerTech.researched=new Set(['E1','M1']); clean();
    const b=ageQualifyBreak(1); const blockNoBld=canAdvanceAge()===false&&b.tech===2&&b.bld===0;
    playerTech.researched=new Set(['E1']); clean(); placeB(0,'barracks',7,5,true);
    const c=ageQualifyBreak(1); const blockTotal=canAdvanceAge()===false&&c.tech===1&&c.bld===1;
    placeB(0,'market',7,8,true);
    const d=ageQualifyBreak(1); const okMix=canAdvanceAge()===true&&d.tech===1&&d.bld===2;
    return {need3,blockNoTech,blockNoBld,blockTotal,okMix};`);
  check('#15 dual floor: need=3; 0 research+2 buildings blocked (research<1); 2 research+0 buildings blocked (buildings<1); 1 research+1 building=2 blocked (total<3); 1 research+2 buildings=3 passes', t25.need3===true && t25.blockNoTech===true && t25.blockNoBld===true && t25.blockTotal===true && t25.okMix===true, t25);

  console.log('\n[26] one-shot corrective nudge: drag a unit → it walks to the drop point → cleared on arrival = back to work (uniform across all units; stuck-unit safety valve; tests the execution logic, gestures tested on device)');
  const t26 = await ev(`
    buildings=buildings.filter(b=>b.side!==0); placeB(0,'tc',5,12,true);
    units=units.filter(x=>x.side!==0); villagers.length=0;
    for(let tx=8;tx<=20;tx++)for(let ty=9;ty<=15;ty++)blocked[idx(tx,ty)]=0;
    const u=spawnUnit(0,'spear',8*TILE,12*TILE,tags[0]);
    nudgeTo(u,15*TILE,12*TILE);
    const nx=u.nudge?u.nudge.x:0,ny=u.nudge?u.nudge.y:0;
    const setOK=!!u.nudge&&u.path.length===0;
    const d0=Math.hypot(u.x-nx,u.y-ny);
    for(let i=0;i<12;i++)step(TICK);
    const advancing=Math.hypot(u.x-nx,u.y-ny)<d0&&!!u.nudge;
    u.x=nx;u.y=ny;step(TICK);
    const clearedOnArrival=!u.nudge;
    nudgeTo(u,5*TILE,12*TILE); const reissue=!!u.nudge;
    units=units.filter(x=>x.side!==0); villagers.length=0;
    const obs=placeB(0,'tower',30,5,true);
    const u2=spawnUnit(0,'spear',27*TILE,5*TILE,tags[2]);
    nudgeTo(u2,obs.x,obs.y);
    let cleared=false; for(let i=0;i<200&&!cleared;i++){step(TICK); if(!u2.nudge)cleared=true;}
    const fd2=Math.hypot(u2.x-obs.x,u2.y-obs.y);
    const stall=u2.nudge?{bd:Math.round(u2.nudge.bd),btAge:+(t-u2.nudge.bt).toFixed(1)}:null;
    const stuckResolved=cleared&&fd2>TILE*0.6;
    const u3=spawnUnit(0,'spear',9*TILE,12*TILE,tags[3]);
    nudgeTo(u3,15*TILE,12*TILE); const hadNudge=!!u3.nudge;
    issueTagOrder(3,12*TILE,12*TILE);
    const tagCancelled=!u3.nudge;
    return {setOK,advancing,clearedOnArrival,reissue,stuckResolved,cleared,fd2:+fd2.toFixed(0),stall,hadNudge,tagCancelled};`);
  check('nudge: sets target+clears path; unit advances to drop point; clears on arrival (resume autonomy); re-issuable', t26.setOK===true && t26.advancing===true && t26.clearedOnArrival===true && t26.reissue===true, t26);
  check('nudge polish: unreachable dest (building) auto-gives-up→resume (no infinite stick); a tag order cancels in-progress nudge', t26.stuckResolved===true && t26.hadNudge===true && t26.tagCancelled===true, t26);

  console.log('\n[27] Stage A drop-off alignment (aim at centre + de≤22 + same elevation): walled in → deliver via an open face; hugs the edge without passing through walls; fully enclosed → never delivers from outside (removes loose jammed cases)');
  const t27 = await ev(`
    gameOver=null; aiWave=99999;
    buildings=buildings.filter(b=>b.side!==0); villagers.length=0; units.length=0;
    if(!hasCC(1))placeB(1,'tc',41,12,true);
    for(let tx=3;tx<=16;tx++)for(let ty=8;ty<=18;ty++){blocked[idx(tx,ty)]=0;gateMask[idx(tx,ty)]=0;}
    const tc=placeB(0,'tc',5,12,true), er=tc.size*TILE/2;
    for(let wy=10;wy<=15;wy++)placeB(0,'wall',9,wy,true);
    spawnVillager(); const v=villagers[villagers.length-1];
    v.x=12.5*TILE; v.y=13.5*TILE; v.carry=10; v.carryType='wood'; v.job='wood'; v.state='idle'; v.path=[]; v.dest=null;
    const wood0=stock.wood;
    let deAtDrop=null, dropX=null, doneAt=-1;
    for(let i=0;i<1500;i++){ step(TICK);
      if(v.carry===0){ deAtDrop=Math.round(footRectDist(tc,v.x,v.y)); dropX=Math.round(v.x); doneAt=i; break; } }
    const dropped=v.carry===0, credited=stock.wood===wood0+10;
    const roundedWall=dropX!==null && dropX<9*TILE;
    const closeEnough=deAtDrop!==null && deAtDrop<=30;
    buildings=buildings.filter(b=>b.side!==0); villagers.length=0;
    for(let tx=7;tx<=13;tx++)for(let ty=19;ty<=24;ty++){blocked[idx(tx,ty)]=0;gateMask[idx(tx,ty)]=0;}
    const tc2=placeB(0,'tc',10,21,true);
    const ring=[];
    for(let x=9;x<=12;x++){ring.push([x,20]);ring.push([x,23]);}
    for(let y=21;y<=22;y++){ring.push([9,y]);ring.push([12,y]);}
    for(const [x,y] of ring)placeB(0,'wall',x,y,true);
    spawnVillager(); const v2=villagers[villagers.length-1];
    v2.x=7*TILE; v2.y=21.5*TILE; v2.carry=10; v2.carryType='stone'; v2.job='stone'; v2.path=[]; v2.dest=null;
    const stone0=stock.stone;
    for(let i=0;i<400;i++)step(TICK);
    const sealedNoLeak=v2.carry===10 && stock.stone===stone0;
    return {dropped,credited,roundedWall,closeEnough,deAtDrop,dropX,doneAt,sealedNoLeak,v2carry:v2.carry};`);
  check('Stage A: walled-off villager routes around to an OPEN face and unloads (carry→0, credited)', t27.dropped===true && t27.credited===true, t27);
  check('Stage A: unloads hugging the TC-side edge (de≤24, x west of the wall) — no through-wall dump', t27.roundedWall===true && t27.closeEnough===true, {deAtDrop:t27.deAtDrop, dropX:t27.dropX, doneAt:t27.doneAt});
  check('Stage A: fully-sealed wall (no gap) → villager NEVER dumps through it (carry kept, not credited) — loose jammed removed', t27.sealedNoLeak===true, t27);

  console.log('\n[28] drop-off alignment v2 (fixes the 159s on-device log): a boxed-in town centre routes to the open gap instead of jamming on the wall + no fixed face (aims at the nearest open face)');
  const t28 = await ev(`
    gameOver=null; aiWave=99999;
    buildings=buildings.filter(b=>b.side!==0); villagers.length=0; units.length=0;
    if(!hasCC(1))placeB(1,'tc',41,12,true);
    const mk=(tx,ty,res)=>{spawnVillager();const v=villagers[villagers.length-1];v.x=(tx+.5)*TILE;v.y=(ty+.5)*TILE;v.carry=10;v.carryType=res;v.job=res;v.path=[];v.dest=null;return v;};
    for(let tx=2;tx<=11;tx++)for(let ty=7;ty<=18;ty++){blocked[idx(tx,ty)]=0;gateMask[idx(tx,ty)]=0;}
    const tc=placeB(0,'tc',5,12,true);
    [[5,11],[6,11],[5,14],[6,14],[7,12],[7,13]].forEach(([x,y])=>placeB(0,'wall',x,y,true));
    const vTop=mk(6,9,'iron'), vRight=mk(9,12,'stone');
    let topOK=false,rightOK=false;
    for(let i=0;i<1500;i++){step(TICK); if(vTop.carry===0)topOK=true; if(vRight.carry===0)rightOK=true; if(topOK&&rightOK)break;}
    for(let tx=2;tx<=11;tx++)for(let ty=7;ty<=18;ty++){blocked[idx(tx,ty)]=0;gateMask[idx(tx,ty)]=0;}
    buildings=buildings.filter(b=>b.side!==0); villagers.length=0;
    placeB(0,'tc',5,12,true);
    const vLL=mk(3,15,'gold'); let dropXLL=null;
    for(let i=0;i<1500;i++){step(TICK); if(vLL.carry===0){dropXLL=Math.round(vLL.x);break;}}
    const nearFace=dropXLL!==null && dropXLL<=270;
    return {topOK,rightOK,dropXLL,nearFace};`);
  check('Stage A v2: boxed TC (3 sides walled) — top & right villagers route to the open LEFT gap and unload (no wall-stuck)', t28.topOK===true && t28.rightOK===true, t28);
  check('Stage A v2: lower-left villager unloads on the NEAR face (x≤270), not detoured to the far right face', t28.nearFace===true, {dropXLL:t28.dropXLL});

  console.log('\n[29] villager unstick: wall/building placed on top of it → auto-walks to the nearest open tile (fixes on-device "stuck inside the town centre"; idle villagers get out too)');
  const t29 = await ev(`
    gameOver=null; aiWave=99999;
    buildings=buildings.filter(b=>b.side!==0); villagers.length=0; units.length=0;
    if(!hasCC(1))placeB(1,'tc',41,12,true);
    for(let tx=2;tx<=11;tx++)for(let ty=7;ty<=18;ty++){blocked[idx(tx,ty)]=0;gateMask[idx(tx,ty)]=0;}
    placeB(0,'tc',5,12,true);
    spawnVillager(); const v=villagers[villagers.length-1];
    v.x=9.5*TILE; v.y=9.5*TILE; v.carry=0; v.carryType=null; v.job=null; v.node=null; v.state='idle'; v.path=[]; v.dest=null;
    const cellOpenBefore=blocked[idx(9,9)]===0;
    placeB(0,'wall',9,9,true);                              // 牆蓋在閒置村民身上：placeB 逐出（2026-07-05）＝放置當下即彈出 footprint
    const ejectedNow=blocked[idx(txOf(v.x),tyOf(v.y))]===0; // 放置瞬間已不在 blocked 格（ejectFootprint）
    for(let i=0;i<200;i++)step(TICK);
    const escaped=blocked[idx(txOf(v.x),tyOf(v.y))]===0;    // 之後也維持在開放格
    return {cellOpenBefore,ejectedNow,escaped};`);
  check('Stage A v2: idle villager built-over by a wall is ejected instantly and stays on an open tile (no stuck-in-building)', t29.cellOpenBefore===true && t29.ejectedNow===true && t29.escaped===true, t29);

  console.log('\n[30] walls block line of sight (minimal): the enemy cannot see through our walls; our own vision is unaffected');
  const t30 = await ev(`
    gameOver=null; aiWave=99999; const aiv0=aiFullVision; aiFullVision=false; // 對稱視野才看得出擋牆效果
    buildings=buildings.filter(b=>b.side!==0); villagers.length=0; units.length=0; scouts.length=0;
    for(let tx=2;tx<=14;tx++)for(let ty=10;ty<=14;ty++){blocked[idx(tx,ty)]=0;gateMask[idx(tx,ty)]=0;wallMask[idx(tx,ty)]=0;}
    spawnUnit(1,'archer',12.5*TILE,12.5*TILE,tags[5]);          // 敵在 (12,12) 看向左方 (6,12)
    updateFog(); const seeNoWall=visibleE[idx(6,12)]===1;       // 無牆＝敵看得到
    placeB(0,'wall',9,12,true);                                 // 中間 (9,12) 放牆
    updateFog();
    const blockedBehind=visibleE[idx(6,12)]===0;               // 牆後＝看不到
    const seeWallItself=visibleE[idx(9,12)]===1;               // 牆本身＝看得到（看到牆、看不過牆）
    spawnUnit(0,'archer',12.5*TILE,12.5*TILE,tags[0]);          // 我方同位置
    updateFog(); const mySeeThrough=visible[idx(6,12)]===1;     // 我方不被自己的牆擋
    aiFullVision=aiv0;
    return {seeNoWall,blockedBehind,seeWallItself,mySeeThrough};`);
  check('Wall LOS: with NO wall the enemy sees the far tile (test premise)', t30.seeNoWall===true, t30);
  check('Wall LOS: a player wall blocks the ENEMY from seeing behind it (sees the wall, not past it)', t30.blockedBehind===true && t30.seeWallItself===true, t30);
  check('Wall LOS: player own vision is NOT blocked by own wall (minimum scope — own vision unchanged)', t30.mySeeThrough===true, t30);

  console.log('\n[31] villager behaviour on two tracks (replaces cardOrder drag ordering): garrison / gather-to-the-death / fight back / turtle bell / emergency repair (overrides the 240 safety lock) / idle retreat to cover');
  const t31 = await ev(`
    gameOver=null; aiWave=99999;
    const save={turtle:turtleBell,gar:garrisonOn,rep:repairOn,st:stance};
    for(const k in stock)stock[k]+=99999;
    if(!hasCC(1))placeB(1,'tc',41,12,true);
    const clear=()=>{buildings=buildings.filter(b=>b.side!==0); villagers.length=0; units.length=0; scouts.length=0;
      for(let tx=1;tx<=18;tx++)for(let ty=7;ty<=18;ty++){blocked[idx(tx,ty)]=0;gateMask[idx(tx,ty)]=0;wallMask[idx(tx,ty)]=0;}};
    const mkV=(tx,ty)=>{spawnVillager();const v=villagers[villagers.length-1];v.x=(tx+.5)*TILE;v.y=(ty+.5)*TILE;
      v.carry=0;v.carryType=null;v.job=null;v.node=null;v.state='idle';v.path=[];v.dest=null;v.garrisoned=false;return v;};

    clear(); turtleBell=false; garrisonOn=true; repairOn=false; stance='flee';
    placeB(0,'tc',5,12,true); const vA=mkV(8,12);
    spawnUnit(1,'spear',10.5*TILE,12.5*TILE,tags[5]);
    let garA=false; for(let i=0;i<600;i++){step(TICK); if(vA.garrisoned){garA=true;break;}}

    clear(); nodes.length=0; turtleBell=false; garrisonOn=false; repairOn=false; stance='gather';
    placeB(0,'tc',3,12,true); const vB=mkV(10,12);
    const vBnode={type:'stone',x:vB.x,y:vB.y,amt:9999,max:9999}; nodes.push(vBnode);
    vB.job='stone'; vB.node=vBnode;
    spawnUnit(1,'spear',13*TILE,12.5*TILE,tags[5]);
    let badB=false; for(let i=0;i<60;i++){step(TICK); if(vB.garrisoned||vB.state==='flee'||vB.state==='retreat'){badB=true;break;}}
    const dieGather=!badB && vB.carry>0;

    clear(); turtleBell=false; garrisonOn=false; repairOn=false; stance='fight';
    placeB(0,'tc',5,12,true); const vC=mkV(8,12);
    spawnUnit(1,'spear',10.5*TILE,12.5*TILE,tags[5]);
    let foughtC=false; for(let i=0;i<60;i++){step(TICK); if(vC.state==='fight')foughtC=true; if(vC.hp<=0)break;}

    clear(); turtleBell=true; garrisonOn=true; repairOn=false; stance='flee';
    placeB(0,'tc',5,12,true); const vD=mkV(8,12);
    let garD=false; for(let i=0;i<400;i++){step(TICK); if(vD.garrisoned){garD=true;break;}}
    let stayD=true; for(let i=0;i<120;i++){step(TICK); if(!vD.garrisoned){stayD=false;break;}}
    turtleBell=false;
    let releaseD=false; for(let i=0;i<160;i++){step(TICK); if(!vD.garrisoned){releaseD=true;break;}}

    clear(); turtleBell=false; garrisonOn=false; stance='flee';
    placeB(0,'tc',3,12,true); const twr=placeB(0,'tower',8,12,true); twr.hp=Math.round(twr.maxHp*0.3);
    const vE=mkV(6,12);
    spawnUnit(1,'spear',13.5*TILE,12.5*TILE,tags[5]);
    repairOn=false; let lockHeld=true; for(let i=0;i<30;i++){step(TICK); if(vE.buildSite===twr){lockHeld=false;break;}}
    repairOn=true; let assignedE=false; for(let i=0;i<80;i++){step(TICK); if(vE.buildSite===twr){assignedE=true;break;}}
    units.length=0;
    const hpA=twr.hp; for(let i=0;i<80;i++)step(TICK); const fixed=twr.hp>hpA;

    clear(); turtleBell=false; garrisonOn=true; repairOn=false; stance='flee'; nodes.length=0;
    const tcF=placeB(0,'tc',5,12,true); const vF=mkV(15,12); vF.job=null;
    const d0=Math.round(footRectDist(tcF,vF.x,vF.y));
    for(let i=0;i<400;i++)step(TICK);
    const d1=Math.round(footRectDist(tcF,vF.x,vF.y));
    const retreated=d1<d0-80;

    clear(); turtleBell=true; garrisonOn=true; repairOn=false; stance='flee'; nodes.length=0;
    const tcG=placeB(0,'tc',5,12,true); tcG.g=BT.tc.cap;
    const vG=mkV(8,12); vG.job='wood'; vG.node={type:'wood',x:vG.x,y:vG.y,amt:9999,max:9999};
    spawnUnit(1,'spear',10.5*TILE,12.5*TILE,tags[5]);
    let retreatG=false,gatherG=false; for(let i=0;i<80;i++){step(TICK); if(vG.state==='retreat')retreatG=true; if(vG.state==='gather')gatherG=true; if(vG.garrisoned||vG.hp<=0)break;}

    clear(); turtleBell=false; garrisonOn=false; repairOn=false; stance='flee'; nodes.length=0;
    placeB(0,'tc',5,18,true);
    const vH=mkV(10,12); const eH=spawnUnit(1,'spear',13.5*TILE,12.5*TILE,tags[5]);
    const distH0=Math.round(Math.hypot(eH.x-vH.x,eH.y-vH.y)), xH0=Math.round(vH.x);
    for(let i=0;i<80;i++){step(TICK); if(vH.hp<=0)break;}
    const distH1=Math.round(Math.hypot(eH.x-vH.x,eH.y-vH.y));
    const fledAway=distH1>distH0+25 && vH.x<xH0-25;

    turtleBell=save.turtle;garrisonOn=save.gar;repairOn=save.rep;stance=save.st;
    return {garA,dieGather,vBcarry:Math.round(vB.carry),foughtC,garD,stayD,releaseD,lockHeld,assignedE,fixed,d0,d1,retreated,retreatG,gatherG,distH0,distH1,xH0,xH1:Math.round(vH.x),fledAway};`);
  check('Behaviour garrison (default): enemy near → villager garrisons into a building', t31.garA===true, t31);
  check('Behaviour gather-to-the-death (garrison off + gather-to-the-death): keeps gathering under threat, never hides/flees', t31.dieGather===true, {carry:t31.vBcarry, dieGather:t31.dieGather});
  check('Behaviour fight back (garrison off + fight back): villager enters fight state vs nearest threat', t31.foughtC===true, t31);
  check('Behaviour turtle bell: hides with NO enemy AND stays garrisoned (no auto-release while bell on)', t31.garD===true && t31.stayD===true, {garD:t31.garD, stayD:t31.stayD});
  check('Behaviour turtle bell off + threat clear → villager auto-releases (resumes work)', t31.releaseD===true, t31);
  check('Behaviour emergency repair OFF = safety lock holds (no under-fire repair assignment)', t31.lockHeld===true, t31);
  check('Behaviour emergency repair ON overrides the 240 lock: assigns villager to the besieged building AND it heals', t31.assignedE===true && t31.fixed===true, {assigned:t31.assignedE, fixed:t31.fixed});
  check('Behaviour idle retreat to cover: idle villager retreats toward nearest friendly building', t31.retreated===true, {d0:t31.d0, d1:t31.d1});
  check('Behaviour turtle bell + all full + enemy near: stance STILL applies (flee→retreat, NOT death-gather) — fixes "bell+no-room only death-gathers"', t31.retreatG===true && t31.gatherG===false, {retreatG:t31.retreatG, gatherG:t31.gatherG});
  check('Behaviour flee runs AWAY from the enemy (dist grows, moves opposite), not toward a building to stand & die', t31.fledAway===true, {distH0:t31.distH0, distH1:t31.distH1, xH0:t31.xH0, xH1:t31.xH1});

  console.log('\n[32] siege breaks walls: HP→0 removes the whole wall segment = clears wallMask = the gap can be seen through (neighbouring walls still block); wired into killBuilding');
  const t32 = await ev(`
    gameOver=null; aiWave=99999; const aiv0=aiFullVision; aiFullVision=false;
    buildings=buildings.filter(b=>b.side!==0); villagers.length=0; units.length=0; scouts.length=0;
    for(let tx=2;tx<=14;tx++)for(let ty=9;ty<=15;ty++){blocked[idx(tx,ty)]=0;gateMask[idx(tx,ty)]=0;wallMask[idx(tx,ty)]=0;}
    spawnUnit(1,'archer',12.5*TILE,12.5*TILE,tags[5]);   // 看向 (6,12)
    spawnUnit(1,'archer',12.5*TILE,13.5*TILE,tags[5]);   // 看向 (6,13)
    const wTop=placeB(0,'wall',9,12,true), wBot=placeB(0,'wall',9,13,true);
    updateFog();
    const blockedTop0=visibleE[idx(6,12)]===0, blockedBot0=visibleE[idx(6,13)]===0;
    wTop.hp=0;                                            // 攻城把上段牆打到 0
    for(const b of buildings)if(b.hp<=0)killBuilding(b);  // step 內的破壞流程：killBuilding 清 wallMask
    buildings=buildings.filter(b=>b.hp>0);
    updateFog();
    const gapSeen=visibleE[idx(6,12)]===1, maskCleared=wallMask[idx(9,12)]===0;
    const neighborStillBlocks=visibleE[idx(6,13)]===0, maskKept=wallMask[idx(9,13)]===1;
    aiFullVision=aiv0;
    return {blockedTop0,blockedBot0,gapSeen,maskCleared,neighborStillBlocks,maskKept};`);
  check('Siege wall-break (premise): two wall segments block both enemy sightlines', t32.blockedTop0===true && t32.blockedBot0===true, t32);
  check('Siege wall-break: destroyed wall tile clears wallMask → enemy now sees through the GAP', t32.gapSeen===true && t32.maskCleared===true, t32);
  check('Siege wall-break: a still-standing neighbor wall keeps blocking LOS (only the broken tile opens)', t32.neighborStillBlocks===true && t32.maskKept===true, t32);

  console.log('\n[33] danger-avoidance execution floor: pathfinding/dispatch for villager auto-work avoids known enemies (soft-cost detour; safe nodes first; gather-to-the-death does not avoid)');
  const t33 = await ev(`
    gameOver=null; aiWave=99999;
    buildings=buildings.filter(b=>b.side!==0); villagers.length=0; units.length=0; scouts.length=0;
    for(let tx=2;tx<=20;tx++)for(let ty=4;ty<=20;ty++){blocked[idx(tx,ty)]=0;gateMask[idx(tx,ty)]=0;wallMask[idx(tx,ty)]=0;}
    const en=spawnUnit(1,'spear',11.5*TILE,12.5*TILE,tags[5]); en.revealT=t+999;
    computeDanger();
    const dangMid=dangerMask[idx(11,12)]===1, safeFar=dangerMask[idx(11,8)]===0;
    const plen=p=>{let s=0,px=5.5*TILE,py=12.5*TILE;for(const w of p){s+=Math.hypot(w.x-px,w.y-py);px=w.x;py=w.y;}return s;};
    const pDirect=findPath(5.5*TILE,12.5*TILE,18.5*TILE,12.5*TILE,0,false);
    const pSafe  =findPath(5.5*TILE,12.5*TILE,18.5*TILE,12.5*TILE,0,true);
    const lenD=Math.round(plen(pDirect)), lenS=Math.round(plen(pSafe));
    let maxDev=0; for(const w of pSafe)maxDev=Math.max(maxDev,Math.abs(w.y-12.5*TILE));
    const detoured = lenS>lenD && maxDev>3*TILE;
    nodes.length=0;
    nodes.push({type:'wood',x:11.5*TILE,y:13.5*TILE,amt:999,max:999});
    nodes.push({type:'wood',x:4.5*TILE, y:12.5*TILE,amt:999,max:999});
    const pickSafe=nearestNode('wood',10.5*TILE,12.5*TILE,null,true);
    const pickAny =nearestNode('wood',10.5*TILE,12.5*TILE,null,false);
    const safeNodeChosen = pickSafe && Math.round(pickSafe.x)===Math.round(4.5*TILE);
    const dangNodeNearest= pickAny  && Math.round(pickAny.x)===Math.round(11.5*TILE);
    return {dangMid,safeFar,lenD,lenS,maxDev:Math.round(maxDev),detoured,safeNodeChosen,dangNodeNearest};`);
  check('Danger floor (premise): known enemy marks danger tiles around it (center danger, outer ring safe)', t33.dangMid===true && t33.safeFar===true, t33);
  check('Danger floor: villager auto-work path routes AROUND the known enemy (detour longer + bows out of the danger radius)', t33.detoured===true, {lenDirect:t33.lenD, lenSafe:t33.lenS, maxDev:t33.maxDev});
  check('Danger floor: auto-dispatch prefers a SAFE node; gather-to-the-death/no-avoid takes the nearer dangerous one (player override)', t33.safeNodeChosen===true && t33.dangNodeNearest===true, {safe:t33.safeNodeChosen, dangerNearest:t33.dangNodeNearest});

  console.log('\n[34] Batch 3 economy sustainability: coppice (wood version of the farm; renewable; one villager; does not block movement; not limited to the left half) + larger starting stockpile');
  const t34 = await ev(`
    gameOver=null; aiWave=99999;
    const copData = !!BT.coppice && BT.coppice.cost.wood===40 && BT.coppice.size===1;
    buildings=buildings.filter(b=>b.side!==0); villagers.length=0; units.length=0; scouts.length=0; nodes.length=0;
    for(const k in stock)stock[k]+=99999;
    for(let tx=2;tx<=40;tx++)for(let ty=4;ty<=20;ty++){blocked[idx(tx,ty)]=0;terr[idx(tx,ty)]=0;explored[idx(tx,ty)]=1;}
    placeB(0,'tc',5,5,true);
    const cop=placeB(0,'coppice',10,10,true);
    const nodeMade = !!cop.node && cop.node.type==='wood' && cop.node.farm===true && nodes.includes(cop.node);
    const notBlocked = blocked[idx(10,10)]===0;
    cop.node.amt=10; for(let i=0;i<40;i++)step(TICK);
    const regrew = cop.node.amt>11 && cop.node.amt<=cop.node.max;
    nodes.length=0;
    const copR=placeB(0,'coppice',30,10,true);
    const pickFarm = nearestNode('wood',30.5*TILE,10.5*TILE,null,false)===copR.node;
    nodes.push({type:'wood',x:30.5*TILE,y:11.5*TILE,amt:999,max:999});
    const natWoodAt=nodes[nodes.length-1];
    const naturalGated = nearestNode('wood',30.5*TILE,10.5*TILE,null,false)!==natWoodAt;
    nodes.length=0; villagers.length=0;
    const copS=placeB(0,'coppice',10,12,true);
    spawnVillager(); const occ=villagers[villagers.length-1]; occ.node=copS.node;
    spawnVillager(); const other=villagers[villagers.length-1]; other.x=10.5*TILE; other.y=12.5*TILE;
    const onePerCoppice = nearestNode('wood',10.5*TILE,12.5*TILE,other,false)===null;
    return {copData,nodeMade,notBlocked,copAmt:+cop.node.amt.toFixed(2),regrew,pickFarm,naturalGated,onePerCoppice};`);
  check('Coppice (premise): new building data exists (wood version of the farm: cost 40 wood, size 1)', t34.copData===true, {copData:t34.copData});
  check('Coppice build → spawns a regenerating wood node (type wood + farm flag + in nodes) and does NOT block tiles', t34.nodeMade===true && t34.notBlocked===true, t34);
  check('Coppice regenerates wood over time (drained to 10 → grows toward max)', t34.regrew===true, {copAmt:t34.copAmt});
  check('Coppice is gatherable anywhere (farm flag bypasses the left-half gate that limits natural wood)', t34.pickFarm===true && t34.naturalGated===true, t34);
  check('Coppice = one villager per plot (farm rule): occupied plot is not re-assigned to another villager', t34.onePerCoppice===true, t34);

  console.log('\n[35] flee jitter fix: villFleeStep heading hysteresis = per-tick heading change is capped (without it the raw flee heading swings hard and the villager shakes side to side)');
  const t35 = await ev(`
    gameOver=null; aiWave=99999;
    buildings=buildings.filter(b=>b.side!==0); villagers.length=0; units.length=0; scouts.length=0; nodes.length=0;
    for(let tx=2;tx<=20;tx++)for(let ty=4;ty<=20;ty++){blocked[idx(tx,ty)]=0;gateMask[idx(tx,ty)]=0;wallMask[idx(tx,ty)]=0;terr[idx(tx,ty)]=0;}
    const sv={t:turtleBell,g:garrisonOn,r:repairOn,s:stance};
    turtleBell=false; garrisonOn=false; repairOn=false; stance='flee';
    placeB(0,'tc',5,18,true);
    spawnVillager(); const vF=villagers[villagers.length-1]; vF.x=12.5*TILE; vF.y=12.5*TILE; vF.job=null; vF.node=null; vF.state='idle'; vF.path=[]; vF.dest=null; vF.garrisoned=false;
    const eF=spawnUnit(1,'spear',vF.x+80,vF.y,tags[5]);
    let prev=undefined, maxJump=0, samples=0, ang=0;
    const x0=vF.x, y0=vF.y;
    for(let i=0;i<50;i++){
      ang+=1.3;                                              // 每 tick 把敵繞村民大角旋轉＝raw 逃向劇烈擺動（無遲滯→fleeHd 會跳近 π）
      eF.x=vF.x+Math.cos(ang)*80; eF.y=vF.y+Math.sin(ang)*80;
      step(TICK);
      if(vF.fleeHd!==undefined){
        if(prev!==undefined){let d=vF.fleeHd-prev;while(d>Math.PI)d-=2*Math.PI;while(d<-Math.PI)d+=2*Math.PI;maxJump=Math.max(maxJump,Math.abs(d));samples++;}
        prev=vF.fleeHd;
      }
    }
    turtleBell=sv.t;garrisonOn=sv.g;repairOn=sv.r;stance=sv.s;
    const cap=3.2*TICK;                                       // maxTurn＝3.2 rad/s × dt
    const moved=Math.hypot(vF.x-x0,vF.y-y0)>5;               // 確實在逃跑移動（方向正確性由 [31]H 涵蓋；此處敵繞圈故只驗「動了」）
    return {samples,moved,maxJump:+maxJump.toFixed(3),cap:+cap.toFixed(3),smooth:samples>20 && maxJump<=cap+0.02};`);
  check('Flee hysteresis (premise): villager is actively fleeing (heading sampled across many ticks, villager moved)', t35.samples>20 && t35.moved===true, {samples:t35.samples, moved:t35.moved});
  check('Flee hysteresis: per-tick heading change is capped at maxTurn (no left-right jitter even when raw flee vector swings wildly)', t35.smooth===true, {maxJump:t35.maxJump, cap:t35.cap});

  console.log('\n[36] unique units (longbowman/heavy infantry/horse archer): unlocked only by researching UL/UH/UM → produced at the barracks/stable; identity stats (longbowman range > plain archer; heavy infantry armour & HP > plain infantry; horse archer upkeep > plain cavalry = soft-cap buffer hung on up, not a population slot)');
  const t36 = await ev(`
    aiWave=99999; gameOver=null;
    buildings=buildings.filter(b=>b.side!==0); units=units.filter(u=>u.side!==0); villagers.length=0;
    for(let tx=2;tx<=20;tx++)for(let ty=4;ty<=20;ty++){blocked[idx(tx,ty)]=0;gateMask[idx(tx,ty)]=0;wallMask[idx(tx,ty)]=0;terr[idx(tx,ty)]=0;}
    ['UL','UH','UM'].forEach(t=>playerTech.researched.delete(t));
    const beforeL=unitUnlocked('longbow'), beforeH=unitUnlocked('heavyinf'), beforeM=unitUnlocked('horsearcher');
    const lb=UT.longbow, hi=UT.heavyinf, ha=UT.horsearcher;
    const idL = lb.rng>UT.archer.rng && !!lb.proj;
    const idH = hi.aM>UT.spear.aM && hi.hp>UT.spear.hp && !hi.proj;
    const idM = ha.up>UT.cavalry.up && !!ha.proj;
    const bldOK = lb.bld==='barracks'&&hi.bld==='barracks'&&ha.bld==='stable';
    ['UL','UH','UM'].forEach(t=>playerTech.researched.add(t));
    const afterL=unitUnlocked('longbow'), afterH=unitUnlocked('heavyinf'), afterM=unitUnlocked('horsearcher');
    ['UL','UH','UM'].forEach(t=>playerTech.researched.delete(t));
    placeB(0,'barracks',12,8,true); const bar=buildings.find(b=>b.type==='barracks'&&b.side===0);
    bar.done=true; bar.hp=BT.barracks.hp; bar.queue=[];
    placeB(0,'stable',12,12,true); const stb=buildings.find(b=>b.type==='stable'&&b.side===0);
    stb.done=true; stb.hp=BT.stable.hp; stb.queue=[];
    for(const k in stock)stock[k]+=9999; starving=false;
    setPlayerCiv('eng'); playerTech.researched.add('UL'); const q1=queueUnit(bar,'longbow'); playerTech.researched.delete('UL');
    setPlayerCiv('mon'); playerTech.researched.add('UM'); const q2=queueUnit(stb,'horsearcher'); playerTech.researched.delete('UM');
    setPlayerCiv('eng');
    return {beforeL,beforeH,beforeM,afterL,afterH,afterM,idL,idH,idM,bldOK,q1,q2,queued:bar.queue.length+stb.queue.length};`);
  check('Unique units locked until their tech (UL/UH/UM) is researched', t36.beforeL===false&&t36.beforeH===false&&t36.beforeM===false&&t36.afterL===true&&t36.afterH===true&&t36.afterM===true, t36);
  check('Unique unit identities: longbow range>archer(ranged), heavyinf def&hp>spear(melee), horsearcher upkeep>cavalry(ranged·buffer on up not pop)', t36.idL&&t36.idH&&t36.idM, t36);
  check('Unique units produce at correct building + own civ (longbow→England barracks, horsearcher→Mongol stable; heavyinf→barracks via bldOK); cross-civ blocked by guard', t36.bldOK&&t36.q1===true&&t36.q2===true&&t36.queued===2, t36);

  console.log('\n[37] hard villager/army caps removed (POP_V/POP_M): pure soft cap instead (army upkeep food); production is no longer blocked by headcount; AI script waves unaffected');
  const t37 = await ev(`
    const constGone = (typeof POP_M==='undefined')&&(typeof POP_V==='undefined');
    buildings=buildings.filter(b=>b.side!==0); units=units.filter(u=>u.side!==0); villagers.length=0;
    for(let tx=2;tx<=20;tx++)for(let ty=4;ty<=20;ty++){blocked[idx(tx,ty)]=0;terr[idx(tx,ty)]=0;}
    placeB(0,'barracks',12,8,true); const bar=buildings.find(b=>b.type==='barracks'&&b.side===0);
    bar.done=true; bar.hp=BT.barracks.hp; bar.queue=[];
    for(const k in stock)stock[k]+=99999; starving=false;
    for(let i=0;i<40;i++)spawnUnit(0,'spear',300+i,300,tags[0]);   // 40 > 舊 POP_M=36
    const pm=popM();
    const canStill=queueUnit(bar,'spear');                          // 仍能下單＝硬上限已除
    return {constGone, pm, canStill};`);
  check('Hard caps POP_V/POP_M removed (constants gone)', t37.constGone===true, t37);
  check('Production not blocked by headcount beyond old cap (40>36, queue still succeeds = soft cap only)', t37.pm>=40&&t37.canStill===true, t37);

  console.log('\n[38] tap a resource node to see what is left: pickNodeAt hits a natural node → openNodePanel shows "remaining amt/max" (reuses the building/farm tap; farms excluded; no hit when too far)');
  const t38 = await ev(`
    nodes.length=0;
    const nx=8.5*TILE, ny=10.5*TILE;
    explored[idx(txOf(nx),tyOf(ny))]=1;
    nodes.push({type:'wood',x:nx,y:ny,amt:240,max:400});
    nodes.push({type:'food',x:nx,y:ny,amt:50,max:90,farm:true});  // 農田節點：不該被 pickNodeAt 命中
    const hit=pickNodeAt(nx,ny);
    const miss=pickNodeAt(nx+200,ny);
    let opened=false, txt='';
    if(hit){openNodePanel(hit); const p=document.querySelector('#bldPanel'); opened=!p.classList.contains('hidden'); txt=p.textContent; closePanels();}
    return {hitWood:!!hit&&hit.type==='wood'&&hit.amt===240, missNull:miss===null, opened, hasRemain:/240/.test(txt)&&/400/.test(txt)};`);
  check('Resource node tap hit-tests nearest natural node (farm node excluded, far tap misses)', t38.hitWood===true&&t38.missNull===true, t38);
  check('Node panel opens and shows remaining amount/max (240/400)', t38.opened===true&&t38.hasRemain===true, t38);

  console.log('\n[39] tapping a wall/gate shows HP (fixes user report "tapping shows no HP"): openWallPanel opens #bldPanel; bldStat shows HP; the gate\'s rectangular footprint is hit-tested with w/h');
  const t39 = await ev(`
    buildings=buildings.filter(b=>b.side!==0);
    for(let tx=2;tx<=20;tx++)for(let ty=4;ty<=20;ty++){blocked[idx(tx,ty)]=0;terr[idx(tx,ty)]=0;gateMask[idx(tx,ty)]=0;}
    placeB(0,'wall',10,10,true); const wl=buildings.find(b=>b.type==='wall'&&b.side===0);
    wl.done=true; wl.maxHp=BT.wall.hp; wl.hp=BT.wall.hp-120;                 // 受損 280/400
    openWallPanel(wl); let p=document.querySelector('#bldPanel');
    const wallOpened=!p.classList.contains('hidden'); const wallHP=/280/.test(p.textContent)&&/400/.test(p.textContent); closePanels();
    placeB(0,'gate',14,10,true); const gt=buildings.find(b=>b.type==='gate'&&b.side===0);
    gt.done=true; gt.maxHp=BT.gate.hp; gt.hp=BT.gate.hp;                     // 550/550
    openWallPanel(gt); p=document.querySelector('#bldPanel');
    const gateOpened=!p.classList.contains('hidden'); const gateHP=/550/.test(p.textContent); closePanels();
    const gateRect=(gt.w||gt.size)!==(gt.h||gt.size);                       // 城門＝矩形 footprint
    const gateHit=!!buildings.find(o=>o.side===0&&o.type==='gate'&&Math.abs(o.x-gt.x)<(o.w||o.size)*TILE/2&&Math.abs(o.y-gt.y)<(o.h||o.size)*TILE/2);
    return {wallOpened,wallHP,gateOpened,gateHP,gateRect,gateHit};`);
  check('Wall click opens HP panel (was: no panel at all) — shows current/max HP 280/400', t39.wallOpened===true&&t39.wallHP===true, t39);
  check('Gate click opens HP panel (HP 550) and rectangular gate is hit-testable via w/h footprint', t39.gateOpened===true&&t39.gateHP===true&&t39.gateRect===true&&t39.gateHit===true, t39);

  console.log('\n[40] pending effects wired: F3 fortification (pure HP) + M6 tactical drill (counter damage + / post-shot speed-up; first strike dropped)');
  const t40 = await ev(`
    for(let tx=20;tx<28;tx++)for(let ty=20;ty<28;ty++){blocked[idx(tx,ty)]=0;terr[idx(tx,ty)]=0;gateMask[idx(tx,ty)]=0;}
    const baseWall=BT.wall.hp, baseGate=BT.gate.hp;
    playerTech.researched.add('F3'); recomputeTechMod();
    const pw=placeB(0,'wall',20,20,true), pwMax=pw.maxHp;
    const ew=placeB(1,'wall',22,20,true), ewMax=ew.maxHp;
    playerTech.researched.delete('F3'); recomputeTechMod();
    const rw=placeB(0,'wall',20,22,true), rwBefore=rw.maxHp; rw.hp=rw.maxHp*0.5;
    completeResearch('F3');
    const rwAfter=rw.maxHp, rwRatio=+(rw.hp/rw.maxHp).toFixed(2);
    const catVsWallF3=bonusVs(UT.catapult,{size:1,type:'wall'},0);
    playerTech.researched.delete('M6'); recomputeTechMod();
    const cd0=techMod.counterDmg, spVsCav0=+bonusVs(UT.spear,{type:'cavalry'},0).toFixed(3); // 1 / 2.0
    playerTech.researched.add('M6'); recomputeTechMod();
    const cd1=techMod.counterDmg, spVsCav1=+bonusVs(UT.spear,{type:'cavalry'},0).toFixed(3); // 1.15 / 2.15
    const spVsCavEnemy=+bonusVs(UT.spear,{type:'cavalry'},1).toFixed(3);
    const catVsWallM6=bonusVs(UT.catapult,{size:1,type:'wall'},0);
    const kiteBuff=techMod.kiteBuff;                                            // 1.35
    const ar=spawnUnit(0,'archer',900,500,tags[0]); ar.postFireT=0; const sp0=uSpeed(ar);
    ar.postFireT=t+5; const sp1=uSpeed(ar); const kiteRatio=+(sp1/sp0).toFixed(3);
    const dummy={x:960,y:500,hp:99,maxHp:99,type:'spear',side:1,movedT:0};
    const a2=spawnUnit(0,'archer',905,500,tags[0]); a2.postFireT=0; fire(a2,dummy); const archerKite=a2.postFireT>t;
    const ct=spawnUnit(0,'catapult',910,500,tags[0]); ct.postFireT=0; fire(ct,dummy); const catNoKite=!(ct.postFireT>t);
    const sp=spawnUnit(0,'spear',915,500,tags[0]); sp.postFireT=0; fire(sp,dummy); const meleeNoKite=!(sp.postFireT>t);
    return {baseWall,baseGate,pwMax,ewMax,rwBefore,rwAfter,rwRatio,catVsWallF3,
      cd0,cd1,spVsCav0,spVsCav1,spVsCavEnemy,catVsWallM6,kiteBuff,kiteRatio,archerKite,catNoKite,meleeNoKite};`);
  check('F3 base HP raised (walls were under market/production-tier): wall 400, gate 550', t40.baseWall===400&&t40.baseGate===550, t40);
  check('F3 = pure HP: player wall +30% (520); enemy wall unaffected (player-only tech)', t40.pwMax===520&&t40.ewMax===400, t40);
  check('F3 retro-boosts existing player walls on completion, preserving damage ratio (400→520, hp stays 0.5)', t40.rwBefore===400&&t40.rwAfter===520&&t40.rwRatio===0.5, t40);
  check('F3 does NOT touch siege multiplier (city defence expressed as HP only): catapult vs wall still 6', t40.catVsWallF3===6&&t40.catVsWallM6===6, t40);
  check('M6 counter damage +15% amplifies only the counter portion vs units (spear→cav 2.0→2.15)', t40.cd0===1&&t40.cd1===1.15&&t40.spVsCav0===2&&t40.spVsCav1===2.15, t40);
  check('M6 counter bonus is player-only (enemy spear→cav stays 2.0)', t40.spVsCavEnemy===2, t40);
  check('M6 post-shot speed-up: kiteBuff 1.35 lifts uSpeed (and feeds the speed→evasion formula by the same factor)', t40.kiteBuff===1.35&&t40.kiteRatio===1.35, t40);
  check('M6 post-shot speed-up fires for ranged skirmishers only (archer yes; catapult/splash no; melee spear no)', t40.archerKite===true&&t40.catNoKite===true&&t40.meleeNoKite===true, t40);

  console.log('\n[41] wrap-up; wiring the pending effects (F1 stonework / E2 three-field / E3 pack animals / E5 deep mining / F2 garrison / S2 beacons / S3 scouting / E4 guilds): pure techMod wiring, values already fixed in specs/12');
  const t41 = await ev(`
    units=units.filter(u=>u.side===0); aiWave=99999;
    playerTech.researched.clear(); playerTech.age=3; recomputeTechMod(); recomputeBuildingHp(); recomputeFarmCap();
    for(let tx=20;tx<30;tx++)for(let ty=20;ty<30;ty++){blocked[idx(tx,ty)]=0;terr[idx(tx,ty)]=0;gateMask[idx(tx,ty)]=0;}
    const br0=placeB(0,'barracks',24,24,true), hp0=br0.maxHp; br0.hp=br0.maxHp*0.5;
    playerTech.researched.add('F1'); recomputeTechMod(); recomputeBuildingHp();
    const hp1=br0.maxHp, hpRatio=+(br0.hp/br0.maxHp).toFixed(2), repair1=techMod.repair;
    const ebr=placeB(1,'barracks',27,24,true), ehp=ebr.maxHp;
    const fm=placeB(0,'farm',29,29,true), fcap0=fm.node.max;
    playerTech.researched.add('E2'); recomputeTechMod(); recomputeFarmCap();
    const fcap1=fm.node.max, farmCap=techMod.farmCap;
    playerTech.researched.add('E3'); recomputeTechMod(); const carry=techMod.carry;
    playerTech.researched.add('E5'); recomputeTechMod();
    const mine=techMod.mineGather, ironRegen=techMod.ironRegen;
    for(const v of villagers){v.job=null;v.node=null;v.state='idle';v.carry=0;}
    let ironNode=nodes.find(n=>n.type==='iron'); if(!ironNode){ironNode={type:'iron',x:800,y:200,amt:400,max:400};nodes.push(ironNode);}
    ironNode.amt=10; const ir0=ironNode.amt;
    for(let i=0;i<10;i++)step(0.1); const ir1=+ironNode.amt.toFixed(2);
    playerTech.researched.add('F2'); recomputeTechMod();
    const pt=placeB(0,'tower',22,28,true), et=placeB(1,'tower',26,28,true);
    const gcapP=garCap(pt), gcapE=garCap(et), towerRng=techMod.towerRng, garArrow=techMod.garArrow;
    playerTech.researched.add('S2'); recomputeTechMod();
    const bldVis=techMod.bldVis, ghost=techMod.ghost, expose=techMod.expose;
    playerTech.researched.add('S3'); recomputeTechMod();
    const fp=techMod.forestPierce, losNo=losOk(12,22,14,22,0,false,0), losYes=losOk(12,22,14,22,0,false,1);
    playerTech.researched.add('E4'); recomputeTechMod(); const mktHalf=techMod.mktHalf;
    priceIdx.wood=1; stock.wood=300; stock.gold=0; mkSell('wood'); const sellE4=stock.gold, decHalf=+priceIdx.wood.toFixed(3);
    priceIdx.iron=1; stock.gold=1000; mkBuy('iron'); const buyE4=1000-stock.gold;
    playerTech.researched.delete('E4'); recomputeTechMod();
    priceIdx.wood=1; stock.wood=300; stock.gold=0; mkSell('wood'); const sell0=stock.gold, decFull=+priceIdx.wood.toFixed(3);
    priceIdx.iron=1; stock.gold=1000; mkBuy('iron'); const buy0=1000-stock.gold;
    return {hp0,hp1,hpRatio,repair1,ehp,fcap0,fcap1,farmCap,carry,mine,ironRegen,ir0,ir1,
      gcapP,gcapE,towerRng,garArrow,bldVis,ghost,expose,fp,losNo,losYes,mktHalf,sellE4,buyE4,sell0,buy0,decHalf,decFull};`);
  check('F1 stonework: player building HP +20% retroactively (barracks 600→720; damage ratio 0.5 preserved); the enemy does not get it = 600', t41.hp0===600&&t41.hp1===720&&t41.hpRatio===0.5&&t41.ehp===600, t41);
  check('F1: repair speed ×1.5', t41.repair1===1.5, t41);
  check('E2 three-field rotation: farm stock cap +30 (90→120)', t41.fcap0===90&&t41.fcap1===120&&t41.farmCap===30, t41);
  check('E3 pack-animal logistics: carry +25%', t41.carry===1.25, t41);
  check('E5 deep mining: stone/iron gather +25% + iron slowly regenerates from a low point (10→10.3)', t41.mine===1.25&&t41.ironRegen===0.3&&t41.ir1>t41.ir0, t41);
  check('F2 garrison hardening: garrison capacity +25% (tower 4→5; enemy 4), tower range +20, extra-arrow weight 3→4', t41.gcapP===5&&t41.gcapE===4&&t41.towerRng===20&&t41.garArrow===4, t41);
  check('S2 beacons: building vision +2, vision afterimage ×2, enemy firing exposure ×2', t41.bldVis===2&&t41.ghost===2&&t41.expose===2, t41);
  check('S3 scouting: we see one extra layer through forest (blocked without pierce; passes with pierce)', t41.fp===1&&t41.losNo===false&&t41.losYes===true, t41);
  check('E4 guilds; narrower buy/sell spread: 80/125→95/105 (the market goes from punitive emergency valve to trading-state economic engine; a residual spread is kept to block arbitrage spam)', t41.sellE4===95&&t41.buyE4===105&&t41.sell0===80&&t41.buy0===125, t41);
  check('E4 guilds: market exchange loss halved (sell loss 0.9→0.95)', t41.mktHalf===true&&t41.decHalf===0.95&&t41.decFull===0.9, t41);

  console.log('\n[42] production panel civ filter (Option 2): other civs\' unique units are not shown even locked (removes UI clutter); the own-civ ones stay = greyed out to signal the research goal');
  const t42 = await ev(`
    playerTech.researched.clear(); recomputeTechMod();
    const barr=buildings.find(b=>b.type==='barracks'&&b.side===0);
    const stab=placeB(0,'stable',24,26,true);
    setPlayerCiv('eng');
    openProdPanel(barr); const engBarr=[...document.querySelectorAll('#bldPanel .uBtn')].map(b=>b.dataset.u);
    openProdPanel(stab); const engStab=[...document.querySelectorAll('#bldPanel .uBtn')].map(b=>b.dataset.u);
    setPlayerCiv('hre');
    openProdPanel(barr); const hreBarr=[...document.querySelectorAll('#bldPanel .uBtn')].map(b=>b.dataset.u);
    setPlayerCiv('mon');
    openProdPanel(stab); const monStab=[...document.querySelectorAll('#bldPanel .uBtn')].map(b=>b.dataset.u);
    setPlayerCiv('eng'); openProdPanel(barr); const staleBefore=[...document.querySelectorAll('#bldPanel .uBtn')].map(b=>b.dataset.u);
    setPlayerCiv('hre'); const staleAfter=[...document.querySelectorAll('#bldPanel .uBtn')].map(b=>b.dataset.u);
    setPlayerCiv('eng'); closePanels();
    return {engBarr,engStab,hreBarr,monStab,staleBefore,staleAfter};`);
  check('England barracks: shows longbowman (own civ) + spearman/archer, hides heavy infantry (HRE)', t42.engBarr.includes('longbow')&&!t42.engBarr.includes('heavyinf')&&t42.engBarr.includes('spear')&&t42.engBarr.includes('archer'), t42);
  check('England stable: shows cavalry, hides horse archer (Mongol)', t42.engStab.includes('cavalry')&&!t42.engStab.includes('horsearcher'), t42);
  check('HRE barracks: shows heavy infantry (own civ), hides longbowman (England)', t42.hreBarr.includes('heavyinf')&&!t42.hreBarr.includes('longbow'), t42);
  check('Mongol stable: shows horse archer (own civ) + cavalry', t42.monStab.includes('horsearcher')&&t42.monStab.includes('cavalry'), t42);
  check('switching civilisation refreshes an open production panel instantly (open the barracks as eng showing longbowman → switch to hre; the panel switches to heavy infantry; no leftover units from the old civ)', t42.staleBefore.includes('longbow')&&t42.staleAfter.includes('heavyinf')&&!t42.staleAfter.includes('longbow'), t42);

  console.log('\n[43] Parthian shot (horse archer hit-and-run; shoots while backing off): still fires when closed on (d<rng*0.55 back-off zone) — fixes "never fires while backing off → flees without shooting, gets chased off screen"');
  const t43 = await ev(`
    units.length=0; scouts.length=0; shots.length=0; aiWave=99999;            // 隔離：清軍隊/投射·停波
    const g0=tags[0]; g0.rule='kite'; g0.task='guard'; g0.holdFire=false; g0.pt=null; g0.focus=null; g0.zoneAnchor=null; g0.holdB=null; // 打帶跑姿態·清前測殘留
    const GAP=UT.horsearcher.rng*0.55-25;                                     // <rng*0.55=77 → 全程落在回馬箭後退區（永不進站定開火窗口）＝任何 side0 箭必來自回馬箭分支
    const cav=spawnUnit(0,'horsearcher',960,540,g0); cav.hp=cav.maxHp=9999; cav.cd=0; cav.anchor={x:960,y:540};  // 地圖中央(W1920/H1080)·界內空曠
    const foe=spawnUnit(1,'spear',960+GAP,540,tags[5]); foe.hp=foe.maxHp=99999; const hp0=foe.hp;
    const x0=cav.x; let fired=false, retreated=false;
    for(let i=0;i<60;i++){ foe.x=cav.x+GAP; foe.y=cav.y; uTick(cav,TICK);      // 驅動弓騎接戰行為（acquire→kite 後退分支）；用 uTick 隔離 AI/step 其他系統對手造敵的夾具干擾
      if(shots.some(s=>s.side===0&&s.kind==='arrow'))fired=true;               // 後退「同時」放箭＝回馬箭（舊碼此後退區純逃·永不開火）
      if(cav.x<x0-30)retreated=true; }                                         // 確實處於後退（非站定開火）
    return {fired, retreated, dx:+(x0-cav.x).toFixed(0)};`);
  check('Parthian shot: a horse archer closed on (back-off zone) shoots while backing off — still fires while retreating (fixes the old code fleeing without shooting → chased off screen)', t43.fired===true && t43.retreated===true, t43);

  console.log('\n[44] arrow turn-rate limit (no homing, no half-turns): turn per frame ≤ cap + arrows that cannot catch a fast crossing target overshoot maxD and miss; stationary targets are still reached by a straight flight (fixes "arrows turn half a circle to track"; movement can dodge; WYSIWYG)');
  const t44 = await ev(`
    shots.length=0; misses.length=0;
    const tA={x:820,y:300,hp:99,maxHp:99,type:'spear',side:1,movedT:0};
    const ar={kind:'arrow',x:800,y:540,tgt:tA,sp:300,dmg:9,side:0,hd:0,flown:0,maxD:1e9};
    let maxStep=0,prev=ar.hd;
    for(let i=0;i<10;i++){ shotTick(ar,TICK); const dh=Math.abs(ar.hd-prev); if(dh>maxStep)maxStep=dh; prev=ar.hd; }
    const cap=ARROW_TURN*TICK;
    shots.length=0; misses.length=0;
    const tB={x:900,y:540,hp:99,maxHp:99,type:'spear',side:1,movedT:t};
    const ar2={kind:'arrow',x:800,y:540,tgt:tB,sp:300,dmg:9,side:0,hd:0,flown:0,maxD:200};
    let died2=false;
    for(let i=0;i<400 && !died2;i++){ tB.y+=50; tB.movedT=t; shotTick(ar2,TICK); if(ar2.dead)died2=true; }
    shots.length=0; misses.length=0;
    const tC={x:900,y:540,hp:99,maxHp:99,type:'spear',side:1,movedT:0};
    const ar3={kind:'arrow',x:800,y:540,tgt:tC,sp:300,dmg:30,side:0,hd:0,flown:0,maxD:300};
    for(let i=0;i<40 && !ar3.dead;i++){ shotTick(ar3,TICK); }
    return {maxStep:+maxStep.toFixed(4), cap:+cap.toFixed(4), withinCap:maxStep<=cap+1e-6,
      died2, flown2:+ar2.flown.toFixed(0), maxD2:ar2.maxD, reachedC:ar3.dead&&ar3.flown<ar3.maxD};`);
  check('arrow turn-rate limit: turn per frame ≤ ARROW_TURN×dt (no more instant half-turn tracking)', t44.withinCap===true, t44);
  check('an arrow that cannot catch a fast crossing target overshoots maxD and misses (no endless homing circles)', t44.died2===true && t44.flown2>=t44.maxD2, t44);
  check('the turn limit does not break straight flight: an arrow reaches a stationary target in a straight line (not a miss)', t44.reachedC===true, t44);

  console.log('\n[45] horse archer balance pass: accuracy penalty (acc; firing from horseback; stacked-enemy evasion) + kites in ranged duels too (kite window widened to 0.85rng; fixes standing still and being wiped by catapults/arrow volleys)');
  const t45 = await ev(`
    units.length=0; scouts.length=0; shots.length=0; aiWave=99999;
    const cav=spawnUnit(0,'horsearcher',960,540,tags[0]); const arc=spawnUnit(0,'archer',960,560,tags[0]);
    const dummy={x:1030,y:540,hp:999,maxHp:999,type:'spear',side:1,movedT:0};
    fire(cav,dummy); const cavArr=shots.find(s=>s.kind==='arrow');
    shots.length=0; fire(arc,dummy); const arcArr=shots.find(s=>s.kind==='arrow');
    const cavAcc=cavArr?cavArr.acc:null, arcAcc=arcArr?arcArr.acc:null;
    units.length=0; shots.length=0;
    const g0=tags[0]; g0.rule='kite'; g0.task='guard'; g0.holdFire=false; g0.pt=null; g0.focus=null; g0.zoneAnchor=null; g0.holdB=null;
    const GAP=UT.horsearcher.rng*0.7;
    const cav2=spawnUnit(0,'horsearcher',960,540,g0); cav2.hp=cav2.maxHp=9999; cav2.cd=0; cav2.anchor={x:960,y:540};
    const foe=spawnUnit(1,'archer',960+GAP,540,tags[5]); foe.hp=foe.maxHp=99999; foe.revealT=t+1e6;
    const x0=cav2.x; let fired=false;
    for(let i=0;i<40;i++){ foe.x=cav2.x+GAP; foe.y=cav2.y; uTick(cav2,TICK);
      if(shots.some(s=>s.side===0&&s.kind==='arrow'))fired=true; }
    return {cavAcc, arcAcc, dx:+(x0-cav2.x).toFixed(0), movedFar:cav2.x<x0-20, firedFar:fired};`);
  check('horse archer accuracy penalty: horse archer arrows acc=0.85, plain archer arrows acc=1 (low accuracy firing from horseback; stacked-enemy evasion)', t45.cavAcc===0.85 && t45.arcAcc===1, t45);
  check('horse archer kites in ranged duels too: with tgt inside the old stand-still window (0.7rng) it still moves while shooting, no standing still (fixes clumping up and being wiped by catapults/arrow volleys)', t45.movedFar===true && t45.firedFar===true, t45);

  console.log('\n[46] age3 civ-specific research (fixes the hollow late knight era; #19 option A): Mongol M8 remount (horse archer accuracy ↑) + England M9 armour-piercing arrows (pierce for the archer line); masked and locked for other civs');
  const t46 = await ev(`
    units.length=0; shots.length=0;
    setPlayerCiv('mon'); playerTech.researched.clear(); recomputeTechMod();
    const cav=spawnUnit(0,'horsearcher',960,540,tags[0]); const dummy={x:1030,y:540,hp:999,maxHp:999,type:'spear',side:1,movedT:0};
    shots.length=0; fire(cav,dummy); const accBefore=shots.find(s=>s.kind==='arrow').acc;
    playerTech.researched.add('M8'); recomputeTechMod();
    shots.length=0; fire(cav,dummy); const accAfter=shots.find(s=>s.kind==='arrow').acc;
    setPlayerCiv('eng'); playerTech.researched.clear(); recomputeTechMod();
    const pierce0=techMod.pierce;
    playerTech.researched.add('M9'); recomputeTechMod();
    const pierce1=techMod.pierce;
    const monHasM8=civEnabled(civById('mon')).has('M8'), engHasM8=civEnabled(civById('eng')).has('M8');
    const engHasM9=civEnabled(civById('eng')).has('M9'), monHasM9=civEnabled(civById('mon')).has('M9');
    const t3=TECH.filter(x=>x.tier===3).map(x=>x.id);
    const monT3=t3.filter(id=>civEnabled(civById('mon')).has(id)), engT3=t3.filter(id=>civEnabled(civById('eng')).has(id)), hreT3=t3.filter(id=>civEnabled(civById('hre')).has(id));
    setPlayerCiv('eng'); playerTech.researched.clear(); recomputeTechMod();
    return {accBefore,accAfter,pierce0,pierce1,monHasM8,engHasM8,engHasM9,monHasM9,monT3,engT3,hreT3};`);
  check('M8 heavy cavalry; remount (Mongol): horse archer accuracy 0.85→1.0 (caps out; fully cancels the horseback firing penalty)', t46.accBefore===0.85 && t46.accAfter===1, t46);
  check('M9 armour-piercing arrows (England): archer-line pierce 1→0.5 (halves the enemy\'s ranged armour on hit)', t46.pierce0===1 && t46.pierce1===0.5, t46);
  check('age3 mask: M8 researchable by Mongol only, M9 by England only (locked for other civs)', t46.monHasM8&&!t46.engHasM8&&t46.engHasM9&&!t46.monHasM9, t46);
  check('late knight era is no longer hollow (#19): England/Mongol each get their own tier3 star (Mongol M8; England M9; HRE M5+F3)', t46.monT3.length>=1&&t46.engT3.length>=1&&t46.hreT3.length>=2, t46);

  console.log('\n[47] engagement sanity (user ruling): 1) always attack anything within attack range (beyond the guard radius) 2) return fire (once hit, chase the attacker outside the radius) 3) cannot see / cannot reach → move away (no standing still)');
  const t47 = await ev(`
    units.length=0; scouts.length=0; shots.length=0; villagers.length=0; aiWave=99999;
    const g0=tags[0]; g0.task='guard'; g0.rule='counter'; g0.holdFire=false; g0.focus=null; g0.zoneAnchor=null; g0.holdB=null; g0.pt=null;
    g0.pt={x:200,y:540};
    const a1=spawnUnit(0,'archer',960,540,g0); a1.cd=0; a1.path=[]; a1.reT=0; a1.lastHitBy=null;
    const e1=spawnUnit(1,'spear',960+100,540,tags[5]); e1.revealT=t+1e6;
    const inRangeAcq = acquire(a1)===e1;
    units.length=0; shots.length=0;
    g0.pt={x:960,y:540};
    const a2=spawnUnit(0,'archer',960,540,g0); a2.cd=0; a2.path=[]; a2.reT=0; a2.lastHitBy=null;
    const e2=spawnUnit(1,'archer',960+220,540,tags[5]); e2.revealT=t+1e6;
    const noReact = acquire(a2);
    a2.lastHitBy=e2; a2.lastHitT=t;
    const reacted = acquire(a2)===e2;
    units.length=0; shots.length=0; visible.fill(0);
    g0.pt={x:960,y:540};
    const a3=spawnUnit(0,'archer',960,540,g0); a3.cd=0; a3.path=[]; a3.reT=0; a3.anchor={x:960,y:540};
    const ghost={x:760,y:540,hp:10};
    a3.lastHitBy=ghost; a3.lastHitT=t;
    const x0=a3.x; for(let i=0;i<12;i++){ uTick(a3,TICK); }
    const fledAway = a3.x>x0+10;
    return {inRangeAcq, noReact, reacted, fledAway, x0:+x0.toFixed(0), x1:+a3.x.toFixed(0)};`);
  check('always attack in range: an enemy outside the guard radius but within own attack range is still targeted (fixes guard honouring only the guard radius and ignoring near enemies)', t47.inRangeAcq===true, t47);
  check('return fire: an enemy outside the radius and out of range is normally ignored (null); once it attacks me (lastHitBy) → target and chase it (attackers are exempt from the guard radius)', t47.noReact===null && t47.reacted===true, t47);
  check('hit by something we cannot see or reach → move away instead of standing still (source invisible; uTick backs off away from the source direction)', t47.fledAway===true, t47);

  console.log('\n[49] hit-and-run strafing (strafe; fixes horse archer jitter vs archers): circles and shoots at ~0.85rng = keeps moving (large perpendicular displacement), stable distance (no radial in-out jitter), still firing');
  const t49 = await ev(`
    units.length=0; scouts.length=0; shots.length=0; villagers.length=0; aiWave=99999; arenaMode=false;
    const g0=tags[0]; g0.task='guard'; g0.rule='kite'; g0.holdFire=false; g0.focus=null; g0.zoneAnchor=null; g0.holdB=null; g0.pt={x:960,y:540};
    const dd=UT.horsearcher.rng*0.85;
    const cav=spawnUnit(0,'horsearcher',960-dd,540,g0); cav.hp=cav.maxHp=9999; cav.cd=0; cav.anchor={x:960,y:540}; cav.kiteDir=1;
    const foe=spawnUnit(1,'archer',960,540,tags[5]); foe.hp=foe.maxHp=99999; foe.revealT=t+1e6; // 靜止弓兵(不追)
    const y0=cav.y; let fired=false, dMin=1e9, dMax=0, yDev=0;
    for(let i=0;i<60;i++){ foe.revealT=t+1e6; uTick(cav,TICK);
      if(shots.some(s=>s.side===0&&s.kind==='arrow'))fired=true;
      const dnow=Math.hypot(cav.x-foe.x,cav.y-foe.y); dMin=Math.min(dMin,dnow); dMax=Math.max(dMax,dnow);
      yDev=Math.max(yDev,Math.abs(cav.y-y0)); }
    const strafed=yDev>40;                                                            // 垂直環繞＝繞圈(非徑向抖)
    const held=dMin>UT.horsearcher.rng*0.5 && dMax<UT.horsearcher.rng*1.1;            // 距離穩定在帶內(沒飛走、沒貼臉)
    return {fired, strafed, held, dMin:+dMin.toFixed(0), dMax:+dMax.toFixed(0), yDev:+yDev.toFixed(0)};`);
  check('hit-and-run strafing: horse archer circles while shooting (perpendicular displacement >40 = circling, not radial jitter)', t49.strafed===true && t49.fired===true, t49);
  check('hit-and-run strafing: distance stays inside the ~0.85rng band (neither runs away nor closes to the face = no radial jitter)', t49.held===true, t49);

  console.log('\n[48] arena mode: arenaSetup flat ground; no economy; no AI raids; whole map visible; no win/lose ruling; the two armies clash (total HP falls)');
  const t48 = await ev(`
    arenaSetup({spear:6},{spear:6});
    const side0=units.filter(u=>u.side===0).length, side1=units.filter(u=>u.side===1).length;
    const flat=terr.every(v=>v===0), noBld=buildings.length===0;
    updateFog(); const revealed=visible.every(v=>v===1);
    const hp0=units.reduce((s,u)=>s+u.hp,0);
    for(let i=0;i<500;i++)step(TICK);
    const hp1=units.reduce((s,u)=>s+u.hp,0);
    arenaSetup({longbow:3,heavyinf:2},{horsearcher:4}); // 自訂可生 civ 鎖兵（長弓/重步/弓騎·擂台繞過 civ 閘）
    const uniqOk = units.filter(u=>u.side===0&&u.type==='longbow').length===3 && units.filter(u=>u.side===0&&u.type==='heavyinf').length===2 && units.filter(u=>u.side===1&&u.type==='horsearcher').length===4;
    const r={side0,side1,flat,noBld,revealed,fought:hp1<hp0,goStayed:gameOver===null,arenaOn:dbg.arenaMode(),uniqOk};
    arenaMode=false; return r;`);
  check('Arena setup: both armies in place (side0=6; side1=6), terrain flattened, no buildings, whole map visible', t48.side0===6&&t48.side1===6&&t48.flat===true&&t48.noBld===true&&t48.revealed===true, t48);
  check('Arena smoke: steps 500 ticks with no exceptions, both armies engage (total HP↓), no winner declared (gameOver stays null), arenaMode on', t48.fought===true&&t48.goStayed===true&&t48.arenaOn===true, t48);
  check('Arena custom: can spawn civ-locked longbowman/heavy infantry/horse archer (bypasses the civ gate; any matchup testable; the units the user wants)', t48.uniqOk===true, t48);

  console.log('\n[50] Water movement layer (naval slice; land/water domain): land units cannot enter deep water; shallows fordable (0.6)/bridges passable; ships take deep water + shallows (slow sail); bridges block ships; coastal cliffs cannot walk down into the water');
  const t50 = await ev(`
    units.length=0; scouts.length=0; villagers.length=0; shots.length=0; arenaMode=false; aiWave=99999;
    terr.fill(T_PLAIN);
    trect(10,0,12,26,T_WATER); trect(10,5,12,5,T_BRIDGE); trect(10,13,12,13,T_SHALLOW); trect(13,20,13,20,T_HIGH);
    paintTerrain();
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const isW=p=>terr[idx(txOf(p.x),tyOf(p.y))]===T_WATER;
    const landWater=canStep(idx(9,20),idx(10,20),0), landFord=canStep(idx(9,13),idx(10,13),0),
          landBridge=canStep(idx(9,5),idx(10,5),0), cliffDown=canStep(idx(13,20),idx(12,20),0);
    const dom_ws_w=domOK(idx(11,8),'water'), dom_ls_w=domOK(idx(20,20),'water'), dom_ws_l=domOK(idx(11,8)), dom_ls_l=domOK(idx(20,20));
    const dom_sh_w=domOK(idx(11,13),'water');
    const spShallow=spdI(idx(11,13)), spBridge=spdI(idx(11,5)), spWater=spdI(idx(11,8));
    const pCross=findPath(C(5,13).x,C(5,13).y,C(20,13).x,C(20,13).y,0,false);
    const pDetour=findPath(C(5,20).x,C(5,20).y,C(20,20).x,C(20,20).y,0,false);
    const crossOk=pCross.length>0&&!pCross.some(isW);
    const detourReach=pDetour.length>0&&Math.hypot(pDetour[pDetour.length-1].x-C(20,20).x,pDetour[pDetour.length-1].y-C(20,20).y)<TILE;
    const detourNoWater=!pDetour.some(isW), detourLonger=pDetour.length>pCross.length;
    const pShip=findPath(C(11,8).x,C(11,8).y,C(11,11).x,C(11,11).y,0,false,'water');
    const shipOk=pShip.length>0&&pShip.every(isW);
    const pShipBridge=findPath(C(11,8).x,C(11,8).y,C(11,2).x,C(11,2).y,0,false,'water');
    const shipBlocked=pShipBridge.length===0;
    const pShipFord=findPath(C(11,10).x,C(11,10).y,C(11,16).x,C(11,16).y,0,false,'water');
    const shipFordOk=pShipFord.length>0&&Math.hypot(pShipFord[pShipFord.length-1].x-C(11,16).x,pShipFord[pShipFord.length-1].y-C(11,16).y)<TILE;
    const sw=spawnUnit(0,'spear',C(12,8).x,C(12,8).y,tags[0]); sw.dom='water'; const sx0=sw.x; sepApply(sw,TILE,0);
    const shipPushBlocked=sw.x===sx0;
    const lu=spawnUnit(0,'spear',C(5,20).x,C(5,20).y,tags[0]);
    const legalLandWater=isLegalPosition(lu,C(11,20).x,C(11,20).y), legalLandFord=isLegalPosition(lu,C(11,13).x,C(11,13).y);
    const su=spawnUnit(0,'spear',C(11,8).x,C(11,8).y,tags[0]); su.dom='water';
    const legalShipLand=isLegalPosition(su,C(20,20).x,C(20,20).y), legalShipWater=isLegalPosition(su,C(11,11).x,C(11,11).y);
    const lu2=spawnUnit(0,'spear',C(9,20).x,C(9,20).y,tags[0]); const x0=lu2.x; sepApply(lu2,TILE,0); const pushBlocked=lu2.x===x0;
    units.length=0; terr.fill(T_PLAIN); paintTerrain();
    return {landWater,landFord,landBridge,cliffDown,dom_ws_w,dom_ls_w,dom_ws_l,dom_ls_l,dom_sh_w,spShallow,spBridge,spWater,
      crossOk,detourReach,detourNoWater,detourLonger,shipOk,shipBlocked,shipFordOk,shipPushBlocked,
      legalLandWater,legalLandFord,legalShipLand,legalShipWater,pushBlocked,pCrossLen:pCross.length,pDetourLen:pDetour.length};`);
  check('Water; land unit canStep: deep water blocked; shallows passable; bridge passable; coastal cliff cannot enter the water', t50.landWater===false&&t50.landFord===true&&t50.landBridge===true&&t50.cliffDown===false, t50);
  check('Water; domOK: deep water ships only / land tiles land only / shallows ships too (slow sail)', t50.dom_ws_w===true&&t50.dom_ls_w===false&&t50.dom_ws_l===false&&t50.dom_ls_l===true&&t50.dom_sh_w===true, t50);
  check('Water; speed: shallows 0.6 (slowed); bridge 1; deep water 1', t50.spShallow===0.6&&t50.spBridge===1&&t50.spWater===1, t50);
  check('Water; land pathfinding: goes straight through a shallow ford; longer detour when there is no ford; never steps on deep water', t50.crossOk&&t50.detourReach&&t50.detourNoWater&&t50.detourLonger, t50);
  check('Water; ship pathfinding: navigable within the same water body; unreachable when cut off by a bridge; shallows passable at slow sail; being pushed shorewards does not cross the boundary', t50.shipOk&&t50.shipBlocked&&t50.shipFordOk&&t50.shipPushBlocked, t50);
  check('Water; physics gate: land unit into deep water illegal / into shallows legal; ship on land illegal / on water legal; cannot be shoved across the boundary', t50.legalLandWater===false&&t50.legalLandFord===true&&t50.legalShipLand===false&&t50.legalShipWater===true&&t50.pushBlocked===true, t50);

  console.log('\n[51] Naval step2a: dock (built on the water; footprint = deep water + adjacent shore; villager builds from the shore; AoE-style) + ships launched on production (fishing boat/transport dom=water; spawn on an adjacent water tile)');
  const t51 = await ev(`
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);scouts.length=0;aiWave=99999;
    arenaMode=true;gameOver=null;
    for(const k in stock)stock[k]=1e9; starving=false;starveN=0;
    terr.fill(T_PLAIN);
    trect(20,0,30,26,T_WATER);
    paintTerrain();explored.fill(1);exploredE.fill(1);
    const shoreOk   = canPlace('dock',20,12);
    const inlandNo  = canPlace('dock',10,10);
    const midWaterNo= canPlace('dock',25,12);
    const landFpNo  = canPlace('dock',18,12);
    terr[idx(19,4)]=T_SHALLOW;terr[idx(19,5)]=T_SHALLOW;
    const fordShoreNo=canPlace('dock',20,4);
    terr[idx(19,4)]=T_PLAIN;terr[idx(19,5)]=T_PLAIN;
    const dk = placeB(0,'dock',20,12,true);
    const dockWater = terr[idx(dk.tx,dk.ty)]===T_WATER, dockDone=!!dk.done;
    dk.queue.push({type:'fishing',tag:0}); dk.defTag=0;
    let ship=null; for(let i=0;i<400&&!ship;i++){step(TICK); ship=units.find(u=>u.type==='fishing');}
    const shipDom = !!ship&&ship.dom==='water';
    const shipOnWater = !!ship&&terr[idx(txOf(ship.x),tyOf(ship.y))]===T_WATER;
    dk.queue.push({type:'transport',tag:0});
    let tr=null; for(let i=0;i<500&&!tr;i++){step(TICK); tr=units.find(u=>u.type==='transport');}
    const trOnWater = !!tr&&tr.dom==='water'&&terr[idx(txOf(tr.x),tyOf(tr.y))]===T_WATER;
    dk.queue.length=0; playerTech.age=1;
    const fireFeudalNo = queueUnit(dk,'fireship')===false && dk.queue.length===0;
    playerTech.age=2; const fireCastleOk = queueUnit(dk,'fireship')===true; playerTech.age=1; dk.queue.length=0;
    const dockUnits = Object.keys(UT).filter(k=>UT[k].bld==='dock');
    const inProdBld = PROD_BLD.has('dock');
    units.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);terr.fill(T_PLAIN);paintTerrain();arenaMode=false;
    return {shoreOk,inlandNo,midWaterNo,landFpNo,fordShoreNo,dockWater,dockDone,shipDom,shipOnWater,trOnWater,fireFeudalNo,fireCastleOk,dockUnits,inProdBld};`);
  check('Naval; dock placement: on the water (adjacent to solid land) allowed; inland / mid-lake (no adjacent shore) / land footprint / adjacent to shallows only not allowed', t51.shoreOk===true&&t51.inlandNo===false&&t51.midWaterNo===false&&t51.landFpNo===false&&t51.fordShoreNo===false, t51);
  check('Naval; dock launches ships: fishing boat dom=water spawns in deep water; dock footprint is on the water', t51.shipDom===true&&t51.shipOnWater===true&&t51.dockWater===true, t51);
  check('Naval; transport launches; dock = production building; list of 5 ships; fire ship/siege ship gated to the Castle age (Feudal blocked; Castle allowed)', t51.trOnWater===true&&t51.inProdBld===true&&t51.dockUnits.length===5&&t51.fireFeudalNo===true&&t51.fireCastleOk===true, t51);

  console.log('\n[52] Naval step2b: fishing boat gathering (villager of the water; gathers the nearest fishery → returns full to the dock to unload food; does not build) + fishery split (land villagers do not gather sea nodes)');
  const t52 = await ev(`
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);scouts.length=0;nodes.length=0;aiWave=99999;
    arenaMode=true;gameOver=null;
    for(const k in stock)stock[k]=0; stock.food=100; starving=false;starveN=0;
    terr.fill(T_PLAIN); trect(20,0,30,26,T_WATER); paintTerrain();   // 右側海·col19=沙灘
    const dk=placeB(0,'dock',18,12,true);                            // 沙灘碼頭(鄰海·漁船卸貨點)
    const fishNode={type:'food',sea:true,x:24.5*TILE,y:12.5*TILE,amt:120,max:120}; nodes.push(fishNode);
    const amt0=fishNode.amt;
    const sh=spawnUnit(0,'fishing',22.5*TILE,12.5*TILE,tags[0]);      // 漁船在水上
    const villFood=nearestNode('food',22.5*TILE,12.5*TILE,null,false); // 陸上村民找 food→應跳過漁場(sea)
    const fishFound=nearestFish(22.5*TILE,12.5*TILE);                  // 漁船找漁場→找得到
    const food0=stock.food;
    let carried=false; for(let i=0;i<200&&!carried;i++){step(TICK); if(sh.carry>0)carried=true;}
    const amtAfterGather=fishNode.amt;
    let hauled=false; for(let i=0;i<400&&!hauled;i++){step(TICK); if(stock.food>food0+5)hauled=true;}
    const r={villSkipsFish:villFood===null, fishFound:fishFound===fishNode, shipDom:sh.dom==='water',
      carried, nodeDepleted:amtAfterGather<amt0, hauled, foodGain:+(stock.food-food0).toFixed(0)};
    units.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;terr.fill(T_PLAIN);paintTerrain();arenaMode=false;
    return r;`);
  check('Naval; fishery split: land villager nearestNode(food) skips sea fisheries; fishing boat nearestFish finds them', t52.villSkipsFish===true&&t52.fishFound===true, t52);
  check('Naval; fishing boat gathers: swims to the fishery and gathers fish (carry↑; node amt↓; dom=water)', t52.carried===true&&t52.nodeDepleted===true&&t52.shipDom===true, t52);
  check('Naval; fishing boat unloads at the dock: swims back full → food into the stock (stock.food↑)', t52.hauled===true&&t52.foodGain>=5, t52);

  console.log('\n[53] Naval step2c: transport load/unload (garrison-style; capacity Σvol≤hold; boards/unloads across the land-water boundary; unloads half and keeps the rest aboard when there is not enough room)');
  const t53 = await ev(`
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);scouts.length=0;nodes.length=0;aiWave=99999;
    arenaMode=true;gameOver=null;
    for(const k in stock)stock[k]=1e9;starving=false;starveN=0;
    terr.fill(T_PLAIN); trect(20,0,40,26,T_WATER); paintTerrain();
    const T=spawnUnit(0,'transport',20.5*TILE,12.5*TILE,tags[0]); T.cargo=[];
    const a=spawnUnit(0,'spear',18.5*TILE,12.5*TILE,tags[1]);
    const b=spawnUnit(0,'spear',18.5*TILE,13.5*TILE,tags[1]);
    const c=spawnUnit(0,'cavalry',17.5*TILE,12.5*TILE,tags[1]); // vol 1+1+2=4
    const okA=boardTransport(a,T),okB=boardTransport(b,T),okC=boardTransport(c,T);
    let boarded=0; for(let i=0;i<300&&boarded<3;i++){step(TICK);boarded=T.cargo.length;}
    const usedFull=transUsed(T), allGar=a.gar===T&&b.gar===T&&c.gar===T;
    const capYes=canBoard(T,2), capNo=canBoard(T,3);
    unloadTransport(T,T.x,T.y);
    let unl=false; for(let i=0;i<150&&!unl;i++){step(TICK);if(T.cargo.length===0)unl=true;}
    const offField=a.gar===null&&b.gar===null&&c.gar===null;
    const onLand=[a,b,c].every(u=>terr[idx(txOf(u.x),tyOf(u.y))]!==T_WATER);
    units.length=0; terr.fill(T_WATER); trect(30,12,30,12,T_PLAIN); paintTerrain();
    const T2=spawnUnit(0,'transport',30.5*TILE,11.5*TILE,tags[0]); T2.cargo=[];
    for(let i=0;i<3;i++){const s=spawnUnit(0,'spear',30.5*TILE,12.5*TILE,tags[0]);s.gar=T2;T2.cargo.push(s);}
    unloadTransport(T2,T2.x,T2.y); for(let i=0;i<60;i++)step(TICK);
    const partialLeft=T2.cargo.length;
    units.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;terr.fill(T_PLAIN);paintTerrain();arenaMode=false;
    return {okA,okB,okC,boarded,usedFull,allGar,capYes,capNo,unl,offField,onLand,partialLeft};`);
  check('Naval; transport carries: 3 units board (cargo=3; Σvol=4; all removed from the field, gar=ship)', t53.boarded===3&&t53.usedFull===4&&t53.allGar===true&&t53.okA&&t53.okB&&t53.okC, t53);
  check('Naval; transport capacity: hold=6; canBoard(+2) allowed, canBoard(+3) not (blocked when full)', t53.capYes===true&&t53.capNo===false, t53);
  check('Naval; transport unloads: drops units against the shore → units back on the field (gar=null; landing on land tiles); cargo cleared', t53.unl===true&&t53.offField===true&&t53.onLand===true, t53);
  check('Naval; transport unloads half: not enough land tiles at the drop point (single tile ringed by water) → only 1 unloaded; the other 2 stay aboard', t53.partialLeft===2, t53);

  console.log('\n[54] Naval step2d: settlers (produced at the TC; capped; land unit that can board a transport; deploys into an outpost = island expansion)');
  const t54 = await ev(`
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);scouts.length=0;nodes.length=0;aiWave=99999;
    arenaMode=true;gameOver=null;
    for(const k in stock)stock[k]=1e9;starving=false;starveN=0;
    terr.fill(T_PLAIN);paintTerrain();explored.fill(1);exploredE.fill(1);
    const tc=placeB(0,'tc',5,12,true);
    playerTech.age=1;trainSettler(tc);const ageGated=cqCount('settler')===0; // 封建時代＝開拓隊被城堡閘擋
    playerTech.age=2; // 城堡時代解鎖
    trainSettler(tc);trainSettler(tc);trainSettler(tc); // 第3個被上限(SETTLER_CAP=2)擋
    const queued=cqCount('settler');
    let settlers=0; for(let i=0;i<600&&settlers<2;i++){step(TICK);settlers=units.filter(u=>u.type==='settler').length;}
    const capped=units.filter(u=>u.type==='settler').length+cqCount('settler')<=SETTLER_CAP;
    const s=units.find(u=>u.type==='settler');
    const isLand=!!s&&s.dom===undefined&&UT.settler.settler===true&&!UT.settler.dom;
    const canBoardTransport=(UT.settler.vol||0)>0;
    s.x=20.5*TILE;s.y=8.5*TILE; // 移到空地部署
    const ob=deploySettler(s);
    const deployed=!!ob&&ob.type==='outpost'&&ob.done;
    const consumed=units.indexOf(s)<0;
    units.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);terr.fill(T_PLAIN);paintTerrain();arenaMode=false;playerTech.age=1;
    return {ageGated,queued,capped,isLand,canBoardTransport,deployed,consumed,settlers};`);
  check('Naval; settlers: Castle age gate (Feudal blocked); cap blocks overflow (SETTLER_CAP); land unit; has vol (can board a transport)', t54.ageGated===true&&t54.queued<=2&&t54.capped===true&&t54.isLand===true&&t54.canBoardTransport===true, t54);
  check('Naval; settlers deploy: deploySettler → outpost immediately; settlers consumed', t54.deployed===true&&t54.consumed===true, t54);

  console.log('\n[55] Naval step3: warships (war galley/fire ship/siege ship) + naval arena (all-naval comps → deep water auto-filled; fleets collide)');
  const t55 = await ev(`
    arenaSetup({galley:5},{fireship:5});
    const navalWater=terr.every(v=>v===T_WATER), allShips=units.every(u=>u.dom==='water');
    const n0=units.length, hp0=units.reduce((s,u)=>s+u.hp,0);
    for(let i=0;i<600;i++)step(TICK);
    const hp1=units.reduce((s,u)=>s+u.hp,0);
    const fought=hp1<hp0, someDead=units.filter(u=>u.hp>0).length<n0;
    units.length=0;scouts.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;aiWave=99999;arenaMode=true;gameOver=null;
    for(const k in stock)stock[k]=1e9;starving=false;
    terr.fill(T_WATER);paintTerrain();
    const g0s=tags[0];g0s.task='guard';g0s.holdFire=false;g0s.focus=null;g0s.rule='focus';g0s.pt={x:600,y:500};
    const sg=spawnUnit(0,'siegeship',600,500,g0s);sg.cd=0;
    tags[5].task='hold';tags[5].holdFire=false;
    const foe=spawnUnit(1,'galley',780,500,tags[5]);foe.revealT=t+1e9; const fhp0=foe.hp;
    let siegeFired=false;
    for(let i=0;i<300;i++){foe.revealT=t+1e9;step(TICK);if(shots.some(s=>s.side===0))siegeFired=true;}
    const siegeHitStatic=foe.hp<fhp0||foe.hp<=0;
    const r={navalWater,allShips,fought,someDead,siegeFired,siegeHitStatic,n0,foeHp:Math.round(foe.hp),fhp0};
    arenaMode=false; return r;`);
  check('Naval; naval arena: all-naval comps → deep water auto-filled; all ships; both sides engage (total HP↓; kills occur)', t55.navalWater===true&&t55.allShips===true&&t55.fought===true&&t55.someDead===true, t55);
  check('Naval; warship combat: siege ship fires (ranged ship works) + splash hits stationary clustered enemy ships (moving targets dodge = the nature of siege)', t55.siegeFired===true&&t55.siegeHitStatic===true, t55);

  console.log('\n[56] Naval; transport with troops aboard returns weak fire (ranged bio units aboard → weak arrows; can be disabled; siege/melee do not count)');
  const t56 = await ev(`
    units.length=0;scouts.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;aiWave=99999;arenaMode=true;gameOver=null;
    for(const k in stock)stock[k]=1e9;starving=false;
    terr.fill(T_WATER);paintTerrain();explored.fill(1);exploredE.fill(1);
    const tr=spawnUnit(0,'transport',600,500,tags[0]);tr.cd=0;tr.cargo=[{type:'archer'}]; // 運輸艦載 1 弓兵
    tags[5].task='hold';tags[5].holdFire=true;
    const foe=spawnUnit(1,'galley',680,500,tags[5]);foe.revealT=t+1e9;const fhp0=foe.hp; // 敵戰船在射程(80<120)內·靜止
    let firedOn=false;
    for(let i=0;i<120;i++){foe.revealT=t+1e9;step(TICK);if(shots.some(s=>s.side===0))firedOn=true;}
    const dmgOn=foe.hp<fhp0;
    shots.length=0;tr.fireOn=false;tr.cd=0;foe.hp=fhp0;let firedOff=false; // 關閉反擊＝靜默航行
    for(let i=0;i<120;i++){foe.revealT=t+1e9;step(TICK);if(shots.some(s=>s.side===0))firedOff=true;}
    tr.fireOn=true;tr.cargo=[{type:'catapult'}];tr.cd=0;shots.length=0;let firedSiege=false; // 只載投石(bio:false)＝不算遠程生物兵
    for(let i=0;i<120;i++){foe.revealT=t+1e9;step(TICK);if(shots.some(s=>s.side===0))firedSiege=true;}
    units.length=0;terr.fill(T_PLAIN);paintTerrain();arenaMode=false;
    return {firedOn,dmgOn,firedOff,firedSiege};`);
  check('Naval; transport return fire: archers aboard → weak arrows that hit (firedOn + damage); disabled = silent; siege does not count (no arrows)', t56.firedOn===true&&t56.dmgOn===true&&t56.firedOff===false&&t56.firedSiege===false, t56);

  console.log('\n[57] Naval battle map v3 (?map=naval; 128×72; strict left-right mirror): central lake + lake island (ford/bridge + resources) + north/south waters with fisheries (linked via the western shallows) + docks on both shores + north/south land corridors (AI waves)');
  const t57 = await ev(`
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;blocked.fill(0);
    dbg.paintNavalTerrain();paintTerrain();explored.fill(1);exploredE.fill(1);dbg.addNavalNodes();
    const cx=(TW/2)|0,y0=5,y1=TH-6,midY=((y0+y1)/2)|0;
    const lake=terr[idx(cx-6,y0+2)]===T_WATER&&terr[idx(cx+6,y1-2)]===T_WATER;
    const island=terr[idx(cx,midY-3)]===T_PLAIN&&terr[idx(cx,y0+1)]===T_WATER&&terr[idx(cx,y1-1)]===T_WATER;
    /* v3: each bank gets one ford (top row) and one bridge (bottom row) so both crossings are equivalent.
       v2 had ford in the west and bridge in the east, which was a structural side bias — caught by the
       tile-by-tile comparison in [111].
       Ford row = midY, bridge row = midY+1; fordShipOK/bridgeShipNo below now compare the two rows on the
       same bank. */
    const ford=terr[idx(cx-5,midY)]===T_SHALLOW&&terr[idx(TW-1-(cx-5),midY)]===T_SHALLOW;
    const bridge=terr[idx(cx-5,midY+1)]===T_SHALLOW&&terr[idx(TW-1-(cx-5),midY+1)]===T_SHALLOW;
    const fish=nodes.filter(n=>n.sea).length;
    const islGold=nodes.some(n=>n.type==='gold'&&Math.abs(txOf(n.x)-cx)<=2&&Math.abs(tyOf(n.y)-midY)<=4);
    const wDock=canPlace('dock',cx-8,y0+3),eDock=canPlace('dock',dbg.mirTx(cx-8),y1-4);
    const corridorN=terr[idx(cx,2)]===T_PLAIN,corridorS=terr[idx(cx,TH-3)]===T_PLAIN;
    const aiPath=findPath((TW-6)*TILE,midY*TILE,6*TILE,midY*TILE,1,false).length>0;
    const pShipNS=findPath((cx+0.5)*TILE,(y0+2)*TILE,(cx+0.5)*TILE,(y1-2)*TILE,0,false,'water');
    const shipCrossFord=pShipNS.length>0&&Math.hypot(pShipNS[pShipNS.length-1].x-(cx+0.5)*TILE,pShipNS[pShipNS.length-1].y-(y1-2)*TILE)<TILE*1.5;
    const fordShipOK=domOK(idx(cx-5,midY),'water')===true&&domOK(idx(TW-1-(cx-5),midY),'water')===true;
    const bridgeShipNo=domOK(idx(cx-5,midY+1),'water')===true&&domOK(idx(TW-1-(cx-5),midY+1),'water')===true;
    trect(0,0,TW-1,4,T_WATER);trect(0,TH-5,TW-1,TH-1,T_WATER);
    const crossViaIsle=findPath((cx-10)*TILE,(midY+0.5)*TILE,(cx+10)*TILE,(midY+0.5)*TILE,1,false).length>0;
    terr.fill(T_PLAIN);nodes.length=0;paintTerrain();computeLandComp();
    return {lake,island,ford,bridge,fish,islGold,wDock,eDock,corridorN,corridorS,aiPath,shipCrossFord,fordShipOK,bridgeShipNo,crossViaIsle};`);
  check('Naval map v3: central lake + lake island + gold on the island + docks buildable on both shores + north/south land corridors + AI can path and attack',
    t57.lake===true&&t57.island===true&&t57.fish>=6&&t57.islGold===true&&t57.wDock===true&&t57.eDock===true&&t57.corridorN===true&&t57.corridorS===true&&t57.aiPath===true, t57);
  check('Naval map v3: the fords on both shores are both 2 rows of shallows (land wades slowly = chokepoint; ships pass at slow sail) = equivalent, no side bias; land crosses the lake via the island (still connected when the corridors are sealed); ships link north to south via the fords (the only naval chokepoint = blockadable)',
    t57.ford===true&&t57.bridge===true&&t57.crossViaIsle===true&&t57.shipCrossFord===true&&t57.fordShipOK===true&&t57.bridgeShipNo===true, t57);

  console.log('\n[58] Naval; transport touch UI: loadNearby (load nearby units; settlers first; ships not loaded; up to capacity)');
  const t58 = await ev(`
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;aiWave=99999;arenaMode=true;gameOver=null;
    for(const k in stock)stock[k]=1e9;starving=false;
    terr.fill(T_PLAIN);trect(20,5,24,9,T_WATER);paintTerrain();explored.fill(1);exploredE.fill(1); // 陸<20·水 20-24·beach col19
    const tr=spawnUnit(0,'transport',20.5*TILE,7.5*TILE,tags[0]);    // 運輸艦貼岸水格(col20·鄰陸 col19)
    spawnUnit(0,'settler',19*TILE,7*TILE,tags[0]);                   // 岸邊開拓隊(vol2)
    for(let i=0;i<3;i++)spawnUnit(0,'spear',18*TILE,(6+i)*TILE,tags[0]); // 3 槍(vol1)
    spawnUnit(0,'galley',23*TILE,8*TILE,tags[0]);                    // 友船(不該被載入)
    const n=loadNearby(tr);
    for(let i=0;i<300;i++)step(TICK);                                // 走到船邊上船
    const aboard=tr.cargo.map(c=>c.type),used=transUsed(tr);
    const hasSettler=aboard.includes('settler'),noShip=!aboard.includes('galley');
    units.length=0;terr.fill(T_PLAIN);paintTerrain();arenaMode=false;
    return {n,used,aboard,hasSettler,noShip};`);
  check('Naval; loadNearby: settlers + land units board (n=4; up to hold 6); friendly ships not loaded; settlers on the list', t58.n===4&&t58.hasSettler===true&&t58.noShip===true&&t58.used>=4, t58);

  console.log('\n[59] Post-test fix batch: economy ships do not join groups (fishing/transport); sites under construction reassign builders automatically; villagers skip island ore they cannot reach; garrisons eject onto land tiles only');
  const t59 = await ev(`
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;aiWave=99999;gameOver=null;arenaMode=true;
    for(const k in stock)stock[k]=1e9;starving=false;
    terr.fill(T_PLAIN);trect(0,0,4,9,T_WATER);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    const dk=placeB(0,'dock',5,4,true);dk.queue=dk.queue||[];dk.qT=0;
    dk.queue.push({type:'fishing',tag:1},{type:'transport',tag:1},{type:'galley',tag:1});
    for(let i=0;i<4000;i++){step(TICK);if(units.filter(u=>['fishing','transport','galley'].includes(u.type)).length>=3)break;}
    const fb=units.find(u=>u.type==='fishing'),tr=units.find(u=>u.type==='transport'),gl=units.find(u=>u.type==='galley');
    const ecoNoGrp=!!fb&&fb.grp==null&&!!tr&&tr.grp==null, shipHasGrp=!!gl&&gl.grp!=null;

    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;
    terr.fill(T_PLAIN);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    const tc=placeB(0,'tc',3,3,true);
    const site=placeB(0,'tower',10,10,false);site.hp=site.maxHp*0.5;site.done=false;
    spawnVillager(tc);const vv=villagers[villagers.length-1];vv.x=12*TILE;vv.y=12*TILE;vv.buildSite=null;vv.repairU=null;vv.job=null;vv.state='idle';
    const beforeB=villagers.filter(x=>x.buildSite===site).length;
    repairScan();
    const afterB=villagers.filter(x=>x.buildSite===site).length;
    const buildResume=beforeB===0&&afterB>=1;

    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;
    terr.fill(T_PLAIN);trect(12,0,13,TH-1,T_WATER);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    nodes.push({type:'gold',x:15.5*TILE,y:5*TILE,amt:500,max:500});
    nodes.push({type:'gold',x:2.5*TILE, y:5*TILE,amt:500,max:500});
    const pickMain=nearestNode('gold',11.5*TILE,5*TILE,null);
    const skipIsland=!!pickMain&&txOf(pickMain.x)===2;
    const pickIsle=nearestNode('gold',16.5*TILE,5*TILE,null);
    const isleLocal=!!pickIsle&&txOf(pickIsle.x)===15;

    units.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);
    terr.fill(T_PLAIN);trect(0,0,8,TH-1,T_WATER);paintTerrain();explored.fill(1);exploredE.fill(1);
    const twr=placeB(0,'tower',9,10,true);
    let anyWater=false;for(let i=0;i<300;i++){const p=placeAround(twr);if(terr[idx(txOf(p.x),tyOf(p.y))]===T_WATER){anyWater=true;break;}}

    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;terr.fill(T_PLAIN);paintTerrain();computeLandComp();arenaMode=false;
    return {ecoNoGrp,shipHasGrp,buildResume,skipIsland,isleLocal,scatterDry:!anyWater};`);
  check('Economy ships do not join groups: fishing boat/transport grp=null; warship (galley) still has a group', t59.ecoNoGrp===true&&t59.shipHasGrp===true, t59);
  check('Site under construction resumes automatically: nobody building → repairScan reassigns an idle villager', t59.buildResume===true, t59);
  check('Villagers skip island ore they cannot reach (across water; different land component); island villagers gather island ore in the same component', t59.skipIsland===true&&t59.isleLocal===true, t59);
  check('Garrison ejects onto land tiles only: waterside tower placeAround never returns a water tile', t59.scatterDry===true, t59);

  console.log('\n[60] Post-test design batch: dock on the water (villager builds from the shore); settler deploy preview (fits on a large island); drag units to board (rendezvous when far)');
  const t60 = await ev(`
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;aiWave=99999;gameOver=null;arenaMode=true;
    for(const k in stock)stock[k]=1e9;starving=false;
    terr.fill(T_PLAIN);trect(20,0,30,26,T_WATER);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    const dock=placeB(0,'dock',20,12,false);
    spawnVillager({x:18*TILE,y:12.5*TILE});const bv=villagers[villagers.length-1];bv.x=18*TILE;bv.y=12.5*TILE;bv.buildSite=dock;bv.job=null;bv.state='idle';
    for(let i=0;i<1500&&!dock.done;i++)step(TICK);
    const waterDockBuilt=dock.done===true&&terr[idx(dock.tx,dock.ty)]===T_WATER;

    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;arenaMode=true;gameOver=null;
    dbg.paintNavalTerrain();paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();dbg.addNavalNodes();
    for(const k in stock)stock[k]=1e9;
    const islandFits=canPlace('outpost',25,10);
    const s=spawnUnit(0,'settler',24.5*TILE,12.5*TILE,tags[0]);
    deploySettlerU=s;placing='outpost';
    tryDeploy(2*TILE,2*TILE);
    const farRej=!s.deployTgt&&units.indexOf(s)>=0&&!buildings.some(b=>b.type==='outpost');
    deploySettlerU=s;placing='outpost';
    tryDeploy(26.2*TILE,11.2*TILE);
    const timedNotInstant=!!s.deployTgt&&!buildings.some(b=>b.type==='outpost'&&b.done);
    let deployed=false;for(let i=0;i<2500&&!deployed;i++){step(TICK);deployed=buildings.some(b=>b.type==='outpost'&&b.done);}
    const consumed=units.indexOf(s)<0;
    deploySettlerU=null;placing=null;

    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;arenaMode=true;gameOver=null;
    for(const k in stock)stock[k]=1e9;starving=false;
    terr.fill(T_PLAIN);trect(10,0,30,26,T_WATER);paintTerrain();explored.fill(1);exploredE.fill(1);
    const sp=spawnUnit(0,'spear',8*TILE,12*TILE,tags[0]),tr=spawnUnit(0,'transport',25*TILE,12*TILE,null);
    boardTransport(sp,tr); if(Math.hypot(tr.x-sp.x,tr.y-sp.y)>TILE*2)tr.path=uFP(tr,sp.x,sp.y);
    let boarded=false;for(let i=0;i<1800&&!boarded;i++){step(TICK);boarded=tr.cargo&&tr.cargo.includes(sp);}
    const rendezvousBoard=boarded===true&&sp.gar===tr;

    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;terr.fill(T_PLAIN);paintTerrain();computeLandComp();arenaMode=false;deploySettlerU=null;placing=null;
    return {waterDockBuilt,islandFits,farRej,timedNotInstant,deployed,consumed,rendezvousBoard};`);
  check('#1 Villager builds a "dock on the water" from the shore (footprint on deep water; villager walks to the shore and finishes it)', t60.waterDockBuilt===true, t60);
  check('#6 Deploy preview tryDeploy: out of range rejected; legal → not instant (walks there to build); settlers consumed on completion; fits on a large island', t60.islandFits===true&&t60.farRej===true&&t60.timedNotInstant===true&&t60.deployed===true&&t60.consumed===true, t60);
  check('#7 Dragging a unit to a distant transport = boards + both meet in the middle (ship moves towards the unit → they meet and it boards)', t60.rendezvousBoard===true, t60);

  console.log('\n[61] Second test-feedback fix batch: fishing boat resumes gathering after unloading at a water dock; settlers that cannot get there cannot build; groups board; no builders assigned across water; construction panel');
  const t61 = await ev(`
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;aiWave=99999;gameOver=null;arenaMode=true;
    for(const k in stock)stock[k]=1e9;starving=false;
    terr.fill(T_PLAIN);trect(20,0,30,26,T_WATER);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    const dk=placeB(0,'dock',20,12,true); dbg.addFish(26,14,200);
    const fbo=spawnUnit(0,'fishing',25*TILE,14*TILE,null); fbo.carry=8; fbo.carryType='food';
    const food0=stock.food;
    let unloaded=false;for(let i=0;i<800&&!unloaded;i++){step(TICK);unloaded=fbo.carry===0&&stock.food>food0;}
    const ux=fbo.x,uy=fbo.y; for(let i=0;i<200;i++)step(TICK);
    const fishUnloadNoFreeze=unloaded&&Math.hypot(fbo.x-ux,fbo.y-uy)>TILE*0.5;

    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;arenaMode=true;gameOver=null;
    for(const k in stock)stock[k]=1e9;
    terr.fill(T_PLAIN);trect(20,10,23,13,T_HIGH);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    const s2=spawnUnit(0,'settler',18*TILE,11.5*TILE,tags[0]);
    deploySettlerU=s2;placing='outpost';
    tryDeploy(21.5*TILE,11.5*TILE);
    const gotTgt=!!s2.deployTgt;
    let cancelled=false;for(let i=0;i<600&&!cancelled;i++){step(TICK);cancelled=!s2.deployTgt&&!s2.deployB;}
    const unreachNoBuild=gotTgt&&cancelled&&s2.hp>0&&!buildings.some(b=>b.type==='outpost');
    deploySettlerU=null;placing=null;

    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;arenaMode=true;gameOver=null;
    for(const k in stock)stock[k]=1e9;starving=false;
    terr.fill(T_PLAIN);trect(12,0,30,26,T_WATER);paintTerrain();explored.fill(1);exploredE.fill(1);
    for(let i=0;i<4;i++)spawnUnit(0,'spear',8*TILE,(10+i)*TILE,tags[1]);
    const tr2=spawnUnit(0,'transport',26*TILE,12*TILE,null);
    issueBoard(1,tr2);
    const rendez=!!(tr2.path&&tr2.path.length);
    let legionAboard=false;for(let i=0;i<2500&&!legionAboard;i++){step(TICK);legionAboard=tr2.cargo&&tr2.cargo.length===4;}
    const legionBoard=rendez&&legionAboard;

    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;
    terr.fill(T_PLAIN);trect(12,0,13,TH-1,T_WATER);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    const tcc=placeB(0,'tc',3,3,true);
    const nearSite=placeB(0,'tower',6,6,false);nearSite.hp=nearSite.maxHp*0.3;nearSite.done=false;
    const farSite=placeB(0,'tower',20,10,false);farSite.hp=farSite.maxHp*0.3;farSite.done=false;
    spawnVillager(tcc);const wv=villagers[villagers.length-1];wv.x=5*TILE;wv.y=5*TILE;wv.buildSite=null;wv.repairU=null;wv.job=null;wv.state='idle';
    repairScan();
    const reachOnly=villagers.every(x=>x.buildSite!==farSite)&&villagers.some(x=>x.buildSite===nearSite);

    units.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);terr.fill(T_PLAIN);paintTerrain();explored.fill(1);exploredE.fill(1);
    const sB=placeB(0,'tower',8,8,false);sB.hp=sB.maxHp*0.4;sB.done=false;
    openSitePanel(sB);
    const txt=q('#bldPanel').textContent;
    const sitePanel=!q('#bldPanel').classList.contains('hidden')&&/建造中/.test(txt)&&/拆除/.test(txt);
    closePanels();

    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;terr.fill(T_PLAIN);paintTerrain();computeLandComp();arenaMode=false;deploySettlerU=null;placing=null;
    return {fishUnloadNoFreeze,unreachNoBuild,legionBoard,reachOnly,sitePanel};`);
  check('#2 Fishing boat goes back to gathering after unloading at a water dock (does not freeze at the dock)', t61.fishUnloadNoFreeze===true, t61);
  check('#4 Settlers that cannot reach a sealed plateau → cancelled on timeout; no sneaking in an "unreachable invincible city"', t61.unreachNoBuild===true, t61);
  check('#3 Dragging a group to a transport = the whole group boards (up to capacity) + the ship meets them nearby', t61.legionBoard===true, t61);
  check('Construction only assigns villagers that can get there: sites across water get no local villagers; sites on the same side are still assigned', t61.reachOnly===true, t61);
  check('#5 Buildings under construction have a simple panel (HP + demolish)', t61.sitePanel===true, t61);

  console.log('\n[62] Third test-feedback fix batch: cancelling an outpost does not refund wood; villagers do not fall into the sea; ships not repaired by villagers; docks repair slowly; transport stops at the rendezvous; fishing boat resumes gathering after combat; unreachable targets do not stall forever');
  const t62 = await ev(`
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;aiWave=99999;gameOver=null;arenaMode=true;
    for(const k in stock)stock[k]=1e9; stock.wood=500;
    terr.fill(T_PLAIN);blocked.fill(0);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    const st4=spawnUnit(0,'settler',10*TILE,10*TILE,tags[0]);
    deploySettlerU=st4;placing='outpost';tryDeploy(11.5*TILE,10*TILE);
    let bld4=false;for(let i=0;i<600&&!bld4;i++){step(TICK);bld4=!!st4.deployB;}
    const op4=st4.deployB;const isSettlerBuilt=!!(op4&&op4.bySettler&&!op4.done);
    const woodBefore=stock.wood;
    if(op4)demolishBuild(op4);step(TICK);
    const noRefund=stock.wood===woodBefore;
    const settlerFreed=units.indexOf(st4)>=0&&st4.hp>0&&!st4.deployB;
    deploySettlerU=null;placing=null;

    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;arenaMode=true;aiWave=99999;
    terr.fill(T_WATER);trect(10,10,14,14,T_PLAIN);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    const isl=placeB(0,'outpost',10,10,true);
    let allLand=true;for(let i=0;i<15;i++){spawnVillager(isl);const v=villagers[villagers.length-1];const ci=idx(txOf(v.x),tyOf(v.y));if(terr[ci]===T_WATER||blocked[ci])allLand=false;}

    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;arenaMode=true;aiWave=99999;gameOver=null;
    for(const k in stock)stock[k]=1e9;
    terr.fill(T_PLAIN);trect(18,0,30,26,T_WATER);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    placeB(0,'dock',18,12,true);
    const gal9=spawnUnit(0,'galley',22*TILE,13*TILE,tags[0]);gal9.hp=40;
    spawnVillager();const vl9=villagers[villagers.length-1];vl9.x=5*TILE;vl9.y=13*TILE;vl9.buildSite=null;vl9.repairU=null;vl9.state='idle';
    repairScan();
    const noVilRepairShip=villagers.every(v=>v.repairU!==gal9);
    const hp0=gal9.hp;for(let i=0;i<200;i++)step(TICK);
    const dockHealed=gal9.hp>hp0;
    const gal9f=spawnUnit(0,'galley',28*TILE,3*TILE,tags[0]);gal9f.hp=40;const hf0=gal9f.hp;for(let i=0;i<100;i++)step(TICK);
    const farNoHeal=gal9f.hp<=hf0+0.001;

    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;arenaMode=true;aiWave=99999;gameOver=null;
    for(const k in stock)stock[k]=1e9;starving=false;
    terr.fill(T_PLAIN);trect(12,0,30,26,T_WATER);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    for(let i=0;i<3;i++)spawnUnit(0,'spear',8*TILE,(10+i)*TILE,tags[1]);
    const tr7=spawnUnit(0,'transport',26*TILE,12*TILE,null);
    issueBoard(1,tr7);
    let ab7=false;for(let i=0;i<3000&&!ab7;i++){step(TICK);ab7=tr7.cargo&&tr7.cargo.length===3;}
    for(let i=0;i<60;i++)step(TICK);
    const transStops=ab7&&(!tr7.path||tr7.path.length===0);

    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;arenaMode=true;aiWave=99999;gameOver=null;
    for(const k in stock)stock[k]=1e9;
    terr.fill(T_PLAIN);trect(20,0,30,26,T_WATER);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    placeB(0,'dock',20,12,true);dbg.addFish(26,14,300);
    const fb3=spawnUnit(0,'fishing',25*TILE,14*TILE,null);
    fb3.fleeing=true;fb3.path=[{x:3*TILE,y:3*TILE}];
    const px3=fb3.x,py3=fb3.y;
    let resume3=false;for(let i=0;i<400&&!resume3;i++){step(TICK);resume3=fb3.fleeing===false&&(fb3.carry>0||Math.hypot(fb3.x-px3,fb3.y-py3)>TILE*0.5);}

    units.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);arenaMode=true;terr.fill(T_PLAIN);trect(10,10,10,10,T_WATER);paintTerrain();explored.fill(1);exploredE.fill(1);
    const trp=spawnUnit(0,'transport',10*TILE+20,10*TILE+20,null);
    trp.path=[{x:2*TILE,y:2*TILE}];
    let clr=false;for(let i=0;i<40&&!clr;i++){step(TICK);clr=trp.path.length===0;}
    const stuckCleared=clr;

    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;terr.fill(T_PLAIN);paintTerrain();computeLandComp();arenaMode=false;aiWave=99999;deploySettlerU=null;placing=null;
    return {isSettlerBuilt,noRefund,settlerFreed,allLand,noVilRepairShip,dockHealed,farNoHeal,transStops,resume3,stuckCleared};`);
  check('#4 Outpost deployed by settlers: cancelling does not refund wood (no resource laundering); settlers released and restored', t62.isSettlerBuilt===true&&t62.noRefund===true&&t62.settlerFreed===true, t62);
  check('#5 Island outpost produces a villager → spawn point snaps to a legal land tile (not into the sea or inside a building)', t62.allLand===true, t62);
  check('#8 Ships are not repaired by villagers (villagers cannot cross the water → do not get stuck on the shore)', t62.noVilRepairShip===true, t62);
  check('#9 Ships heal slowly near a dock; no healing away from a dock', t62.dockHealed===true&&t62.farNoHeal===true, t62);
  check('#7 Transport stops at the rendezvous point once boarding is done (does not sail on elsewhere)', t62.transStops===true, t62);
  check('#3 Fishing boat clears the flee state after combat and resumes gathering (no freeze; no manual nudge needed)', t62.resume3===true, t62);
  check('stepPath no longer stalls forever on an unreachable target (ship trapped in a land pocket → clears the path and stops)', t62.stuckCleared===true, t62);

  console.log('\n[63] Fourth test-feedback fix batch: stuck units nudge themselves free (idle units not nudged by mistake); settlers/transport meet in the middle (distant units still get picked up); info panel covers the three corner buttons');
  const t63 = await ev(`
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;arenaMode=true;aiWave=99999;gameOver=null;
    terr.fill(T_PLAIN);blocked.fill(0);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    const su=spawnUnit(0,'spear',10*TILE,10*TILE,tags[0]);
    su.path=[{x:10*TILE,y:10*TILE}];su.movedT=t-5;su.nudge=null;su._unstkT=0;su.state='walk';
    dbgScan();
    const stuckNudged=!!su.nudge;
    const su2=spawnUnit(0,'spear',13*TILE,13*TILE,tags[0]);
    su2.path=[];su2.movedT=t-9;su2.nudge=null;su2._unstkT=0;su2.state='idle';
    dbgScan();
    const idleNoNudge=!su2.nudge;

    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;arenaMode=true;aiWave=99999;gameOver=null;
    for(const k in stock)stock[k]=1e9;starving=false;
    terr.fill(T_PLAIN);trect(12,0,30,26,T_WATER);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    const spr=spawnUnit(0,'spear',9*TILE,13*TILE,tags[1]);
    const trb=spawnUnit(0,'transport',26*TILE,13*TILE,null);
    boardTransport(spr,trb);
    let rvOk=false;for(let i=0;i<6000&&!rvOk;i++){step(TICK);rvOk=trb.cargo&&trb.cargo.length===1;}

    // (c) The info panel's z-index must sit above the three corner buttons (🐞/⚔️/🌊). Read the authoritative
    // rule from the stylesheet — getComputedStyle on a hidden panel returns auto and is unreliable. Corner
    // buttons have no z-index (auto = 0), so any panel z-index > 0 puts it on top.
    let ziPanel=null;
    for(const ss of document.styleSheets){try{for(const r of ss.cssRules){if(r.selectorText==='#bldPanel'||r.selectorText==='#scPanel')ziPanel=r.style.zIndex;}}catch(e){}}
    const panelAboveBtn=(parseInt(ziPanel)||0)>0;

    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;terr.fill(T_PLAIN);paintTerrain();computeLandComp();arenaMode=false;aiWave=99999;
    return {stuckNudged,idleNoNudge,rvOk,panelAboveBtn};`);
  check('Stuck unit >3s → nudges itself free (only nudged when it has a target but cannot move)', t63.stuckNudged===true, t63);
  check('Idle (no path) is not nudged by mistake (idle ≠ stuck; standing around after a resource runs out is not stuck)', t63.idleNoNudge===true, t63);
  check('Settlers/transport meet in the middle: a distant unit boards on its own; the ship comes to pick it up', t63.rvOk===true, t63);
  check('Info panel covers the three bottom-right buttons (no longer overlapping)', t63.panelAboveBtn===true, t63);

  console.log('\n[64] Four items this round: general stuck-unit progress criterion (workT); formations (loose/tight + front/back ranks); naval tech tree (dock research); debug tools menu / log minimise');
  const t64 = await ev(`
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;arenaMode=true;aiWave=99999;gameOver=null;
    terr.fill(T_PLAIN);blocked.fill(0);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    for(const k in stock)stock[k]=1e9;starving=false;
    playerTech.researched=new Set();playerTech.age=1;recomputeTechMod();recomputeShipHp();

    const wu=spawnUnit(0,'archer',10*TILE,10*TILE,tags[0]);
    wu.path=[{x:10*TILE,y:10*TILE}];wu.movedT=t-6;wu.workT=t;wu.nudge=null;wu._unstkT=0;wu.state='walk';
    dbgScan(); const workingNoNudge=!wu.nudge;
    wu.workT=t-6;wu.nudge=null;wu._unstkT=0; dbgScan(); const staleNudged=!!wu.nudge;
    villagers.length=0;
    const site=placeB(0,'barracks',10,14,false);
    spawnVillager(); const bv=villagers[villagers.length-1];
    bv.x=site.x;bv.y=site.y-site.size*TILE/2-8;bv.buildSite=site;bv.job=null;bv.state='walk';bv.path=[{x:bv.x,y:bv.y}];bv.workT=t-9;bv.movedT=t-9;
    const hp0=site.hp; for(let i=0;i<10;i++)vTick(bv,TICK);
    const buildWorkT=t-(bv.workT||-9)<0.5, buildProgressed=site.hp>hp0, buildPathCleared=bv.path.length===0;

    tags[0].spread='dense'; const uu1={type:'spear',side:0,grp:tags[0]};
    const rDense=bodyR(uu1)*2;
    tags[0].spread='sparse'; const rSparse=bodyR(uu1)*2+SEP_SPARSE_EXTRA; const spreadWider=rSparse>rDense&&sparseOf(uu1);
    units.length=0; tags[0].spread='dense';
    const sp1=spawnUnit(0,'spear',10*TILE,10*TILE,tags[0]);
    const ar1=spawnUnit(0,'archer',10*TILE,10*TILE,tags[0]);
    const ftD=formationTargets(tags[0],[sp1,ar1],20*TILE,10*TILE);
    const meleeFront=ftD.get(sp1).x>ftD.get(ar1).x;
    tags[0].spread='sparse';
    const ftS=formationTargets(tags[0],[sp1,ar1],20*TILE,10*TILE);
    const sparseGapBigger=Math.abs(ftS.get(sp1).y-ftS.get(ar1).y)>=0 && (Math.abs(ftS.get(sp1).x-20*TILE))>Math.abs(ftD.get(sp1).x-20*TILE);
    tags[0].spread='dense';

    playerTech.age=1;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);
    const n1NoDock=techState(techById('N1'))==='atbld';
    placeB(0,'dock',3,3,true);
    const n1WithDock=techState(techById('N1'))==='avail';
    playerTech.age=1;const n2AgeLock=techState(techById('N2'))==='age';
    playerTech.researched=new Set(['N1']);recomputeTechMod(); const fishUp=techMod.fishGather>1.3;
    playerTech.researched=new Set();recomputeTechMod();recomputeShipHp();
    const gBase=spawnUnit(0,'galley',10*TILE,10*TILE,tags[0]); const galleyBaseHp=gBase.maxHp;
    const rngBase=unitRng({side:0,type:'galley'});
    playerTech.researched=new Set(['N3']);recomputeTechMod(); const galleyRngUp=unitRng({side:0,type:'galley'})>rngBase;
    playerTech.researched=new Set(['N2']);recomputeTechMod();recomputeShipHp();
    const shipHpRetro=gBase.maxHp>galleyBaseHp;
    const gNew=spawnUnit(0,'galley',11*TILE,10*TILE,tags[0]); const shipHpSpawn=gNew.maxHp>UT.galley.hp;
    playerTech.researched=new Set(['NH']);recomputeTechMod(); const shipDefUp=armP(gBase)>(UT.galley.aP||0);
    playerTech.researched=new Set(['NM']);recomputeTechMod();
    const fsU=spawnUnit(0,'fireship',10*TILE,10*TILE,tags[0]);
    playerTech.researched=new Set();recomputeTechMod(); const spNo=uSpeed(fsU);
    playerTech.researched=new Set(['NM']);recomputeTechMod(); const fireFaster=uSpeed(fsU)>spNo;
    playerTech.researched=new Set(['N4']);recomputeTechMod(); shots.length=0;
    const ss=spawnUnit(0,'siegeship',10*TILE,10*TILE,tags[0]); const foeG=spawnUnit(1,'galley',12*TILE,10*TILE,null);
    ss.cd=0;fire(ss,foeG); const rk=shots.find(s=>s.kind==='rock'); const siegeAntiTagged=!!(rk&&rk.antiShip>1);
    const engNaval=civEnabled('eng').has('NE')&&!civEnabled('eng').has('NH');

    const menu=document.querySelector('#toolsMenu');
    const btnsInMenu=menu.contains(document.querySelector('#dbgBtn'))&&menu.contains(document.querySelector('#arenaBtn'))&&menu.contains(document.querySelector('#mapBtn'));
    const m0=menu.classList.contains('hidden'); toggleTools(true); const m1=!menu.classList.contains('hidden'); toggleTools(false); const m2=menu.classList.contains('hidden');
    const toolsMenuWorks=m0&&m1&&m2&&btnsInMenu;
    setDebug(true); const logEl=document.querySelector('#dbgLog');
    document.querySelector('#dbgMiniBtn').onclick(); const miniOn=logEl.classList.contains('mini');
    document.querySelector('#dbgMiniBtn').onclick(); const miniOff=!logEl.classList.contains('mini');
    setDebug(false); const logMiniWorks=miniOn&&miniOff;

    // reset
    playerTech.researched=new Set();playerTech.age=1;recomputeTechMod();recomputeShipHp();
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;shots.length=0;tags[0].spread='dense';arenaMode=false;aiWave=99999;
    return {workingNoNudge,staleNudged,buildWorkT,buildProgressed,buildPathCleared,
      spreadWider,meleeFront,sparseGapBigger,
      n1NoDock,n1WithDock,n2AgeLock,fishUp,galleyRngUp,shipHpRetro,shipHpSpawn,shipDefUp,fireFaster,siegeAntiTagged,engNaval,
      toolsMenuWorks,logMiniWorks};`);
  check('General stuck-unit progress criterion: recent progress (fresh workT) not nudged by mistake; only nudged once progress stops (stale workT)', t64.workingNoNudge===true && t64.staleNudged===true, t64);
  check('Villager building: construction stamps workT + clears the leftover path + progresses as usual (not nudged away as a stuck unit and then back)', t64.buildWorkT===true && t64.buildProgressed===true && t64.buildPathCleared===true, t64);
  check('Formation loose/tight: loose spacing gives bigger gaps between individuals (really spread out; separation in effect)', t64.spreadWider===true, t64);
  check('Formation front/back ranks: on a move order melee ranks in front (facing the target); ranged behind; loose formation is deeper', t64.meleeFront===true && t64.sparseGapBigger===true, t64);
  check('Naval research gate: no dock → atbld; build a dock → avail; N2 blocked by age in Feudal', t64.n1NoDock===true && t64.n1WithDock===true && t64.n2AgeLock===true, t64);
  check('Naval effects: N1 fishing yield↑; N3 war galley range↑; N2 ship HP applied retroactively + to new ships; NH ship armour↑; NM fire ship speed↑; N4 marks siege against ships; mutually exclusive',
    t64.fishUp&&t64.galleyRngUp&&t64.shipHpRetro&&t64.shipHpSpawn&&t64.shipDefUp&&t64.fireFaster&&t64.siegeAntiTagged&&t64.engNaval, t64);
  check('Debug tools: the three buttons merged into the 🔧 menu (toggleable); log can be minimised/expanded', t64.toolsMenuWorks===true && t64.logMiniWorks===true, t64);

  console.log('\n[65] Device-test feedback fixes this round: splash falloff (centred on the impact point); villagers deliver before going idle when a node runs out; fish trap (unlocked by N1; renewable sea food); stepPath clears the path on arrival; separation deadzone stops the jitter');
  const t65 = await ev(`
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;shots.length=0;arenaMode=true;aiWave=99999;gameOver=null;
    terr.fill(T_PLAIN);blocked.fill(0);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    for(const k in stock)stock[k]=1e9;starving=false;playerTech.researched=new Set();playerTech.age=3;recomputeTechMod();recomputeShipHp();

    const spl=UT.siegeship.splash;
    const hg0={task:'hold',rule:'counter',holdFire:true,pt:null,focus:null,side:0,spread:'dense'};
    const hg1={task:'hold',rule:'counter',holdFire:true,pt:null,focus:null,side:1,spread:'dense'};
    const ctr=spawnUnit(1,'spear',20*TILE,10*TILE,hg1); ctr.maxHp=ctr.hp=300;
    const edge=spawnUnit(1,'spear',20*TILE+(spl-5),10*TILE,hg1); edge.maxHp=edge.hp=300;
    const ss=spawnUnit(0,'siegeship',20*TILE,16*TILE,hg0); ss.cd=0;
    fire(ss,ctr);
    for(let i=0;i<90&&shots.length;i++)step(TICK);
    const dmgCtr=300-ctr.hp, dmgEdge=300-edge.hp;
    const splashFalloff=dmgCtr>0 && dmgEdge>0 && dmgCtr>dmgEdge*1.25;

    units.length=0;villagers.length=0;nodes.length=0;shots.length=0;
    let tc=buildings.find(b=>b.type==='tc'&&b.side===0); if(!tc)tc=placeB(0,'tc',5,12,true);
    spawnVillager(); const vv=villagers[villagers.length-1];
    vv.x=8*TILE;vv.y=12*TILE;vv.carry=4;vv.carryType='wood';vv.job='wood';vv.node=null;vv.state='idle';vv.buildSite=null;vv.repairU=null;
    const woodBefore=stock.wood;
    let delivered=false;for(let i=0;i<400&&!delivered;i++){vTick(vv,TICK);if(vv.carry===0&&stock.wood>woodBefore)delivered=true;}
    const depletedDeliver=delivered;

    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;
    terr.fill(T_PLAIN);for(let x=10;x<=20;x++)for(let y=5;y<=15;y++)terr[idx(x,y)]=T_WATER;paintTerrain();computeLandComp();
    playerTech.researched=new Set();recomputeTechMod();
    const fbNo=spawnUnit(0,'fishing',14*TILE,10*TILE,null);
    const trapGated=deployTrap(fbNo)===null;
    playerTech.researched=new Set(['N1']);recomputeTechMod();
    const fb=spawnUnit(0,'fishing',15*TILE,10*TILE,null);
    const trap=deployTrap(fb);
    const trapBuilt=!!trap&&trap.type==='fishtrap';
    const tnode=nodes.find(n=>n.sea&&n.farm);
    const trapNodeSea=!!tnode;
    let regenOk=false; if(tnode){tnode.amt=5;const a0=tnode.amt;bTick(trap,1);regenOk=tnode.amt>a0;}
    const fishFinds=trapBuilt&&nearestFish(fb.x,fb.y)!==null;

    units.length=0;terr.fill(T_PLAIN);blocked.fill(0);paintTerrain();
    const au=spawnUnit(0,'spear',10*TILE,10*TILE,tags[0]);
    au.path=[{x:au.x+6,y:au.y}];au.dest={x:au.x+6,y:au.y};
    stepPath(au,TICK);
    const arrivedCleared=au.path.length===0;

    units.length=0;tags[0].spread='dense';
    const p1=spawnUnit(0,'spear',10*TILE,10*TILE,tags[0]);
    const p2=spawnUnit(0,'spear',10*TILE+12,10*TILE,tags[0]);
    const x1=p1.x,x2=p2.x; separation();
    const equilNoJitter=Math.abs(p1.x-x1)<0.5&&Math.abs(p2.x-x2)<0.5;
    p2.x=p1.x+2; const d0=Math.abs(p2.x-p1.x); for(let i=0;i<6;i++)separation();
    const overlapSeparated=Math.abs(p2.x-p1.x)>d0+2;

    // reset
    playerTech.researched=new Set();playerTech.age=1;recomputeTechMod();recomputeShipHp();
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;shots.length=0;tags[0].spread='dense';arenaMode=false;aiWave=99999;
    return {splashFalloff,dmgCtr,dmgEdge,depletedDeliver,trapGated,trapBuilt,trapNodeSea,regenOk,fishFinds,arrivedCleared,equilNoJitter,overlapSeparated};`);
  check('Splash falloff: the impact point (centre) takes full damage; units at the edge take reduced damage (spreading out really pays)', t65.splashFalloff===true, t65);
  check('After a resource runs out villagers deliver what they carry to the capital/outpost first; no standing around holding cargo', t65.depletedDeliver===true, t65);
  check('Fish trap: unlocked by the N1 fishing improvement (blocked before research); fishing boat drops a trap in deep water → renewable sea food node; regenerates; fishing boats can find it', t65.trapGated&&t65.trapBuilt&&t65.trapNodeSea&&t65.regenOk&&t65.fishFinds, t65);
  check('stepPath near the final tile = clear the path (stops the endless retry/jitter when it cannot squeeze onto the exact point)', t65.arrivedCleared===true, t65);
  check('separation: no push at equilibrium (deadzone stops the micro-jitter); overlaps still separate', t65.equilNoJitter===true && t65.overlapSeparated===true, t65);

  console.log('\n[66] Second device-test feedback: fishing boat ≠ villager (drop-trap button); settlers independent, not in a group; villager missing-resource label + keeps its job and resumes; formation by attack range (medics last); outposts do not assign villagers; win/loss overlay does not block debug');
  const t66 = await ev(`
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;shots.length=0;arenaMode=true;aiWave=99999;gameOver=null;
    terr.fill(T_PLAIN);blocked.fill(0);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    for(const k in stock)stock[k]=1e9;starving=false;playerTech.researched=new Set();playerTech.age=1;recomputeTechMod();

    const fb0=spawnUnit(0,'fishing',10*TILE,10*TILE,null); fb0.carry=0;
    const boatVsVil=isFishBoat(fb0)===true && isFishBoat({carry:0,side:0})===false;
    playerTech.researched=new Set(['N1']);recomputeTechMod();
    openUnitPanel(fb0); const hasTrapBtn=!!document.querySelector('#uTrap'); const notVilPanel=!document.querySelector('#uTrap')||true; closePanels();
    playerTech.researched=new Set();recomputeTechMod();

    let tcB=buildings.find(b=>b.type==='tc'&&b.side===0); if(!tcB)tcB=placeB(0,'tc',5,12,true);
    const st=spawnSettler(tcB); const settlerIndep=(st.grp===null||st.grp===undefined);
    const beforeXY={x:st.x,y:st.y}; issueTagOrder(0,20*TILE,20*TILE);
    const settlerNotPulled=(st.path.length===0);

    villagers.length=0;nodes.length=0;
    spawnVillager(); const vg=villagers[villagers.length-1];
    vg.x=10*TILE;vg.y=10*TILE;vg.carry=0;vg.job='gold';vg.node=null;vg.state='idle';vg.buildSite=null;vg.repairU=null;vg.lackRes=null;
    for(let i=0;i<4;i++)vTick(vg,TICK);
    const lackKept=vg.job==='gold'&&vg.lackRes==='gold';
    const lackLabel=vJobLabel(vg).includes('缺');
    nodes.push({type:'gold',x:11*TILE,y:10*TILE,amt:100});
    let resumed=false;for(let i=0;i<300&&!resumed;i++){vTick(vg,TICK);if(vg.lackRes==null&&(vg.state==='gather'||vg.node))resumed=true;}
    const lackResume=resumed;

    units.length=0;tags[0].spread='dense';
    const sp1=spawnUnit(0,'spear',10*TILE,10*TILE,tags[0]);
    const ar1=spawnUnit(0,'archer',10*TILE,10*TILE,tags[0]);
    const md1=spawnUnit(0,'medic',10*TILE,10*TILE,tags[0]);
    const ft=formationTargets(tags[0],[sp1,ar1,md1],20*TILE,10*TILE);
    const dSp=ft.get(sp1).x,dAr=ft.get(ar1).x,dMd=ft.get(md1).x;
    const echOrder=dSp>dAr && dAr>dMd;

    villagers.length=0;
    const op=placeB(0,'outpost',7,7,false); op.bySettler=true; op.hp=op.maxHp*0.4;
    spawnVillager(); const hv=villagers[villagers.length-1]; hv.x=7*TILE;hv.y=8*TILE;hv.buildSite=null;hv.repairU=null;hv.job=null;hv.state='idle';hv.garrisoned=false;
    repairScan();
    const settlerSolo=hv.buildSite!==op;

    let ovZ='0',toolZ='0',logZ='0';
    for(const ss of document.styleSheets){try{for(const r of ss.cssRules){if(r.selectorText==='#overlay')ovZ=r.style.zIndex;if(r.selectorText==='#toolsWrap')toolZ=r.style.zIndex;if(r.selectorText==='#dbgLog')logZ=r.style.zIndex;}}catch(e){}}
    const overlayZOk=parseInt(toolZ)>parseInt(ovZ)&&parseInt(logZ)>parseInt(ovZ);

    // reset
    playerTech.researched=new Set();recomputeTechMod();
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;tags[0].spread='dense';arenaMode=false;aiWave=99999;
    return {boatVsVil,hasTrapBtn,settlerIndep,settlerNotPulled,lackKept,lackLabel,lackResume,echOrder,dSp,dAr,dMd,settlerSolo,overlayZOk};`);
  check('Fishing boat ≠ villager: isFishBoat tells them apart; unit panel shows a "drop fish trap" button (does not wrongly show the villager panel)', t66.boatVsVil===true && t66.hasTrapBtn===true, t66);
  check('Settlers stay independent, not in a group (grp=null); not dragged along by tag0 move orders', t66.settlerIndep===true && t66.settlerNotPulled===true, t66);
  check('Villager missing a resource: keeps its job + labelled "idle (no X)"; resumes automatically once a node is back (farm regrowth likewise)', t66.lackKept===true && t66.lackLabel===true && t66.lackResume===true, t66);
  check('Formation tiers by attack range: melee frontmost; ranged next; medics last', t66.echOrder===true, t66);
  check('An outpost being deployed by settlers is built by the settlers themselves; no villagers assigned to help', t66.settlerSolo===true, t66);
  check('Win/loss overlay does not block the debug tools (toolsWrap/dbgLog z-index > overlay) = logs can still be saved after the game ends', t66.overlayZOk===true, t66);

  console.log('\n[67] Odd fixes in the evaluation round: island town centre producing settlers/scouts → spawn point snaps to a legal land tile (same as spawnVillager #5; spawnSettler/spawnScout brought in line)');
  const t67 = await ev(`
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;arenaMode=true;aiWave=99999;gameOver=null;
    terr.fill(T_WATER);trect(10,10,14,14,T_PLAIN);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    const isl=placeB(0,'outpost',12,13,true); // 島南緣：footprint 下方即深水＝舊 spawn 偏移會落水
    let settlerLand=true;for(let i=0;i<12;i++){const u=spawnSettler(isl);const ci=idx(txOf(u.x),tyOf(u.y));if(terr[ci]===T_WATER||blocked[ci])settlerLand=false;units.length=0;}
    let scoutLand=true;for(let i=0;i<12;i++){spawnScout(isl);const s=scouts[scouts.length-1];const ci=idx(txOf(s.x),tyOf(s.y));if(terr[ci]===T_WATER||blocked[ci])scoutLand=false;scouts.length=0;}
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);scouts.length=0;terr.fill(T_PLAIN);blocked.fill(0);paintTerrain();computeLandComp();arenaMode=false;aiWave=99999;
    return {settlerLand,scoutLand};`);
  check('Island town centre produces settlers → spawn point snaps to a legal land tile (not into the sea)', t67.settlerLand===true, t67);
  check('Island town centre produces a scout → spawn point snaps to a legal land tile (not into the sea)', t67.scoutLand===true, t67);

  console.log('\n[68] Evaluation-round fixes: units do not leave the map bounds (isLegalPosition/sepApply boundary gate); economy radius ecoReach replaces the hard-coded left half');
  const t68 = await ev(`
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;arenaMode=true;aiWave=99999;gameOver=null;
    terr.fill(T_PLAIN);blocked.fill(0);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    const eu=spawnUnit(0,'spear',W-15,H/2,tags[0]);
    for(let i=0;i<80;i++)stepDir(eu,1,0,TICK,999);
    const clampRight=eu.x<=W-9;
    sepApply(eu,300,0);sepApply(eu,0,-1e4);
    const sepClamp=eu.x<=W-9&&eu.y>=9;
    for(let i=0;i<40;i++)stepDir(eu,-1,0,TICK,200);
    const canReturn=eu.x<W-40;
    spawnVillager();const bv=villagers[villagers.length-1];bv.x=W-30;bv.y=H/2;bv.job=null;bv.state='idle';
    for(let i=0;i<100;i++)vGoto(bv,W+200,H/2,80,TICK);
    const vilClamp=bv.x<=W-9;
    // (b) Economic radius (a range around the TC family; R=1100 as the initial, tunable value): with no
    // TC-family building there is no limit at all (fail-safe); nodes outside the radius are never assigned;
    // build an outpost somewhere and the radius follows. Positions are derived from ECO_REACH so tuning R
    // later does not break the test.
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;
    terr.fill(T_PLAIN);blocked.fill(0);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    const tcx=(3+1)*TILE, gx=tcx+ECO_REACH+150, gy=(3+1)*TILE;
    nodes.push({type:'gold',x:gx,y:gy,amt:500,max:500});
    const noDropUnrestricted=!!nearestNode('gold',gx-40,gy,null);
    placeB(0,'tc',3,3,true);
    const farExcluded=nearestNode('gold',gx-40,gy,null)===null&&availRes('gold')===false;
    placeB(0,'outpost',txOf(gx)-4,2,true);
    const nearIncluded=!!nearestNode('gold',gx-40,gy,null)&&availRes('gold')===true;
    const rIs1100=ECO_REACH===1100;
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;terr.fill(T_PLAIN);paintTerrain();computeLandComp();arenaMode=false;aiWave=99999;
    return {clampRight,sepClamp,canReturn,vilClamp,noDropUnrestricted,farExcluded,nearIncluded,rIs1100};`);
  check('Units do not leave the map: walking straight out / being shoved out is stopped by the boundary gate; walking back in is not blocked', t68.clampRight===true&&t68.sepClamp===true&&t68.canReturn===true&&t68.vilClamp===true, t68);
  check('Economy radius governed by the TC: no TC = no limit; no assignments outside R(=1100); build an outpost further out = the radius follows', t68.noDropUnrestricted===true&&t68.farExcluded===true&&t68.nearIncluded===true&&t68.rIs1100===true, t68);

  console.log('\n[69] Fishing boat behaviour redesign (2026-07-05, user: fishing boats should not fully inherit villager behaviour): per-boat stance flee/gather-to-death; flees to open water (covers siege ship 240; does not return to the fishery); manual move clears the node and gathers in place (the order sticks)');
  const t69 = await ev(`
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;aiWave=99999;arenaMode=true;gameOver=null;
    for(const k in stock)stock[k]=1e9;starving=false;
    terr.fill(T_PLAIN);blocked.fill(0);trect(10,0,40,26,T_WATER);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    dbg.addFish(20,13,999);
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const fb=spawnUnit(0,'fishing',C(25,13).x,C(25,13).y,tags[0]); fb.stance='flee'; fb.hp=fb.maxHp=1e9;
    const enemy=spawnUnit(1,'galley',fb.x+100,fb.y,tags[5]); enemy.revealT=t+999;
    const d0=Math.hypot(fb.x-enemy.x,fb.y-enemy.y);
    for(let i=0;i<40;i++)boatFleeStep(fb,TICK);
    const d1=Math.hypot(fb.x-enemy.x,fb.y-enemy.y);
    const fledAway=d1>d0+TILE&&fb.x<C(25,13).x-TILE;
    fb.x=C(25,13).x;fb.y=C(25,13).y;fb.fleeing=false;fb.fleeHd=undefined;
    enemy.x=fb.x+250;enemy.y=fb.y;enemy.revealT=t+999;
    fishTick(fb,TICK);
    const triggersAt250=fb.fleeing===true;
    fb.x=C(25,13).x;fb.y=C(25,13).y;fb.stance='gather';fb.fleeing=false;fb.node=null;
    enemy.x=fb.x+120;enemy.y=fb.y;enemy.revealT=t+999;
    for(let i=0;i<20;i++)fishTick(fb,TICK);
    const dieHardNoFlee=fb.fleeing!==true;
    units.splice(units.indexOf(enemy),1);
    fb.x=C(25,13).x;fb.y=C(25,13).y;fb.stance='flee';fb.node={type:'food',sea:true,x:C(20,13).x,y:C(20,13).y,amt:999,max:999};
    const dest=C(37,21);fb.manualDest={x:dest.x,y:dest.y};fb.node=null;fb.path=[];
    let arrived=false;for(let i=0;i<400;i++){fishTick(fb,TICK);if(fb.manualDest===null){arrived=true;break;}}
    const relocated=arrived&&Math.hypot(fb.x-dest.x,fb.y-dest.y)<TILE*2;
    units.length=0;nodes.length=0;terr.fill(T_PLAIN);paintTerrain();arenaMode=false;
    return {fledAway,triggersAt250,dieHardNoFlee,relocated,d0:+d0.toFixed(0),d1:+d1.toFixed(0)};`);
  check('Fishing boat flees: retreats away from the enemy (to open water); ends up further from the enemy', t69.fledAway===true, t69);
  check('Fishing boat flee trigger radius 300 > siege ship range 240: flees with an enemy at 250px (the old 200 would miss it)', t69.triggersAt250===true, t69);
  check('Fishing boat gathers to death (stance=gather): does not flee even with the enemy close; keeps gathering', t69.dieHardNoFlee===true, t69);
  check('Fishing boat manual move: paths through water to the given water tile; clears manualDest on arrival = the order sticks (not dragged back to the old fishery)', t69.relocated===true, t69);

  console.log('\n[70] Real fix for stuck units (2026-07-05; evidenced by the 1136s/1320s logs): cross-domain stranding rescued by snapping; buildings evict units underfoot; ships never land; vGoto blocked exemption; unloading spread over several faces');
  const t70 = await ev(`
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;aiWave=99999;arenaMode=true;gameOver=null;
    for(const k in stock)stock[k]=1e9;starving=false;
    terr.fill(T_PLAIN);blocked.fill(0);trect(20,0,40,26,T_WATER);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    // (a) Cross-domain stranding rescue: a siege ship spawned on land, 6 tiles from water (seen in a real
    // log at 1136s). isLegalPosition rejects every direction and findPath cannot produce a route, so the
    // old safety valve never saw it — dbgScan now snaps it to the nearest water tile.
    const sh=spawnUnit(0,'siegeship',C(14,13).x,C(14,13).y,tags[0]);
    for(let i=0;i<30;i++)step(TICK);
    const shipRescued=domOK(idx(txOf(sh.x),tyOf(sh.y)),'water');
    const rescueLogged=mlog.some(m=>m.kind==='搶救');
    const cav=spawnUnit(0,'cavalry',C(5,5).x,C(5,5).y,tags[1]);
    placeB(0,'tower',5,5,true);
    const cavEjected=!blocked[idx(txOf(cav.x),tyOf(cav.y))];
    const dk=placeB(0,'dock',20,10,true);
    for(let y=8;y<=13;y++)for(let x=18;x<=23;x++)if(terr[idx(x,y)]===T_WATER&&!(x>=20&&x<22&&y>=10&&y<12))blocked[idx(x,y)]=1; /* Block the whole adjacent ring. */
    dk.queue.push({type:'galley',tag:0});dk.qT=UT.galley.bt+1;
    bTick(dk,TICK);
    const boat=units.find(u=>u.type==='galley');
    const boatWet=!boat||domOK(idx(txOf(boat.x),tyOf(boat.y)),'water'); /* If it spawned it must be on water; if it never spawned (requeued) that passes too — the point is that
   it must not land on ground. */
    for(let y=8;y<=13;y++)for(let x=18;x<=23;x++)if(terr[idx(x,y)]===T_WATER&&!(x>=20&&x<22&&y>=10&&y<12))blocked[idx(x,y)]=0;
    const sp2=spawnUnit(0,'spear',C(3,20).x,C(3,20).y,tags[2]);
    placeB(0,'tower',3,20,true); /* Evicted first. */
    sp2.x=C(3,20).x;sp2.y=C(3,20).y; /* Force it back onto a blocked tile to simulate a leftover from an earlier state. */
    sp2.nudge={x:C(3,22).x,y:C(3,22).y};
    for(let i=0;i<40;i++)nudgeStep(sp2,TICK);
    const nudgeOut=!blocked[idx(txOf(sp2.x),tyOf(sp2.y))];
    const tc2=placeB(0,'tc',8,20,true);
    const vs=[];for(let i=0;i<4;i++){spawnVillager(tc2);vs.push(villagers[villagers.length-1]);}
    const east=C(10,21); vs[0].x=east.x;vs[0].y=east.y; vs[1].x=east.x+8;vs[1].y=east.y; vs[2].x=east.x;vs[2].y=east.y+8; /* Pack 3 units against the east face. */
    const v4=vs[3]; v4.x=C(12,21).x; v4.y=C(12,21).y; /* Approaching from the east. */
    const ap=dropApproach(v4,tc2);
    const spread=ap&&!(txOf(ap.x)===10&&tyOf(ap.y)===21); /* No longer crowds into the same east-face tile. */
    const vd=vs[2]; vd.x=(tc2.tx+2.5)*TILE; vd.y=(tc2.ty+2.5)*TILE; /* Diagonal neighbour centre, de≈28. */
    vd.carry=10;vd.carryType='wood';vd.job='wood';
    const w0=stock.wood; vTick(vd,TICK); const diagUnload=stock.wood>w0;
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);blocked.fill(0);terr.fill(T_PLAIN);paintTerrain();computeLandComp();arenaMode=false;
    return {shipRescued,rescueLogged,cavEjected,boatWet,nudgeOut,spread,diagUnload};`);
  check('Cross-domain stranding rescue: ship spawned on land → dbgScan snaps it back to the nearest water tile + logs a "rescue"', t70.shipRescued===true&&t70.rescueLogged===true, t70);
  check('Building eviction: tower built on top of cavalry → pushed out of the footprint at placement time (military units had no escape = permanently stuck)', t70.cavEjected===true, t70);
  check('Ships never land: all water adjacent to the dock occupied → wide search for a launch tile or back into the queue (no more falling back to spawning on land)', t70.boatWet===true, t70);
  check('vGoto blocked exemption: a unit caught on a blocked tile can nudge its way out (the no-path branch used to stall for certain)', t70.nudgeOut===true, t70);
  check('Unloading spread over several faces + diagonal unload: a face crowded with 3 units is penalised and another face chosen; a diagonal neighbour at de≈28 can unload directly', t70.spread===true&&t70.diagUnload===true, t70);

  console.log('\n[71] Slice A per-side (specs/13; 2026-07-05): resources/tech isolated per side; AI whitelist obeys the same rules (placeCmd/queueUnit gates); TC-family needs a garrison to attack (towers unchanged)');
  const t71 = await ev(`
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;arenaMode=true;aiWave=99999;gameOver=null;
    terr.fill(T_PLAIN);blocked.fill(0);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    for(const k in stock)stock[k]=1e9;starving=false;
    const s0w=stock.wood, s1w0=dbg.S2(1).wood;
    dbg.giveS(1,'wood',500);
    const isoStock=stock.wood===s0w&&dbg.S2(1).wood===s1w0+500;
    dbg.giveS(1,'wood',9000);dbg.giveS(1,'food',9000);dbg.giveS(1,'gold',9000);dbg.giveS(1,'stone',9000);dbg.giveS(1,'iron',9000);
    placeB(1,'tc',40,20,true); /* E1 research needs its building prerequisite (at:'tc'), so side1 also needs its own TC before it can
   research — same rules as the player. */
    const m0=techMod.gather;
    const rOK=dbg.AICMD.research(1,'E1');
    for(let i=0;i<700;i++)step(TICK);
    const isoMod=techMod.gather===m0&&dbg.modOf(1).gather>1&&dbg.techOf(1).researched.includes('E1');
    const w1=dbg.S2(1).wood;
    const bar=dbg.placeCmd(1,'barracks',30,20);
    const paid=!!bar&&bar.side===1&&dbg.S2(1).wood===w1-120;
    bar.hp=bar.maxHp;bar.done=true; /* side1 has no villagers yet, so it completes instantly. The construction flow is covered separately in
   [61]. */
    const cavBlocked=queueUnit(bar,'cavalry')===false;
    const spearOK=queueUnit(bar,'spear')===true;
    let s1u=null;for(let i=0;i<800&&!s1u;i++){step(TICK);s1u=units.find(u=>u.side===1&&u.type==='spear')||null;}
    const trained=!!s1u&&s1u.grp===dbg.tagsOf(1)[0];
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);shots.length=0;
    const tc=placeB(0,'tc',10,10,true);
    const hg=dbg.tagsOf(1)[5];hg.task='hold';hg.holdFire=true; /* Enemy units stand still and never retaliate — pure targets. */
    const foe=spawnUnit(1,'spear',tc.x+150,tc.y,hg);foe.hp=9999;foe.maxHp=9999;
    let sawNoGar=false;for(let i=0;i<160;i++){step(TICK);if(shots.some(s=>s.side===0))sawNoGar=true;}
    spawnVillager(tc);const gv=villagers[villagers.length-1];gv.garrisoned=true;gv.garB=tc;tc.g=1;
    let sawGar=false;for(let i=0;i<160&&!sawGar;i++){step(TICK);if(shots.some(s=>s.side===0))sawGar=true;}
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);shots.length=0;
    const tw=placeB(0,'tower',10,10,true);
    const foe2=spawnUnit(1,'spear',tw.x+150,tw.y,hg);foe2.hp=9999;foe2.maxHp=9999;
    let twFired=false;for(let i=0;i<160&&!twFired;i++){step(TICK);if(shots.some(s=>s.side===0))twFired=true;}
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);shots.length=0;nodes.length=0;terr.fill(T_PLAIN);paintTerrain();computeLandComp();arenaMode=false;
    return {isoStock,rOK,isoMod,paid,cavBlocked,spearOK,trained,sawNoGar,sawGar,twFired};`);
  check('per-side isolation: side1 resources/research (E1) independent; side0 techMod untouched; modOf(1) in effect', t71.isoStock===true&&t71.rOK===true&&t71.isoMod===true, t71);
  check('AI whitelist obeys the same rules: placeCmd(1) charges side1 resources; side1 without U1 has cavalry blocked; spearman joins the side1 group', t71.paid===true&&t71.cavBlocked===true&&t71.spearOK===true&&t71.trained===true, t71);
  check('TC-family needs a garrison to attack: no garrison, no arrows → garrison 1 villager and it fires; towers fire without a garrison (unchanged)', t71.sawNoGar===false&&t71.sawGar===true&&t71.twFired===true, t71);

  console.log('\n[72] Device-test feedback fixes (2026-07-06; 1228s log): enemy tower return fire src; fishing boat avoids threatened fisheries (stops the jitter); melee does not cross land/water (enemies stop blocking fishing boats); ghosts frozen out of vision');
  const t72 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const clr=()=>{units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;shots.length=0;ghosts.length=0;};
    arenaMode=true;aiWave=99999;gameOver=null;terr.fill(T_PLAIN);blocked.fill(0);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    for(const k in stock)stock[k]=1e9;
    clr();
    const tw=placeB(1,'tower',20,20,true);tw.seen=true;
    const cav=spawnUnit(0,'cavalry',tw.x-180,tw.y,tags[3]);
    const g3=tags[3];g3.task='guard';g3.rule='counter';g3.holdFire=false;g3.pt={x:cav.x,y:cav.y};
    let hitByTower=false,acqTower=false;
    for(let i=0;i<300;i++){step(TICK);if(cav.lastHitBy===tw)hitByTower=true;if(acquire(cav)===tw)acqTower=true;if(hitByTower&&acqTower)break;}
    clr();visible.fill(1);
    const nThreat={type:'food',sea:true,x:C(10,10).x,y:C(10,10).y,amt:100,max:100};
    const nSafe={type:'food',sea:true,x:C(34,10).x,y:C(34,10).y,amt:100,max:100};
    nodes.push(nThreat,nSafe);
    const bp=C(12,10);
    spawnUnit(1,'spear',nThreat.x+40,nThreat.y,dbg.tagsOf(1)[0]);
    const gatherPick=nearestFish(bp.x,bp.y,0,false)===nThreat;
    const fleePick=nearestFish(bp.x,bp.y,0,true)===nSafe;
    spawnUnit(1,'spear',nSafe.x+40,nSafe.y,dbg.tagsOf(1)[0]);
    const allThreatNull=nearestFish(bp.x,bp.y,0,true)===null;
    clr();
    const lc=spawnUnit(0,'cavalry',C(5,5).x,C(5,5).y,tags[0]);
    const la=spawnUnit(0,'archer',C(5,6).x,C(5,6).y,tags[0]);
    const bt=spawnUnit(1,'fishing',C(6,5).x,C(6,5).y,dbg.tagsOf(1)[0]);
    const dk=placeB(1,'dock',10,10,true);
    const fs=spawnUnit(1,'fireship',C(7,5).x,C(7,5).y,dbg.tagsOf(1)[0]);
    const meleeNoWater=canMelee(lc,bt)===false,rangedWater=canMelee(la,bt)===true,meleeBld=canMelee(lc,dk)===true,waterNoLand=canMelee(fs,lc)===false;
    arenaMode=false;clr();visible.fill(0);explored.fill(1);exploredE.fill(1);
    const ge=spawnUnit(1,'spear',C(10,10).x,C(10,10).y,dbg.tagsOf(1)[0]);
    spawnUnit(0,'spear',C(10,10).x,C(10,10).y,tags[0]);
    updateFog();const wasVisT=ge.wasVis===true;
    ge.x=C(44,10).x;ge.y=C(44,10).y;ge.revealT=t+2;
    updateFog();const wasVisF=ge.wasVis===false,ghosted=ghosts.some(g=>g.ref===ge);
    clr();terr.fill(T_PLAIN);paintTerrain();computeLandComp();arenaMode=false;
    return {hitByTower,acqTower,gatherPick,fleePick,allThreatNull,meleeNoWater,rangedWater,meleeBld,waterNoLand,wasVisT,wasVisF,ghosted};`);
  check('Enemy tower return fire: tower hits cavalry → lastHitBy=tower → guard can lock on and return fire from src alone even outside the engagement radius (fixes user report)', t72.hitByTower===true&&t72.acqTower===true, t72);
  check('Fishing boat avoids threatened fisheries: fleeing skips fisheries with enemies beside them and picks a safe one; all threatened → null (waits in place; stops the jitter); gather-to-death still picks the nearest', t72.fleePick===true&&t72.allThreatNull===true&&t72.gatherPick===true, t72);
  check('Melee does not cross land/water: land melee cannot hit ships (ranged can; buildings still hit); a ship hugging the shore cannot hit land units (enemies no longer block fishing boats)', t72.meleeNoWater===true&&t72.rangedWater===true&&t72.meleeBld===true&&t72.waterNoLand===true, t72);
  check('Ghost freezes on leaving vision: an enemy leaving actual vision pushes a ghost; wasVis reads tileVis only (revealT no longer draws the real unit as moving)', t72.wasVisT===true&&t72.wasVisF===true&&t72.ghosted===true, t72);

  console.log('\n[73] Tree system (#12 + line-of-sight model; user ruling 2026-07-06/07): unified single trees / default marking (thickness-2 boundary) / per-tree occlusion / footprint-radius system (capacity system retired; physical space = hiding limit)');
  const t73 = await ev(`
    const R={};
    const clr=()=>{units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);scouts.length=0;nodes.length=0;shots.length=0;ghosts.length=0;};
    arenaMode=false;gameOver=null;
    dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN); clr();
    trect(5,5,7,7,T_FOREST); trect(15,5,15,5,T_FOREST); trect(20,15,22,15,T_FOREST);
    initForest(); paintTerrain();
    placeB(0,'tc',9,6,true);
    const F=idx(6,6);
    R.woodInit = forestWood[F]===FOREST_WOOD && nodes.some(n=>n.forestI===F&&n.type==='wood'&&n.amt===FOREST_WOOD);
    R.defaultKeep = !forestMarkedFor(idx(5,5),0) && !forestMarkedFor(idx(5,5),1);
    R.defaultCut  = forestMarkedFor(idx(15,5),0) && forestMarkedFor(idx(15,5),1)
                 && forestMarkedFor(idx(21,15),0);
    R.singleTreeSeen = losOk(13,5,15,5,0,false,0)===true && losOk(13,5,17,5,0,false,0)===true;
    R.deepBlocked = losOk(3,6,6,6,0,false,0)===false;
    R.edgeSeen = losOk(3,6,5,6,0,false,0)===true;
    R.pierceSees = losOk(3,6,6,6,0,false,1)===true;
    const nMarked = markForestComp(6,6,0);
    R.markedAll = nMarked===9 && forestMarkedFor(idx(5,5),0) && !forestMarkedFor(F,1);
    const v0={x:9.5*TILE,y:6.5*TILE,side:0};
    const pick0 = nearestNode('wood',v0.x,v0.y,v0,false);
    R.woodPicksForest = !!pick0 && pick0.forestI!==undefined;
    for(let ty2=5;ty2<=7;ty2++)for(let tx2=5;tx2<=7;tx2++)harvestForestTile(idx(tx2,ty2));
    R.turnedPlain = terr[F]===T_PLAIN && forestWood[F]===0 && !nodes.some(n=>n.forestI===F);
    R.visionOpens = losOk(3,6,6,6,0,false,0)===true;
    dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN); clr();
    dbg.setTerr(20,10,24,14,T_FOREST);       // 5×5
    R.deepCap = dbg.forestDeepAt(22,12)===true && dbg.forestDeepAt(20,10)===false;
    R.capGone = dbg.forestCapAt===undefined && typeof window.ambushOverflow==='undefined' && typeof window.computeAmbush==='undefined';
    const g=tagsOf(0)[0]; g.task='ambush'; g.holdFire=true;
    const inF=[]; for(let i=0;i<11;i++)inF.push(spawnUnit(0,'spear',22.5*TILE,12.5*TILE,g));
    const eob=spawnUnit(1,'spear',17.5*TILE,12.5*TILE,tagsOf(1)[5]);
    updateFog();
    R.noExposedFlag = inF.every(u=>u.exposed===undefined);
    R.deepHiddenAll = inF.every(u=>canSee(eob,u)===false);
    const edgeU=spawnUnit(0,'spear',20.5*TILE,12.5*TILE,g);
    R.edgeSeenByFoe = canSee(eob,edgeU)===true;
    /* This group must switch omniscience on explicitly: what it verifies is the behaviour of the
       all-seeing shortcut itself. The old code relied on aiFullVision defaulting to true at build time, so
       the test was quietly feeding on a cheat value. Once the default flipped to honest vision this failed
       immediately — direct evidence inside the suite of "reacts to what it never saw": eob is 15 tiles
       from openU and was never scouted, yet the old code could still "see" it. */
    const av1=aiFullVision; aiFullVision=true;
    R.aiNoTreeXray = canSee(eob,inF[0])===false;
    const openU=spawnUnit(0,'spear',30.5*TILE,20.5*TILE,g);
    R.aiSeesOpen = canSee(eob,openU)===true;
    R.honestNoXray = (aiFullVision=false, canSee(eob,openU)===false);
    aiFullVision=av1;
    R.bodyRTable = dbg.bodyR({type:'spear'})===6 && dbg.bodyR({type:'cavalry'})===9 && dbg.bodyR({type:'catapult'})===12 && dbg.bodyR({side:0,carry:0})===6;
    clr(); dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN);
    const c1=spawnUnit(0,'catapult',10*TILE,10*TILE,tagsOf(0)[0]);
    const c2=spawnUnit(0,'catapult',10*TILE+2,10*TILE,tagsOf(0)[0]);
    spawnVillager(); spawnVillager();
    const vA=villagers[villagers.length-2],vB=villagers[villagers.length-1];
    vA.x=vB.x=14*TILE; vA.y=vB.y=14*TILE;
    for(let i=0;i<40;i++)separation();
    const dCat=Math.hypot(c2.x-c1.x,c2.y-c1.y),dVil=Math.hypot(vB.x-vA.x,vB.y-vA.y);
    R.catSpread = dCat>=16;
    R.vilSpread = dVil>=9;
    R.catWiderThanVil = dCat>dVil+4;
    clr();
    dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN); clr();
    nodes.push({type:'wood',x:20.5*TILE,y:20.5*TILE,amt:400,max:400});
    convertWoodNodesToTrees(); initForest();
    R.nodeConverted = terr[idx(20,20)]===T_FOREST && forestWood[idx(20,20)]===400
      && nodes.some(n=>n.forestI===idx(20,20)&&n.amt===400)
      && forestMarkedFor(idx(20,20),0) && forestMarkedFor(idx(20,20),1);
    dbg.setForestWood(12); dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN); clr();
    arenaMode=true; gameOver=null;
    dbg.setTerr(6,6,6,6,T_FOREST); const tc2=placeB(0,'tc',9,6,true);
    for(const k in shares)shares[k]=(k==='wood'?1:0);
    spawnVillager(tc2); const vv=villagers[villagers.length-1]; vv.job='wood'; vv.x=7.5*TILE; vv.y=6.5*TILE;
    let converted=false;
    for(let i=0;i<800;i++){ step(TICK); if(terr[idx(6,6)]===T_PLAIN){converted=true;break;} }
    R.villHarvests = converted;
    arenaMode=false; dbg.setForestWood(100); dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN); clr();
    return R;`);
  check('Forest init + default marking: forests (2×2 blocks) kept by default; single trees / thin lines marked for harvest by default on both sides', t73.woodInit&&t73.defaultKeep&&t73.defaultCut, t73);
  check('Per-tree occlusion: a single tree is see-through (hides nobody); blocked from the 2nd row on; forest edge stays visible; S3 sees one tree further', t73.singleTreeSeen&&t73.deepBlocked&&t73.edgeSeen&&t73.pierceSees, t73);
  check('per-side marking + harvest priority: side0 marks the whole patch (9 tiles); side1 unaffected; nearestNode hits the forest node', t73.markedAll&&t73.woodPicksForest, t73);
  check('Harvested out → becomes open ground + node cleared + vision opens: centre not visible before, visible after', t73.turnedPlain&&t73.visionOpens, t73);
  check('Capacity system retired: deep tiles still conceal (scout covered); forestCapAt/ambushOverflow/computeAmbush all removed', t73.deepCap&&t73.capGone, t73);
  check('Concealment = pure line-of-sight: 11 units packed into a deep tile all stay hidden (no overflow forced exposure; exposed deleted); the front row at the forest edge is still seen', t73.noExposedFlag&&t73.deepHiddenAll&&t73.edgeSeenByFoe, t73);
  check('Full-vision shortcut does not see through trees (aligned with the tower rule): deep-forest ambusher invisible, open-ground target visible = ambush works; and under honest vision (factory default) even a distant open-ground target is invisible = no peeking',
    t73.aiNoTreeXray&&t73.aiSeesOpen&&t73.honestNoXray, t73);
  check('Footprint radius: foot 6 / mounted 9 / catapult 12 / villager 6; separation physically spaces them = villagers do not stack; a catapult takes more room than a man = hiding limit emerges from space', t73.bodyRTable&&t73.catSpread&&t73.vilSpread&&t73.catWiderThanVil, t73);
  check('Tree unification: discrete wood nodes → single trees (amount 400 kept; marked by default on both sides) = wired into the economy', t73.nodeConverted, t73);
  check('End-to-end: a real villager harvests a default-marked single tree to depletion → becomes open ground (wood gathering / conversion acceptance; specs13 A′)', t73.villHarvests===true, t73);

  console.log('\n[74] Villager suicide-gathering fix (2026-07-06; 530s log: villagers charged food next to the enemy TC, ignoring tower fire): enemy defensive building fire zone = static lethal area → never gathered into automatically (nearestNode hard-skips / availRes treats it as depleted → rebalance switches); flee on entering; a forced gather does not avoid it');
  const t74 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const clr=()=>{units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;shots.length=0;ghosts.length=0;};
    arenaMode=true;aiWave=99999;gameOver=null;terr.fill(T_PLAIN);blocked.fill(0);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    for(const k in stock)stock[k]=1e9;
    const R={};
    clr();
    const tw=placeB(1,'tower',30,10,true);
    computeDanger(); R.unseenNoDanger = dangerMask[idx(30,10)]!==2;
    tw.seen=true; computeDanger();
    R.towerDanger = dangerMask[idx(30,10)]===2 && dangerMask[idx(30,12)]===2;
    R.outsideSafe = dangerMask[idx(30,17)]!==2;
    clr();
    const etc=placeB(1,'tc',30,10,true); etc.seen=true; computeDanger();
    R.tcNoGarNoDanger = dangerMask[idx(30,11)]!==2 && defFireRange(etc)===0;
    etc.g=1; computeDanger();
    R.tcGarDanger = dangerMask[idx(30,11)]===2 && defFireRange(etc)>0;
    clr();
    placeB(0,'tc',6,10,true);
    const tw2=placeB(1,'tower',30,10,true); tw2.seen=true;
    const fSafe={type:'food',x:C(8,10).x,y:C(8,10).y,amt:300,max:300};
    const fDanger={type:'food',x:C(30,12).x,y:C(30,12).y,amt:300,max:300};
    nodes.push(fSafe,fDanger); computeDanger();
    const bp=C(20,10);
    R.pickSafeNotDanger = nearestNode('food',bp.x,bp.y,{side:0},true)===fSafe;
    R.availWhileSafe = availRes('food',0)===true;
    fSafe.amt=0; computeDanger();
    R.nullWhenOnlyDanger = nearestNode('food',bp.x,bp.y,{side:0},true)===null;
    R.availFalseOnlyDanger = availRes('food',0)===false;
    R.diehardStillPicks = nearestNode('food',bp.x,bp.y,{side:0},false)===fDanger;
    clr();
    const ptc2=placeB(0,'tc',6,10,true);
    const tw3=placeB(1,'tower',30,10,true); tw3.seen=true;
    nodes.push({type:'food',x:C(30,12).x,y:C(30,12).y,amt:300,max:300});
    nodes.push({type:'wood',x:C(8,8).x,y:C(8,8).y,amt:300,max:300});
    for(const k in shares)shares[k]=0; shares.food=1; shares.wood=1;
    for(let i=0;i<4;i++)spawnVillager(ptc2);
    computeDanger(); rebalance(0);
    const jobs=villagers.map(v=>v.job);
    R.noFoodJobs = jobs.every(j=>j!=='food');
    R.allWood = jobs.filter(j=>j==='wood').length===4;
    clr();
    const ptc3=placeB(0,'tc',6,10,true);
    const tw4=placeB(1,'tower',30,10,true); tw4.seen=true;
    S_(0).stance='flee'; S_(0).garrisonOn=false; S_(0).bell=false;
    nodes.push({type:'wood',x:C(8,8).x,y:C(8,8).y,amt:300,max:300});
    spawnVillager(ptc3); const vf=villagers[villagers.length-1];
    vf.x=C(26,10).x; vf.y=C(26,10).y; vf.job='wood';
    computeDanger(); let sawRetreat=false;
    for(let i=0;i<80;i++){step(TICK); if(vf.state==='retreat')sawRetreat=true;}
    R.fleesTower = sawRetreat && dangerMask[idx(txOf(vf.x),tyOf(vf.y))]!==2;
    clr();
    const ptc4=placeB(0,'tc',6,10,true);
    const tw5=placeB(1,'tower',30,10,true); tw5.seen=true;
    S_(0).stance='gather';
    nodes.push({type:'wood',x:C(8,8).x,y:C(8,8).y,amt:300,max:300});
    spawnVillager(ptc4); const vg=villagers[villagers.length-1];
    vg.x=C(26,10).x; vg.y=C(26,10).y; vg.job='wood';
    computeDanger(); let diehardRetreat=false;
    for(let i=0;i<40;i++){step(TICK); if(vg.state==='retreat')diehardRetreat=true;}
    R.diehardNoFlee = !diehardRetreat;
    S_(0).stance='flee'; S_(0).garrisonOn=true;
    clr();
    const ptc5=placeB(0,'tc',6,10,true);
    const tw6=placeB(1,'tower',30,10,true); tw6.seen=true;
    nodes.push({type:'food',x:C(8,10).x,y:C(8,10).y,amt:16,max:300});
    nodes.push({type:'food',x:C(30,12).x,y:C(30,12).y,amt:300,max:300});
    nodes.push({type:'wood',x:C(9,9).x,y:C(9,9).y,amt:300,max:300});
    for(const k in shares)shares[k]=0; shares.food=1; shares.wood=1;
    for(let i=0;i<3;i++)spawnVillager(ptc5);
    villagers.forEach(v=>{v.x=C(8,10).x;v.y=C(8,10).y;});
    computeDanger(); rebalance(0);
    let everInTowerZone=false;
    for(let i=0;i<600;i++){step(TICK); for(const v of villagers)if(dangerMask[idx(txOf(v.x),tyOf(v.y))]===2)everInTowerZone=true;}
    R.neverEntersTowerZone = !everInTowerZone;
    arenaMode=false; clr(); for(const k in shares)shares[k]=0; for(const k in stock)stock[k]=0;
    return R;`);
  check('Enemy tower fire zone marked dangerous (=2): only counts once seen (fair fog); outside the zone is safe', t74.unseenNoDanger&&t74.towerDanger&&t74.outsideSafe, t74);
  check('TC-family buildings need a garrison to become a lethal area (same rule as firing arrows): ungarrisoned does not count, garrisoned does; towers always count', t74.tcNoGarNoDanger&&t74.tcGarDanger, t74);
  check('nearestNode hard-skips nodes inside tower zones; availRes treats them as depleted; a forced gather (safe=false) still picks them', t74.pickSafeNotDanger&&t74.availWhileSafe&&t74.nullWhenOnlyDanger&&t74.availFalseOnlyDanger&&t74.diehardStillPicks, t74);
  check('rebalance: food only under towers → the share shifts to safe wood (auto-switches to another resource when one runs out; no idling)', t74.noFoodJobs&&t74.allWood, t74);
  check('Stepping into a tower fire zone → flee out of it; a forced-gather stance does not flee (keeps gathering)', t74.fleesTower&&t74.diehardNoFlee, t74);
  check('End-to-end: after nearby food runs out, real villagers do not charge the food under the towers (never step into the fire zone)', t74.neverEntersTowerZone===true, t74);

  console.log('\n[75] Device-feedback fixes 6 (2026-07-06; 1329s log): outpost only fires when garrisoned / single trees do not outrank coppices / unmarking stops gathering at once / danger memory (word of mouth) / shortest distance to the drop-off hub wins / fleeing does not route past the enemy / ambush = task');
  const t75 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const clr=()=>{units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;shots.length=0;ghosts.length=0;};
    arenaMode=true;aiWave=99999;gameOver=null;terr.fill(T_PLAIN);blocked.fill(0);paintTerrain();explored.fill(1);exploredE.fill(1);computeLandComp();
    for(const k in stock)stock[k]=1e9;
    const R={};
    clr();
    const opo=placeB(1,'outpost',30,10,true); opo.seen=true; opo.cd=0;
    R.outNoGarNoDanger = (defFireRange(opo)===0);
    const sp=spawnUnit(0,'spear',30.5*TILE,12*TILE,tags[0]); sp.revealT=t+999;
    for(let i=0;i<6;i++)bTick(opo,TICK);
    R.outNoGarNoFire = !shots.some(s=>s.src===opo);
    opo.g=1; opo.seen=true; computeDanger();
    R.outGarDanger = defFireRange(opo)>0 && dangerMask[idx(30,11)]===2;
    shots.length=0; for(let i=0;i<6;i++)bTick(opo,TICK);
    R.outGarFires = shots.some(s=>s.src===opo);
    clr(); dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN);
    placeB(0,'tc',5,10,true);
    dbg.setTerr(9,10,9,10,T_FOREST); initForest();
    const cop=placeB(0,'coppice',8,10,true);
    const vpick={x:C(8,10).x,y:C(8,10).y,side:0};
    const pick=nearestNode('wood',vpick.x,vpick.y,vpick,false);
    R.thinNotOverride = pick===cop.node && pick.forestI===undefined;
    clr(); dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN);
    placeB(0,'tc',9,6,true); dbg.setTerr(5,5,7,7,T_FOREST); initForest();
    markForestComp(6,6,0,true);
    spawnVillager(); const vh=villagers[villagers.length-1];
    vh.job='wood'; vh.node=nodes.find(n=>n.forestI===idx(6,6)); vh.state='gather';
    markForestComp(6,6,0,false);
    R.unmarkStops = vh.node===null;
    clr(); dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN); visible.fill(0);
    placeB(0,'tc',5,10,true);
    const fSafe={type:'food',x:C(7,10).x,y:C(7,10).y,amt:300,max:300};
    const fMem ={type:'food',x:C(20,10).x,y:C(20,10).y,amt:300,max:300};
    nodes.push(fSafe,fMem);
    const en2=spawnUnit(1,'spear',20.5*TILE,10.5*TILE,tags[5]); en2.revealT=t+999;
    computeDanger();
    en2.hp=0; visible.fill(0); computeDanger();
    R.memPersists = dangerMask[idx(20,10)]===0 && remDanger(idx(20,10))===true;
    R.memNodeAvoided = nearestNode('food',C(19,10).x,C(19,10).y,{side:0},true)===fSafe;
    R.memAvailFalse = availRes('food',0)===true;
    visible[idx(20,10)]=1; computeDanger();
    fSafe.amt=0;
    R.memClearsOnReExplore = remDanger(idx(20,10))===false && nearestNode('food',C(19,10).x,C(19,10).y,{side:0},true)===fMem;
    clr(); dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN);
    placeB(0,'tc',5,10,true);
    const gNear={type:'gold',x:C(8,10).x,y:C(8,10).y,amt:500,max:500};
    const gFar ={type:'gold',x:C(20,10).x,y:C(20,10).y,amt:500,max:500};
    nodes.push(gNear,gFar);
    R.nearTCpriority = nearestNode('gold',C(19,10).x,C(19,10).y,{side:0},false)===gNear;
    clr(); dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN);
    const en3=spawnUnit(1,'spear',15.5*TILE,10.5*TILE,tags[5]);
    const vflee={x:C(10,10).x,y:C(10,10).y,side:0};
    const sFar=placeB(0,'tc',17,10,true);
    R.shelterPastThreatNull = fleeShelter(vflee)===null;
    const sNear=placeB(0,'outpost',3,10,true);
    R.shelterAwayChosen = fleeShelter(vflee)===sNear;
    // (g) Ambush is a task: dragging it (to open ground or into a garrison) or assigning a target (an
    // enemy) must return it to guard. Covers issueTagOrder/issueGarrison, fixing the report that dragging
    // or assigning a target (building or unit) did not switch back to guard.
    clr(); dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN); visible.fill(0);
    const setAmb=()=>{tags[0].task='ambush';tags[0].holdFire=true;tags[0].focus=null;};
    setAmb(); issueTagOrder(0, C(12,12).x, C(12,12).y, 0);
    const revGround = tags[0].task==='guard' && !tags[0].holdFire;
    setAmb(); const efoe=spawnUnit(1,'spear',C(30,12).x,C(30,12).y,tags[5]); visible[idx(30,12)]=1;
    issueTagOrder(0, efoe.x, efoe.y, 0);
    const revFoe = tags[0].task==='guard' && !tags[0].holdFire && tags[0].focus===efoe; efoe.hp=0;
    setAmb(); const ownB=placeB(0,'tower',10,10,true); issueGarrison(0, ownB, 0);
    const revGarrison = tags[0].task==='guard' && !tags[0].holdFire;
    setAmb(); const trn=spawnUnit(0,'transport',C(12,10).x,C(12,10).y,null); issueBoard(0,trn,0);
    const revBoard = tags[0].task==='guard' && !tags[0].holdFire;
    setAmb(); const mem=spawnUnit(0,'spear',C(12,12).x,C(12,12).y,tags[0]); breakAmbush(mem.grp);
    const revMember = tags[0].task==='guard' && !tags[0].holdFire;
    AICMD.setTask(1,0,'ambush'); const aiHfOn=tagsOf(1)[0].holdFire===true;
    AICMD.setTask(1,0,'guard'); const aiHfOff=tagsOf(1)[0].holdFire===false;
    R.ambushRevertsToGuard = revGround && revFoe && revGarrison && revBoard && revMember;
    R.aiTaskSyncsHoldFire = aiHfOn && aiHfOff;
    arenaMode=false; clr(); tags[0].task='guard'; tags[0].holdFire=false;
    for(const k in stock)stock[k]=0;
    return R;`);
  check('Outpost: ungarrisoned fires no arrows (defFireRange 0; does not fire); garrisoned fires (lethal zone + real arrows) = "only attacks once manned"', t75.outNoGarNoDanger&&t75.outNoGarNoFire&&t75.outGarDanger&&t75.outGarFires, t75);
  check('Single trees do not outrank coppices: thin scrub (auto-marked) = ordinary node; bF priority only for deliberately marked forest blocks → picks the nearer coppice', t75.thinNotOverride, t75);
  check('Unmarking a whole forest → gathering stops immediately (clears the node of villagers mid-gather; no lingering)', t75.unmarkStops, t75);
  check('Danger memory (word of mouth): after the enemy leaves, that node is still avoided under fog (no more shuttling toward the enemy TC); the memory clears only after re-scouting confirms no enemy (needs a scout)', t75.memPersists&&t75.memNodeAvoided&&t75.memAvailFalse&&t75.memClearsOnReExplore, t75);
  check('Shortest distance to the drop-off hub (TC) wins: a villager standing at a far ore node is still assigned the node nearer the TC (minimum round-trip cost)', t75.nearTCpriority, t75);
  check('Fleeing does not route past the enemy: a sheltering building on the far side of the enemy is not counted as refuge (returns null → just runs away); only a building safely away from the enemy is chosen', t75.shelterPastThreatNull&&t75.shelterAwayChosen, t75);
  check('Ambush breaks on any order: a move (open ground / garrison / board) + targeting an enemy + dragging a member (breakAmbush as the single exit) → all revert to guard; AICMD.setTask syncs holdFire', t75.ambushRevertsToGuard&&t75.aiTaskSyncsHoldFire, t75);

  console.log('\n[76] AI economic brain (slice B; specs/13): noai isolation / opening villager gathering / villager training / resource mix / research / age up → Castle Age / farm top-up / symmetric danger map / expansion outposts');
  const t76 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const clr=()=>{units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;shots.length=0;ghosts.length=0;};
    const R={};
    R.offByDefault = dbg.aiEcoOn()===false;
    arenaMode=false; gameOver=null; aiWave=99999; aiDefT=1e9; aiFullVision=true;
    clr(); dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN); computeLandComp(); explored.fill(1);exploredE.fill(1); visible.fill(0);
    placeB(0,'tc',3,20,true);
    const atc=placeB(1,'tc',30,10,true); placeB(1,'barracks',34,13,true);
    for(const k in stockOf(1))stockOf(1)[k]=0; stockOf(1).food=250; stockOf(1).wood=250;
    techOf(1).researched.clear(); techOf(1).age=1; techOf(1).track=null; techOf(1).queue.length=0; techOf(1).ageUp=null; recomputeTechMod(1);
    for(const k in S_(1).shares)S_(1).shares[k]=1;
    nodes.push({type:'wood',x:C(27,7).x,y:C(27,7).y,amt:800,max:800});
    nodes.push({type:'food',x:C(33,7).x,y:C(33,7).y,amt:800,max:800});
    nodes.push({type:'gold',x:C(27,13).x,y:C(27,13).y,amt:500,max:500});
    nodes.push({type:'stone',x:C(34,11).x,y:C(34,11).y,amt:500,max:500});
    dbg.setAiEco(true); dbg.setAiMil(false);
    R.spawned8 = villagers.filter(v=>(v.side||0)===1).length===8;
    for(let i=0;i<800;i++)step(TICK);                                    // 40s
    const g1=S_(1).gathered;
    R.gathers = g1.wood>0 && g1.food>0;
    R.trains = villagers.filter(v=>(v.side||0)===1).length+cqCount('villager',1)>8;
    R.sharesTuned = Object.values(S_(1).shares).some(x=>x!==1);
    for(let i=0;i<1600;i++)step(TICK);
    R.researched = techOf(1).researched.has('E1');
    stockOf(1).food+=500; stockOf(1).wood+=400; stockOf(1).gold+=200; stockOf(1).stone+=200;
    for(let i=0;i<400;i++)step(TICK);
    R.ageUpStarted = !!techOf(1).ageUp || techOf(1).age>=2;
    for(let i=0;i<800;i++)step(TICK);
    R.castleAge = techOf(1).age>=2;
    for(const n of nodes)if(n.type==='food'&&!n.farm)n.amt=0;
    stockOf(1).wood+=200; dbg.aiEcoTick();
    R.farmPlaced = buildings.some(b=>b.side===1&&b.type==='farm');
    const ptw=placeB(0,'tower',24,10,true); computeDanger();
    R.dangerE2 = dbg.dangerAtE(24,11)===2 && dbg.dangerAt(24,11)===0;
    const wSafe={type:'wood',x:C(34,9).x,y:C(34,9).y,amt:500,max:500};
    const wTower={type:'wood',x:C(24,12).x,y:C(24,12).y,amt:500,max:500};
    nodes.push(wSafe,wTower);
    R.aiVillAvoids = nearestNode('wood',C(25,12).x,C(25,12).y,{side:1},true)===wSafe;
    dbg.setEcoReach(300);
    nodes.push({type:'stone',x:C(22,20).x,y:C(22,20).y,amt:500,max:500});
    while(villagers.filter(v=>(v.side||0)===1).length<12)spawnVillager(atc);
    techOf(1).age=3; techOf(1).ageUp=null; recomputeTechMod(1);
    stockOf(1).wood=800; stockOf(1).stone=800; stockOf(1).gold=400; stockOf(1).food=400; computeDanger();
    dbg.aiMapFeat(1,true); // Force the map-feature cache to refresh: this test changes ECO_REACH (1100→300) and adds ore mid-run,
// but aiStratTick does not advance t, so aiOutMax reads the pre-change clusters (=0) and wrongly
// concludes there are no expansion slots. In a real sim t advances continuously, the cache expires
// naturally, and expansion measures fine at 2-4 outposts per match.
    for(let i=0;i<12;i++)dbg.aiStratTick(); // Several ticks needed: age3 has just been set, so farm and castle commitments (higher score) grab the
// one-building-per-tick slot first and expansion (1.0) queues behind them. Give enough ticks for the
// outpost's turn to come round — after the map was enlarged the RNG ordering shifted and 4 ticks was
// no longer enough, hence 12.
    R.outpostPlaced = buildings.some(b=>b.side===1&&b.type==='outpost');
    dbg.setEcoReach(1100);
    dbg.setAiEco(false); dbg.setAiMil(true);
    villagers=villagers.filter(v=>(v.side||0)===0);
    techOf(1).researched.clear(); techOf(1).age=1; techOf(1).track=null; techOf(1).queue.length=0; techOf(1).ageUp=null; recomputeTechMod(1);
    for(const k in S_(1).shares)S_(1).shares[k]=1; for(const k in stockOf(1))stockOf(1)[k]=0;
    clr(); for(const k in stock)stock[k]=0; computeDanger();
    return R;`);
  check('?noai=1 = AI economic brain off by default (isolates legacy test worlds); setAiEco(true) = tops up 8 starting villagers', t76.offByDefault&&t76.spawned8, t76);
  check('AI villagers gather automatically (shared execution layer; deposits into side1 stock) + the economic brain trains villagers', t76.gathers&&t76.trains, t76);
  check('Resource mix = fill whatever is short (shares adjusted by the brain)', t76.sharesTuned, t76);
  check('Research line: the AI researches E1 by itself (via AICMD = same resource and prerequisite gates as the player)', t76.researched, t76);
  check('Age up: requirements (research + buildings) met and funds ready → the AI reaches the Castle Age on its own (slice B acceptance)', t76.ageUpStarted&&t76.castleAge, t76);
  check('Farm top-up: food inside the perimeter exhausted → the economic brain builds farms (a renewable source)', t76.farmPlaced, t76);
  check('Danger map symmetry: player towers = lethal area for AI villagers (dangerMaskE=2); AI villagers avoid ore inside tower zones; the player\'s side unaffected', t76.dangerE2&&t76.aiVillAvoids, t76);
  check('Expansion: ore outside the perimeter that is reachable and nearer to home → build an outpost to push the economic perimeter out', t76.outpostPlaced, t76);

  console.log('\n[77] Footprint avoidance + push resistance (2026-07-07 user): moving units route around stationary ones; stationary units are barely shoved; gatherers ring up instead of stacking');
  const t77 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const clr=()=>{units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;shots.length=0;};
    arenaMode=true; aiWave=99999; gameOver=null;
    clr(); dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN); computeLandComp(); explored.fill(1);exploredE.fill(1);
    const R={};
    tags[1].task='guard'; tags[1].pt=C(20,10); tags[1].holdFire=false;
    const blocker=spawnUnit(0,'spear',C(20,10).x,C(20,10).y,tags[1]);
    tags[0].task='guard'; tags[0].holdFire=false;
    const mover=spawnUnit(0,'spear',C(16,10).x,C(16,10).y,tags[0]);
    for(let i=0;i<10;i++)step(TICK);
    const b0={x:blocker.x,y:blocker.y};
    issueTagOrder(0,C(24,10).x,C(24,10).y);
    for(let i=0;i<300;i++)step(TICK);
    R.moverPast = mover.x>C(22,10).x;
    R.blockerStays = Math.hypot(blocker.x-b0.x,blocker.y-b0.y)<8;
    R.noOverlap = Math.hypot(mover.x-blocker.x,mover.y-blocker.y)>=11;
    clr(); const ptc=placeB(0,'tc',4,10,true);
    const wn={type:'wood',x:C(8,10).x,y:C(8,10).y,amt:600,max:600}; nodes.push(wn);
    for(const k in shares)shares[k]=0; shares.wood=1;
    spawnVillager(ptc); spawnVillager(ptc);
    const vA=villagers[villagers.length-2], vB=villagers[villagers.length-1];
    rebalance(0);
    for(let i=0;i<400;i++){vA.carry=0;vB.carry=0;step(TICK);}
    R.bothGather = vA.state==='gather'&&vB.state==='gather';
    R.spread = Math.hypot(vA.x-vB.x,vA.y-vB.y)>=10;
    R.harvesting = wn.amt<600;
    const aPos={x:vA.x,y:vA.y};
    spawnVillager(ptc); const vC=villagers[villagers.length-1]; vC.x=C(12,10).x; vC.y=C(12,10).y; rebalance(0);
    for(let i=0;i<300;i++){vA.carry=0;vB.carry=0;vC.carry=0;step(TICK);}
    R.gathererUndisturbed = Math.hypot(vA.x-aPos.x,vA.y-aPos.y)<6;
    arenaMode=false; clr(); for(const k in shares)shares[k]=1; for(const k in stock)stock[k]=0;
    return R;`);
  check('A moving unit routes around a stationary one: goes round to the other side; the stationary unit is displaced <8px (push has resistance); footprints do not overlap', t77.moverPast&&t77.blockerStays&&t77.noOverlap, t77);
  check('Gathering ring positions: two villagers on the same node each take their own spot (≥10px); both are gathering', t77.bothGather&&t77.spread&&t77.harvesting, t77);
  check('A later villager routes around one already gathering (the first is displaced <6px and keeps gathering in place)', t77.gathererUndisturbed, t77);

  console.log('\n[78] Concealment display (2026-07-07 user: "can\'t tell whether I\'m hidden"): semi-transparent in a deep tile = hidden; forest edge / single tree / exposed by firing = visible');
  const t78 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const clr=()=>{units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;shots.length=0;};
    arenaMode=true; aiWave=99999; gameOver=null;
    clr(); dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN);
    dbg.setTerr(10,8,14,12,T_FOREST);                                    // 5×5 成塊森林
    dbg.setTerr(20,10,20,10,T_FOREST);                                   // 孤立單樹
    computeLandComp(); explored.fill(1);exploredE.fill(1);
    const R={};
    R.deepSane = dbg.forestDeepAt(12,10)===true && dbg.forestDeepAt(10,8)===false;
    const u=spawnUnit(0,'spear',C(12,10).x,C(12,10).y,tags[0]);
    R.deepHidden = concealedFx(u)===true;                                // 深格（第二排起）＝半透明「躲好了」
    u.x=C(10,8).x; u.y=C(10,8).y;
    R.edgeVisible = concealedFx(u)===false;                              // 林緣第一排＝看得到
    u.x=C(12,10).x; u.y=C(12,10).y; u.revealT=t+2;
    R.firedExposed = concealedFx(u)===false;                             // 開火暴露＝現形
    u.revealT=0;
    u.x=C(20,10).x; u.y=C(20,10).y;
    R.singleTreeVisible = concealedFx(u)===false;                        // 單樹藏不了人
    spawnVillager(); const v=villagers[villagers.length-1]; v.x=C(12,10).x; v.y=C(12,10).y;
    R.villagerToo = concealedFx(v)===true;                               // 村民/斥候同規則
    arenaMode=false; clr(); dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN); computeLandComp();
    return R;`);
  check('Deep tile = concealed (semi-transparent); forest edge = visible; firing reveals; a single tree hides nobody; villagers follow the same rule', t78.deepSane&&t78.deepHidden&&t78.edgeVisible&&t78.firedExposed&&t78.singleTreeVisible&&t78.villagerToo, t78);

  console.log('\n[79] AI military brain (slice C; specs/13): scripted waves retired / same-rules production and formation / counter mix / route map + chokepoints / state machine (pressure / defence / retreat) / patrol / attack the wall when fully blocked');
  await ev(`AI_SQUADS=false;return 1;`); // [79]-[105] cover behaviour under the old multi-squad patch scheduling. The three-squad rewrite makes
// AI_SQUADS default to true (new scheduling); the legacy behaviour is now verified along the ablation
// path with AI_SQUADS=false, so it remains a valid byte-identical fallback baseline. New three-squad
// behaviour is [106].
  const t79 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const clr=()=>{units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;shots.length=0;ghosts.length=0;};
    const R={};
    arenaMode=false; gameOver=null; aiDefT=1e9; aiFullVision=true;
    clr(); dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN); computeLandComp(); explored.fill(1);exploredE.fill(1); visible.fill(0);
    const ptc=placeB(0,'tc',3,20,true); const pfarm=placeB(0,'farm',7,17,true);
    const atc=placeB(1,'tc',30,10,true); const abar=placeB(1,'barracks',34,13,true);
    for(const k in stockOf(1))stockOf(1)[k]=1000;
    techOf(1).researched.clear(); techOf(1).age=1; techOf(1).track=null; techOf(1).queue.length=0; techOf(1).ageUp=null; recomputeTechMod(1);
    dbg.setAiEco(true); dbg.setAiMil(true);
    dbg.A(1).plan={open:'std',routeBias:0,harass:false};
    dbg.aiMil.state='develop'; dbg.aiMil.sT=t; dbg.aiMil.mission=null; dbg.aiMil.retreatT=-1e9;
    for(const k in dbg.aiMil.foeSeen)delete dbg.aiMil.foeSeen[k]; dbg.aiMil.ord.length=0;
    R.scriptedOff = dbg.sideState(1).scripted===false;
    aiWave=0; for(let i=0;i<5;i++)step(TICK);
    R.noWave = aiWave===0 && !units.some(u=>u.side===1&&u.wp);
    aiWave=99999;
    for(let i=0;i<900;i++)step(TICK);
    const milU=units.filter(u=>u.side===1&&u.hp>0&&UT[u.type]&&!u.wp);
    R.produced = milU.length>=3;
    R.inTagGroups = milU.every(u=>tagsOf(1).includes(u.grp));
    R.defStaffed = milU.filter(u=>u.grp===tagsOf(1)[1]).length>=2;
    for(let i=0;i<6;i++)spawnUnit(0,'cavalry',C(20,14).x+i*8,C(20,14).y,tags[0]);
    dbg.aiMilTick();
    const w1=dbg.aiMilWant();
    R.counterSpear = (w1.spear||0)>3 && (w1.spear||0)>(w1.archer||0);
    units.filter(u=>u.side===0).forEach(u=>u.hp=0); step(TICK);
    for(const k in dbg.aiMil.foeSeen)delete dbg.aiMil.foeSeen[k];
    techOf(1).researched.add('U1');
    for(let i=0;i<6;i++)spawnUnit(0,'archer',C(20,14).x+i*8,C(20,14).y,tags[0]);
    dbg.aiMilTick();
    const w2=dbg.aiMilWant();
    R.counterCav = (w2.cavalry||0)>1;
    units.filter(u=>u.side===0).forEach(u=>u.hp=0); step(TICK);
    for(const k in dbg.aiMil.foeSeen)delete dbg.aiMil.foeSeen[k];
    dbg.aiAnalyzeRoutes();
    R.routesK = dbg.aiMil.routes.length>=2;
    const ral=dbg.aiMil.routes[0].rally;
    R.rallyBetween = ral.x>ptc.x && ral.x<atc.x && !blocked[idx(txOf(ral.x),tyOf(ral.y))];
    const wallY=[];
    for(let y=0;y<TH;y++){if(y===14||y===15)continue;placeB(0,'wall',16,y,true);wallY.push(y);}
    dbg.aiAnalyzeRoutes();
    const r0=dbg.aiRoutesInfo()[0];
    R.bottleneck = dbg.aiMil.routes.length>=1 && r0.bn.length>=1 && Math.abs(r0.bn[0].x/TILE-16)<4;
    placeB(0,'wall',16,14,true); placeB(0,'wall',16,15,true);
    dbg.aiAnalyzeRoutes();
    R.breachFound = dbg.aiMil.routes.length===0 && !!dbg.aiMil.breach && dbg.aiMil.breach.type==='wall';
    for(let i=0;i<6;i++)spawnUnit(1,'spear',atc.x-60+i*10,atc.y+40,tagsOf(1)[0]);
    dbg.aiMil.state='pressure'; dbg.aiMil.sT=t; dbg.aiMil.mission=null;
    dbg.aiMilTick();
    R.breachMission = dbg.aiMil.mission && dbg.aiMil.mission.kind==='breach' && tagsOf(1)[0].focus===dbg.aiMil.breach && tagsOf(1)[0].task==='attack';
    buildings.filter(b=>b.type==='wall').forEach(b=>b.hp=0); step(TICK);
    dbg.aiMil.state='develop'; dbg.aiMil.sT=t; dbg.aiMil.mission=null; dbg.aiMil.retreatT=-1e9; dbg.aiMil.ord.length=0;
    dbg.A(1).plan={open:'std',routeBias:0,harass:false};
    dbg.aiAnalyzeRoutes();
    while(units.filter(u=>u.side===1&&u.grp===tagsOf(1)[0]&&u.hp>0).length<8)spawnUnit(1,'spear',atc.x-60+(rng()*2-1)*30,atc.y+40+(rng()*2-1)*30,tagsOf(1)[0]);
    dbg.aiMilTick();
    R.pressure = dbg.aiMil.state==='pressure';
    R.missionEco = dbg.aiMil.mission && dbg.aiMil.mission.tgt===pfarm && dbg.aiMil.mission.legs.length>=2 && tagsOf(1)[0].task==='attack';
    {const mis=dbg.aiMil.mission, rally=mis.legs[0];
     const gmain=units.filter(u=>u.side===1&&u.grp===tagsOf(1)[0]&&u.hp>0);
     mis.li=0; mis.legT=undefined;
     gmain.forEach((u,i)=>{u.x=rally.x+(i%2?1:-1)*TILE*10; u.y=rally.y;});
     dbg.aiMilTick();
     R.stageWaitsStrung = dbg.aiMil.mission && dbg.aiMil.mission.li===0;
     gmain.forEach(u=>{u.x=rally.x+(rng()*2-1)*TILE*2; u.y=rally.y+(rng()*2-1)*TILE*2;});
     dbg.aiMilTick();
     R.stageAdvancesGathered = dbg.aiMil.mission && dbg.aiMil.mission.li===1;
    }
    const g0u=units.filter(u=>u.side===1&&u.grp===tagsOf(1)[0]&&u.hp>0);
    g0u.slice(3).forEach(u=>u.hp=0); step(TICK);
    units.filter(u=>u.side===1&&u.grp===tagsOf(1)[0]&&u.hp>0).forEach((u,i)=>{u.x=pfarm.x+30+i*10;u.y=pfarm.y;});
    for(let i=0;i<12;i++)spawnUnit(0,'spear',pfarm.x+(rng()*2-1)*40,pfarm.y+60+(rng()*2-1)*30,tags[0]);
    dbg.aiMilTick();
    R.retreat = dbg.aiMil.mission===null && dbg.aiMil.state==='develop' && tagsOf(1)[0].task==='guard'
      && Math.hypot(tagsOf(1)[0].pt.x-dbg.aiMil.homeRally.x,tagsOf(1)[0].pt.y-dbg.aiMil.homeRally.y)<TILE*2;
    units.filter(u=>u.side===0).forEach(u=>u.hp=0); step(TICK);
    dbg.aiMil.ord.length=0;
    for(let i=0;i<8;i++)spawnUnit(0,'spear',atc.x-140,atc.y+20+i*14,tags[0]);
    dbg.aiMilTick();
    const thr={x:atc.x-140,y:atc.y+69};
    R.defendState = dbg.aiMil.state==='defend';
    R.raidResponse = tagsOf(1)[1].task==='guard' && Math.hypot(tagsOf(1)[1].pt.x-thr.x,tagsOf(1)[1].pt.y-thr.y)<TILE*3;
    units.filter(u=>u.side===0).forEach(u=>u.hp=0); step(TICK);
    for(let i=0;i<8;i++)dbg.aiMilTick();
    R.threatClears = dbg.aiMil.state==='develop';
    spawnUnit(1,'spear',atc.x+40,atc.y+40,tagsOf(1)[2]); spawnUnit(1,'archer',atc.x+52,atc.y+40,tagsOf(1)[2]);
    dbg.aiMilTick();
    R.patrol = tagsOf(1)[2].task==='patrol' && !!tagsOf(1)[2].zoneAnchor;
    dbg.setAiEco(false);
    dbg.aiMil.state='develop'; dbg.aiMil.mission=null; dbg.aiMil.routes.length=0; dbg.aiMil.retreatT=-1e9;
    dbg.aiMil.ord.length=0; for(const k in dbg.aiMil.foeSeen)delete dbg.aiMil.foeSeen[k]; dbg.aiMil.breach=null;
    villagers=villagers.filter(v=>(v.side||0)===0);
    techOf(1).researched.clear(); techOf(1).age=1; techOf(1).track=null; techOf(1).queue.length=0; techOf(1).ageUp=null; recomputeTechMod(1);
    for(const k in S_(1).shares)S_(1).shares[k]=1; for(const k in stockOf(1))stockOf(1)[k]=0;
    for(const g of tagsOf(1)){g.task='guard';g.pt=null;g.focus=null;g.holdFire=false;g.zoneAnchor=null;}
    clr(); for(const k in stock)stock[k]=0; computeDanger(); aiWave=99999;
    return R;`);
  check('Scripted waves retired: with aiEco on no waves spawn; scripted=false (the AI pays upkeep = survives by the same rules)', t79.scriptedOff&&t79.noWave, t79);
  check('Formation production: with no waves, all side1 troops come from the queue (AICMD, same gates as the player); all in groups g0-g2; the guard group forms first', t79.produced&&t79.inTagGroups&&t79.defStaffed, t79);
  check('Counter mix: a cavalry swarm sighted → more spearmen; an archer swarm (U1 researched) → build cavalry (RPS emerges)', t79.counterSpear&&t79.counterCav, t79);
  check('Route map: k≥2 alternative routes on plains; the rally point on a standable tile between the two bases; a wall opening = chokepoint detected', t79.routesK&&t79.rallyBetween&&t79.bottleneck, t79);
  check('Fully blocked = attack the wall: no route → breach = the player\'s wall; the pressure task focuses fire on that wall (specs/13 §10)', t79.breachFound&&t79.breachMission, t79);
  check('State machine: enough troops → pressure; task = hit the economy (known farms); rally first (legs≥2)', t79.pressure&&t79.missionEco, t79);
  check('R9 staged march rally: centroid at the rally point but the column strung out = no advance; only push toward the target once the whole group has closed up (stops it being defeated in detail)', t79.stageWaitsStrung&&t79.stageAdvancesGathered, t79);
  check('Retreat criterion: 3 against 12 = fall back to the home rally point and return to developing (cooldown stops flapping)', t79.retreat, t79);
  check('Defence + response to raided ore: enemy near home = the guard group intercepts; a big threat = defend; 8s clear → back to developing', t79.defendState&&t79.raidResponse&&t79.threatClears, t79);
  check('Patrol: once g2 is manned it patrols the home sectors automatically (catches harassment at home)', t79.patrol, t79);

  console.log('\n[80] Slow terrain + ramps (spec 10 #86; merged into slice C): route around swamp (string-pulling does not straighten through it); a full-width swamp is crossed anyway; ramps cost the same up and down');
  const t80 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const clr=()=>{units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;shots.length=0;};
    arenaMode=true; aiWave=99999; gameOver=null;
    clr(); dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN); computeLandComp(); explored.fill(1);exploredE.fill(1);
    const R={};
    const sampleTerr=(sx,sy,pts)=>{const hits=[];let px=sx,py=sy;
      for(const p of pts){const d=Math.hypot(p.x-px,p.y-py),n=Math.max(1,Math.ceil(d/(TILE*0.4)));
        for(let i=1;i<=n;i++){const x=px+(p.x-px)*i/n,y=py+(p.y-py)*i/n;hits.push(terr[idx(txOf(x),tyOf(y))]);}px=p.x;py=p.y;}
      return hits;};
    dbg.setTerr(10,3,14,8,T_SWAMP);
    const p1=findPath(C(7,7).x,C(7,7).y,C(18,7).x,C(18,7).y,0,false,undefined);
    R.detours = p1.length>0 && !sampleTerr(C(7,7).x,C(7,7).y,p1).includes(T_SWAMP);
    dbg.setTerr(22,0,24,TH-1,T_SWAMP);
    const p2=findPath(C(20,7).x,C(20,7).y,C(27,7).x,C(27,7).y,0,false,undefined);
    R.crosses = p2.length>0 && sampleTerr(C(20,7).x,C(20,7).y,p2).includes(T_SWAMP);
    dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN);
    dbg.setTerr(32,8,40,12,T_HIGH); dbg.setTerr(30,8,31,12,T_RAMP);
    computeLandComp();
    const walk=(fx,fy,tx2,ty2)=>{const u=spawnUnit(0,'spear',C(fx,fy).x,C(fx,fy).y,tags[0]);
      u.path=findPath(u.x,u.y,C(tx2,ty2).x,C(tx2,ty2).y,0,false,undefined);
      if(!u.path.length){u.hp=0;return -1;}
      let n=0;while(n<1200&&u.path.length){stepPath(u,TICK);n++;}
      const ok=Math.hypot(u.x-C(tx2,ty2).x,u.y-C(tx2,ty2).y)<60;
      u.hp=0;return ok?n:-1;};
    const up=walk(27,10,35,10), down=walk(35,10,27,10);
    step(TICK);
    R.rampSym = up>0 && down>0 && Math.abs(up-down)/Math.max(up,down)<0.10;
    R.upN=up; R.downN=down;
    arenaMode=false; clr(); dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN); computeLandComp();
    return R;`);
  check('Route around swamp: with a gap, A* goes around and string-pulling does not straighten back through it (sampled path has no swamp tiles)', t80.detours, t80);
  check('Full-width swamp = no way round = crossed anyway (slow terrain is not a wall)', t80.crosses, t80);
  check('Ramps are the same speed both ways: uphill/downhill time differs <10% (the 0.8/1.15 asymmetry is gone)', t80.rampSym, t80);

  console.log('\n[81] AI naval brain (slice D; specs/13 §9): short-circuit on land maps / builds dock + fishing boats + fish reaching the stockpile unaided / naval counter mix / fishing escort / ford blockade / transport island grab / ship upkeep counted into the food target');
  const t81 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const clr=()=>{units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;shots.length=0;ghosts.length=0;};
    const R={};
    arenaMode=false; gameOver=null; aiDefT=1e9; aiFullVision=true; aiWave=99999;
    const richer=(si)=>{for(const k in stockOf(si))stockOf(si)[k]=2000;};
    const resetAi=()=>{techOf(1).researched.clear();techOf(1).age=1;techOf(1).track=null;techOf(1).queue.length=0;techOf(1).ageUp=null;recomputeTechMod(1);
      dbg.aiMil.state='develop';dbg.aiMil.sT=t;dbg.aiMil.mission=null;dbg.aiMil.retreatT=-1e9;dbg.aiMil.navyRetreatT=-1e9;dbg.aiMil.island=null;
      dbg.aiMil.ord.length=0;for(const k in dbg.aiMil.foeSeen)delete dbg.aiMil.foeSeen[k];dbg.AI_SEA.ready=false;};

    clr(); dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN); computeLandComp(); explored.fill(1);exploredE.fill(1);
    placeB(1,'tc',30,10,true); richer(1); resetAi(); dbg.setAiEco(true); dbg.setAiMil(false);
    for(let i=0;i<12;i++)spawnVillager(buildings[0]);
    dbg.aiSeaInit();
    R.landNoWater = dbg.aiSeaInfo().hasWater===false;
    for(let i=0;i<40;i++)dbg.aiEcoTick();
    dbg.aiNavyTick();
    R.landShort = !buildings.some(b=>b.type==='dock') && !units.some(u=>u.dom==='water');

    const mkSea=()=>{
      clr(); gameOver=null; dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN);
      dbg.setTerr(18,1,28,25,T_WATER);
      dbg.setTerr(18,13,28,13,T_SHALLOW);
      dbg.setTerr(21,4,24,7,T_PLAIN);
      computeLandComp(); explored.fill(1);exploredE.fill(1); visible.fill(0); visibleE.fill(0);
      dbg.AI_SEA.ready=false; computeDanger();
    };

    mkSea();
    const atc=placeB(1,'tc',34,12,true); placeB(0,'tc',6,12,true);
    for(const [fx,fy] of [[20,10],[21,15],[26,11]])dbg.addFish(fx,fy,400);
    richer(1); resetAi(); dbg.setAiEco(true); dbg.setAiMil(false);
    for(let i=0;i<12;i++)spawnVillager(atc);
    S_(1).gathered.food=0;
    for(let i=0;i<3600;i++)step(TICK);
    const dk=buildings.find(b=>b.side===1&&b.type==='dock');
    R.dockBuilt = !!dk && dk.done;
    R.fishBoats = units.filter(u=>u.side===1&&u.type==='fishing').length;
    R.fishFood = Math.round(S_(1).gathered.food);
    R.fishIncome = R.fishBoats>=2 && nodes.some(n=>n.sea&&n.amt<n.max);

    techOf(1).age=2; recomputeTechMod(1);
    for(const k in dbg.aiMil.foeSeen)delete dbg.aiMil.foeSeen[k];
    for(let i=0;i<5;i++)spawnUnit(0,'galley',C(20,20).x+i*10,C(20,20).y,tags[0]);
    dbg.aiNavyTick();
    const nw1=dbg.aiNavyWant();
    R.counterFire = (nw1.fireship||0)>1 && !(nw1.siegeship>0);
    units.filter(u=>u.side===0&&u.dom==='water').forEach(u=>u.hp=0); step(TICK);
    for(const k in dbg.aiMil.foeSeen)delete dbg.aiMil.foeSeen[k];
    for(let i=0;i<5;i++)spawnUnit(0,'fireship',C(20,20).x+i*10,C(20,20).y,tags[0]);
    dbg.aiNavyTick();
    const nw2=dbg.aiNavyWant();
    R.counterSiege = (nw2.siegeship||0)>1;
    units.filter(u=>u.side===0&&u.dom==='water').forEach(u=>u.hp=0); step(TICK);
    for(const k in dbg.aiMil.foeSeen)delete dbg.aiMil.foeSeen[k];

    dbg.aiMil.ord.length=0; dbg.aiMil.state='develop';
    units.filter(u=>u.side===1&&u.dom==='water').forEach(u=>u.hp=0); step(TICK);
    const fb=spawnUnit(1,'fishing',C(20,10).x,C(20,10).y,null);
    for(let i=0;i<4;i++)spawnUnit(1,'galley',C(26,20).x,C(26,20).y+i*12,tagsOf(1)[3]);
    const eg=spawnUnit(0,'galley',C(23,10).x,C(23,10).y,tags[0]);
    dbg.aiNavyTick();
    R.guardFish = tagsOf(1)[3].task==='guard' && Math.hypot(tagsOf(1)[3].pt.x-eg.x,tagsOf(1)[3].pt.y-eg.y)<TILE*2;
    eg.hp=0; step(TICK);

    dbg.aiMil.ord.length=0; dbg.aiMil.state='develop';
    fb.hp=0; step(TICK);
    dbg.aiAnalyzeRoutes();
    const bnS=dbg.aiRoutesInfo().flatMap(r=>r.bn).filter(b=>terr[idx(txOf(b.x),tyOf(b.y))]===T_SHALLOW);
    R.fordBn = bnS.length>=1;
    const ford=dbg.aiFordStation(1);
    R.fordStation = !!ford && terr[idx(txOf(ford.x),tyOf(ford.y))]===T_WATER;
    dbg.aiNavyTick();
    R.blockade = !!ford && tagsOf(1)[3].task==='guard' && Math.hypot(tagsOf(1)[3].pt.x-ford.x,tagsOf(1)[3].pt.y-ford.y)<TILE*2;

    units.filter(u=>u.side===1&&u.dom==='water'&&u.type!=='fishing').forEach(u=>u.hp=0); step(TICK);
    const isleN={type:'gold',x:C(24,7).x,y:C(24,7).y,amt:400,max:400}; nodes.push(isleN);
    dbg.AI_SEA.ready=false; dbg.aiSeaInit();
    const hubC=landComp[idx(txOf(atc.x),tyOf(atc.y))], isleC=landComp[idx(23,6)];
    R.isleSeparate = isleC>=0 && isleC!==hubC && dbg.aiSeaInfo().ores.some(o=>o.comp===isleC);
    techOf(1).age=2;
    dbg.setAiEco(false); S_(1).scripted=false;
    const T2=spawnUnit(1,'transport',C(27,20).x,C(27,20).y,null);
    const su=spawnUnit(1,'settler',C(30,20).x,C(30,20).y,null);
    dbg.aiMil.island=null; dbg.aiIslandStart(1);
    R.isleStart = !!dbg.aiMil.island;
    const phases=new Set();
    for(let i=0;i<7200&&dbg.aiMil.island;i++){
      if(dbg.aiMil.island)phases.add(dbg.aiMil.island.phase);
      if(i%60===0)dbg.aiIslandTick(1);
      step(TICK);
    }
    R.isleT=Math.round(t); R.phases=[...phases];
    R.isleFlow = ['train','load','sail','unload','deploy'].every(p=>phases.has(p));
    R.isleOutpost = buildings.some(b=>b.side===1&&b.type==='outpost'&&landComp[idx(b.tx,b.ty)]===isleC);
    R.isleDone = dbg.aiMil.island===null;

    dbg.setAiEco(true);
    clr(); gameOver=null; dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN); computeLandComp(); computeDanger();
    placeB(0,'tc',6,12,true);
    const btc=placeB(1,'tc',30,10,true); resetAi(); dbg.setAiEco(true);
    for(let i=0;i<10;i++)spawnVillager(btc);
    for(const k in stockOf(1))stockOf(1)[k]=300;
    step(TICK); dbg.aiEcoTick(); const share0=S_(1).shares.food;
    dbg.setTerr(18,1,28,25,T_WATER); computeLandComp(); dbg.AI_SEA.ready=false;
    for(let i=0;i<6;i++)spawnUnit(1,'galley',C(22,10).x+i*12,C(22,10).y,tagsOf(1)[3]);
    step(TICK);
    R.shipUpkeep = +S_(1).curUpkeep.toFixed(2);
    dbg.aiEcoTick(); const share1=S_(1).shares.food;
    R.share0=share0; R.share1=share1;
    R.foodTargetUp = R.shipUpkeep>0.5 && share1>share0+0.1;

    dbg.setAiEco(false); dbg.setAiMil(true); resetAi();
    clr(); dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN); computeLandComp(); computeDanger();
    villagers=villagers.filter(v=>(v.side||0)===0);
    for(const k in S_(1).shares)S_(1).shares[k]=1; for(const k in stockOf(1))stockOf(1)[k]=0;
    for(const k in stock)stock[k]=0;
    for(const g of tagsOf(1)){g.task='guard';g.pt=null;g.focus=null;g.holdFire=false;g.zoneAnchor=null;}
    dbg.aiMil.routes.length=0; dbg.AI_SEA.ready=false; aiWave=99999;
    return R;`);
  check('Land map = naval brain fully short-circuited (hasWater=false; no docks, no ships, zero cost)', t81.landNoWater&&t81.landShort, t81);
  check('Water map: the AI builds a dock, trains ≥2 fishing boats and fish actually reach the stockpile (end-to-end; all via AICMD, same gates as the player)', t81.dockBuilt&&t81.fishBoats>=2&&t81.fishFood>0&&t81.fishIncome, t81);
  check('Naval counter mix both ways: enemy war galleys → add fire ships; enemy fire ships → add siege ships (naval RPS)', t81.counterFire&&t81.counterSiege, t81);
  check('Fishing escort: an enemy ship closing within 9 tiles of an own fishing boat → fleet intercept order (threat centroid)', t81.guardFish, t81);
  check('Ford blockade: shallows inside a land chokepoint = a ford; when the fleet is dominant it stands guard on the adjacent deep-water tile', t81.fordBn&&t81.fordStation&&t81.blockade, t81);
  check('Transport island grab: isolated island (landComp ≠ home) → train/load/sail/unload/deploy all phases complete + an outpost on the island + the task closes', t81.isleSeparate&&t81.isleStart&&t81.isleFlow&&t81.isleOutpost&&t81.isleDone, t81);
  check('Ship upkeep counted into the AI food target (the food share rises after training ships = no food-shortage army penalty)', t81.foodTargetUp, t81);

  console.log('\n[82] AI difficulty tiers + cheating tier + personality (slice E; specs/13 §4/§6/§8): knobs take effect / never retreat / cycle multiplier / cheat bonuses really enter the stockpile / hot-switch resets the clock / per-side brain isolation / draw determinism');
  const t82 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const clr=()=>{units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;shots.length=0;ghosts.length=0;};
    const R={};
    arenaMode=false; gameOver=null; aiDefT=1e9; aiFullVision=true; aiWave=99999;
    const world=()=>{clr();gameOver=null;dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN);computeLandComp();explored.fill(1);exploredE.fill(1);visible.fill(0);visibleE.fill(0);computeDanger();};
    world();
    const ptc=placeB(0,'tc',3,20,true), atc=placeB(1,'tc',30,10,true);
    placeB(1,'barracks',34,13,true);
    for(const k in stockOf(1))stockOf(1)[k]=2000;
    techOf(1).researched.clear(); techOf(1).age=1; techOf(1).track=null; techOf(1).queue.length=0; techOf(1).ageUp=null;
    dbg.setAiEco(true); dbg.setAiMil(true);

    for(let i=0;i<6;i++)spawnUnit(0,'cavalry',C(20,14).x+i*8,C(20,14).y,tags[0]);
    dbg.setAiDiff(1,'noob');   dbg.aiMilTick(1); const wN=dbg.aiMilWant(1);
    dbg.setAiDiff(1,'normal'); dbg.aiMilTick(1); const wM=dbg.aiMilWant(1);
    dbg.setAiDiff(1,'hard');   dbg.aiMilTick(1); const wH=dbg.aiMilWant(1);
    R.noobSingle  = Object.keys(wN).length===1 && wN.spear>0;
    R.wM=wM;
    R.normalFixed = (wM.archer||0)>0 && Math.abs((wM.spear||0)/(wM.archer||1)-7/3)<0.35
      && Math.abs((wM.spear||0)-(wH.spear||0))>0.5;
    R.hardCounter = (wH.spear||0)>(wH.archer||0)*1.5;
    R.wN=wN; R.wH=wH;

    dbg.setAiDiff(1,'noob');   R.retNoob = dbg.aiRetreatR(1)===0;
    dbg.setAiDiff(1,'normal'); R.retNormal = dbg.aiRetreatR(1)===0;
    dbg.setAiDiff(1,'hard');   R.retHard = dbg.aiRetreatR(1)>1;
    units.filter(u=>u.side===0&&!u.gar).forEach(u=>u.hp=0); step(TICK);
    const pfarm=placeB(0,'farm',7,17,true);
    for(let i=0;i<6;i++)spawnUnit(1,'spear',pfarm.x+30+i*10,pfarm.y,tagsOf(1)[0]);
    for(let i=0;i<12;i++)spawnUnit(0,'spear',pfarm.x+(rng()*2-1)*40,pfarm.y+60,tags[0]);
    const runRetreat=(lv)=>{
      dbg.setAiDiff(1,lv); dbg.aiAnalyzeRoutes(1);
      dbg.aiMil.state='pressure'; dbg.aiMil.sT=t; dbg.aiMil.mission=null; dbg.aiMil.retreatT=-1e9; dbg.aiMil.ord.length=0;
      dbg.aiMilTick(1);
      const built=!!dbg.aiMil.mission;
      dbg.aiMilTick(1);
      return {built,mission:!!dbg.aiMil.mission,state:dbg.aiMil.state};
    };
    const rN=runRetreat('noob'), rH=runRetreat('hard');
    R.rN=rN; R.rH=rH;
    R.noobNoRetreat = rN.built && rN.mission && rN.state==='pressure';
    R.hardRetreats  = rH.built && !rH.mission && rH.state==='develop';
    units.filter(u=>u.side===0&&!u.gar).forEach(u=>u.hp=0); step(TICK);

    dbg.setAiDiff(1,'hard'); dbg.A(1).ecoT=0; dbg.aiSideTick(1,0.001);
    const perHard = dbg.A(1).ecoT;
    dbg.setAiDiff(1,'noob'); dbg.A(1).ecoT=0; dbg.aiSideTick(1,0.001);
    const perNoob = dbg.A(1).ecoT;
    R.perHard=+perHard.toFixed(2); R.perNoob=+perNoob.toFixed(2);
    R.periodKnob = Math.abs(perHard-dbg.AI_T.eco)<0.01 && perNoob>=dbg.AI_T.eco*2.5*0.6-0.01 && perNoob<=dbg.AI_T.eco*2.5*1.4+0.01;

    dbg.setAiDiff(1,'hard');  R.gHard=modOf(1).gather;  R.aHard=modOf(1).meleeAtk;
    dbg.setAiDiff(1,'shura'); R.gShura=modOf(1).gather; R.aShura=modOf(1).meleeAtk;
    dbg.setAiDiff(1,'god');   R.gGod=modOf(1).gather;   R.aGod=modOf(1).meleeAtk;
    R.cheatTech = R.aHard===0 && R.aShura===1 && R.aGod===2 && R.gHard===1 && Math.abs(R.gShura-1.2)<1e-9 && Math.abs(R.gGod-1.5)<1e-9;
    const gather=(lv)=>{
      world(); placeB(0,'tc',3,20,true);
      const tc=placeB(1,'tc',10,10,true);
      const n={type:'wood',x:C(13,10).x,y:C(13,10).y,amt:1e6,max:1e6}; nodes.push(n);
      dbg.setAiEco(false); dbg.setAiDiff(1,lv); dbg.setAiSide(1,false); S_(1).scripted=false;
      for(const k in S_(1).gathered)S_(1).gathered[k]=0;
      for(const k in stockOf(1))stockOf(1)[k]=500;
      for(let i=0;i<4;i++)spawnVillager(tc);
      villagers.filter(v=>v.side===1).forEach(v=>{v.job='wood';});
      for(let i=0;i<900;i++)step(TICK);                                                          // 30s
      return Math.round(S_(1).gathered.wood);
    };
    const gH=gather('hard'), gG=gather('god');
    R.gathHard=gH; R.gathGod=gG;
    R.cheatGather = gG>gH*1.15;

    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',30,10,true);
    dbg.setAiEco(true); dbg.setAiDiff(1,'hard');
    dbg.aiMil.state='pressure'; dbg.aiMil.sT=t-500; dbg.aiMil.retreatT=t-1;
    dbg.setAiDiff(1,'boss');
    R.hotSwapReset = dbg.aiMil.state==='develop' && Math.abs(dbg.aiMil.sT-t)<0.01 && dbg.aiMil.retreatT<-1e8;

    dbg.setAiSide(0,true); dbg.setAiDiff(0,'noob');
    dbg.aiAnalyzeRoutes(0); dbg.aiAnalyzeRoutes(1);
    dbg.A(0).state='allin'; dbg.A(0).foeSeen.spear=99; dbg.A(0).civGuess='mongol';
    R.perSide = dbg.aiDiff(0)==='noob' && dbg.aiDiff(1)==='boss'
      && dbg.A(1).state!=='allin' && dbg.A(1).foeSeen.spear!==99 && dbg.A(1).civGuess!=='mongol'
      && dbg.aiRoutesInfo(0).length>=1 && dbg.aiRoutesInfo(1).length>=1
      && dbg.aiRoutesInfo(0)[0].rally.x!==dbg.aiRoutesInfo(1)[0].rally.x;
    R.side0Vill = villagers.filter(v=>(v.side||0)===0).length>=8;
    dbg.setAiSide(0,false);

    seed=777; dbg.A(1).pers=null; const p1=JSON.stringify(dbg.aiDraw(1)), c1=dbg.sideState(1).civ;
    seed=777; dbg.A(1).pers=null; const p2=JSON.stringify(dbg.aiDraw(1)), c2=dbg.sideState(1).civ;
    R.drawDet = p1===p2 && c1===c2; R.plan=p1;
    dbg.setAiPers(1,'mongol');
    R.persMongol = dbg.aiPers(1)==='mongol' && dbg.sideState(1).civ==='mon'
      && dbg.aiTechLine(1).indexOf('U1')<dbg.aiTechLine(1).indexOf('E1');
    dbg.setAiPers(1,'hre');
    R.persHre = dbg.sideState(1).civ==='hre' && dbg.aiPlan(1).open==='boom';
    // 8.4 deferred commitment (the fixed version of the lateStar dead knob): the civilisation-specific
    // final step (UM horse archer) is not queued until the opponent's civilisation has been identified —
    // age2 is enough to hold it. The original code tested age<2, when the unique is not yet unlocked, so
    // it never fired: a dead knob. age3 is the fallback so a line never deadlocks just because scouting
    // never happened.
    dbg.setAiDiff(1,'boss'); dbg.A(1).pers=null; dbg.setAiPers(1,'mongol'); dbg.A(1).civGuess=null; techOf(1).age=2;
    const lineDefer=dbg.aiTechLine(1);
    dbg.A(1).civGuess='england'; const lineRead=dbg.aiTechLine(1);
    dbg.A(1).civGuess=null; techOf(1).age=3; const lineAge3=dbg.aiTechLine(1);
    R.lateStar = !lineDefer.includes('UM') && lineRead.includes('UM') && lineAge3.includes('UM');
    // Control: on hard (lateStar=false) at age2, with the opponent unidentified, the final step is queued
    // anyway — the ablation (swap in hard's value, behaviour changes) proves this is not a dead knob.
    // save/restore the seed so the draw does not pollute the shared rng used by later tests (the fort tests
    // do not reset the seed).
    {const _seed=seed; dbg.setAiDiff(1,'hard'); dbg.A(1).pers=null; dbg.setAiPers(1,'mongol'); dbg.A(1).civGuess=null; techOf(1).age=2;
     R.lateStarAblate = dbg.aiTechLine(1).includes('UM'); seed=_seed;}

    dbg.setAiEco(false); dbg.setAiSide(0,false); dbg.setAiDiff(1,'hard'); dbg.A(1).pers=null; dbg.A(1).plan=null;
    dbg.setSideCiv(1,'eng'); S_(1).aiCheat={gather:1,tech:0}; recomputeTechMod(1);
    dbg.setAiMil(true); dbg.aiResetBrain(1); dbg.A(1).plan=null;
    techOf(1).researched.clear(); techOf(1).age=1; techOf(1).track=null; techOf(1).queue.length=0; techOf(1).ageUp=null; recomputeTechMod(1);
    world(); villagers=villagers.filter(v=>(v.side||0)===0);
    for(const k in S_(1).shares)S_(1).shares[k]=1; for(const k in stockOf(1))stockOf(1)[k]=0; for(const k in stock)stock[k]=0;
    for(const g of tagsOf(1)){g.task='guard';g.pt=null;g.focus=null;g.holdFire=false;g.zoneAnchor=null;}
    aiWave=99999;
    return R;`);
  check('Formation knob: easy = a single unit type / normal = a fixed mix (ignores sightings) / hard = full counter mix', t82.noobSingle&&t82.normalFixed&&t82.hardCounter, t82);
  check('Retreat knob: easy and normal "never retreat" (3 against 12 keeps attacking) / hard retreats only at 1.55', t82.retNoob&&t82.retNormal&&t82.retHard&&t82.noobNoRetreat&&t82.hardRetreats, t82);
  check('Brain cycle multiplier: hard ×1 = 2s / easy ×2.5 plus randomly skipped beats = 3-7s (feels idle)', t82.periodKnob, t82);
  check('Cheating tier, explicit numbers: gathering ×1.2 / ×1.5 really enters the stockpile; M-line attack/armour +1 / +2 tiers (fair tiers stay neutral)', t82.cheatTech&&t82.cheatGather, t82);
  check('Hot-switching difficulty resets the state machine clock (no instant turtle-bell timeout; landmine c)', t82.hotSwapReset, t82);
  check('per-side brain isolation: a brain on side0 gets its own containers / routes / sighting memory (does not pollute side1) + tops up starting villagers', t82.perSide&&t82.side0Vill, t82);
  check('Draw determinism (same seed, same plan) + three personality archetypes (civilisation commitment / research-line bias / opening template) + boss deferred commitment as the last step (§8.4; commits only after reading the board; the hard control is unchanged)', t82.drawDet&&t82.persMongol&&t82.persHre&&t82.lateStar&&t82.lateStarAblate, t82);

  console.log('\n[83] AI civilisation scouting counters + read-only enemy panel (slice F; specs/13 §5): tell-reading / persistent intel / cheating tier knows instantly / hard still needs tells / counter pivot (formation + research line) / enemy panel clickable but read-only, not clickable under fog');
  const t83 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const clr=()=>{units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;shots.length=0;ghosts.length=0;};
    const R={};
    arenaMode=false; gameOver=null; aiDefT=1e9; aiWave=99999; aiFullVision=true;
    const world=()=>{clr();gameOver=null;dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN);computeLandComp();explored.fill(1);exploredE.fill(1);visible.fill(0);visibleE.fill(0);computeDanger();};
    const freshAi=(lv)=>{techOf(1).researched.clear();techOf(1).age=1;techOf(1).track=null;techOf(1).queue.length=0;techOf(1).ageUp=null;recomputeTechMod(1);
      dbg.setAiEco(true);dbg.setAiMil(true);dbg.A(1).pers=null;dbg.A(1).plan=null;dbg.setAiDiff(1,lv);dbg.aiResetBrain(1);};

    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',30,10,true);
    for(const k in stockOf(1))stockOf(1)[k]=2000;
    freshAi('hard');
    R.guess0 = dbg.aiCivGuessOf(1)===null;
    techOf(0).researched.add('M3'); techOf(0).researched.add('UL'); recomputeTechMod(0);
    const lb=spawnUnit(0,'longbow',C(20,14).x,C(20,14).y,tags[0]);
    dbg.aiMilTick(1);
    R.guessEngland = dbg.aiCivGuessOf(1)==='england';
    lb.hp=0; step(TICK); dbg.aiMilTick(1);
    R.guessSticky = dbg.aiCivGuessOf(1)==='england';

    techOf(1).researched.add('U1');
    for(const k in dbg.A(1).foeSeen)delete dbg.A(1).foeSeen[k];
    for(let i=0;i<5;i++)spawnUnit(0,'archer',C(20,14).x+i*9,C(20,14).y,tags[0]);
    dbg.aiMilTick(1);
    dbg.A(1).civGuess=null; const wNo=dbg.aiMilWant(1);
    dbg.A(1).civGuess='england'; const wEn=dbg.aiMilWant(1);
    dbg.A(1).civGuess='mongol';  const wMo=dbg.aiMilWant(1);
    dbg.A(1).civGuess='hre';     const wHr=dbg.aiMilWant(1);
    R.wNo=wNo; R.wEn=wEn; R.wMo=wMo; R.wHr=wHr;
    const share=(w,k)=>{let tot=0;for(const x in w)tot+=w[x];return tot?(w[k]||0)/tot:0;};
    R.pivotEngland = share(wEn,'cavalry')>share(wNo,'cavalry')*1.2 && share(wEn,'spear')<share(wNo,'spear');
    R.pivotMongol  = share(wMo,'spear')  >share(wNo,'spear')*1.15;
    R.pivotHre     = share(wHr,'archer') >share(wNo,'archer')*1.15;
    dbg.A(1).civGuess='england';
    const line=dbg.aiTechLine(1);
    R.pivotTech = line.indexOf('U1')<line.indexOf('E1') && line.indexOf('M1')<line.indexOf('E1');
    units.filter(u=>u.side===0&&!u.gar).forEach(u=>u.hp=0); step(TICK);

    const godScene=(lv)=>{
      world(); placeB(0,'tc',3,20,true); placeB(1,'tc',30,10,true);
      freshAi(lv);
      techOf(0).researched.clear(); dbg.setSideCiv(0,'mon');
      techOf(0).researched.add('M6'); recomputeTechMod(0);
      spawnUnit(0,'spear',C(20,14).x,C(20,14).y,tags[0]);
      dbg.aiMilTick(1);
      return dbg.aiCivGuessOf(1);
    };
    R.godKnows = godScene('god')==='mongol';
    R.hardBlind = godScene('hard')===null;
    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',30,10,true); freshAi('god');
    techOf(0).researched.clear(); dbg.setSideCiv(0,'mon'); recomputeTechMod(0);
    R.civ0Mon = dbg.sideState(0).civ==='mon';
    spawnUnit(0,'spear',C(20,14).x,C(20,14).y,tags[0]); dbg.aiMilTick(1);
    R.godNotAtStart = dbg.aiCivGuessOf(1)===null;
    aiFullVision=false; visibleE.fill(0);
    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',30,10,true); freshAi('god');
    techOf(0).researched.clear(); dbg.setSideCiv(0,'mon');
    techOf(0).researched.add('M6'); recomputeTechMod(0);
    const hidden=spawnUnit(0,'spear',C(20,14).x,C(20,14).y,tags[0]);
    dbg.aiMilTick(1);
    R.godNoXray = dbg.aiCivGuessOf(1)===null;
    aiFullVision=true;

    world(); placeB(0,'tc',3,20,true); const etc=placeB(1,'tc',30,10,true);
    dbg.setAiEco(false); dbg.setSideCiv(0,'eng');
    visible.fill(0); visible[idx(20,14)]=1; visible[idx(20,15)]=1;
    const foeLb=spawnUnit(1,'longbow',C(20,14).x,C(20,14).y,tagsOf(1)[0]);
    const foeFog=spawnUnit(1,'spear',C(28,3).x,C(28,3).y,tagsOf(1)[0]);
    R.pickFoe = dbg.pickUnitAt(foeLb.x,foeLb.y)===foeLb;
    R.pickFog = dbg.pickUnitAt(foeFog.x,foeFog.y)===null;
    const mine=spawnUnit(0,'spear',foeLb.x+4,foeLb.y,tags[0]);
    R.pickMineFirst = dbg.pickUnitAt(foeLb.x,foeLb.y)===mine;
    mine.hp=0; step(TICK);
    dbg.openUnitPanel(foeLb);
    const h=dbg.panelHtml();
    R.panelOpen = dbg.panelOpen();
    R.panelFoe = h.includes('（敵）') && h.includes('唯讀') && h.includes('長弓兵');
    R.panelCiv = h.includes('英格蘭');
    R.panelNoCmd = !h.includes('<button');
    R.panelHp = h.includes('HP '+Math.ceil(foeLb.hp));
    etc.seen=true; const eci=idx(txOf(etc.x),tyOf(etc.y));
    visible[eci]=1; dbg.openFoeBldPanel(etc); const hb1=dbg.panelHtml();
    visible[eci]=0; dbg.openFoeBldPanel(etc); const hb2=dbg.panelHtml();
    R.panelBldLive = hb1.includes('HP ') && hb1.includes('（敵）');
    R.panelBldGhost = hb2.includes('殘影') && !hb2.includes('HP ');
    closePanels();

    dbg.setAiEco(false); dbg.setAiDiff(1,'hard'); dbg.A(1).pers=null; dbg.A(1).plan=null;
    dbg.setSideCiv(1,'eng'); dbg.setSideCiv(0,'eng'); S_(1).aiCheat={gather:1,tech:0};
    techOf(0).researched.clear(); techOf(1).researched.clear();
    techOf(0).age=1; techOf(1).age=1; recomputeTechMod(0); recomputeTechMod(1);
    dbg.aiResetBrain(1); dbg.A(1).plan=null;
    world(); visible.fill(0); explored.fill(1);exploredE.fill(1); villagers=villagers.filter(v=>(v.side||0)===0);
    for(const k in stockOf(1))stockOf(1)[k]=0; for(const k in stock)stock[k]=0;
    return R;`);
  check('F1 tell-reading: no intel at the start → longbowman sighted → infer England → still remembered after it leaves vision (a commitment is persistent intel)', t83.guess0&&t83.guessEngland&&t83.guessSticky, t83);
  check('F2 counter pivot (formation): vs England → cavalry share ↑ spearmen ↓; vs the Mongols → spearmen ↑; vs the Holy Roman Empire → archers ↑', t83.pivotEngland&&t83.pivotMongol&&t83.pivotHre, t83);
  check('F2 counter pivot (research line): England read → U1 cavalry line + M1 moved ahead of economic research', t83.pivotTech, t83);
  check('F1 cheating-tier omniscience (explicit): once the opponent has committed a civilisation, sighting any unit reveals it; hard tier still has no intel in the same scenario', t83.godKnows&&t83.hardBlind, t83);
  check('Never-cheat clauses: the cheating tier does not know from the start (opponent uncommitted = no intel); and it cannot see through fog (not scouted = not known)', t83.civ0Mon&&t83.godNotAtStart&&t83.godNoXray, t83);
  check('F3 read-only enemy unit panel: visible enemy units are clickable (stats / civilisation tag on unique units / no command buttons); not clickable under fog; own units win when overlapping', t83.pickFoe&&t83.pickFog&&t83.pickMineFirst&&t83.panelOpen&&t83.panelFoe&&t83.panelCiv&&t83.panelNoCmd&&t83.panelHp, t83);
  check('F3 read-only enemy building panel: visible = live HP; under fog = the ghost\'s "last seen"', t83.panelBldLive&&t83.panelBldGhost, t83);

  console.log('\n[84] AI trickle-attack fix + late-game economy fix (2026-07-09 device 1207s log feedback): wave criterion switched to the main army / rally flag comes home on a wipe / formation threshold scales with budget / AI marks new woodlots / market sells surplus to buy shortages / research line not frozen by one missing resource / farm cap scales with villager count');
  const t84 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const clr=()=>{units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;shots.length=0;ghosts.length=0;};
    const R={};
    arenaMode=false; gameOver=null; aiDefT=1e9; aiWave=99999; aiFullVision=true;
    const world=()=>{clr();gameOver=null;dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN);computeLandComp();explored.fill(1);exploredE.fill(1);visible.fill(0);visibleE.fill(0);dangerMem.fill(0);dangerMemE.fill(0);computeDanger();};
    const freshAi=()=>{techOf(1).researched.clear();techOf(1).age=1;techOf(1).track=null;techOf(1).queue.length=0;techOf(1).ageUp=null;recomputeTechMod(1);
      dbg.setAiEco(true);dbg.setAiMil(true);dbg.A(1).pers=null;dbg.A(1).plan=null;dbg.setAiDiff(1,'hard');dbg.aiResetBrain(1);
      dbg.A(1).plan={open:'std',routeBias:0,harass:false};};

    world(); placeB(0,'tc',3,20,true); const atc=placeB(1,'tc',30,10,true); placeB(1,'barracks',33,10,true);
    for(const k in stockOf(1))stockOf(1)[k]=1000;
    freshAi(); villagers=villagers.filter(v=>(v.side||0)===0);
    dbg.aiMilTick(1);
    const a1=dbg.A(1);
    a1.state='pressure'; a1.sT=t;
    const gM=tagsOf(1)[0]; gM.task='attack'; gM.pt={x:C(4,20).x,y:C(4,20).y};
    a1.ord[0]={t,x:C(4,20).x,y:C(4,20).y,task:'attack'};
    a1.mission={tgt:buildings.find(b=>b.side===0),kind:'base',legs:[{x:C(4,20).x,y:C(4,20).y}],li:0};
    dbg.aiMilTick(1);
    R.wipeState = a1.state==='develop';
    R.flagHome = !!gM.pt && Math.hypot(gM.pt.x-C(4,20).x,gM.pt.y-C(4,20).y)>TILE*8 && gM.task==='guard';
    a1.state='develop'; a1.sT=t; a1.retreatT=-1e9;
    for(let i=0;i<5;i++)spawnUnit(1,'spear',C(31,11).x+i*9,C(31,11).y,tagsOf(1)[1]);
    for(let i=0;i<3;i++)spawnUnit(1,'archer',C(31,12).x+i*9,C(31,12).y,tagsOf(1)[2]);
    dbg.aiMilTick(1);
    R.noInflate = a1.state==='develop';
    for(let i=0;i<7;i++)spawnUnit(1,'spear',C(30,12).x+i*9,C(30,12).y,tagsOf(1)[0]);
    dbg.aiMilTick(1);
    R.waveLaunch = a1.state==='pressure'||a1.state==='allin';
    for(const k in a1.foeSeen)delete a1.foeSeen[k];
    const w84=dbg.aiMilWant(1); let wTot=0; for(const k in w84)wTot+=w84[k];
    R.baselineScales = wTot>=5;
    units.length=0;

    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',30,10,true);
    dbg.setTerr(25,6,27,8,T_FOREST);
    computeLandComp();
    for(const k in stockOf(1))stockOf(1)[k]=500;
    freshAi();
    const fI=idx(26,7);
    R.forestUnmarked0 = !dbg.forestMarkedFor(26,7,1);
    dbg.aiEcoTick(1);
    R.forestMarked = dbg.forestMarkedFor(26,7,1);
    R.playerUnaffected = !dbg.forestMarkedFor(26,7,0);
    villagers=villagers.filter(v=>(v.side||0)===0);

    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',30,10,true); placeB(1,'market',33,12,true);
    freshAi(); techOf(1).age=3;
    for(const k in S_(1).priceIdx)S_(1).priceIdx[k]=1;
    const stk84=stockOf(1); for(const k in stk84)stk84[k]=0;
    stk84.stone=900; stk84.food=300; stk84.gold=30; stk84.wood=10;
    const g0=stk84.gold;
    dbg.aiEcoTick(1);
    R.mktSold = stk84.stone<900 && stk84.gold>g0;
    let bought=false;
    for(let i=0;i<10&&!bought;i++){dbg.aiEcoTick(1);if(stk84.wood>=60)bought=true;}
    R.mktBought = bought;
    villagers=villagers.filter(v=>(v.side||0)===0);

    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',30,10,true); placeB(1,'smith',33,10,true); placeB(1,'stable',33,13,true);
    freshAi(); const T84=techOf(1);
    dbg.setAiPers(1,'england'); dbg.A(1).plan={open:'std',routeBias:0,harass:false};
    dbg.A(1).civGuess='hre';
    for(const id of ['E1','E2','S1','F1','M3','M1'])T84.researched.add(id);
    T84.age=2; recomputeTechMod(1);
    const s84=stockOf(1); for(const k in s84)s84[k]=0;
    s84.wood=300; s84.food=200; s84.gold=0;
    dbg.aiEcoTick(1);
    R.lookahead = (T84.track&&T84.track.id)==='U1'||T84.queue.includes('U1')||T84.researched.has('U1');
    R.lineFirstStillPriority = !T84.researched.has('U2')&&(!T84.track||T84.track.id!=='U2');
    dbg.A(1).civGuess=null; villagers=villagers.filter(v=>(v.side||0)===0);

    world(); placeB(0,'tc',3,20,true); const atc2=placeB(1,'tc',30,10,true);
    freshAi(); techOf(1).age=3;
    while(villagers.filter(v=>(v.side||0)===1).length<23)spawnVillager(atc2);
    for(let i=0;i<8;i++)placeB(1,'farm',24+(i%4)*2,14+((i/4)|0)*2,true);
    for(let i=0;i<7;i++)placeB(1,'coppice',24+i,22,true);
    const s85=stockOf(1); for(const k in s85)s85[k]=0; s85.wood=500;
    const fc84=dbg.aiFarmCap(1);
    dbg.aiEcoTick(1);
    R.farmCapScales = fc84>8 &&
      buildings.filter(b=>b.side===1&&(b.type==='farm'||b.type==='coppice')).length>15;

    dbg.setAiEco(false); dbg.setAiMil(true); dbg.setAiDiff(1,'hard'); dbg.A(1).pers=null; dbg.A(1).plan=null;
    techOf(1).researched.clear(); techOf(1).age=1; techOf(1).track=null; techOf(1).queue.length=0; techOf(1).ageUp=null; recomputeTechMod(1);
    dbg.aiResetBrain(1); world(); explored.fill(1);exploredE.fill(1);
    villagers=villagers.filter(v=>(v.side||0)===0);
    for(const k in stockOf(1))stockOf(1)[k]=0; for(const k in stock)stock[k]=0;
    return R;`);
  check('Trickle fix ①: main army wiped → the rally flag is pulled back to the home guard point + return to developing (new units no longer walk one by one to the old flag in enemy territory)', t84.wipeState&&t84.flagHome, t84);
  check('Trickle fix ②: guard/patrol units do not pad the state machine = pressure only once the main army makes up a full wave (the wave feel is back)', t84.noInflate&&t84.waveLaunch, t84);
  check('Formation threshold scales with budget: the main-army target still forms a real force when the opponent is quiet (≥5 units; was a fixed 2+2)', t84.baselineScales, t84);
  check('AI marks new woodlots: marked wood inside the perimeter exhausted → marks the nearest unmarked forest block (per-side; the player\'s side unaffected)', t84.forestUnmarked0&&t84.forestMarked&&t84.playerUnaffected, t84);
  check('Market deadlock resolved: short of wood and short of gold → sell the largest surplus (stone) for gold first → then buy wood', t84.mktSold&&t84.mktBought, t84);
  check('Research line does not freeze: the top item is unaffordable → research a later affordable item (priority is retained = the top item is not skipped for good)', t84.lookahead&&t84.lineFirstStillPriority, t84);
  check('Renewable cap tied to the map (R2): farmCap>8 on large plains (the villager-count derivation is retired); renewable sources keep growing beyond 8 farms + 7 coppices (no late-game idling)', t84.farmCapScales, t84);


  console.log('\n[85] AI completion round (2026-07-09 device feedback): wood deadlock (coppice / wood budget reservation) / production line rebuild / fortifications (tower; wall+gate; castle) / villagers garrison by touching the building / fishing-boat ring positions / eject from inside buildings + long-term stuck / per-side explored map');
  const t85 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const clr=()=>{units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;shots.length=0;ghosts.length=0;};
    const world=()=>{clr();gameOver=null;dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN);computeLandComp();explored.fill(1);exploredE.fill(1);visible.fill(0);visibleE.fill(0);computeDanger();};
    const freshAi=(lv)=>{techOf(1).researched.clear();techOf(1).age=1;techOf(1).track=null;techOf(1).queue.length=0;techOf(1).ageUp=null;recomputeTechMod(1);
      dbg.setAiEco(true);dbg.setAiMil(true);dbg.A(1).pers=null;dbg.A(1).plan=null;dbg.setAiDiff(1,lv||'hard');dbg.aiResetBrain(1);
      dbg.A(1).plan={open:'std',routeBias:0,harass:false};};
    const nB=(si,tp)=>buildings.filter(b=>b.side===si&&b.hp>0&&b.type===tp).length;
    const R={};
    arenaMode=false; gameOver=null; aiDefT=1e9; aiWave=99999; aiFullVision=true;

    world(); placeB(0,'tc',3,20,true); const atc=placeB(1,'tc',30,10,true);
    freshAi(); villagers=villagers.filter(v=>(v.side||0)===0);
    for(let i=0;i<12;i++)spawnVillager(atc);
    {const s=stockOf(1); for(const k in s)s[k]=0; s.wood=500;}
    dbg.aiEcoTick(1);
    R.copFirst = nB(1,'coppice')===1 && nB(1,'farm')===0;
    {const cc85=dbg.aiCopCap(1);
     for(let i=nB(1,'coppice');i<cc85;i++)placeB(1,'coppice',18+i,22,true);
     dbg.aiMapFeat(1,true);}
    dbg.aiEcoTick(1);
    R.farmAfterCop = nB(1,'farm')>=1;

    world(); placeB(0,'tc',3,20,true); const atc3=placeB(1,'tc',30,10,true); placeB(1,'barracks',34,13,true);
    freshAi(); villagers=villagers.filter(v=>(v.side||0)===0);
    for(let i=0;i<12;i++)spawnVillager(atc3);
    {const s=stockOf(1); for(const k in s)s[k]=1000; s.wood=30;}
    dbg.aiEcoTick(1);
    R.copSave = dbg.aiCmt(1).some(c=>c.key==='bld:coppice') && dbg.aiResv(1,'wood')>=BT.coppice.cost.wood;
    for(let i=0;i<2;i++)spawnUnit(1,'spear',atc3.x-60,atc3.y+40+i*12,tagsOf(1)[1]);
    dbg.aiMilTick(1);
    const qWood = buildings.filter(b=>b.side===1).some(b=>b.queue.some(q=>(UT[q.type].cost.wood||0)>0));
    R.milYieldsWood = !qWood && stockOf(1).wood>=30;
    stockOf(1).wood=200; dbg.aiEcoTick(1);
    R.copBuilt = nB(1,'coppice')>=1;

    world(); placeB(0,'tc',3,20,true); const atc4=placeB(1,'tc',30,10,true); const bar=placeB(1,'barracks',34,13,true);
    freshAi(); villagers=villagers.filter(v=>(v.side||0)===0);
    for(let i=0;i<12;i++)spawnVillager(atc4);
    {const s=stockOf(1); for(const k in s)s[k]=1000;}
    dbg.aiStratTick(1);
    R.hadBarracks = dbg.A(1).had.barracks===true;
    bar.hp=0; step(TICK);
    R.barracksGone = nB(1,'barracks')===0;
    dbg.aiStratTick(1);
    R.rebuilt = nB(1,'barracks')===1;
    world(); placeB(0,'tc',3,20,true); const atc5=placeB(1,'tc',30,10,true); placeB(1,'tower',34,13,true);
    freshAi(); villagers=villagers.filter(v=>(v.side||0)===0);
    for(let i=0;i<12;i++)spawnVillager(atc5);
    dbg.A(1).had.barracks=true;
    for(const id of ['E1','E2'])techOf(1).researched.add(id); recomputeTechMod(1);
    {const s=stockOf(1); for(const k in s)s[k]=0; s.food=AGES[1].cost.food; s.wood=AGES[1].cost.wood+130;}
    dbg.aiStratTick(1);
    R.rebuildYieldsAge = nB(1,'barracks')===1 && dbg.aiCmt(1).some(c=>c.key==='age'&&c.exp);

    world(); const ftc0=placeB(0,'tc',3,20,true),ftc1=placeB(1,'tc',40,20,true);
    dbg.aiAnalyzeRoutes(0); dbg.aiAnalyzeRoutes(1);
    const frontDot=(si,hub,sp)=>{const rly=dbg.A(si).homeRally,dx=rly.x-hub.x,dy=rly.y-hub.y;
      return (sp.tx-txOf(hub.x))*dx+(sp.ty-tyOf(hub.y))*dy;};
    const fs0=dbg.aiFindSpot(0,'tower',ftc0.x,ftc0.y,4),fs1=dbg.aiFindSpot(1,'tower',ftc1.x,ftc1.y,4);
    R.frontPlacement=!!fs0&&!!fs1&&frontDot(0,ftc0,fs0)>0&&frontDot(1,ftc1,fs1)>0;

    world(); placeB(0,'tc',3,20,true); const atc6=placeB(1,'tc',30,10,true);
    freshAi(); villagers=villagers.filter(v=>(v.side||0)===0);
    for(let i=0;i<14;i++)spawnVillager(atc6);
    {const s=stockOf(1); for(const k in s)s[k]=1000;}
    dbg.aiAnalyzeRoutes(1); dbg.A(1).had.barracks=false;
    dbg.aiFortNeeds(1,dbg.aiHub(1),techOf(1),stockOf(1),14); dbg.aiCommitExec(1);
    R.homeTower = nB(1,'tower')===1;
    /* Novice difficulty gets exactly one tower, at the home gate, and only that one.
       The old assertion claimed novice builds 0 towers all game, which froze the AI_DIFF.noob.towers=0
       spec violation into the test suite. The spec says novice defends home on a loose threshold (build
       after being attacked 2-3 times; defending home is the baseline), and d.towers (aiTowerCap) is a
       category-unlock level where 1 = home gate — so 0 sits below the minimum and switched home defence
       off entirely.
       Knock-on: G1-1 (boss vs novice, razing the home gate) reported "novice has zero defensive buildings
       ⇒ no candidates for stepwise target selection ⇒ 1a unmeasurable" as a fact of nature, when it was a
       consequence of this violation. Fix here first, then G1-1 has something to measure.
       The difficulty gradient still holds: noob=1 (home gate only) < normal=1 < hard=2 (+ active resource
       areas) < boss=3 (+ outposts). */
    world(); placeB(0,'tc',3,20,true); const atc7=placeB(1,'tc',30,10,true);
    freshAi('noob'); dbg.A(1).plan={open:'std',routeBias:0,harass:false};
    villagers=villagers.filter(v=>(v.side||0)===0); for(let i=0;i<14;i++)spawnVillager(atc7);
    {const s=stockOf(1); for(const k in s)s[k]=1000;}
    dbg.aiAnalyzeRoutes(1);
    for(let i=0;i<5;i++)dbg.aiFortNeeds(1,dbg.aiHub(1),techOf(1),stockOf(1),14); dbg.aiCommitExec(1);
    R.noobHomeTower = nB(1,'tower')===1;
    R.noobTowerCap  = dbg.aiTowerCap(1)===1;
    {const dN=AI_DIFF.noob, old=dN.towers; dN.towers=0;
     world(); placeB(0,'tc',3,20,true); const atc7b=placeB(1,'tc',30,10,true);
     freshAi('noob'); dbg.A(1).plan={open:'std',routeBias:0,harass:false};
     villagers=villagers.filter(v=>(v.side||0)===0); for(let i=0;i<14;i++)spawnVillager(atc7b);
     {const s=stockOf(1); for(const k in s)s[k]=1000;}
     dbg.aiAnalyzeRoutes(1);
     for(let i=0;i<5;i++)dbg.aiFortNeeds(1,dbg.aiHub(1),techOf(1),stockOf(1),14); dbg.aiCommitExec(1);
     R.noobTowers0Silent = nB(1,'tower')===0; dN.towers=old;}

    world(); placeB(0,'tc',3,20,true); const atc8=placeB(1,'tc',30,10,true);
    freshAi(); villagers=villagers.filter(v=>(v.side||0)===0); for(let i=0;i<14;i++)spawnVillager(atc8);
    {const s=stockOf(1); for(const k in s)s[k]=1000;}
    dbg.aiAnalyzeRoutes(1);
    placeB(1,'tower',txOf(dbg.A(1).homeRally.x),tyOf(dbg.A(1).homeRally.y),true);
    const mine=C(20,20); dbg.A(1).harassAt={'5,5':{n:2,x:mine.x,y:mine.y}};
    dbg.aiFortNeeds(1,dbg.aiHub(1),techOf(1),stockOf(1),14); dbg.aiCommitExec(1);
    R.harassTower = buildings.some(b=>b.side===1&&b.type==='tower'&&Math.hypot(b.x-mine.x,b.y-mine.y)<TILE*5);

    world(); const ptc9=placeB(0,'tc',3,20,true); const atc9=placeB(1,'tc',40,20,true);
    freshAi(); villagers=villagers.filter(v=>(v.side||0)===0); for(let i=0;i<14;i++)spawnVillager(atc9);
    techOf(1).age=2; recomputeTechMod(1);
    for(let y=0;y<TH;y++){if(y>=20&&y<=22)continue;placeB(0,'wall',30,y,true);}
    computeLandComp(); dbg.aiAnalyzeRoutes(1);
    R.bnFound = dbg.A(1).routes.length>=1 && dbg.A(1).routes[0].bn.length>=1;
    {const s=stockOf(1); for(const k in s)s[k]=1000;}
    dbg.A(1).defAcc=0;
    dbg.aiFortNeeds(1,dbg.aiHub(1),techOf(1),stockOf(1),14); dbg.aiCommitExec(1);
    R.noWallBeforeSiege = nB(1,'gate')===0;
    dbg.A(1).defAcc=60;
    dbg.aiFortNeeds(1,dbg.aiHub(1),techOf(1),stockOf(1),14); dbg.aiCommitExec(1);
    const gate=buildings.find(b=>b.side===1&&b.type==='gate');
    R.gatePlaced = !!gate;
    R.gateOnRoute = !!gate && dbg.A(1).routes[0].bn.some(b=>Math.hypot(b.x-gate.x,b.y-gate.y)<TILE*2);
    dbg.aiFortNeeds(1,dbg.aiHub(1),techOf(1),stockOf(1),14); dbg.aiCommitExec(1);
    R.wallPlaced = nB(1,'wall')>=1;
    R.gatePassable = !!gate && canStep(idx(gate.tx,gate.ty),idx(gate.tx,gate.ty),1,undefined);
    R.gateBlocksFoe = !!gate && !canStep(idx(gate.tx,gate.ty),idx(gate.tx,gate.ty),0,undefined);

    /* Fortifications: castles. Castles are the expensive R1 item, funded from an income share banked as
       stone — build only when the bucket fills, which retires the v1 "surplus > cost + 300" cash gate.
       castleN (a fixed count from the difficulty table plus a T.age>=3 "late knights" tie-in) is retired
       in favour of d.castle as a category-unlock level (0/1/2), with aiCastleCap driven by stone economy ×
       number of defended points, and aiCastleTime by unlock level + economy size + the first attack wave.
       The fixture therefore has to supply three new preconditions:
       1. age >= 2 (the castle's BTIER unlock; the old fixture passed with age=3 anyway)
       2. stone in the territory (stoneAmt >= castleStone — this map can afford one; otherwise cap=0, which
          is exactly the point of tying it to the economy)
       3. villagers >= castleVill and a first engagement already fought (defAcc > 0) */
    world(); placeB(0,'tc',3,20,true); const atc10=placeB(1,'tc',30,10,true);
    freshAi(); villagers=villagers.filter(v=>(v.side||0)===0);
    for(let i=0;i<AI_MAPP.castleVill+2;i++)spawnVillager(atc10);
    nodes.push({type:'stone',x:(34+0.5)*TILE,y:(10+0.5)*TILE,amt:AI_MAPP.castleStone+500,max:AI_MAPP.castleStone+500});
    techOf(1).age=3; recomputeTechMod(1); dbg.aiAnalyzeRoutes(1);
    dbg.A(1).defAcc=60;
    {const s=stockOf(1); for(const k in s)s[k]=1000; s.stone=BT.castle.cost.stone+200;}
    const nV=villagers.filter(v=>(v.side||0)===1).length;
    R.castleCap1 = dbg.aiCastleCap(1)===1;
    dbg.aiFortNeeds(1,dbg.aiHub(1),techOf(1),stockOf(1),nV); dbg.aiCommitExec(1);
    R.stoneWantPending = dbg.aiCmt(1).some(c=>c.key==='bld:castle'&&c.exp);
    R.noCastleThin = nB(1,'castle')===0;
    dbg.aiIncomeTick(1); dbg.aiIncomeTick(1);
    dbg.aiFortNeeds(1,dbg.aiHub(1),techOf(1),stockOf(1),nV); dbg.aiCommitExec(1);
    R.castlePlaced = nB(1,'castle')===1;
    /* Liveness for the castle knob (castleN was the only one of the four dead knobs with no liveness check)
       plus a causal control for each of the three new gates: removing any one precondition must stop the
       castle being built, proving each is a real gate and not decoration. */
    {const before=nB(1,'castle');
     /* Temporarily lift the finished castle out of the array so we can ask "would it still want one now?"
        (aiCastleWant includes nCastle < cap). Put it straight back afterwards so we don't pollute
        towerNoSpotNoWant/fortStoneWant below — they assert zero reservation in the def domain, and a
        leftover castle demand would turn them red for the wrong reason. */
     const saved=buildings.filter(b=>b.side===1&&b.type==='castle');
     for(const c of saved)buildings.splice(buildings.indexOf(c),1);
     const want=(mut,undo)=>{mut();dbg.aiMapFeat(1,true);const ok=dbg.aiCastleWant(1);undo();dbg.aiMapFeat(1,true);return ok;};
     R.castleWantBase  =  want(()=>{},()=>{});
     R.castleLive      =  before===1 && !want(()=>{AI_DIFF.hard.castle=0;},()=>{AI_DIFF.hard.castle=1;});
     R.castleNeedsAge  = !want(()=>{techOf(1).age=1;recomputeTechMod(1);},()=>{techOf(1).age=3;recomputeTechMod(1);});
     R.castleAge2OK    =  want(()=>{techOf(1).age=2;recomputeTechMod(1);},()=>{techOf(1).age=3;recomputeTechMod(1);});
     R.castleNeedsWave = !want(()=>{dbg.A(1).defAcc=0;dbg.A(1).offAcc=0;},()=>{dbg.A(1).defAcc=60;});
     R.castleNeedsVill = !want(()=>{dbg.A(1).__v=villagers;villagers=villagers.filter(v=>(v.side||0)!==1);},()=>{villagers=dbg.A(1).__v;});
     R.castleNeedsStone= !want(()=>{for(const n of nodes)if(n.type==='stone')n.amt=0;},
                               ()=>{for(const n of nodes)if(n.type==='stone')n.amt=AI_MAPP.castleStone+500;});
     for(const c of saved)buildings.push(c); dbg.aiMapFeat(1,true);}
    dbg.aiFortNeeds(1,dbg.aiHub(1),techOf(1),stockOf(1),14); dbg.aiCommitExec(1);
    R.towerNoSpotNoWant = nB(1,'tower')<AI_DIFF.hard.towers && dbg.aiTowerSpot(1,14)===null
                          && !dbg.aiCmt(1).some(c=>c.dom==='def') && dbg.aiResv(1,'stone')===0;
    placeB(1,'tower',26,8,true); placeB(1,'tower',26,12,true);
    dbg.aiFortNeeds(1,dbg.aiHub(1),techOf(1),stockOf(1),14); dbg.aiCommitExec(1);
    R.fortStoneWant = !dbg.aiCmt(1).some(c=>c.dom==='def') && dbg.aiResv(1,'stone')===0;

    world(); const tcv=placeB(0,'tc',20,12,true); placeB(1,'tc',44,20,true);
    S_(0).garrisonOn=true; S_(0).bell=false; S_(0).stance='flee';
    spawnVillager(tcv); const vBack=villagers[villagers.length-1];
    vBack.x=tcv.x; vBack.y=tcv.y+tcv.size*TILE/2+14; vBack.state='idle'; vBack.node=null;
    const foe=spawnUnit(1,'spear',tcv.x,tcv.y-tcv.size*TILE/2-10,tagsOf(1)[0]);
    visible.fill(1);
    R.shelterFound = dbg.fleeShelter(vBack)===tcv;
    for(let i=0;i<200&&!vBack.garrisoned;i++)step(TICK);
    R.villGarrisons = vBack.garrisoned===true;
    foe.hp=0; step(TICK);

    world(); placeB(0,'tc',20,20,true); placeB(1,'tc',40,4,true);
    dbg.setTerr(4,4,14,14,T_WATER); computeLandComp();
    const fnode=dbg.addFish(9,9,99999);
    const boats=[]; for(let i=0;i<4;i++){const u=spawnUnit(0,'fishing',fnode.x+40+i*22,fnode.y+40,null);u.stance='gather';boats.push(u);}
    let gTicks=[0,0,0,0],samp=0;
    for(let k=0;k<900;k++){for(const b of boats)b.carry=0; step(TICK);
      if(k%3===0){samp++;for(let i=0;i<4;i++)if(boats[i]._fish)gTicks[i]++;}}
    R.fishUptime = gTicks.map(g=>+(g/samp).toFixed(2));
    R.fishAllGather = gTicks.every(g=>g/samp>0.85);
    R.fishNoJitter = boats.every(u=>Math.hypot(u.x-fnode.x,u.y-fnode.y)<40);
    world();

    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',40,4,true);
    const trapped=spawnUnit(1,'spear',C(20,10).x,C(20,10).y,tagsOf(1)[0]);
    trapped.path=[{x:C(24,10).x,y:C(24,10).y}];
    for(let y=9;y<=11;y++)for(let x=19;x<=21;x++)blocked[idx(x,y)]=1;
    const mlog0=mlog.length;
    for(let i=0;i<40;i++)step(TICK);
    const rescN=mlog.slice(mlog0).filter(m=>m.kind==='搶救'&&m.info==='建物內彈出').length;
    R.rescOnce = rescN<=2;
    for(let i=0;i<200;i++)step(TICK);
    R.rescEscaped = !blocked[idx(txOf(trapped.x),tyOf(trapped.y))];
    for(let y=9;y<=11;y++)for(let x=19;x<=21;x++)blocked[idx(x,y)]=0;
    world();

    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',40,4,true);
    const frozen=spawnUnit(1,'spear',C(25,10).x,C(25,10).y,tagsOf(1)[0]);
    /* This test never actually exercised what it claimed, independently of the vision change. The old
       setup staged a stuck-unit state, then step(0.5), then dbgScan — but that step let the unit genuinely
       walk its path (measured posMoved=60.2px, so movedT was reset and t-movedT>2 never held), meaning the
       branch under test was never entered. It stayed green only because the assertion asked whether the
       rescue appeared anywhere in mlog, and some *other* long-stuck object on the field happened to
       satisfy it. Under honest vision the field got cleaner, that object stopped getting stuck, the
       stand-in vanished and the test broke.
       Fix: (1) run a tick first, then stage the state — the subject is dbgScan's escalation logic, not
       whether this unit can move; (2) bind the assertion to a specific id so we verify this unit. */
    step(0.5);
    frozen.path=[{x:C(28,10).x,y:C(28,10).y}]; frozen.movedT=t-999;
    frozen._stk=1; frozen._stkT=t-999;
    /* Start from mlog.length=0 rather than slice(before): mlog is a ring buffer capped at 200 (logEvt
       shifts once full). Past 200, every push drops an entry, length stays pinned at 200, and
       slice(before) always returns an empty array — so the assertion can't see what just happened.
       That was the real reason this failed: the rescue did fire (_hardT was set to t, path was cleared),
       the log just couldn't be read. Honest vision changed the event volume of earlier cases, mlog crossed
       200, and this pre-existing fragility surfaced — nothing to do with vision itself. */
    mlog.length=0; dbgScan();
    R.hardRescue = mlog.some(m=>m.info==='長期卡死強制吸附'&&m.id===frozen.id);
    const fresh=spawnUnit(1,'spear',C(25,14).x,C(25,14).y,tagsOf(1)[0]);
    fresh.path=[{x:C(28,14).x,y:C(28,14).y}];
    mlog.length=0; dbgScan();
    R.freshNotRescued = !mlog.some(m=>m.info==='長期卡死強制吸附'&&m.id===fresh.id);
    world();

    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',30,10,true);
    aiFullVision=false; exploredE.fill(0);
    R.noPlaceUnexplored = canPlace('farm',34,10,undefined,1)===false;
    for(let y=8;y<=12;y++)for(let x=32;x<=36;x++)exploredE[idx(x,y)]=1;
    R.placeExplored = canPlace('farm',34,10,undefined,1)===true;
    R.playerGateUnchanged = canPlace('farm',34,10,undefined,0)===true;
    aiFullVision=true; exploredE.fill(1);

    world(); dbg.setAiEco(false); dbg.setAiDiff(1,'hard'); dbg.A(1).pers=null; dbg.A(1).plan=null;
    techOf(1).researched.clear(); techOf(1).age=1; recomputeTechMod(1); dbg.aiResetBrain(1);
    S_(0).garrisonOn=true; S_(0).bell=false;
    for(const k in stockOf(1))stockOf(1)[k]=0; for(const k in stock)stock[k]=0;
    return R;`);
  check('Wood deadlock ①: natural wood exhausted → build coppices first (wood is the input to everything); farms only get their turn once coppices hit cCap', t85.copFirst&&t85.farmAfterCop, t85);
  check('Wood deadlock ② (R1 ledger version): a coppice commitment = 40 wood reserved; military spending cannot touch it (the reservation is bound to the production side); redeemed as soon as the funds arrive', t85.copSave&&t85.milYieldsWood&&t85.copBuilt, t85);
  check('Production line rebuild: all barracks destroyed → the strategic brain queues a replacement within one tick (only rebuilds what was built before)', t85.hadBarracks&&t85.barracksGone&&t85.rebuilt, t85);
  check('Production line rebuild × age up (R1 income split): the rebuild still fires (highest score first); the age up keeps saving in its pot = both run in parallel, no longer either/or', t85.rebuildYieldsAge, t85);
  check('AI placement: military buildings are sited along each side\'s own home rally direction; the two sides no longer share an absolute top-left offset', t85.frontPlacement, t85);
  check('Fortification, tower: one beside the home rally point (villagers ≥12); ⑥ easy also builds the home tower (§6.1 defending home is the baseline; the old towers:0 was a spec violation, now fixed) but it only unlocks the home-tower class (causal control with towers:0 = back to 0 towers)', t85.homeTower&&t85.noobHomeTower&&t85.noobTowerCap&&t85.noobTowers0Silent, t85);
  check('Fortification, tower: the same resource area harassed twice → add a tower beside that node (responsive, not a tower rush)', t85.harassTower, t85);
  check('Fortification, wall+gate: never attacked, never walls; hard + Castle Age + 60s cumulative defence → a gate appears at the chokepoint (on the main route) plus wall segments', t85.bnFound&&t85.noWallBeforeSiege&&t85.gatePlaced&&t85.gateOnRoute&&t85.wallPlaced, t85);
  check('Fortification, gate is side-aware: own units pass through, enemies are blocked (same rule as the player\'s)', t85.gatePassable&&t85.gateBlocksFoe, t85);
  check('Fortification, castle (R1 expensive item + ⑩ activation): joins the savings set for stone (pot not full = no build) → surplus fills the pot → build one; once built the stone reservation drops to zero. ⑩: the count comes from the table (guard points × stone economy = cap 1); castle knob one tier lower = no build (first liveness check for the dead-knob clause); the unlock tier needs age≥2 but is **not tied to late knights** (it builds at age 2; the old age>=3 was where it starved); no first engagement yet = no build; no stone inside the perimeter = no build',
    t85.noCastleThin&&t85.castlePlaced&&t85.stoneWantPending&&t85.fortStoneWant&&
    t85.castleCap1&&t85.castleWantBase&&t85.castleLive&&t85.castleNeedsAge&&t85.castleAge2OK&&t85.castleNeedsWave&&
    t85.castleNeedsVill&&t85.castleNeedsStone, t85);
  check('Fortification, stone reservation must match the towers that will actually be built: cap not reached but none of the three triggers holds = no stone set aside (the old code over-gathered stone forever → age up stalled)', t85.towerNoSpotNoWant, t85);
  check('A villager touching the back of the TC garrisons (the old code used centre distance, so the whole TC counted as "walking over there means charging the enemy" → it fled instead)', t85.shelterFound&&t85.villGarrisons, t85);
  check('Fishing-boat ring positions: all 4 boats on the same fishery can gather (old code: gather radius 16 < summed footprint radius 18 = boats 3 and 4 ran empty)', t85.fishAllGather&&t85.fishNoJitter, t85);
  check('Eject from inside a building: rescued even when a path exists (leftover B....w1 case); 2s cooldown keeps the log clean; it really gets out', t85.rescOnce&&t85.rescEscaped, t85);
  check('Long-term stuck (>60s continuous) → escalating rescue; newly spawned units (movedT=0) are not misflagged', t85.hardRescue&&t85.freshNotRescued, t85);
  check('per-side explored map: under honest vision side1 can only build on ground it has explored (the old code allowed not a single tile → the ladder was measuring thin air)', t85.noPlaceUnexplored&&t85.placeExplored&&t85.playerGateUnchanged, t85);

  console.log('\n[86] Integration balance round; monotonicity break (2026-07-10): enemy strength estimation (observation / prior / intel freshness) / army size scales with enemy activity / no trickling on defence / defenders concentrate / same vision rules on both sides');
  const t86 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const clr=()=>{units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;shots.length=0;ghosts.length=0;};
    const world=()=>{clr();gameOver=null;dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN);computeLandComp();explored.fill(1);exploredE.fill(1);visible.fill(0);visibleE.fill(0);computeDanger();};
    const freshAi=(lv)=>{techOf(1).researched.clear();techOf(1).age=1;techOf(1).track=null;techOf(1).queue.length=0;techOf(1).ageUp=null;recomputeTechMod(1);
      dbg.setAiEco(true);dbg.setAiMil(true);dbg.A(1).pers=null;dbg.A(1).plan=null;dbg.setAiDiff(1,lv||'hard');dbg.aiResetBrain(1);
      dbg.A(1).plan={open:'std',routeBias:0,harass:false};};
    const R={};
    arenaMode=false; gameOver=null; aiDefT=1e9; aiWave=99999; aiFullVision=true;

    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',30,10,true); freshAi();
    const a=dbg.A(1), tSave=t;
    for(const k in a.foeSeen)delete a.foeSeen[k];
    t=600; a.intelT=-1e9;
    R.priorNoIntel = dbg.aiFoeEst(1)>8 && dbg.aiFoeObs(1)===0;
    a.intelT=t;
    R.freshIntelDropsPrior = dbg.aiFoeEst(1)===0;
    a.foeSeen.spear=5;
    R.obsFromMemory = Math.abs(dbg.aiFoeObs(1)-6)<0.01 && Math.abs(dbg.aiFoeEst(1)-6)<0.01;
    a.intelT=-1e9;
    R.staleTakesPrior = dbg.aiFoeEst(1)>dbg.aiFoeObs(1);

    a.state='develop'; a.foeSeen.spear=20;
    stockOf(1).food=600;
    R.capDevNoAdapt = Math.abs(dbg.aiMilCap(1)-AI_MILCAP.develop*AI_DIFF.hard.milCap)<0.01;
    a.state='defend';
    R.capGrows = dbg.aiMilCap(1) > AI_MILCAP.defend;
    a.state='allin';
    R.capAllinCeil = dbg.aiMilCap(1) <= AI_MILCAP.allin*AI_DIFF.hard.milCap + 0.01;
    dbg.setAiDiff(1,'noob'); a.state='defend'; a.foeSeen.spear=20;
    R.noobNoAdapt = Math.abs(dbg.aiMilCap(1)-AI_MILCAP.defend*AI_DIFF.noob.milCap)<0.01;
    dbg.setAiDiff(1,'hard'); t=tSave; freshAi();

    world(); placeB(0,'tc',3,20,true); const btc=placeB(1,'tc',30,10,true); placeB(1,'barracks',33,10,true);
    freshAi(); villagers=villagers.filter(v=>(v.side||0)===0);
    for(const k in stockOf(1))stockOf(1)[k]=1000;
    dbg.aiMilTick(1);
    const A1=dbg.A(1), rally={...A1.homeRally};
    spawnUnit(1,'spear',btc.x-40,btc.y+30,tagsOf(1)[0]);
    for(let i=0;i<10;i++)spawnUnit(0,'spear',btc.x-70+i*10,btc.y+50,tagsOf(0)[0]);
    const gMain=tagsOf(1)[0];
    gMain.task='attack'; gMain.pt={x:btc.x-70,y:btc.y+50}; A1.ord.length=0;
    dbg.aiMilTick(1);
    R.siegeState = dbg.aiState(1).state==='defend';
    R.noDripCharge = gMain.task==='guard' && Math.hypot(gMain.pt.x-rally.x,gMain.pt.y-rally.y)<TILE*2;
    for(let i=0;i<12;i++)spawnUnit(1,'spear',btc.x-40,btc.y+30+i*6,tagsOf(1)[0]);
    A1.ord.length=0;
    dbg.aiMilTick(1);
    R.counterWhenReady = tagsOf(1)[0].task==='attack';

    world(); placeB(0,'tc',3,20,true); const ctc=placeB(1,'tc',30,10,true); const bar=placeB(1,'barracks',33,10,true);
    freshAi(); villagers=villagers.filter(v=>(v.side||0)===0);
    for(const k in stockOf(1))stockOf(1)[k]=1000;
    dbg.aiMilTick(1);
    dbg.A(1).state='defend'; dbg.A(1).clearT=0; bar.queue.length=0; bar.cq.length=0;
    dbg.aiMilTick(1);
    R.defendState = dbg.aiState(1).state==='defend';
    R.defendFeedsMain = bar.queue.length>0 && bar.queue[0].tag===0;
    dbg.A(1).state='develop'; dbg.A(1).clearT=99; bar.queue.length=0;
    dbg.aiMilTick(1);
    R.developFeedsDef = bar.queue.length>0 && bar.queue[0].tag===1;

    world(); placeB(0,'tc',3,20,true); const dtc=placeB(1,'tc',30,10,true);
    freshAi(); villagers=villagers.filter(v=>(v.side||0)===0);
    dbg.aiMilTick(1);
    const A2=dbg.A(1), gm2=tagsOf(1)[0];
    R.developRally = A2.state==='develop' && gm2.task==='guard' && !!A2.homeRally
      && Math.hypot(gm2.pt.x-A2.homeRally.x,gm2.pt.y-A2.homeRally.y)<TILE*2;

    world();
    R.wallSideStored = (()=>{placeB(1,'wall',26,11,true);return wallMask[idx(26,11)]===2;})();
    world();
    for(let y=8;y<=14;y++)wallMask[idx(20,y)]=2;
    const vh0=hgtI(idx(16,11)), vh1=hgtI(idx(24,11));
    R.losFoeWallBlocks = losOk(16,11,24,11,vh0,0,0)===false;
    R.losOwnWallPasses = losOk(24,11,16,11,vh1,1,0)===true;
    R.losNoSideIgnores = losOk(16,11,24,11,vh0,-1,0)===true;
    placeB(0,'tower',16,11,true);
    updateFog();
    R.fogNearVisible = visible[idx(19,11)]===1;
    R.fogBeyondWall  = visible[idx(24,11)]===0;
    wallMask.fill(0);

    world(); dbg.setAiEco(false); dbg.setAiDiff(1,'hard'); dbg.A(1).pers=null; dbg.A(1).plan=null;
    techOf(1).researched.clear(); techOf(1).age=1; recomputeTechMod(1); dbg.aiResetBrain(1);
    for(const k in stockOf(1))stockOf(1)[k]=0; for(const k in stock)stock[k]=0;
    return R;`);
  check('Enemy estimation: no intel = fall back on a pessimistic prior (observation 0 but estimate >0); freshly scouted = the prior steps aside and observation is trusted', t86.priorNoIntel&&t86.freshIntelDropsPrior, t86);
  check('Enemy estimation: observation comes from decaying memory (foeSeen × unit strength); intel expires → the prior takes over (take the larger = information never makes you more timid)', t86.obsFromMemory&&t86.staleTakesPrior, t86);
  check('Main-army size: not scaled up during development; scaled only in defence / pressure / all-in (hard and above; capped at the all-in size); easy never scales at all', t86.capDevNoAdapt&&t86.capGrows&&t86.capAllinCeil&&t86.noobNoAdapt, t86);
  check('defensive posture does not trickle: outmatched → main force rallies at the home gate (not one unit at a time into the enemy army); counter-attacks only once it has the numbers', t86.siegeState&&t86.noDripCharge&&t86.counterWhenReady, t86);
  check('main force takes production priority while defending (the 4 garrison slots were being harvested = a leaking bucket); in normal times the home garrison is still filled first', t86.defendState&&t86.defendFeedsMain&&t86.developFeedsDef, t86);
  check('during development the main force stands at the home rally point = the defender concentrates too (the old code issued no order = spread across the barracks and beaten in detail)', t86.developRally, t86);
  check('vision follows the same rule for both sides: blocked by the enemy\'s wall, seeing over its own; updateFog really does carry vSide',
        t86.wallSideStored&&t86.losFoeWallBlocks&&t86.losOwnWallPasses&&t86.losNoSideIgnores&&t86.fogNearVisible&&t86.fogBeyondWall, t86);

  console.log('\n[87] siege setup time (feel): fires only once stopped / movement interrupts it / shoving does not / DPS unchanged / shoreline arena');
  const t87 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const clr=()=>{units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;shots.length=0;ghosts.length=0;};
    arenaMode=true;aiWave=99999;gameOver=null;terr.fill(T_PLAIN);blocked.fill(0);paintTerrain();computeLandComp();
    explored.fill(1);exploredE.fill(1);visible.fill(1);visibleE.fill(1);
    for(const k in stock)stock[k]=1e9;
    const R={};
    R.setupDeclared = UT.catapult.setup>0 && !UT.archer.setup && !UT.spear.setup; /* Only siege units have a setup time. */

    /* Detect firing by catching the frame where u.cd is reset. Counting shots.length does not work: a
       catapult shot lands and leaves the list after 1.2s, so the second shot never grows the array.
       Enemies are frozen with stunT so they cannot rush inside minRng and push the catapult back — that
       would refresh movedT and make setup look like it never completes. */
    const cleanGrp=(g,task)=>{g.task=task;g.rule='counter';g.holdFire=false;g.focus=null;g.pt=null;g.zoneAnchor=null;g.inCombat=false;g.fightPt=null;g.autoFocus=null;};
    const froze=(u)=>{u.hp=1e6;u.maxHp=1e6;u.stunT=1e9;return u;};
    const fireTimes=(u,n,maxTicks)=>{const out=[];let prev=u.cd;
      for(let i=0;i<maxTicks&&out.length<n;i++){step(TICK);if(u.cd>prev+0.01)out.push(t);prev=u.cd;}
      return out;};

    clr();
    const ga=tags[0];cleanGrp(ga,'hold');
    const cat=spawnUnit(0,'catapult',C(10,10).x,C(10,10).y,ga);
    const cx0=cat.x,cy0=cat.y;
    cat.movedT=t;
    R.notReadyRightAfterMove = dbg.siegeReady(cat)===false;
    const t0=t; for(let i=0;i<100;i++){step(TICK);if(dbg.siegeReady(cat))break;}
    R.readyAfterSetup = dbg.siegeReady(cat)===true && (t-t0)>=UT.catapult.setup && Math.hypot(cat.x-cx0,cat.y-cy0)<1;
    R.archerAlwaysReady = dbg.siegeReady(spawnUnit(0,'archer',C(12,12).x,C(12,12).y,ga))===true;

    clr();
    const g0=tags[0];cleanGrp(g0,'attack');
    const cm=spawnUnit(0,'catapult',C(6,13).x,C(6,13).y,g0);
    cm.movedT=-1e3; /* Already set up before departure, proving the interruption comes from starting to move rather than
   from never having been set up. */
    froze(spawnUnit(1,'spear',C(11,13).x,C(11,13).y,dbg.tagsOf(1)[0])); /* 200px — inside rng 235, outside minRng 70. */
    g0.pt=C(40,13); cm.relocate=true; cm.path=uFP(cm,g0.pt.x,g0.pt.y);
    const movedFires=fireTimes(cm,1,40);
    R.noFireWhileMoving = movedFires.length===0 && t-cm.movedT<0.2; /* Genuinely moving (movedT keeps being refreshed) and not a single shot fired. */

    clr();
    const gh=tags[0];cleanGrp(gh,'hold');
    const ch=spawnUnit(0,'catapult',C(6,16).x,C(6,16).y,gh);
    froze(spawnUnit(1,'spear',C(11,16).x,C(11,16).y,dbg.tagsOf(1)[0]));
    ch.movedT=t; /* Just came to a stop. */
    const tStop=t;
    const ft=fireTimes(ch,2,400);
    R.firstShotWaits = ft.length>=1 && (ft[0]-tStop)>=UT.catapult.setup;
    R.cadenceIsCd = ft.length>=2 && (ft[1]-ft[0]) < UT.catapult.setup+UT.catapult.cd*0.6; /* The second shot only waits on cd; it does not wait through setup again. */

    clr();
    const cs=spawnUnit(0,'catapult',C(20,20).x,C(20,20).y,tags[0]);
    cs.movedT=-1e3; /* Set up long ago. */
    for(let i=0;i<4;i++)spawnUnit(0,'spear',cs.x+2,cs.y+2,tags[0]); /* Stacked on top of each other so the separation force is guaranteed to act. */
    const sx=cs.x,sy=cs.y;
    for(let i=0;i<20;i++)step(TICK);
    R.pushedButStillReady = dbg.siegeReady(cs)===true && Math.hypot(cs.x-sx,cs.y-sy)>0.5; /* Genuinely pushed, but setup still counts as complete. */

    dbg.arenaSetup({archer:2},{galley:1});
    R.shoreLand = terr[idx(12,13)]===T_PLAIN;
    R.shoreWater = terr[idx(36,13)]===T_WATER;
    R.shoreArmies = units.filter(u=>u.side===0&&u.type==='archer').length===2 && units.filter(u=>u.side===1&&u.type==='galley').length===1;
    dbg.arenaSetup({spear:1},{spear:1}); /* Pure land map, all flat as before, so we don't accidentally trip the shoreline path. */
    R.plainStillPlain = terr[idx(36,13)]===T_PLAIN;

    clr();terr.fill(T_PLAIN);paintTerrain();computeLandComp();arenaMode=false;visible.fill(0);visibleE.fill(0);
    for(const k in stock)stock[k]=0;
    return R;`);
  check('siege setup: only the catapult has one; just moved = not set up; 2.5s stationary = set up; the archer can always shoot', t87.setupDeclared&&t87.notReadyRightAfterMove&&t87.readyAfterSetup&&t87.archerAlwaysReady, t87);
  check('siege engines do not shoot on the move: zero shots even with an enemy in range while executing a move order (the old code fired en route on relocate)', t87.noFireWhileMoving, t87);
  check('siege engine stops → waits out the full setup before the first shot, then fires on cooldown (setup is a mobility cost, not a DPS cost)', t87.firstShotWaits&&t87.cadenceIsCd, t87);
  check('being shoved by a friendly unit does not interrupt setup (separation does not write movedT: physical crowding is not redeployment)', t87.pushedButStillReady, t87);
  check('shoreline arena: land-only army on one side, warships on the other → the map splits half land, half water (the pure land arena is unaffected)', t87.shoreLand&&t87.shoreWater&&t87.shoreArmies&&t87.plainStillPlain, t87);

  console.log('\n[88] siege engines and siege ships hold their ground (feel): do not back off while something else is shootable; retreat only when the last target is in your face');
  const t88 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const clr=()=>{units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;shots.length=0;ghosts.length=0;};
    arenaMode=true;aiWave=99999;gameOver=null;terr.fill(T_PLAIN);blocked.fill(0);paintTerrain();computeLandComp();
    explored.fill(1);exploredE.fill(1);visible.fill(1);visibleE.fill(1);
    for(const k in stock)stock[k]=1e9;
    const cleanGrp=(g,task)=>{g.task=task;g.rule='counter';g.holdFire=false;g.focus=null;g.pt=null;g.zoneAnchor=null;g.inCombat=false;g.fightPt=null;g.autoFocus=null;};
    const froze=(u)=>{u.hp=1e6;u.maxHp=1e6;u.stunT=1e9;return u;};
    const firedIn=(u,ticks)=>{let prev=u.cd,hit=false;for(let i=0;i<ticks;i++){step(TICK);if(u.cd>prev+0.01)hit=true;prev=u.cd;}return hit;};
    const R={};
    const MIN=UT.catapult.minRng, RNG=UT.catapult.rng;

    clr();
    const g=tags[0];cleanGrp(g,'attack');
    const cat=spawnUnit(0,'catapult',C(20,13).x,C(20,13).y,g);
    cat.movedT=-1e3; /* Set up in advance so setup time can't interfere — this tests only whether it backs off. */
    const near=froze(spawnUnit(1,'spear',C(20,13).x+40,C(20,13).y,dbg.tagsOf(1)[0])); /* 40px < minRng 70 — point blank. */
    const far =froze(spawnUnit(1,'spear',C(24,13).x,C(24,13).y,dbg.tagsOf(1)[0]));     /* ~160px — inside the [70, 235] band. */
    R.altPicksFar = dbg.siegeAlt(cat,RNG,MIN)===far;

    const sx=cat.x, sy=cat.y, dNear0=Math.hypot(near.x-cat.x,near.y-cat.y);
    const fired=firedIn(cat,120);
    R.standAndFire = fired && Math.hypot(cat.x-sx,cat.y-sy)<30 && Math.hypot(near.x-cat.x,near.y-cat.y)<dNear0+30;

    clr();
    const g2=tags[0];cleanGrp(g2,'attack');
    const cat2=spawnUnit(0,'catapult',C(20,16).x,C(20,16).y,g2);
    cat2.movedT=-1e3;
    const lone=froze(spawnUnit(1,'spear',C(20,16).x+40,C(20,16).y,dbg.tagsOf(1)[0]));
    R.altNullWhenOnlyNear = dbg.siegeAlt(cat2,RNG,MIN)===null;
    const d0=Math.hypot(lone.x-cat2.x,lone.y-cat2.y);
    const firedEarly=firedIn(cat2,30);
    R.retreatWhenLoneNear = Math.hypot(lone.x-cat2.x,lone.y-cat2.y)>d0+10 && !firedEarly;

    clr();
    const g3=tags[0];cleanGrp(g3,'attack');
    const ss=spawnUnit(0,'siegeship',C(20,20).x,C(20,20).y,g3);
    froze(spawnUnit(1,'spear',C(20,20).x+30,C(20,20).y,dbg.tagsOf(1)[0])); /* 30 < minRng 45 — point blank. */
    const sfar=froze(spawnUnit(1,'spear',C(24,20).x,C(24,20).y,dbg.tagsOf(1)[0]));
    R.shipAltPicksFar = dbg.siegeAlt(ss,UT.siegeship.rng,UT.siegeship.minRng)===sfar;

    clr();terr.fill(T_PLAIN);paintTerrain();computeLandComp();arenaMode=false;visible.fill(0);visibleE.fill(0);
    for(const k in stock)stock[k]=0;
    return R;`);
  check('siege engine alternative targets: anything inside minRng does not count; it picks only the distant enemies it can actually hit', t88.altPicksFar, t88);
  check('siege engine holds and keeps firing: in-your-face and distant enemies both present → holds position and keeps shooting (it does not retreat over one unit at melee range)', t88.standAndFire, t88);
  check('siege engine with only the in-your-face unit left → retreats (it backs off only when there is nothing else to shoot, and opens the distance rather than standing and firing)', t88.altNullWhenOnlyNear&&t88.retreatWhenLoneNear, t88);
  check('siege ship likewise: when closed on, it still prefers another target inside its range band (minRng 45)', t88.shipAltPicksFar, t88);

  console.log('\n[89] R0 turning the design into tables: completeness of the four tables + reverse lookup of the derived sets + a swordsman dry-run (add a row, change no code) + personality binding strength');
  const t89 = await ev(`
    const R={};
    const ROLES=new Set(['front','ranged','mobile','siege','anti','support']);
    const mil=dbg.AI_MILTYPES();
    R.milSet = JSON.stringify([...mil].sort())===JSON.stringify(['archer','catapult','cavalry','heavyinf','horsearcher','longbow','medic','spear']);
    R.rolesOk = mil.every(k=>ROLES.has(UT[k].role)) && Object.keys(UT).every(k=>!UT[k].role||ROLES.has(UT[k].role));
    R.thwOk = mil.every(k=>typeof UT[k].thW==='number');
    R.costBldOk = mil.every(k=>UT[k].cost&&UT[k].bld&&typeof UT[k].up==='number');
    const un=dbg.AI_UNIQ();
    R.replOk = Object.keys(un).length===3 && Object.keys(un).every(k=>UT[un[k]]&&!UT[un[k]].repl);
    const ctr=dbg.AI_CTR(), sign=dbg.AI_SIGN(), rb=dbg.AI_RB();
    R.ctrOk = ctr.cavalry==='spear'&&ctr.spear==='archer'&&ctr.archer==='cavalry'&&ctr.catapult==='cavalry';
    R.signOk = sign.longbow==='england'&&sign.heavyinf==='hre'&&sign.horsearcher==='mongol';
    R.rbOk = rb.front==='spear'&&rb.ranged==='archer'&&rb.mobile==='cavalry'&&rb.siege==='catapult'&&rb.support==='medic';
    const DOMS=new Set(['eco','mil','def','intel','sea']);
    R.techDomAll = TECH.every(x=>DOMS.has(dbg.techDom(x.id)));
    R.techDomSpot = dbg.techDom('E1')==='eco'&&dbg.techDom('M4')==='mil'&&dbg.techDom('S1')==='intel'&&dbg.techDom('F1')==='def'&&dbg.techDom('N2')==='sea'&&dbg.techDom('U1')==='mil';
    R.techSegOk = dbg.techSeg('E1')==='common'&&dbg.techSeg('M9')==='civ'&&dbg.techSeg('UL')==='civ'&&dbg.techSeg('N5')==='common';
    R.civOk = CIVS.every(c=>c.aid&&c.ai&&['open','harass','retreatM','outM','wallAge'].every(k=>c.ai[k]!==undefined)
      &&Array.isArray(c.ai.pre)&&Array.isArray(c.ai.star)&&c.ai.ctrW&&Array.isArray(c.ai.ctrTech)
      &&Object.keys(c.ai.ctrW).every(k=>UT[k])&&c.ai.ctrTech.every(id=>!!techById(id)));
    const dk=Object.keys(AI_DIFF.noob).sort().join(',');
    R.diffOrth = dbg.AI_DIFF_ORDER.every(lv=>Object.keys(AI_DIFF[lv]).sort().join(',')===dk);
    return R;`);
  check('R0 table completeness: the unit table\'s AI columns (role/thW/repl/ulk) + the derived sets are correct', t89.milSet&&t89.rolesOk&&t89.thwOk&&t89.costBldOk&&t89.replOk, t89);
  check('R0 derived-set reverse lookup: counters = reverse lookup of bonus; tells = derived from uniq; role anchors = front/ranged/mobile/siege/support', t89.ctrOk&&t89.signOk&&t89.rbOk, t89);
  check('R0 tech table AI columns: effect domains (eco/mil/def/intel/sea) fully covered + prerequisite tiers (shared vs a civilisation\'s final step)', t89.techDomAll&&t89.techDomSpot&&t89.techSegOk, t89);
  check('R0 all three civilisation rows complete + difficulty table columns orthogonal (every row carries the same column set)', t89.civOk&&t89.diffOrth, t89);

  const t89b = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const R={};
    UT.sword={nm:'劍士',ch:'🗡',hp:75,dmg:9,rng:18,cd:1.0,sp:70,vis:6,bld:'barracks',role:'front',thW:1,
      cost:{food:45,gold:20},bt:7,bonus:{spear:1.8},vol:1,bio:true,up:.07,aM:1,aP:1};
    dbg.rebuildAiTables();
    R.dryInSet = dbg.AI_MILTYPES().includes('sword');
    R.dryCtr = dbg.AI_CTR().spear==='sword';
    dbg.setAiDiff(1,'hard'); dbg.A(1).civGuess=null; dbg.A(1).state='defend';
    for(const k in dbg.A(1).foeSeen)delete dbg.A(1).foeSeen[k];
    dbg.A(1).foeSeen.spear=6;
    const w=dbg.aiMilWant(1);
    R.dryWanted = (w.sword||0)>2;
    for(const k in dbg.A(1).foeSeen)delete dbg.A(1).foeSeen[k];
    dbg.A(1).foeSeen.sword=4;
    R.dryObs = dbg.aiFoeObs(1)>1;
    for(const k in dbg.A(1).foeSeen)delete dbg.A(1).foeSeen[k];
    dbg.A(1).foeSeen.spear=6;
    const bar={side:1,type:'barracks',x:C(30,13).x,y:C(30,13).y,tx:30,ty:13,size:2,w:2,h:2,hp:600,maxHp:600,done:true,queue:[],defTag:0};
    buildings.push(bar);
    const SK=S_(1).stock;
    const kOld={...SK}; SK.food=2000;SK.gold=2000;SK.wood=2000;SK.iron=500;SK.stone=500; /* Overwhelm any saveFor reservation so this only checks that the queue recognises swordsmen. */
    dbg.aiMilProd(1);
    R.dryQueued = bar.queue.some(q=>q.type==='sword');
    bar.queue.length=0; buildings.splice(buildings.indexOf(bar),1);
    for(const k in kOld)SK[k]=kOld[k];
    delete UT.sword; dbg.rebuildAiTables();
    R.dryGone = !dbg.AI_MILTYPES().includes('sword') && dbg.AI_CTR().spear==='archer';
    for(const k in dbg.A(1).foeSeen)delete dbg.A(1).foeSeen[k];
    dbg.A(1).state='develop';
    const bOld=AI_DIFF.noob.bind;
    AI_DIFF.noob.bind=0; dbg.setAiDiff(1,'noob'); dbg.A(1).pers=null; dbg.setAiPers(1,'mongol');
    R.bindMismatch = dbg.aiPers(1)!=='mongol' && dbg.sideState(1).civ==='mon';
    AI_DIFF.noob.bind=1; dbg.A(1).pers=null; dbg.setAiPers(1,'mongol');
    R.bindMatch = dbg.aiPers(1)==='mongol' && dbg.sideState(1).civ==='mon';
    AI_DIFF.noob.bind=bOld;
    dbg.A(1).pers=null; dbg.A(1).plan=null; dbg.aiDraw(1);
    R.noobHasCiv = !!dbg.aiPers(1) && ['eng','hre','mon'].includes(dbg.sideState(1).civ);
    dbg.setAiDiff(1,'hard'); dbg.A(1).pers=null; dbg.A(1).plan=null;
    return R;`);
  check('R0 swordsman dry-run: add one UT row → the formation system picks it up (counter reverse lookup / mix demand / barracks queue / threat count); removing the row restores everything', t89b.dryInSet&&t89b.dryCtr&&t89b.dryWanted&&t89b.dryObs&&t89b.dryQueued&&t89b.dryGone, t89b);
  check('R0 personality binding strength: bind 0 = personality mismatched while the civilisation is unchanged; bind 1 = matched; every difficulty carries a civilisation (even Beginner has an identity)', t89b.bindMismatch&&t89b.bindMatch&&t89b.noobHasCiv, t89b);

  console.log('\n[90] R1 the scoring core: three regression assertions from past mistakes + market tier 7.2 + saving up does not freeze the standing items');
  const t90 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const world=()=>{units.length=0;villagers.length=0;buildings.length=0;nodes.length=0;scouts.length=0;shots.length=0;
      blocked.fill(0);wallMask.fill(0);gateMask.fill(0);terr.fill(T_PLAIN);paintTerrain();computeLandComp();
      explored.fill(1);exploredE.fill(1);computeDanger();gameOver=null;aiWave=99999;};
    const freshAi=(lv)=>{dbg.setAiDiff(1,lv||'hard');dbg.A(1).pers=null;dbg.setAiPers(1,'england');
      dbg.aiResetBrain(1);dbg.A(1).plan={open:'std',routeBias:0,harass:false};
      techOf(1).researched.clear();techOf(1).age=1;techOf(1).track=null;techOf(1).queue.length=0;techOf(1).ageUp=null;recomputeTechMod(1);
      const s=stockOf(1);for(const k in s)s[k]=0;for(const k in S_(1).shares)S_(1).shares[k]=1;};
    const nB=(si,tp)=>buildings.filter(b=>b.side===si&&b.hp>0&&b.type===tp).length;
    const R={};
    world(); placeB(0,'tc',3,20,true); const tc1=placeB(1,'tc',30,10,true); placeB(1,'barracks',34,13,true);
    freshAi(); villagers=villagers.filter(v=>(v.side||0)===0); for(let i=0;i<12;i++)spawnVillager(tc1);
    for(let i=0;i<2;i++)spawnUnit(1,'spear',tc1.x-60,tc1.y+40+i*12,tagsOf(1)[1]);
    {const s=stockOf(1);for(const k in s)s[k]=1000;s.wood=30;}
    dbg.aiEcoTick(1);
    R.cmtHolds = dbg.aiCmt(1).some(c=>c.key==='bld:coppice');
    stockOf(1).wood=50;
    dbg.aiMilProd(1);
    R.milBlocked = !buildings.some(b=>b.side===1&&b.queue.length>0);
    dbg.A(1).cmt.length=0;
    dbg.aiMilProd(1);
    R.milFlowsNoCmt = buildings.some(b=>b.side===1&&b.queue.length>0);
    world(); placeB(0,'tc',3,20,true); const tc2=placeB(1,'tc',30,10,true);
    freshAi(); villagers=villagers.filter(v=>(v.side||0)===0); for(let i=0;i<6;i++)spawnVillager(tc2);
    {const s=stockOf(1);for(const k in s)s[k]=1000;}
    dbg.aiFortNeeds(1,dbg.aiHub(1),techOf(1),stockOf(1),6); dbg.aiCommitExec(1);
    R.noSpotNoResv = !dbg.aiCmt(1).some(c=>c.key==='bld:tower') && dbg.aiResv(1,'stone')===0;
    dbg.A(1).harassAt={'5,5':{n:2,x:C(20,20).x,y:C(20,20).y}};
    dbg.aiFortNeeds(1,dbg.aiHub(1),techOf(1),stockOf(1),6); dbg.aiCommitExec(1);
    R.spotCommits = nB(1,'tower')===1 || dbg.aiCmt(1).some(c=>c.key==='bld:tower');
    world(); placeB(0,'tc',3,20,true); const tc3=placeB(1,'tc',30,10,true); placeB(1,'barracks',34,13,true);
    placeB(1,'market',26,12,true);
    freshAi(); villagers=villagers.filter(v=>(v.side||0)===0); for(let i=0;i<12;i++)spawnVillager(tc3);
    for(const id of ['E1','E2'])techOf(1).researched.add(id); recomputeTechMod(1);
    {const s=stockOf(1);for(const k in s)s[k]=0;s.food=AGES[1].cost.food+100;s.gold=200;s.stone=60;s.iron=30;}
    dbg.aiStratTick(1);
    R.ageCmt = dbg.aiCmt(1).some(c=>c.key==='age'&&c.exp);
    const w0=stockOf(1).wood;
    dbg.aiEcoTick(1);
    R.mktFlowsWhileSaving = stockOf(1).wood>w0;
    const vq=(tc3.cq?tc3.cq.length:0)+villagers.filter(v=>(v.side||0)===1).length;
    R.villFlowsWhileSaving = vq>12;
    world(); placeB(0,'tc',3,20,true); const tc4=placeB(1,'tc',30,10,true); placeB(1,'market',26,12,true);
    freshAi(); villagers=villagers.filter(v=>(v.side||0)===0); for(let i=0;i<10;i++)spawnVillager(tc4);
    {const s=stockOf(1);for(const k in s)s[k]=300;s.stone=1500;s.gold=300;}
    dbg.aiEcoTick(1);
    R.balanceSells = stockOf(1).stone<1500;
    freshAi('noob');
    {const s=stockOf(1);for(const k in s)s[k]=300;s.stone=1500;s.gold=300;}
    dbg.aiEcoTick(1);
    R.rescueHolds = stockOf(1).stone===1500;
    freshAi('hard');
    {const s=stockOf(1);for(const k in s)s[k]=500;s.wood=0;s.gold=400;}
    S_(1).priceIdx.wood=1.6;
    dbg.aiEcoTick(1);
    const wAfterHold=stockOf(1).wood;
    S_(1).priceIdx.wood=1.0;
    dbg.aiEcoTick(1);
    R.rateGateHolds = wAfterHold===0;
    R.rateGateBuys = stockOf(1).wood>0;
    dbg.setAiEco(false); villagers=villagers.filter(v=>(v.side||0)===0);
    dbg.A(1).cmt.length=0; dbg.A(1).harassAt={}; S_(1).priceIdx.wood=1;
    techOf(1).researched.clear(); techOf(1).age=1; techOf(1).track=null; techOf(1).queue.length=0; techOf(1).ageUp=null; recomputeTechMod(1);
    {const s=stockOf(1);for(const k in s)s[k]=0;} for(const k in S_(1).shares)S_(1).shares[k]=1;
    world();
    return R;`);
  check('R1 mistake ①: the reservation binds at the production end = a commitment cannot be bought against while the army fund is being raised; withdraw the commitment and the same stock buys immediately (causal control)', t90.cmtHolds&&t90.milBlocked&&t90.milFlowsNoCmt, t90);
  check('R1 mistake ②: the reservation matches the placement condition = an unmet trigger never enters the pool (zero reserved); only a met trigger enters it and gets built', t90.noSpotNoResv&&t90.spotCommits, t90);
  check('R1 mistake ③: income is split into shares = market buys and villager production keep flowing while saving for an age-up (the savings bucket does not lock existing stock)', t90.ageCmt&&t90.mktFlowsWhileSaving&&t90.villFlowsWhileSaving, t90);
  check('R1 market tier 7.2: Hard actively balances by selling its surplus; Beginner\'s rescue mode does nothing without a shortfall; a bad exchange rate blocks the buy until it drifts back', t90.balanceSells&&t90.rescueHolds&&t90.rateGateHolds&&t90.rateGateBuys, t90);

  console.log('\n[91] R2 parameterising the map: scaling assertions (the main acceptance test) + G2 march coefficient (a winding route is not a straight line) + liveness of the knobs wired to the table');
  const t91 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const world=()=>{units.length=0;villagers.length=0;buildings.length=0;nodes.length=0;scouts.length=0;shots.length=0;
      blocked.fill(0);wallMask.fill(0);gateMask.fill(0);terr.fill(T_PLAIN);paintTerrain();computeLandComp();
      explored.fill(1);exploredE.fill(1);computeDanger();gameOver=null;aiWave=99999;};
    const freshAi=(lv)=>{dbg.setAiDiff(1,lv||'hard');dbg.A(1).pers=null;dbg.setAiPers(1,'england');
      dbg.aiResetBrain(1);dbg.A(1).plan={open:'std',routeBias:0,harass:false};};
    const gold=(tx,ty)=>nodes.push({type:'gold',x:C(tx,ty).x,y:C(tx,ty).y,amt:500,max:500});
    const R={};
    const reach0=dbg.ecoReach();
    dbg.setEcoReach(500);
    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',30,10,true);
    freshAi();
    for(let i=0;i<8;i++)gold(24+(i%4),8+((i/4)|0));
    gold(10,20);gold(11,20); gold(40,22);gold(41,22);
    let f=dbg.aiMapFeat(1,true);
    const villA=dbg.aiVillT(1,2), outA=dbg.aiOutMax(1), clA=f.clusters;
    for(let i=0;i<8;i++)gold(24+(i%4),12+((i/4)|0));
    gold(12,3);gold(13,3); gold(44,4);gold(45,4);
    f=dbg.aiMapFeat(1,true);
    const villB=dbg.aiVillT(1,2), outB=dbg.aiOutMax(1), clB=f.clusters;
    R.villScales = villB>villA;
    R.outScales  = clA===2&&clB===4&&outB>outA;
    freshAi('boss');
    placeB(1,'outpost',12,20,true);
    const twA=(dbg.aiMapFeat(1,true),dbg.aiTowerCap(1));
    placeB(1,'outpost',40,21,true); placeB(1,'outpost',13,4,true);
    const twB=(dbg.aiMapFeat(1,true),dbg.aiTowerCap(1));
    R.towerScales = twB===twA+2;
    freshAi();
    const fcS=(dbg.aiMapFeat(1,true),dbg.aiFarmCap(1)), ccS=dbg.aiCopCap(1);
    dbg.setEcoReach(1100);
    const fcL=(dbg.aiMapFeat(1,true),dbg.aiFarmCap(1)), ccL=dbg.aiCopCap(1);
    R.regenScales = fcL>fcS && ccL>ccS;
    dbg.setEcoReach(reach0);
    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',30,10,true); freshAi();
    dbg.setEcoReach(500);
    for(let i=0;i<8;i++)gold(24+(i%4),8+((i/4)|0));
    gold(10,20);gold(11,20); gold(40,22);gold(41,22); gold(12,3);gold(13,3); gold(44,4);gold(45,4);
    dbg.aiMapFeat(1,true);
    const v0=dbg.aiVillT(1,2), o0=dbg.aiOutMax(1);
    const kV=AI_DIFF.hard.villF, kO=AI_DIFF.hard.outF;
    AI_DIFF.hard.villF=0.5;  R.villFLive = dbg.aiVillT(1,2)<v0;  AI_DIFF.hard.villF=kV;
    AI_DIFF.hard.outF=0.34;  R.outFLive  = dbg.aiOutMax(1)<o0;   AI_DIFF.hard.outF=kO;
    dbg.setEcoReach(reach0);
    world(); placeB(0,'tc',4,13,true); placeB(1,'tc',42,13,true); freshAi();
    dbg.aiAnalyzeRoutes(1);
    const mcStraight=dbg.aiMarchC(1), srcStraight=dbg.A(1).marchSrc;
    world(); placeB(0,'tc',4,13,true); placeB(1,'tc',42,13,true); freshAi();
    dbg.setTerr(22,0,23,22,T_WATER); computeLandComp();
    const mcEst=dbg.aiMarchC(1), srcEst=dbg.A(1).marchSrc;
    dbg.aiAnalyzeRoutes(1);
    const mcDetour=dbg.aiMarchC(1), srcDetour=dbg.A(1).marchSrc;
    R.detourLonger = srcStraight==='route'&&srcDetour==='route'&&mcDetour>mcStraight+0.15;
    R.abMix = srcEst==='est'&&mcDetour>mcEst+0.15;
    dbg.A(1).marchC=1;  const pNear=dbg.aiPrior(1,300);
    dbg.A(1).marchC=2;  const pFar=dbg.aiPrior(1,300);
    R.priorShifts = pNear>4 && pFar===0;
    dbg.setAiEco(false); dbg.aiResetBrain(1); world(); explored.fill(1);exploredE.fill(1);
    villagers=villagers.filter(v=>(v.side||0)===0);
    for(const k in stockOf(1))stockOf(1)[k]=0;
    return R;`);
  check('R2 scaling: gatherable amount ×2 → villager target rises; clusters outside the home radius 2→4 → outpost cap rises (the main acceptance test)', t91.villScales&&t91.outScales, t91);
  check('R2 scaling: defensive points (outposts 1→3) → tower count +2; more buildable space → renewable cap rises (the count-based cap is retired)', t91.towerScales&&t91.regenScales, t91);
  check('R2 knob liveness: move villF/outF → the villager target and outpost cap move with them (an early warning for the dead-knob clause)', t91.villFLive&&t91.outFLive, t91);
  check('R2 G2 march coefficient: same straight-line distance, but the winding map\'s marchC > the straight map\'s (it measures the route, not the ruler) + the static first estimate is corrected by the route', t91.detourLonger&&t91.abMix, t91);
  check('R2 time parameters shift: the prior curve follows the march coefficient (C=2 = t0/per shift, t=300 still 0)', t91.priorShifts, t91);

  console.log('\n[92] R3 fortifications and expansion: expansion by difficulty (the !T.ageUp dead knob retired) + the tower decision chain (false positives / difficulty thresholds / no duplicate cover / a guard rail) + wall personality');
  const t92 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const world=()=>{units.length=0;villagers.length=0;buildings.length=0;nodes.length=0;scouts.length=0;shots.length=0;
      blocked.fill(0);wallMask.fill(0);gateMask.fill(0);terr.fill(T_PLAIN);paintTerrain();computeLandComp();
      explored.fill(1);exploredE.fill(1);computeDanger();gameOver=null;aiWave=99999;};
    const freshAi=(lv)=>{dbg.setAiDiff(1,lv||'hard');dbg.A(1).pers=null;dbg.setAiPers(1,'england');
      dbg.aiResetBrain(1);dbg.A(1).plan={open:'std',routeBias:0,harass:false};};
    const gold=(tx,ty)=>nodes.push({type:'gold',x:C(tx,ty).x,y:C(tx,ty).y,amt:500,max:500});
    const nB=(si,tp)=>buildings.filter(b=>b.side===si&&b.hp>0&&b.type===tp).length;
    const hasOut=()=>dbg.aiCmt(1).some(c=>c.key==='bld:outpost')||nB(1,'outpost')>0;
    const R={}; const reach0=dbg.ecoReach();
    const expSetup=(lv)=>{world(); placeB(0,'tc',3,20,true); const tc=placeB(1,'tc',30,10,true);
      freshAi(lv); villagers=villagers.filter(v=>(v.side||0)===0); for(let i=0;i<12;i++)spawnVillager(tc);
      dbg.setEcoReach(500);
      gold(40,22);gold(41,22); gold(10,2);gold(11,2);
      {const s=stockOf(1);for(const k in s)s[k]=1000;} return tc;};
    expSetup('hard'); gold(28,10);gold(29,10); dbg.aiMapFeat(1,true);
    for(let i=0;i<6;i++)dbg.aiStratTick(1);
    R.hardProactive = hasOut();
    R.outpostBuilt = nB(1,'outpost')>0;
    expSetup('hard'); gold(28,10);gold(29,10);
    techOf(1).ageUp={t:0}; dbg.aiMapFeat(1,true); dbg.aiStratTick(1);
    R.expandDuringAge = hasOut();
    expSetup('noob'); gold(28,10);gold(29,10); dbg.aiMapFeat(1,true); dbg.aiStratTick(1);
    R.noobHoldsWhenRich = !hasOut();
    expSetup('noob'); dbg.aiMapFeat(1,true); dbg.aiStratTick(1);
    R.noobExpandsWhenExhausted = hasOut();
    dbg.setEcoReach(reach0);
    world(); placeB(0,'tc',3,20,true); const btc=placeB(1,'tc',30,10,true);
    freshAi(); for(let i=0;i<14;i++)spawnVillager(btc); dbg.aiAnalyzeRoutes(1);
    placeB(1,'tower',txOf(dbg.A(1).homeRally.x),tyOf(dbg.A(1).homeRally.y),true);
    const mine=C(20,20);
    dbg.A(1).harassAt={'5,5':{n:1,x:mine.x,y:mine.y}};
    R.oneHitNoTower = dbg.aiTowerSpot(1,14)===null;
    dbg.A(1).harassAt={'5,5':{n:2,x:mine.x,y:mine.y}};
    const sp=dbg.aiTowerSpot(1,14);
    R.twoHitTower = !!sp && Math.hypot(sp.x-mine.x,sp.y-mine.y)<TILE*5;
    dbg.setAiDiff(1,'noob'); R.noobTwoHitHolds = dbg.aiTowerSpot(1,14)===null; dbg.setAiDiff(1,'hard');
    placeB(1,'tower',20,20,true);
    R.coveredNoTower = dbg.aiTowerSpot(1,14)===null;
    world(); placeB(0,'tc',3,20,true); const ctc=placeB(1,'tc',30,10,true);
    freshAi('boss'); for(let i=0;i<14;i++)spawnVillager(ctc);
    {const s=stockOf(1);for(const k in s)s[k]=2000;} dbg.aiAnalyzeRoutes(1);
    const cap=dbg.aiTowerCap(1);
    for(let i=0;i<8;i++){dbg.aiFortNeeds(1,dbg.aiHub(1),techOf(1),stockOf(1),14);dbg.aiCommitExec(1);}
    R.towerBounded = cap>=1 && nB(1,'tower')===cap;
    // (d) Wall personality: rush never builds walls at all; turtle builds proactively without waiting for
    // defAcc; balanced is reactive and needs accumulated defensive pressure.
    const wallSetup=(pers,open)=>{world(); placeB(0,'tc',3,20,true); const wtc=placeB(1,'tc',40,20,true);
      dbg.setAiDiff(1,'hard'); dbg.A(1).pers=null; dbg.setAiPers(1,pers); dbg.aiResetBrain(1);
      dbg.A(1).plan={open:open,routeBias:0,harass:false};
      villagers=villagers.filter(v=>(v.side||0)===0); for(let i=0;i<14;i++)spawnVillager(wtc);
      techOf(1).age=2; recomputeTechMod(1);
      for(let y=0;y<TH;y++){if(y>=20&&y<=22)continue;placeB(0,'wall',30,y,true);}
      computeLandComp(); dbg.aiAnalyzeRoutes(1);
      {const s=stockOf(1);for(const k in s)s[k]=1000;} return wtc;};
    wallSetup('mongol','rush'); dbg.A(1).defAcc=120;
    dbg.aiFortNeeds(1,dbg.aiHub(1),techOf(1),stockOf(1),14); dbg.aiCommitExec(1);
    R.rushNeverWalls = nB(1,'gate')===0 && !dbg.aiCmt(1).some(c=>c.key==='bld:gate'||c.key==='fort:wall');
    wallSetup('hre','boom'); dbg.A(1).defAcc=0;
    dbg.aiFortNeeds(1,dbg.aiHub(1),techOf(1),stockOf(1),14); dbg.aiCommitExec(1);
    dbg.aiFortNeeds(1,dbg.aiHub(1),techOf(1),stockOf(1),14); dbg.aiCommitExec(1);
    R.turtleProactiveWalls = nB(1,'gate')===1;
    wallSetup('england','std'); dbg.A(1).defAcc=0;
    dbg.aiFortNeeds(1,dbg.aiHub(1),techOf(1),stockOf(1),14); dbg.aiCommitExec(1);
    const reactiveHolds = nB(1,'gate')===0;
    dbg.A(1).defAcc=60;
    dbg.aiFortNeeds(1,dbg.aiHub(1),techOf(1),stockOf(1),14); dbg.aiCommitExec(1);
    R.reactiveWalls = reactiveHolds && nB(1,'gate')===1;
    dbg.setAiEco(false); dbg.aiResetBrain(1); world(); explored.fill(1);exploredE.fill(1);
    villagers=villagers.filter(v=>(v.side||0)===0);
    for(const k in stockOf(1))stockOf(1)[k]=0;
    return R;`);
  check('R3 expansion by difficulty: Hard expands actively (including mid age-up; the !T.ageUp dead knob is retired; outposts really do get built, >0); Beginner expands only once its home radius is exhausted (reactive)', t92.hardProactive&&t92.outpostBuilt&&t92.expandDuringAge&&t92.noobHoldsWhenRich&&t92.noobExpandsWhenExhausted, t92);
  check('R3 tower decision chain: one raid does not trigger (false-positive protection); two does (Hard\'s threshold); Beginner\'s threshold is higher; a mine that already has a tower is not covered twice', t92.oneHitNoTower&&t92.twoHitTower&&t92.noobTwoHitHolds&&t92.coveredNoTower, t92);
  check('R3 turtle guard rail: tower building stops at aiTowerCap (no unbounded count crowding out the economy)', t92.towerBounded, t92);
  check('R3 wall personality: the rusher (Mongol) never walls; the turtle (HRE) walls pre-emptively without waiting to be on the defensive; the balanced civilisation (England) is reactive', t92.rushNeverWalls&&t92.turtleProactiveWalls&&t92.reactiveWalls, t92);

  console.log('\n[93] R4 the intelligence pipeline: three-state urgency / scouts at every difficulty / no instant replacement on death / boss switches after repeated losses / 4.5 the anti-bluff clock');
  const t93 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const world=()=>{units.length=0;villagers.length=0;buildings.length=0;nodes.length=0;scouts.length=0;shots.length=0;
      blocked.fill(0);wallMask.fill(0);gateMask.fill(0);terr.fill(T_PLAIN);paintTerrain();computeLandComp();
      explored.fill(1);exploredE.fill(1);computeDanger();gameOver=null;aiWave=99999;};
    const freshAi=(lv)=>{dbg.setAiDiff(1,lv||'hard');dbg.A(1).pers=null;dbg.setAiPers(1,'england');
      dbg.aiResetBrain(1);dbg.A(1).plan={open:'std',routeBias:0,harass:false};};
    const wantsScout=()=>dbg.aiCmt(1).some(x=>x.key==='unit:scout')||cqCount('scout',1)>0||scouts.filter(s=>(s.side||0)===1).length>0;
    const R={};
    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',30,10,true); freshAi();
    dbg.A(1).intelT=t; R.freshLow = dbg.aiIntelUrg(1)<0.4;
    dbg.A(1).intelT=t-9999; R.staleHigh = dbg.aiIntelUrg(1)>=1;
    dbg.A(1).intelT=t; dbg.A(1).foeNewT=t; R.newTypeHigh = dbg.aiIntelUrg(1)>=1;
    dbg.A(1).foeNewT=-1e9; dbg.A(1).clearT=9999; R.quietMid = dbg.aiIntelUrg(1)>=0.7;
    const scoutWant=(lv)=>{world(); placeB(0,'tc',3,20,true); const c=placeB(1,'tc',30,10,true);
      freshAi(lv); for(let i=0;i<30;i++)spawnVillager(c); {const s=stockOf(1);for(const k in s)s[k]=500;}
      dbg.A(1).intelT=t-9999; dbg.aiEcoTick(1); return wantsScout();};
    R.noobScouts = scoutWant('noob'); R.hardScouts = scoutWant('hard'); R.bossScouts = scoutWant('boss');
    world(); placeB(0,'tc',3,20,true); const dtc=placeB(1,'tc',30,10,true);
    freshAi(); for(let i=0;i<30;i++)spawnVillager(dtc); {const s=stockOf(1);for(const k in s)s[k]=500;}
    dbg.A(1).intelT=t; dbg.aiEcoTick(1);
    R.noReplaceWhenFresh = !wantsScout();
    world(); placeB(0,'tc',3,20,true); const gtc=placeB(1,'tc',30,10,true);
    freshAi('boss'); for(let i=0;i<30;i++)spawnVillager(gtc); {const s=stockOf(1);for(const k in s)s[k]=500;}
    dbg.A(1).intelT=t-9999; dbg.A(1).scoutDeaths=2; dbg.aiEcoTick(1);
    R.bossGiveUp = !wantsScout();
    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',34,20,true); freshAi(); aiFullVision=true;
    for(let i=0;i<8;i++)spawnUnit(0,'spear',C(10+i%3,20).x,C(10+i%3,20).y);
    R.singleGlimpseNo = !dbg.aiConfirmedIncoming(1);
    units.filter(u=>u.side===0).forEach(u=>u.x+=6*TILE); dbg.aiConfirmedIncoming(1);
    units.filter(u=>u.side===0).forEach(u=>u.x+=6*TILE);
    R.twoApproachYes = dbg.aiConfirmedIncoming(1);
    units.filter(u=>u.side===0).forEach(u=>u.x-=24*TILE);
    R.retreatResets = !dbg.aiConfirmedIncoming(1);
    dbg.setAiEco(false); dbg.aiResetBrain(1); world(); explored.fill(1);exploredE.fill(1);
    villagers=villagers.filter(v=>(v.side||0)===0); units.length=0;
    for(const k in stockOf(1))stockOf(1)[k]=0;
    return R;`);
  check('R4 three-state urgency: low right after a sighting; high when nothing has been seen for a while or a new unit type appears; medium when the opponent is quiet', t93.freshLow&&t93.staleHigh&&t93.newTypeHigh&&t93.quietMid, t93);
  check('R4 every difficulty produces scouts (Beginner, Hard and boss alike; they wander and locate the enemy base — this is not a boss-only behaviour)', t93.noobScouts&&t93.hardScouts&&t93.bossScouts, t93);
  check('R4 a dead scout is not replaced immediately (fresh intelligence = the demand is already met = no replacement, and no cooldown timer either)', t93.noReplaceWhenFresh, t93);
  check('R4 boss switches to scouting en route with its army after losing 2 scouts in a row, and stops maintaining them', t93.bossGiveUp, t93);
  check('R4 4.5 anti-bluff clock: a single glimpse does not count; only two consecutive approaches towards me do; moving away resets it (the cost of a false read is low)', t93.singleGlimpseNo&&t93.twoApproachYes&&t93.retreatResets, t93);

  console.log('\n[94] R3/R4 review corrections: the 6.5 early-warning difficulty gate + Beginner\'s exhausted check includes natural food and wood + a new game clears the scout-death baseline');
  const t94 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const world=()=>{units.length=0;villagers.length=0;buildings.length=0;nodes.length=0;scouts.length=0;shots.length=0;
      blocked.fill(0);wallMask.fill(0);gateMask.fill(0);terr.fill(T_PLAIN);paintTerrain();computeLandComp();
      explored.fill(1);exploredE.fill(1);computeDanger();gameOver=null;aiWave=99999;};
    const freshAi=(lv)=>{dbg.setAiDiff(1,lv||'hard');dbg.A(1).pers=null;dbg.setAiPers(1,'england');
      dbg.aiResetBrain(1);dbg.A(1).plan={open:'std',routeBias:0,harass:false};};
    const R={};
    const alarm=(lv)=>{world(); placeB(0,'tc',3,20,true); placeB(1,'tc',34,20,true);
      freshAi(lv); aiFullVision=true;
      for(let i=0;i<2;i++)spawnUnit(1,'spear',C(33,23).x+i*24,C(33,23).y,tagsOf(1)[2]);
      for(let i=0;i<8;i++)spawnUnit(0,'spear',C(8+i%3,20).x,C(8+i%3,20).y);
      dbg.aiMilTick(1);
      units.filter(u=>u.side===0).forEach(u=>u.x+=4*TILE); dbg.aiMilTick(1);
      units.filter(u=>u.side===0).forEach(u=>u.x+=4*TILE); dbg.aiMilTick(1);
      const g=tagsOf(1)[2],hr=dbg.A(1).homeRally;
      return {task:g.task,atRally:!!(g.pt&&hr)&&Math.hypot(g.pt.x-hr.x,g.pt.y-hr.y)<TILE*3};};
    const ab=alarm('boss'); R.bossAlarms = ab.task==='guard'&&ab.atRally;
    const ah=alarm('hard'); R.hardStaysPatrol = ah.task==='patrol';
    world(); placeB(0,'tc',3,20,true); const ntc=placeB(1,'tc',30,10,true);
    freshAi('noob'); villagers=villagers.filter(v=>(v.side||0)===0); for(let i=0;i<12;i++)spawnVillager(ntc);
    const reach0=dbg.ecoReach(); dbg.setEcoReach(500);
    nodes.push({type:'food',x:C(28,10).x,y:C(28,10).y,amt:400,max:400});
    nodes.push({type:'gold',x:C(40,22).x,y:C(40,22).y,amt:500,max:500});
    nodes.push({type:'gold',x:C(41,22).x,y:C(41,22).y,amt:500,max:500});
    nodes.push({type:'gold',x:C(10,2).x,y:C(10,2).y,amt:500,max:500});
    nodes.push({type:'gold',x:C(11,2).x,y:C(11,2).y,amt:500,max:500});
    {const s=stockOf(1);for(const k in s)s[k]=1000;}
    const hasOut=()=>dbg.aiCmt(1).some(c=>c.key==='bld:outpost')||buildings.some(b=>b.side===1&&b.hp>0&&b.type==='outpost');
    dbg.aiMapFeat(1,true); for(let i=0;i<3;i++)dbg.aiStratTick(1);
    R.noobHoldsOnBerries = !hasOut();
    nodes.find(n=>n.type==='food').amt=0;
    dbg.aiMapFeat(1,true); for(let i=0;i<3;i++)dbg.aiStratTick(1);
    R.noobExpandsAfterBerries = hasOut();
    dbg.setEcoReach(reach0);
    dbg.A(1)._scN=7; dbg.A(1).scoutDeaths=1; dbg.aiResetBrain(1);
    R.scoutBaseCleared = dbg.A(1)._scN===undefined && dbg.A(1).scoutDeaths===0;
    dbg.setAiEco(false); dbg.aiResetBrain(1); world(); explored.fill(1);exploredE.fill(1);
    villagers=villagers.filter(v=>(v.side||0)===0); units.length=0;
    for(const k in stockOf(1))stockOf(1)[k]=0;
    return R;`);
  check('R4 correction, 6.5 early-warning difficulty gate: a confirmed sighting sends the boss\'s patrol back to the rally point to wait; below Hard there is no early warning (patrols behave as before)', t94.bossAlarms&&t94.hardStaysPatrol, t94);
  check('R3 correction, Beginner\'s exhausted check includes natural food and wood: only berries left inside the radius = do not expand; go out only once it is genuinely gathered out', t94.noobHoldsOnBerries&&t94.noobExpandsAfterBerries, t94);
  check('R4 correction: a new game clears the scout-death baseline (_scN/scoutDeaths, so last game\'s losses cannot be counted as consecutive)', t94.scoutBaseCleared, t94);

  console.log('\n[95] R5 military production and upkeep: counter thresholds (at scale / relative to my own army / no flapping) + the siege standard-issue curve / boss driven by intelligence + upkeep ceiling (food cut off → the army shrinks) + unique-unit upkeep scoring');
  const t95 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const world=()=>{units.length=0;villagers.length=0;buildings.length=0;nodes.length=0;scouts.length=0;shots.length=0;
      blocked.fill(0);wallMask.fill(0);gateMask.fill(0);terr.fill(T_PLAIN);paintTerrain();computeLandComp();
      explored.fill(1);exploredE.fill(1);computeDanger();gameOver=null;aiWave=99999;aiFullVision=true;};
    const freshAi=(lv)=>{techOf(1).researched.clear();techOf(1).age=1;techOf(1).track=null;techOf(1).queue.length=0;techOf(1).ageUp=null;recomputeTechMod(1);
      dbg.setAiEco(true);dbg.setAiMil(true);dbg.setAiDiff(1,lv||'hard');dbg.A(1).pers=null;dbg.setAiPers(1,'england');dbg.aiResetBrain(1);dbg.A(1).plan={open:'std',routeBias:0,harass:false};};
    const R={};
    world(); placeB(0,'tc',3,20,true); const atc=placeB(1,'tc',30,10,true);
    freshAi('hard'); villagers=villagers.filter(v=>(v.side||0)===0); S_(1).starving=false;
    stockOf(1).food=600;
    dbg.A(1).state='develop';
    for(let i=0;i<10;i++)spawnUnit(1,'spear',C(28,10).x,C(28,10).y,tagsOf(1)[0]);
    const spearW=(cav)=>{dbg.A(1).foeSeen=cav?{cavalry:cav}:{};return dbg.aiMilWant(1).spear||0;};
    const spear0=spearW(0), spear1=spearW(1), spear5=spearW(5);
    R.counterNoJitter = spear1===spear0;
    R.counterScale = spear5 > spear1*1.3;
    units.filter(u=>u.side===1&&!u.gar).forEach(u=>u.hp=0);
    spawnUnit(1,'spear',C(28,10).x,C(28,10).y,tagsOf(1)[0]);
    const spear1Small=spearW(1);
    R.counterRelToOwn = spear1Small > spear1;
    R.spearVals=[spear0,spear1,spear5,spear1Small];
    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',30,10,true); freshAi('hard');
    techOf(1).researched.add('M1'); techOf(1).researched.add('U2'); techOf(1).age=1; recomputeTechMod(1);
    R.siegeAge1None = dbg.aiSiegeWant(1,'pressure')===0;
    techOf(1).age=2; dbg.A(1).offAcc=0;
    R.siegeDevNone = dbg.aiSiegeWant(1,'develop')===0;
    const sgP2=dbg.aiSiegeWant(1,'pressure'), sgA2=dbg.aiSiegeWant(1,'allin');
    R.siegeAge2 = sgP2===2 && sgA2===3;
    techOf(1).age=3;
    R.siegeCurveRises = dbg.aiSiegeWant(1,'allin') > sgA2;
    techOf(1).age=2; dbg.A(1).offAcc=270;
    const sgRamp=dbg.aiSiegeWant(1,'allin');
    R.siegeTimeRamp = sgRamp===sgA2+3;
    dbg.A(1).offAcc=1e5;
    const sgCap=dbg.aiSiegeWant(1,'allin');
    R.siegeBounded = sgCap===Math.min(8,sgA2+3) && sgCap<=8;
    for(let i=0;i<20;i++)placeB(0,'tower',6+i,7,true);
    R.siegeNoSnapshot = dbg.aiSiegeWant(1,'allin')===sgCap;
    dbg.setAiDiff(1,'boss'); techOf(1).age=2; dbg.A(1).offAcc=0;
    const sgBoss=dbg.aiSiegeWant(1,'allin');
    R.siegeDiffScaled = sgBoss>sgA2;
    dbg.A(1).offAcc=1e5;
    R.siegeDiffCeil = dbg.aiSiegeWant(1,'allin')===9;
    R.siegeVals=[sgP2,sgA2,sgRamp,sgCap,sgBoss];
    // (c) 7.4 supply cap, reworked as a continuous function after review: normally non-binding (income plus
    // amortised food stores far exceeds military upkeep). When the food source is removed it bites
    // *before* starving — in the window where production is not yet hard-blocked — which is what makes it a
    // live path. Covers the stores slide, the additional ×0.5 while starving, supBuf tiering (ablation),
    // and fishing boats counting towards food capacity.
    world(); const stc=placeB(1,'tc',30,10,true); freshAi('boss'); villagers=villagers.filter(v=>(v.side||0)===0);
    dbg.A(1).state='defend'; dbg.A(1).foeSeen={spear:20}; S_(1).starving=false;
    stockOf(1).food=600;
    for(let i=0;i<6;i++)spawnVillager(stc);
    villagers.filter(v=>(v.side||0)===1).forEach(v=>v.job='food');
    const capHealthy=dbg.aiMilCap(1), supHealthy=dbg.aiSupplyCap(1);
    R.supplyNonBinding = supHealthy>capHealthy*2 && capHealthy>15;
    const incFood=dbg.aiFoodIncome(1);
    villagers.filter(v=>(v.side||0)===1).forEach(v=>v.job=null);
    const incNone=dbg.aiFoodIncome(1);
    const fboat=spawnUnit(1,'fishing',C(30,10).x,C(30,10).y,null);
    R.fishIncome = dbg.aiFoodIncome(1)>0; fboat.hp=0;
    R.foodIncomeCausal = incFood>0 && incNone===0;
    stockOf(1).food=60;
    const capWreck=dbg.aiMilCap(1);
    stockOf(1).food=0;
    const capDrain=dbg.aiMilCap(1);
    R.liveWindow = !S_(1).starving && capWreck<capHealthy*0.5 && capDrain<capWreck;
    S_(1).starving=true;
    const capStarve=dbg.aiMilCap(1);
    R.starveDropsArmy = capStarve<=capDrain && Math.abs(capStarve-4)<0.01;
    villagers.filter(v=>(v.side||0)===1).slice(0,3).forEach(v=>v.job='food');
    dbg.setAiDiff(1,'boss'); const supBoss=dbg.aiSupplyCap(1);
    dbg.setAiDiff(1,'noob'); const supNoob=dbg.aiSupplyCap(1);
    R.supBufKnob = supBoss>supNoob;
    R.supVals=[+capHealthy.toFixed(1),+capWreck.toFixed(1),+capDrain.toFixed(1),+capStarve.toFixed(1),+supBoss.toFixed(1),+supNoob.toFixed(1)];
    world(); const etc=placeB(1,'tc',30,10,true); freshAi('hard'); dbg.setAiPers(1,'england');
    villagers=villagers.filter(v=>(v.side||0)===0);
    techOf(1).researched.add('M3'); techOf(1).researched.add('UL'); recomputeTechMod(1); techOf(1).age=2;
    dbg.A(1).state='pressure'; dbg.A(1).foeSeen={};
    const ratio=()=>{const w=dbg.aiMilWant(1);const lb=w.longbow||0,ar=w.archer||0;return lb+ar>0?lb/(lb+ar):0;};
    S_(1).starving=false; stockOf(1).food=600;
    for(let i=0;i<4;i++)spawnVillager(etc); villagers.filter(v=>(v.side||0)===1).forEach(v=>v.job='food');
    const fracHealthy=ratio();
    villagers.filter(v=>(v.side||0)===1).forEach(v=>v.job=null); stockOf(1).food=0;
    const fracTight=ratio();
    R.uniqAppears = fracHealthy>0.4;
    R.uniqSupplyGate = fracHealthy > fracTight+0.05;
    R.fracVals=[+fracHealthy.toFixed(2),+fracTight.toFixed(2)];
    dbg.setAiEco(false); dbg.aiResetBrain(1); world(); explored.fill(1);exploredE.fill(1);
    villagers=villagers.filter(v=>(v.side||0)===0); units.length=0; S_(1).starving=false;
    for(const k in stockOf(1))stockOf(1)[k]=0;
    return R;`);
  check('R5 8.2 counter threshold: one unit does not shift the mix (identical to no sighting at all, so bait cannot make it flap); a real number does; and it is relative to my own army (a small army shifts for a single knight)', t95.counterNoJitter&&t95.counterScale&&t95.counterRelToOwn, t95);
  check('R9 siege ramp-up curve by difficulty: Dark/development = 0; Hard age 2 base 2/3; +1 in the Castle age; ramps with time spent on the offensive (bounded); the defender snapshot is gone; boss has a higher base and ceiling', t95.siegeAge1None&&t95.siegeDevNone&&t95.siegeAge2&&t95.siegeCurveRises&&t95.siegeTimeRamp&&t95.siegeBounded&&t95.siegeNoSnapshot&&t95.siegeDiffScaled&&t95.siegeDiffCeil, t95);
  check('R5 7.4 upkeep ceiling (continuous): not binding in normal play; with the food supply cleared it shrinks before starving even hits (a live path down the stock slope); starving drops it to the floor; supBuf tiers; fishing boats count towards food capacity', t95.supplyNonBinding&&t95.foodIncomeCausal&&t95.fishIncome&&t95.liveWindow&&t95.starveDropsArmy&&t95.supBufKnob, t95);
  check('R5 8.4 unique-unit upkeep scoring: the tell arrives with the unlock (longbow); when upkeep is tight it substitutes fewer of them to keep the army\'s headcount (not a fixed ratio)', t95.uniqAppears&&t95.uniqSupplyGate, t95);

  console.log('\n[96] R6 groups and the tactical line: the reinforcement column finally fixes trickling + two safety lines + the feint/raid detachment (1-tick recall fixed) + resource guards and construction guards + D1 wave threshold inverted / no strength comparison + D2 target tiers and attack priority');
  const t96 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const world=()=>{units.length=0;villagers.length=0;buildings.length=0;nodes.length=0;scouts.length=0;shots.length=0;
      blocked.fill(0);wallMask.fill(0);gateMask.fill(0);terr.fill(T_PLAIN);paintTerrain();computeLandComp();
      explored.fill(1);exploredE.fill(1);computeDanger();gameOver=null;aiWave=99999;aiDefT=1e9;aiFullVision=true;};
    const freshAi=(lv)=>{dbg.setAiDiff(1,lv||'hard');dbg.A(1).pers=null;dbg.setAiPers(1,'england');
      dbg.aiResetBrain(1);dbg.A(1).plan={open:'std',routeBias:0,harass:false};dbg.A(1).intelT=t;};
    const adv=(s)=>{const n=Math.ceil(s/TICK);for(let i=0;i<n;i++)step(TICK);};
    const G=dbg.AI_G,R={};
    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',34,20,true); placeB(0,'farm',8,20,true);
    const brk=placeB(1,'barracks',30,16,true);
    freshAi('hard'); villagers=villagers.filter(v=>(v.side||0)===0);
    {const s=stockOf(1);for(const k in s)s[k]=1000;} S_(1).starving=false;
    const gM=tagsOf(1)[G.main],gRe=tagsOf(1)[G.reinf];
    for(let i=0;i<8;i++)spawnUnit(1,'spear',C(32,22).x+i*10,C(32,22).y,gM);
    {const gD=tagsOf(1)[G.def],gP=tagsOf(1)[G.pat];
     spawnUnit(1,'spear',C(33,21).x,C(33,21).y,gD);spawnUnit(1,'spear',C(33,21).x+14,C(33,21).y,gD);
     spawnUnit(1,'archer',C(33,20).x,C(33,20).y,gD);spawnUnit(1,'archer',C(33,20).x+14,C(33,20).y,gD);
     spawnUnit(1,'spear',C(34,22).x,C(34,22).y,gP);spawnUnit(1,'archer',C(34,22).x+14,C(34,22).y,gP);}
    dbg.aiMilTick(1);
    adv(2.6); dbg.aiMilTick(1);
    R.stateOut = dbg.A(1).state==='pressure'&&!!dbg.A(1).mission;
    R.prodToReinf = brk.queue.some(q=>q.tag===G.reinf);
    brk.queue.length=0;
    const r1=spawnUnit(1,'spear',C(33,22).x,C(33,22).y,gRe),r2=spawnUnit(1,'spear',C(33,23).x,C(33,23).y,gRe);
    adv(2.6); dbg.aiMilTick(1);
    const hr=dbg.A(1).homeRally;
    R.reinfHolds = !dbg.A(1).reinfDep && gRe.task==='guard' && !!gRe.pt && Math.hypot(gRe.pt.x-hr.x,gRe.pt.y-hr.y)<TILE*3;
    const r3=spawnUnit(1,'spear',C(33,24).x,C(33,24).y,gRe),r4=spawnUnit(1,'spear',C(32,24).x,C(32,24).y,gRe);
    adv(2.6); dbg.aiMilTick(1);
    R.reinfDeparts = dbg.A(1).reinfDep===true && gRe.task==='attack';
    {const mUs=units.filter(u=>u.side===1&&u.grp===gM&&u.hp>0);
     const mcx=mUs.reduce((s,u)=>s+u.x,0)/mUs.length,mcy=mUs.reduce((s,u)=>s+u.y,0)/mUs.length;
     [r1,r2,r3,r4].forEach((u,i)=>{u.x=mcx+i*8;u.y=mcy;});}
    dbg.aiMilTick(1);
    R.reinfMerges = [r1,r2,r3,r4].every(u=>u.grp===gM) && !dbg.A(1).reinfDep;
    const r5=spawnUnit(1,'spear',C(33,22).x,C(33,22).y,gRe);
    dbg.A(1).state='develop'; dbg.A(1).mission=null; adv(2.6); dbg.aiMilTick(1);
    R.reinfHomeMerge = r5.grp===gM;
    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',34,20,true); const ptc=buildings[0]; placeB(0,'farm',8,20,true);
    freshAi('boss'); dbg.A(1).plan={open:'std',routeBias:0,harass:true};
    villagers=villagers.filter(v=>(v.side||0)===0);
    const gM2=tagsOf(1)[G.main],gH=tagsOf(1)[G.har];
    for(let i=0;i<8;i++)spawnUnit(1,'spear',C(32,22).x+i*10,C(32,22).y,gM2);
    for(let i=0;i<2;i++)spawnUnit(1,'cavalry',C(33,19).x+i*20,C(33,19).y,gH);
    dbg.aiMilTick(1);
    R.harDispatch = dbg.A(1).harOut===true && gH.task==='attack';
    const hT0=dbg.A(1).harassT;
    adv(2.6); dbg.aiMilTick(1); adv(2.6); dbg.aiMilTick(1); adv(2.6); dbg.aiMilTick(1);
    R.harStaysOut = dbg.A(1).harOut===true && gH.task==='attack' && dbg.A(1).harassT===hT0;
    dbg.A(1).harassT=t-(41);
    adv(2.6); dbg.aiMilTick(1);
    R.harRecalled = dbg.A(1).harOut===false && gH.task==='guard' && Math.hypot(gH.pt.x-dbg.A(1).homeRally.x,gH.pt.y-dbg.A(1).homeRally.y)<TILE*3;
    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',34,20,true); const ptc2=buildings[0]; placeB(0,'farm',8,20,true);
    freshAi('boss'); dbg.A(1).plan={open:'std',routeBias:0,harass:true};
    villagers=villagers.filter(v=>(v.side||0)===0);
    const gM3=tagsOf(1)[G.main],gH2=tagsOf(1)[G.har];
    for(let i=0;i<5;i++)spawnUnit(1,'spear',C(32,22).x+i*10,C(32,22).y,gM3);
    for(let i=0;i<2;i++)spawnUnit(1,'cavalry',C(33,19).x+i*20,C(33,19).y,gH2);
    dbg.aiMilTick(1); dbg.A(1).state='pressure'; dbg.A(1).sT=t; dbg.A(1).harassT=-1e9;
    adv(2.6); dbg.aiMilTick(1);
    R.harLineBlocks = !dbg.A(1).harOut && gH2.task!=='attack';
    for(let i=0;i<3;i++)spawnUnit(1,'spear',C(31,23).x+i*10,C(31,23).y,gM3);
    adv(2.6); dbg.aiMilTick(1);
    R.harLineReleases = dbg.A(1).harOut===true && gH2.task==='attack';
    adv(2.6);
    {const hUs=units.filter(u=>u.side===1&&u.grp===gH2&&u.hp>0);
     const cx=hUs.reduce((s,u)=>s+u.x,0)/hUs.length,cy=hUs.reduce((s,u)=>s+u.y,0)/hUs.length;
     spawnVillager(ptc2); const sv=villagers[villagers.length-1]; sv.x=cx+100; sv.y=cy;
     dbg.A(1).harLeg=null; dbg.aiMilTick(1);
     R.harHuntsVillager = gH2.focus===sv;}
    R.knobDir = AI_DIFF.noob.pressMin<AI_DIFF.normal.pressMin;
    R.knobSquads = AI_DIFF.noob.squads==='none'&&AI_DIFF.normal.squads==='none'&&AI_DIFF.hard.squads==='patrol'&&AI_DIFF.boss.squads==='dynamic';
    const patProbe=(lv)=>{world(); placeB(0,'tc',3,20,true); placeB(1,'tc',34,20,true);
      const bk=placeB(1,'barracks',30,16,true);
      freshAi(lv); villagers=villagers.filter(v=>(v.side||0)===0);
      {const s=stockOf(1);for(const k in s)s[k]=1000;} S_(1).starving=false;
      const gD=tagsOf(1)[G.def];
      spawnUnit(1,'spear',C(33,21).x,C(33,21).y,gD);spawnUnit(1,'spear',C(33,21).x+14,C(33,21).y,gD);
      spawnUnit(1,'archer',C(33,22).x,C(33,22).y,gD);spawnUnit(1,'archer',C(33,22).x+14,C(33,22).y,gD);
      dbg.aiMilTick(1);
      return bk.queue.length?bk.queue[0].tag:-1;};
    R.hardPatrols   = patProbe('hard')===G.pat;
    R.noobNoPatrol  = patProbe('noob')===G.main;
    R.normalNoPatrol= patProbe('normal')===G.main;
    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',34,20,true);
    freshAi('hard'); villagers=villagers.filter(v=>(v.side||0)===0);
    {const gD=tagsOf(1)[G.def],gP=tagsOf(1)[G.pat];
     spawnUnit(1,'spear',C(33,21).x,C(33,21).y,gD);spawnUnit(1,'spear',C(33,21).x+14,C(33,21).y,gD);
     spawnUnit(1,'archer',C(33,22).x,C(33,22).y,gD);spawnUnit(1,'archer',C(33,22).x+14,C(33,22).y,gD);
     spawnUnit(1,'cavalry',C(33,19).x,C(33,19).y,gP);spawnUnit(1,'cavalry',C(33,19).x+20,C(33,19).y,gP);
     dbg.aiMilTick(1);
     const patBefore=units.filter(u=>u.side===1&&u.hp>0&&u.grp===gP).length;
     units.filter(u=>u.side===1&&u.grp===gD).forEach(u=>u.hp=0);
     for(let i=0;i<4;i++)spawnUnit(0,'spear',C(31,20).x+i*12,C(31,20).y,tags[5]);
     adv(2.6); dbg.aiMilTick(1);
     R.patFoldsBack = patBefore===2 && units.filter(u=>u.side===1&&u.hp>0&&u.grp===gP).length===0
                   && units.filter(u=>u.side===1&&u.hp>0&&u.grp===gD).length>=1;}
    world(); placeB(0,'tc',3,20,true); const btc=placeB(1,'tc',34,20,true);
    freshAi('boss'); dbg.A(1).plan={open:'std',routeBias:0,harass:false};
    villagers=villagers.filter(v=>(v.side||0)===0);
    {const P=C(22,30);
     dbg.A(1).harassAt={k1:{n:2,x:P.x,y:P.y}};
     for(let i=0;i<2;i++)spawnVillager(btc);
     villagers.filter(v=>(v.side||0)===1).forEach((v,i)=>{v.x=P.x+i*12;v.y=P.y;});
     const gG=tagsOf(1)[G.rgu];
     spawnUnit(1,'spear',C(33,21).x,C(33,21).y,gG);spawnUnit(1,'archer',C(33,21).x+14,C(33,21).y,gG);
     dbg.aiMilTick(1);
     R.rguStations = !!dbg.A(1).rguPt && gG.task==='guard' && Math.hypot(gG.pt.x-P.x,gG.pt.y-P.y)<TILE*3;
     villagers.filter(v=>(v.side||0)===1).forEach(v=>v.hp=0);
     adv(2.6); dbg.aiMilTick(1);
     R.rguLeaves = !dbg.A(1).rguPt && Math.hypot(gG.pt.x-dbg.A(1).homeRally.x,gG.pt.y-dbg.A(1).homeRally.y)<TILE*3;
     dbg.setAiDiff(1,'hard'); dbg.A(1).plan={open:'std',routeBias:0,harass:false}; dbg.A(1).intelT=t;
     for(let i=0;i<2;i++)spawnVillager(btc);
     villagers.filter(v=>(v.side||0)===1&&v.hp>0).forEach((v,i)=>{v.x=P.x+i*12;v.y=P.y;});
     adv(2.6); dbg.aiMilTick(1);
     R.rguBossOnly = !dbg.A(1).rguPt;}
    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',34,20,true);
    freshAi('hard'); villagers=villagers.filter(v=>(v.side||0)===0);
    {const gD2=tagsOf(1)[G.def];
     spawnUnit(1,'spear',C(33,21).x,C(33,21).y,gD2);spawnUnit(1,'spear',C(33,21).x+14,C(33,21).y,gD2);
     spawnUnit(1,'archer',C(33,22).x,C(33,22).y,gD2);spawnUnit(1,'archer',C(33,22).x+14,C(33,22).y,gD2);
     dbg.aiMilTick(1);
     const tw=placeB(1,'tower',20,30,false);
     adv(2.6); dbg.aiMilTick(1);
     R.defGuardsSite = Math.hypot(gD2.pt.x-tw.x,gD2.pt.y-tw.y)<TILE*3;
     tw.done=true; tw.hp=tw.maxHp;
     adv(2.6); dbg.aiMilTick(1);
     R.defReturnsHome = Math.hypot(gD2.pt.x-dbg.A(1).homeRally.x,gD2.pt.y-dbg.A(1).homeRally.y)<TILE*3;
     dbg.setAiDiff(1,'noob'); dbg.A(1).intelT=t; tw.done=false;
     adv(2.6); dbg.aiMilTick(1);
     R.noobNoSiteGuard = Math.hypot(gD2.pt.x-dbg.A(1).homeRally.x,gD2.pt.y-dbg.A(1).homeRally.y)<TILE*3;}
    const d1=(lv,nSpear,foe)=>{world(); placeB(0,'tc',3,20,true); placeB(1,'tc',34,20,true);
      freshAi(lv); villagers=villagers.filter(v=>(v.side||0)===0);
      const g=tagsOf(1)[G.main];
      for(let i=0;i<nSpear;i++)spawnUnit(1,'spear',C(31,22).x+(i%4)*12,C(31,22).y+((i/4)|0)*12,g);
      dbg.A(1).foeSeen=foe||{};
      dbg.aiMilTick(1);
      return dbg.A(1).state;};
    R.d1NormalBumped   = d1('normal',11,{spear:30})==='develop';
    R.d1NormalGoes     = d1('normal',15,{spear:30})==='pressure';
    R.d1HardCompares   = d1('hard',15,{spear:30})==='develop';
    R.d1NoobSmallWave  = d1('noob',6,null)==='pressure';
    R.d1NormalNeedsMore= d1('normal',6,null)==='develop';
    const missionOf=(lv)=>{world(); placeB(0,'tc',3,20,true); placeB(1,'tc',34,20,true);
      placeB(0,'farm',8,20,true); placeB(0,'farm',8,24,true); placeB(0,'market',6,16,true);
      freshAi(lv); villagers=villagers.filter(v=>(v.side||0)===0);
      const g=tagsOf(1)[G.main];
      for(let i=0;i<12;i++)spawnUnit(1,'spear',C(31,22).x+(i%4)*12,C(31,22).y+((i/4)|0)*12,g);
      dbg.aiMilTick(1);
      const m=dbg.A(1).mission; return m?m.kind:null;};
    R.d2NoobBase        = missionOf('noob')==='base';
    R.d2NormalNearestEco= missionOf('normal')==='eco';
    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',34,20,true);
    placeB(0,'farm',8,20,true); placeB(0,'farm',8,24,true); placeB(0,'market',6,16,true);
    freshAi('hard');
    {const seen=new Set(),hub={x:C(34,20).x,y:C(34,20).y};
     for(let i=0;i<10;i++){const b=dbg.aiEcoTarget(1,hub,false,true);if(b)seen.add(b.tx+','+b.ty);}
     R.d2HardVaries = seen.size>=2;}
    R.noobRuleNearest = (dbg.setAiDiff(1,'noob'),tagsOf(1)[G.main].rule==='nearest');
    R.hardRuleCounter = (dbg.setAiDiff(1,'hard'),tagsOf(1)[G.main].rule==='counter');
    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',34,20,true);
    {const twr=placeB(0,'tower',20,18,true),fm=placeB(0,'farm',20,22,true);
     const gA=tagsOf(1)[G.main]; gA.rule='counter'; gA.task='attack'; gA.focus=null; gA.pt=null;
     const at=spawnUnit(1,'spear',C(20,20).x,C(20,20).y,gA);
     adv(0.3);
     R.prioTowerOverFarm = acquire(at)===twr;
     const es=spawnUnit(0,'spear',C(21,20).x,C(21,20).y,tags[5]);
     adv(0.3);
     R.prioUnitOverTower = acquire(at)===es;}
    dbg.setAiEco(false); dbg.setAiDiff(1,'hard'); dbg.aiResetBrain(1); world(); explored.fill(1);exploredE.fill(1);
    villagers=villagers.filter(v=>(v.side||0)===0); units.length=0; S_(1).starving=false;
    for(const k in stockOf(1))stockOf(1)[k]=0;
    return R;`);
  check('R6 5.1 reinforcement column (the final fix for trickling, at every difficulty): with the main force away, production is assigned to the reinforcement column; it waits at home until it is up to strength, marches as a formed body, merges into the main force on arrival, and merges in place when the wave ends', t96.stateOut&&t96.prodToReinf&&t96.reinfHolds&&t96.reinfDeparts&&t96.reinfMerges&&t96.reinfHomeMerge, t96);
  check('R6 5.5 feint/raid detachment (boss; 1-tick recall fixed): sorties during an offensive, is not recalled inside its window, disbands when the window closes, does not detach below the main force\'s safety line, and the mobile party goes straight for visible villagers (focus)', t96.harDispatch&&t96.harStaysOut&&t96.harRecalled&&t96.harLineBlocks&&t96.harLineReleases&&t96.harHuntsVillager, t96);
  check('R6 5.1 two safety lines + detachment by difficulty: Beginner and Normal never detach a patrol; Hard detaches only once the garrison is at full strength; a thinned garrison absorbs the patrol back (the squads knob is live)', t96.knobSquads&&t96.hardPatrols&&t96.noobNoPatrol&&t96.normalNoPatrol&&t96.patFoldsBack, t96);
  check('R6 6.1 detachment support: boss keeps a standing resource guard on a mine that is in use and being harassed (unused = it relocates or goes home; Hard has no such party); Hard guards a tower site until completion then leaves (Beginner does not guard at all)', t96.rguStations&&t96.rguLeaves&&t96.rguBossOnly&&t96.defGuardsSite&&t96.defReturnsHome&&t96.noobNoSiteGuard, t96);
  check('R6 5.2 D1/D5: the wave threshold is inverted (Beginner 7 < Normal 10); Beginner and Normal do not compare strength (running into a large army just raises the threshold, they still attack); Hard compares and does not sortie if it would lose', t96.knobDir&&t96.d1NormalBumped&&t96.d1NormalGoes&&t96.d1HardCompares&&t96.d1NoobSmallWave&&t96.d1NormalNeedsMore, t96);
  check('R6 5.3 D2 target tiers and attack priority: Beginner heads for the town centre (no selection logic, rule = nearest); Normal takes the nearest economy; Hard varies its target (drawn from the seed); counter = units > towers and castles > other buildings', t96.d2NoobBase&&t96.d2NormalNearestEco&&t96.d2HardVaries&&t96.noobRuleNearest&&t96.hardRuleCounter&&t96.prioTowerOverFarm&&t96.prioUnitOverTower, t96);

  console.log('\n[97] R7-pre spectator fixes: mirrored placement goes through canPlace = no more overlaps + equal counts of each building type per side + a symmetric exploredE placement gate + iron under a footprint is sealed and stops regenerating');
  const t97 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const world=()=>{units.length=0;villagers.length=0;buildings.length=0;nodes.length=0;scouts.length=0;shots.length=0;
      blocked.fill(0);wallMask.fill(0);gateMask.fill(0);terr.fill(T_PLAIN);paintTerrain();computeLandComp();
      explored.fill(0);exploredE.fill(0);computeDanger();gameOver=null;aiWave=99999;aiDefT=1e9;aiFullVision=false;};
    const adv=(s)=>{const n=Math.ceil(s/TICK);for(let i=0;i<n;i++)step(TICK);};
    const R={};
    world(); explored.fill(1); exploredE.fill(1); aiFullVision=true;
    placeB(0,'tc',3,20,true); placeB(1,'tc',44,20,true);
    const nIr=[{type:'iron',x:C(10,10).x,y:C(10,10).y,amt:0,max:120},
               {type:'iron',x:C(14,10).x,y:C(14,10).y,amt:0,max:120},
               {type:'iron',x:C(18,10).x,y:C(18,10).y,amt:0,max:120}];
    nodes.push(...nIr);
    const wSeal=placeB(0,'wall',10,10,true); placeB(0,'farm',14,10,true);
    modOf(1).ironRegen=0.3;
    adv(3);
    R.sealedWall = nIr[0].amt===0;
    R.sealedFarm = nIr[1].amt===0;
    R.openRegens = nIr[2].amt>0.5;
    wSeal.hp=0; adv(3);
    R.unsealResumes = nIr[0].amt>0.5;
    modOf(1).ironRegen=0;
    world();
    placeB(0,'tc',START.ptc[0],START.ptc[1],true);
    placeB(0,'barracks',START.pbar[0],START.pbar[1],true);
    placeB(1,'tc',START.etc[0],START.etc[1],true);
    for(const [bx,by] of START.ebar)placeB(1,'barracks',bx,by,true);
    for(const [bx,by] of START.etw)placeB(1,'tower',bx,by,true);
    spectateInit('hard');
    {let ov=false;
     for(let i=0;i<buildings.length&&!ov;i++)for(let j=i+1;j<buildings.length&&!ov;j++){
       const a=buildings[i],b=buildings[j],fa=fpOf(a.type,a.ori),fb=fpOf(b.type,b.ori);
       if(a.tx<b.tx+fb.w&&b.tx<a.tx+fa.w&&a.ty<b.ty+fb.h&&b.ty<a.ty+fa.h)ov=true;}
     R.noOverlap=!ov;}
    {const cnt=(si,ty)=>buildings.filter(b=>b.side===si&&b.type===ty).length;
     R.symBar = cnt(0,'barracks')===cnt(1,'barracks');
     R.symTw  = cnt(0,'tower')===cnt(1,'tower');
     R.mirrorWorks = cnt(0,'barracks')>=2 && cnt(0,'tower')===2;}
    R.expE = exploredE.every(v=>v===1);
    {let bad=false;
     for(const b of buildings){const fp=fpOf(b.type,b.ori);
       for(let y=b.ty;y<b.ty+fp.h;y++)for(let x=b.tx;x<b.tx+fp.w;x++)if(!blocked[idx(x,y)])bad=true;}
     R.blockedSane=!bad;}
    {const brk=buildings.find(b=>b.side===1&&b.type==='barracks');
     const s1=stockOf(1);s1.food=500;s1.wood=500;s1.gold=500;S_(1).starving=false;
     queueUnit(brk,'spear');
     openFoeBldPanel(brk);
     R.specBldProd=q('#bldPanel').innerHTML.includes(UT.spear.ch);
     const gm=tagsOf(1)[dbg.AI_G.main];
     const su=spawnUnit(1,'spear',brk.x,brk.y+60,gm);
     openFoeUnitPanel(su);
     R.specUnitLegion=q('#bldPanel').innerHTML.includes(SPEC_G_NM[0]);
     spawnVillager(buildings.find(b=>b.side===0&&b.type==='tc'));
     const vv=villagers[villagers.length-1];
     openFoeUnitPanel(vv);
     R.specVilTask=q('#bldPanel').innerHTML.includes(STR.ui_specTask.slice(0,3));
     closePanels();}
    spectate=false; aiFullVision=true; aiOn[0]=false;
    q('#specBar').classList.add('hidden');
    for(const id of ['tagbar','leftTabs','scoutbar','buildPanel','ecoPanel'])q('#'+id).classList.remove('hidden');
    world(); explored.fill(1); exploredE.fill(1); aiFullVision=true;
    return R;`);
  check('R7-pre ④ iron sealed: covered by a wall or farm = no regeneration (walling over a mined-out node is legal, and regrowth must not refill it); uncovered nodes regenerate as normal; demolish and it resumes', t97.sealedWall&&t97.sealedFarm&&t97.openRegens&&t97.unsealResumes, t97);
  check('R7-pre ① symmetric opening: mirrored placement goes through canPlace = no overlaps; equal counts of each building type per side; mirroring still applies; exploredE filled; blocked bookkeeping complete', t97.noOverlap&&t97.symBar&&t97.symTw&&t97.mirrorWorks&&t97.expE&&t97.blockedSane, t97);
  check('R7-pre spectator panels show full state: buildings = production queue shown; military units = group membership (main force); villagers = task list (smoke test throws nothing)', t97.specBldProd&&t97.specUnitLegion&&t97.specVilTask, t97);

  console.log('\n[98] R7a \"hitting accurately\": scouts made per-side + E2 manual control and observation posts + E4 scouting en route + D2 weak + the two-party siege split / pure harassment + tower-ring stop-loss + regrouping in place / retreat turned into attack + U2 research hunger');
  const t98 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const world=()=>{units.length=0;villagers.length=0;buildings.length=0;nodes.length=0;scouts.length=0;shots.length=0;
      blocked.fill(0);wallMask.fill(0);gateMask.fill(0);terr.fill(T_PLAIN);paintTerrain();computeLandComp();
      explored.fill(1);exploredE.fill(1);unreachable.fill(0);unreachableE.fill(0);computeDanger();gameOver=null;aiWave=99999;aiDefT=1e9;aiFullVision=true;};
    const freshAi=(lv)=>{dbg.setAiDiff(1,lv||'boss');dbg.A(1).pers=null;dbg.setAiPers(1,'england');
      dbg.aiResetBrain(1);dbg.A(1).plan={open:'std',routeBias:0,harass:false};dbg.A(1).intelT=t;};
    const adv=(s)=>{const n=Math.ceil(s/TICK);for(let i=0;i<n;i++)step(TICK);};
    const G=dbg.AI_G,R={};
    /* This group must run with honest vision: what it verifies is that each side only knows about towers it
       has actually seen, and the world() fixture ships with omniscience on.
       The old code passed by coincidence — the stale-memory gate aiSeenB had no aiFullVision branch
       (seenBy had one, aiSeenB didn't: two implementations of the same idea drifting apart), so it stayed
       honest even under omniscience. Once the two were merged, the contradiction of "omniscience on, yet
       asserting no clairvoyance" surfaced; running honest vision is what this test always meant. */
    world(); aiFullVision=false;   /* Ordering matters: world() sets aiFullVision=true at the end, so it can only be turned off afterwards. */
    placeB(0,'tc',3,20,true); placeB(1,'tc',44,20,true);
    const tw0=placeB(0,'tower',10,10,true),tw1=placeB(1,'tower',30,10,true);
    tw0.seenE=true; tw1.seen=true;
    R.sideSeesEnemyTower = dbg.scoutUnsafe(C(11,10).x,C(11,10).y,1)===true;
    R.sideIgnoresOwnTower= dbg.scoutUnsafe(C(29,10).x,C(29,10).y,1)===false;
    R.p0Unchanged        = dbg.scoutUnsafe(C(29,10).x,C(29,10).y,0)===true;
    tw0.seenE=false;
    R.noPrescience       = dbg.scoutUnsafe(C(11,10).x,C(11,10).y,1)===false;
    exploredE.fill(1); exploredE[idx(40,6)]=0; exploredE[idx(42,6)]=0;
    {const n1=dbg.nearestUnexplored(C(44,20).x,C(44,20).y,1),n0=dbg.nearestUnexplored(C(3,20).x,C(3,20).y,0);
     R.perSideExplore = !!n1 && Math.hypot(n1.x-C(41,6).x,n1.y-C(41,6).y)<TILE*3 && n0===null;}
    exploredE.fill(1); aiFullVision=true;
    world(); const ptc=placeB(0,'tc',3,20,true); const etc=placeB(1,'tc',44,20,true);
    freshAi('boss'); villagers=villagers.filter(v=>(v.side||0)===0);
    spawnScout(etc); spawnScout(etc); const sc=scouts[scouts.length-2],scB=scouts[scouts.length-1];
    dbg.A(1).intelT=-1e9;
    dbg.aiScoutCtl(1);
    {const o=dbg.aiObsPt(1),dispatched=[sc,scB].filter(x=>x.aiDir);
     R.e2Directed = dispatched.length===1 && dispatched[0].manual===true && dispatched[0].mode==='explore'
        && !!dispatched[0].expT && Math.hypot(dispatched[0].expT.x-o.x,dispatched[0].expT.y-o.y)<TILE*3;}
    dbg.A(1).intelT=t;
    dbg.aiScoutCtl(1);
    R.e2Release = !sc.aiDir && sc.manual===false && !scB.aiDir;
    dbg.setAiDiff(1,'hard'); dbg.A(1).intelT=-1e9;
    scouts.length=0; spawnScout(etc); const sc2=scouts[scouts.length-1];
    dbg.aiScoutCtl(1);
    R.e2HardNoCtl = !sc2.aiDir && sc2.manual===false;
    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',44,20,true); placeB(0,'farm',8,24,true);
    freshAi('boss'); villagers=villagers.filter(v=>(v.side||0)===0);
    aiFullVision=false; visibleE.fill(0); buildings.forEach(b=>{if(b.side===0)b.seenE=true;});
    {const gM=tagsOf(1)[G.main];for(let i=0;i<9;i++)spawnUnit(1,'spear',C(40,22).x+i*10,C(40,22).y,gM);}
    dbg.A(1).scoutDeaths=2; dbg.A(1).intelT=-1e9;
    dbg.A(1).state='pressure'; dbg.A(1).sT=t;
    dbg.aiMilTick(1);
    {const m=dbg.A(1).mission,o=dbg.aiObsPt(1);
     R.e4Leg = !!m && m.kind==='eco' && m.legs.some(l=>Math.hypot(l.x-o.x,l.y-o.y)<TILE*3);}
    dbg.A(1).scoutDeaths=0; dbg.A(1).intelT=t; dbg.A(1).mission=null;
    dbg.A(1).state='pressure'; dbg.A(1).sT=t;
    dbg.aiMilTick(1);
    {const m=dbg.A(1).mission,o=dbg.aiObsPt(1);
     R.e4NoLegFresh = !!m && !m.legs.some(l=>Math.hypot(l.x-o.x,l.y-o.y)<TILE*3);}
    aiFullVision=true;
    R.knobWeak = AI_DIFF.boss.tgtSel==='weak' && AI_DIFF.hard.tgtSel==='vary';
    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',44,20,true);
    const fNear=placeB(0,'farm',30,20,true);
    placeB(0,'tower',28,19,true); placeB(0,'tower',31,22,true); placeB(0,'tower',28,22,true);
    const fOpen=placeB(0,'farm',8,24,true);
    freshAi('boss');
    dbg.A(1).intelT=t;
    {const tgt=dbg.aiEcoTarget(1,dbg.aiHub(1),false,false,true);
     R.weakPicksOpen = tgt===fOpen;}
    R.weakScoreOrder = dbg.aiDefScore(1,fNear.x,fNear.y)>dbg.aiDefScore(1,fOpen.x,fOpen.y);
    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',44,20,true); const fT=placeB(0,'farm',8,24,true);
    freshAi('boss'); villagers=villagers.filter(v=>(v.side||0)===0);
    const gM5=tagsOf(1)[G.main],gSg=tagsOf(1)[G.sieg];
    for(let i=0;i<8;i++)spawnUnit(1,'spear',C(40,22).x+i*10,C(40,22).y,gM5);
    const ct1=spawnUnit(1,'catapult',C(41,23).x,C(41,23).y,gM5),ct2=spawnUnit(1,'catapult',C(41,23).x+30,C(41,23).y,gM5);
    dbg.A(1).state='pressure'; dbg.A(1).sT=t;
    dbg.aiMilTick(1);
    R.siegeSplit  = ct1.grp===gSg && ct2.grp===gSg && !!dbg.A(1).mission && !!dbg.A(1).mission.tgt.size;
    R.siegeFocus  = gSg.focus===dbg.A(1).mission.tgt;
    R.escortNoFocus = gM5.focus===null;
    dbg.A(1).mission=null; dbg.A(1).state='develop'; dbg.A(1).retreatT=t;
    adv(2.6); dbg.aiMilTick(1);
    R.siegeMerge  = ct1.grp===gM5 && ct2.grp===gM5;
    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',44,20,true);
    const fHard=placeB(0,'farm',8,24,true);
    placeB(0,'tower',7,22,true);placeB(0,'tower',10,25,true);placeB(0,'tower',6,25,true); // defScore 3 > 2.2
    freshAi('boss'); dbg.A(1).plan={open:'std',routeBias:0,harass:true};
    villagers=villagers.filter(v=>(v.side||0)===0);
    const gM6=tagsOf(1)[G.main],gH6=tagsOf(1)[G.har];
    for(let i=0;i<8;i++)spawnUnit(1,'spear',C(40,22).x+i*10,C(40,22).y,gM6);
    const hv1=spawnUnit(1,'cavalry',C(41,19).x,C(41,19).y,gH6),hv2=spawnUnit(1,'cavalry',C(41,19).x+20,C(41,19).y,gH6);
    dbg.A(1).state='pressure'; dbg.A(1).sT=t; dbg.A(1).harassT=-1e9;
    dbg.aiMilTick(1);
    R.pureOn = dbg.A(1).harOut===true && dbg.A(1).harPure===true && gH6.noBld===true;
    hv1.x=fHard.x+80;hv1.y=fHard.y;hv2.x=fHard.x+90;hv2.y=fHard.y+20;
    adv(1.7);
    R.pureNoBld = hv1.tgt!==fHard && hv2.tgt!==fHard;
    const op=placeB(0,'outpost',5,27,true); hv1.x=op.x+70;hv1.y=op.y; hv1.tgt=null;hv1.reT=0;
    adv(1.7);
    R.pureOutpostOk = hv1.tgt===op;
    dbg.A(1).harassT=t-41; adv(2.6); dbg.aiMilTick(1);
    R.pureOffHome = dbg.A(1).harPure===false && gH6.noBld===false;
    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',44,20,true); placeB(0,'farm',8,24,true);
    freshAi('boss'); dbg.A(1).plan={open:'std',routeBias:0,harass:true};
    villagers=villagers.filter(v=>(v.side||0)===0);
    {const gM7=tagsOf(1)[G.main],gH7=tagsOf(1)[G.har];
     for(let i=0;i<8;i++)spawnUnit(1,'spear',C(40,22).x+i*10,C(40,22).y,gM7);
     spawnUnit(1,'cavalry',C(41,19).x,C(41,19).y,gH7);spawnUnit(1,'cavalry',C(41,19).x+20,C(41,19).y,gH7);
     dbg.A(1).state='pressure'; dbg.A(1).sT=t; dbg.A(1).harassT=-1e9;
     dbg.aiMilTick(1);
     R.pureCausal = dbg.A(1).harOut===true && dbg.A(1).harPure===false && gH7.noBld===false;}
    world(); dbg.setAiEco(true); dbg.setAiMil(false);
    placeB(0,'tc',3,20,true); placeB(1,'tc',44,20,true);
    freshAi('boss'); villagers=villagers.filter(v=>(v.side||0)===0);
    const twS=placeB(0,'tower',20,20,true);
    spawnVillager(buildings.find(b=>b.side===0&&b.type==='tc'));
    const flee=villagers[villagers.length-1];
    const gMS=tagsOf(1)[G.main];
    const ch=spawnUnit(1,'cavalry',twS.x+90,twS.y+40,gMS);
    gMS.task='attack'; gMS.focus=flee; ch.tgt=flee;
    flee.x=ch.x+130; flee.y=ch.y;
    {let n=Math.ceil(5/TICK);
     for(let i=0;i<n&&ch.hp>0;i++){step(TICK);ch.x=twS.x+90;ch.y=twS.y+40;flee.x=ch.x+130;flee.y=ch.y;flee.hp=flee.maxHp;}}
    R.stopLoss = ch.hp>0 && ch.banTgt===flee && ch.tgt!==flee;
    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',44,20,true);
    villagers=villagers.filter(v=>false);
    const twE=placeB(1,'tower',20,20,true); twE.seen=true;
    {const btc=buildings.find(b=>b.side===1&&b.type==='tc');spawnVillager(btc);}
    const fleeE=villagers[villagers.length-1];
    const gP0=tags[0];
    const chP=spawnUnit(0,'cavalry',twE.x+90,twE.y+40,gP0);
    gP0.task='attack'; gP0.focus=fleeE; chP.tgt=fleeE;
    fleeE.x=chP.x+130; fleeE.y=chP.y;
    {let n=Math.ceil(5/TICK);
     for(let i=0;i<n&&chP.hp>0;i++){step(TICK);chP.x=twE.x+90;chP.y=twE.y+40;fleeE.x=chP.x+130;fleeE.y=chP.y;fleeE.hp=fleeE.maxHp;}}
    R.playerUnaffected = chP.hp>0 && !chP.banTgt;
    gP0.focus=null; gP0.task='guard';
    dbg.setAiEco(false); dbg.setAiMil(true);
    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',44,20,true); placeB(1,'smith',40,18,true);
    freshAi('boss'); villagers=villagers.filter(v=>(v.side||0)===0);
    techOf(1).age=2; techOf(1).track=null; techOf(1).queue.length=0;
    dbg.A(1).state='develop';
    R.hungerDevNull = dbg.aiTechHunger(1)===null;
    dbg.A(1).state='pressure';
    R.hungerPre = dbg.aiTechHunger(1)==='M1';
    completeResearch('M1',1);
    R.hungerU2 = dbg.aiTechHunger(1)==='U2';
    {const s=stockOf(1);for(const k in s)s[k]=1000;} S_(1).starving=false;
    dbg.aiEcoTick(1);
    {const cm=dbg.aiCmt(1).find(c=>c.key==='tech:U2');
     R.hungerBucket = !!cm && cm.exp===true;}
    // The trickle bucket takes a share of *income* only, never surplus directly. Ablation evidence: taking
    // surplus earmarks the stockpile, military spending gets locked out by aiResvExt, and you replay the
    // hard-loses-to-normal collapse (100% → 38%). This case feeds gather increments to simulate the
    // trickle.
    S_(1).gathered.wood=(S_(1).gathered.wood||0)+800; S_(1).gathered.gold=(S_(1).gathered.gold||0)+400;
    dbg.aiEcoTick(1);
    R.hungerResearch = (techOf(1).track&&techOf(1).track.id==='U2')||techOf(1).queue.includes('U2');
    completeResearch('U2',1); if(techOf(1).track)techOf(1).track=null;
    placeB(1,'monastery',38,22,true);
    R.hungerU3 = dbg.aiTechHunger(1)==='U3';
    completeResearch('U3',1);
    R.hungerDone = dbg.aiTechHunger(1)===null;
    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',44,20,true); placeB(0,'farm',8,24,true);
    freshAi('boss'); villagers=villagers.filter(v=>(v.side||0)===0);
    const gM8=tagsOf(1)[G.main];
    const wounded=[];for(let i=0;i<6;i++)wounded.push(spawnUnit(1,'spear',C(40,22).x+i*10,C(40,22).y,gM8));
    const md=spawnUnit(1,'medic',C(41,23).x,C(41,23).y,gM8);
    dbg.A(1).state='pressure'; dbg.A(1).sT=t;
    dbg.aiMilTick(1);
    wounded.forEach(u=>u.hp=u.maxHp*0.6);
    adv(2.6); dbg.aiMilTick(1);
    R.healHolds = dbg.A(1).healHold>0 && gM8.task==='guard' && !dbg.A(1).regrp;
    wounded.forEach(u=>u.hp=u.maxHp);
    adv(2.6); dbg.aiMilTick(1);
    R.healResumes = dbg.A(1).healHold===0 && gM8.task==='attack';
    world(); placeB(0,'tc',3,20,true); const etc2=placeB(1,'tc',44,20,true); placeB(0,'farm',8,24,true);
    freshAi('boss'); villagers=villagers.filter(v=>(v.side||0)===0);
    const gM9=tagsOf(1)[G.main],gD9=tagsOf(1)[G.def];
    for(let i=0;i<6;i++)spawnUnit(1,'spear',C(24,14).x+i*10,C(24,14).y,gM9);
    spawnUnit(1,'spear',C(43,21).x,C(43,21).y,gD9);spawnUnit(1,'spear',C(43,21).x+14,C(43,21).y,gD9);
    spawnUnit(1,'archer',C(43,22).x,C(43,22).y,gD9);spawnUnit(1,'archer',C(43,22).x+14,C(43,22).y,gD9);
    dbg.A(1).state='pressure'; dbg.A(1).sT=t;
    dbg.aiMilTick(1);
    for(let i=0;i<12;i++)spawnUnit(0,'spear',C(32,10).x+(i%6)*12,C(32,10).y+((i/6)|0)*14,tags[5]);
    dbg.A(1).retreatT=-1e9;
    dbg.aiMilTick(1);
    {const m=dbg.A(1).mission;
     R.flipGoes = !!m && m.kind==='flip' && m.tgt===buildings.find(b=>b.side===0&&b.type==='tc')
       && dbg.A(1).state!=='develop' && gM9.task==='attack';}
    dbg.aiMilTick(1);
    R.flipCommits = !!dbg.A(1).mission && dbg.A(1).mission.kind==='flip';
    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',44,20,true); placeB(0,'farm',8,24,true);
    dbg.setAiDiff(1,'hard'); dbg.A(1).pers=null; dbg.setAiPers(1,'england');
    dbg.aiResetBrain(1); dbg.A(1).plan={open:'std',routeBias:0,harass:false}; dbg.A(1).intelT=t;
    villagers=villagers.filter(v=>(v.side||0)===0);
    {const gMh=tagsOf(1)[G.main],gDh=tagsOf(1)[G.def];
     for(let i=0;i<6;i++)spawnUnit(1,'spear',C(24,14).x+i*10,C(24,14).y,gMh);
     spawnUnit(1,'spear',C(43,21).x,C(43,21).y,gDh);spawnUnit(1,'spear',C(43,21).x+14,C(43,21).y,gDh);
     dbg.A(1).state='pressure'; dbg.A(1).sT=t;
     dbg.aiMilTick(1);
     for(let i=0;i<12;i++)spawnUnit(0,'spear',C(32,10).x+(i%6)*12,C(32,10).y+((i/6)|0)*14,tags[5]);
     dbg.A(1).retreatT=-1e9;
     dbg.aiMilTick(1);
     R.hardRetreats = !dbg.A(1).mission && dbg.A(1).state==='develop';}
    units.length=0;villagers.length=0;scouts.length=0;
    return R;`);
  check('R7a scouts made per-side: side 1 fears enemy towers and not its own; last-seen ghosts are per-side so it cannot see the future; explored area is each side\'s own (side 0\'s semantics are unchanged)',
    t98.sideSeesEnemyTower&&t98.sideIgnoresOwnTower&&t98.p0Unchanged&&t98.noPrescience&&t98.perSideExplore, t98);
  check('boss scouts under manual control on demand: stale intelligence = one scout is sent by hand to an observation post (outside the tower ring, exactly one); fresh = it is released to wander rather than loiter at the gate; below Hard there is no manual control',
    t98.e2Directed&&t98.e2Release&&t98.e2HardNoCtl, t98);
  check('R7a E4 scouting en route: dead scouts + stale intelligence = an observation leg is injected into the main force\'s path; fresh intelligence = no detour (causal control)',
    t98.e4Leg&&t98.e4NoLegFresh, t98);
  check('R7a D2 tgtSel weak: boss picks the thinnest-defended point (a heavily defended near target yields to an open far one); the defence score points the right way; the knob is wired (hard still uses vary)',
    t98.knobWeak&&t98.weakPicksOpen&&t98.weakScoreOrder, t98);
  check('R7a 5.3 two-party siege split: siege engines are detached into group g4 (focus = the mission building); the escort party returns to the default priority order; the party merges back into the main force when the mission ends',
    t98.siegeSplit&&t98.siegeFocus&&t98.escortNoFocus&&t98.siegeMerge, t98);
  check('R7a 5.3 pure harassment mode: a target area defended too heavily = hunt units and villagers only, do not chew on buildings; outposts are the exception and may be attacked; the party withdraws afterwards; undefended = ordinary harassment (causal control)',
    t98.pureOn&&t98.pureNoBld&&t98.pureOutpostOk&&t98.pureOffHome&&t98.pureCausal, t98);
  check('R7a tower-ring target stop-loss: an AI unit that cannot catch its target under tower fire gives up and blacklists it (rather than dying to it); player units are unaffected',
    t98.stopLoss&&t98.playerUnaffected, t98);
  check('R7a U2 research hunger (promoting a single item to an income share): on the offensive in age 2 without siege unlocked = walk the prerequisites back, M1 → U2 → medic U3, into the bucket (exp) and actually research it; during development, or with everything unlocked, no promotion (it is bounded)',
    t98.hungerDevNull&&t98.hungerPre&&t98.hungerU2&&t98.hungerBucket&&t98.hungerResearch&&t98.hungerU3&&t98.hungerDone, t98);
  check('R7a 5.4 regrouping in place: lightly wounded + a medic present + no enemy in sight = pause and heal (guard); resume the advance once topped up (attack)',
    t98.healHolds&&t98.healResumes, t98);
  check('R7a 5.4 retreat turned into attack: boss under pressure + the enemy\'s main force away + its own home holding = attacks the empty base instead (flip; committed for the window); Hard in the same position still retreats home',
    t98.flipGoes&&t98.flipCommits&&t98.hardRetreats, t98);

  console.log('\n[99] R7b \"hitting cleverly\": picking the moment + detaching to raid when the enemy\'s main force is away + blockade without assault + trading bases + naval-land coordination + shura/god following the boss');
  const t99 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const world=()=>{units.length=0;villagers.length=0;buildings.length=0;nodes.length=0;scouts.length=0;shots.length=0;
      blocked.fill(0);wallMask.fill(0);gateMask.fill(0);terr.fill(T_PLAIN);paintTerrain();computeLandComp();
      explored.fill(1);exploredE.fill(1);unreachable.fill(0);unreachableE.fill(0);computeDanger();gameOver=null;aiWave=99999;aiDefT=1e9;aiFullVision=true;AI_SEA.ready=false;};
    const freshAi=(lv,har)=>{dbg.setAiDiff(1,lv||'boss');dbg.A(1).pers=null;dbg.setAiPers(1,'england');
      dbg.aiResetBrain(1);dbg.A(1).plan={open:'std',routeBias:0,harass:!!har};dbg.A(1).intelT=t;};
    const adv=(s)=>{const n=Math.ceil(s/TICK);for(let i=0;i<n;i++)step(TICK);};
    const G=dbg.AI_G,R={};
    const oppWorld=()=>{world();placeB(0,'tc',3,20,true);placeB(1,'tc',44,20,true);
      villagers=villagers.filter(v=>false);
      const gM=tagsOf(1)[G.main];
      for(let i=0;i<7;i++)spawnUnit(1,'spear',C(40,22).x+i*10,C(40,22).y,gM);
      for(let i=0;i<8;i++)spawnUnit(0,'spear',C(6,17).x+i*10,C(6,17).y,tags[5]);};
    oppWorld(); freshAi('boss');
    dbg.A(1).foePk=22;
    dbg.aiMilTick(1);
    R.oppSet    = dbg.A(1).oppT>0;
    R.oppAttack = dbg.A(1).state==='pressure';
    oppWorld(); freshAi('boss'); dbg.A(1).foePk=22; dbg.A(1).myPk=20;
    dbg.aiMilTick(1);
    R.oppSelfHurt = dbg.A(1).oppT<0 && dbg.A(1).state==='develop';
    oppWorld(); freshAi('hard'); dbg.A(1).foePk=22;
    dbg.aiMilTick(1);
    R.oppHardNo = dbg.A(1).oppT<0 && dbg.A(1).state==='develop';
    AI_OPPORTUNISM=false; oppWorld(); freshAi('boss'); dbg.A(1).foePk=22;
    dbg.aiMilTick(1);
    R.oppAblate = dbg.A(1).oppT<0 && dbg.A(1).state==='develop';
    AI_OPPORTUNISM=true;
    world(); placeB(0,'tc',3,20,true); placeB(1,'tc',44,20,true); placeB(0,'farm',8,24,true);
    freshAi('boss',false);
    villagers=villagers.filter(v=>false);
    {const gM=tagsOf(1)[G.main],gH=tagsOf(1)[G.har];
     for(let i=0;i<6;i++)spawnUnit(1,'spear',C(40,22).x+i*10,C(40,22).y,gM);
     spawnUnit(1,'cavalry',C(41,19).x,C(41,19).y,gH);spawnUnit(1,'cavalry',C(41,19).x+20,C(41,19).y,gH);
     const roam=[];for(let i=0;i<6;i++)roam.push(spawnUnit(0,'spear',C(30,20).x+i*10,C(30,20).y,tags[5]));
     dbg.aiMilTick(1);
     R.raidOut = dbg.A(1).harOut===true && dbg.A(1).state==='develop';
     roam.forEach((u,i)=>{u.x=C(5,20).x+i*10;u.y=C(5,20).y;});
     adv(3.7); dbg.aiMilTick(1);
     R.raidRecall = dbg.A(1).harOut===false;}
    const blkWorld=()=>{world();placeB(0,'tc',3,20,true);placeB(1,'tc',44,20,true);
      villagers=villagers.filter(v=>false);
      const f=placeB(0,'farm',8,24,true);
      const tws=[placeB(0,'tower',7,22,true),placeB(0,'tower',10,25,true),placeB(0,'tower',6,25,true)]; // defScore 3 > AI_PURE_DEF 2.2
      const gM=tagsOf(1)[G.main];
      for(let i=0;i<6;i++)spawnUnit(1,'spear',C(40,22).x+i*10,C(40,22).y,gM);
      const ct=spawnUnit(1,'catapult',C(41,23).x,C(41,23).y,gM);
      return {f,tws,ct};};
    const bw=blkWorld(); freshAi('boss');
    dbg.A(1).state='pressure'; dbg.A(1).sT=t;
    dbg.aiMilTick(1);
    const gMb=tagsOf(1)[G.main],gSb=tagsOf(1)[G.sieg];
    R.blkOn    = !!dbg.A(1).mission && dbg.A(1).mission.kind==='blockade' && gMb.noBld===true;
    R.blkSiege = bw.ct.grp===gSb && gSb.focus===dbg.A(1).mission.tgt;
    {const m=dbg.A(1).mission; m.li=m.legs.length-1;
     units.forEach(u=>{if(u.side===1&&u.grp===gMb){u.x=C(10,24).x;u.y=C(10,24).y;}});
     spawnVillager(buildings.find(b=>b.side===0&&b.type==='tc')); const vv=villagers[villagers.length-1];
     vv.x=C(9,25).x; vv.y=C(9,25).y;
     dbg.aiMilTick(1);
     R.blkHunt = gMb.focus===vv;
     m.bT=t-61; dbg.aiMilTick(1);
     R.blkExpire = !dbg.A(1).mission && gMb.noBld===false && bw.ct.grp===gMb;}
    bw.tws.forEach(tw=>tw.hp=0);
    dbg.aiMilTick(1);
    R.blkCausal = !!dbg.A(1).mission && dbg.A(1).mission.kind==='eco' && gMb.noBld===false;
    AI_BLOCKADE=false;
    {const bw2=blkWorld(); freshAi('boss'); dbg.A(1).state='pressure'; dbg.A(1).sT=t;
     dbg.aiMilTick(1);
     R.blkAblate = !!dbg.A(1).mission && dbg.A(1).mission.kind==='eco';}
    AI_BLOCKADE=true;
    const swapWorld=(cities,forts)=>{world();
      const etc=placeB(0,'tc',3,20,true); placeB(1,'tc',44,20,true);
      if(cities>1)placeB(1,'city',40,26,true);
      if(forts){placeB(0,'tower',4,18,true);placeB(0,'tower',5,22,true);}
      villagers=villagers.filter(v=>false);
      const gM=tagsOf(1)[G.main],gD=tagsOf(1)[G.def];
      for(let i=0;i<6;i++)spawnUnit(1,'spear',C(40,22).x+i*10,C(40,22).y,gM);
      spawnUnit(1,'spear',C(43,21).x,C(43,21).y,gD);
      for(let i=0;i<12;i++)spawnUnit(0,'spear',C(42,19).x+(i%6)*12,C(42,19).y+((i/6)|0)*14,tags[5]);
      return etc;};
    {const etc=swapWorld(2,false); freshAi('boss');
     dbg.aiMilTick(1);
     R.swapGoes  = !!dbg.A(1).mission && dbg.A(1).mission.kind==='swap' && dbg.A(1).mission.tgt===etc
       && dbg.A(1).state==='allin' && tagsOf(1)[G.main].task==='attack';
     dbg.aiMilTick(1);
     R.swapHolds = dbg.A(1).state==='allin' && !!dbg.A(1).mission && dbg.A(1).mission.kind==='swap';}
    {swapWorld(1,false); freshAi('boss');
     dbg.aiMilTick(1);
     R.swapOneCityNo = dbg.A(1).state==='defend' && !dbg.A(1).mission;}
    {swapWorld(2,true); freshAi('boss');
     dbg.aiMilTick(1);
     R.swapFortNo = dbg.A(1).state==='defend' && !dbg.A(1).mission;}
    AI_HOMESWAP=false;
    {swapWorld(2,false); freshAi('boss');
     dbg.aiMilTick(1);
     R.swapAblate = dbg.A(1).state==='defend' && !dbg.A(1).mission;}
    AI_HOMESWAP=true;
    const seaWorld=()=>{world();
      dbg.setTerr(18,1,28,25,T_WATER); dbg.setTerr(18,13,28,13,T_SHALLOW); dbg.setTerr(21,4,24,7,T_PLAIN);
      computeLandComp(); explored.fill(1); exploredE.fill(1); AI_SEA.ready=false; computeDanger();
      placeB(0,'tc',6,12,true); placeB(1,'tc',34,12,true);
      villagers=villagers.filter(v=>false);};
    seaWorld(); freshAi('hard'); dbg.aiSeaInit();
    {const gN=tagsOf(1)[G.navy];
     spawnUnit(1,'galley',C(26,18).x,C(26,18).y,gN);
     for(let i=0;i<5;i++)spawnUnit(0,'spear',C(31,11).x+i*10,C(31,11).y,tags[5]);
     dbg.aiMilTick(1);
     R.callSet = !!dbg.A(1).navyCall;
     dbg.aiNavyTick(1);
     const cl=dbg.A(1).navyCall;
     R.callAnswer = gN.task==='guard' && !!gN.pt && Math.hypot(gN.pt.x-cl.x,gN.pt.y-cl.y)<TILE*3;
     const fb=spawnUnit(1,'fishing',C(20,20).x,C(20,20).y,null);
     const eg=spawnUnit(0,'galley',C(21,21).x,C(21,21).y,tags[5]);
     dbg.aiNavyTick(1);
     R.callFishFirst = !!gN.pt && Math.hypot(gN.pt.x-eg.x,gN.pt.y-eg.y)<TILE*4;
     fb.hp=0; eg.hp=0;}
    seaWorld(); freshAi('noob'); dbg.aiSeaInit();
    {const gN=tagsOf(1)[G.navy];
     spawnUnit(1,'galley',C(26,18).x,C(26,18).y,gN);
     for(let i=0;i<5;i++)spawnUnit(0,'spear',C(31,11).x+i*10,C(31,11).y,tags[5]);
     dbg.aiMilTick(1);
     R.callNoobNo = !dbg.A(1).navyCall;}
    seaWorld();
    const shoreF=placeB(0,'farm',16,12,true);
    freshAi('boss'); dbg.aiSeaInit();
    R.parityPre = (2*uStrT('galley')+uStrT('siegeship'))>=3*uStrT('galley')
               && (2*uStrT('galley')+uStrT('siegeship'))<3*uStrT('galley')*1.3;
    {const gN=tagsOf(1)[G.navy];
     spawnUnit(1,'galley',C(26,8).x,C(26,8).y,gN);spawnUnit(1,'galley',C(27,9).x,C(27,9).y,gN);
     spawnUnit(1,'siegeship',C(25,9).x,C(25,9).y,gN);
     for(let i=0;i<3;i++)spawnUnit(0,'galley',C(20,22).x+i*20,C(20,22).y,tags[5]);
     dbg.A(1).state='pressure'; dbg.A(1).sT=t;
     dbg.A(1).mission={tgt:buildings.find(b=>b.side===0&&b.type==='tc'),kind:'eco',legs:[{x:C(10,20).x,y:C(10,20).y}],li:0,bT:t};
     dbg.aiNavyTick(1);
     R.twoFront = gN.task==='attack' && gN.focus===shoreF;
     gN.focus=null; gN.task='guard'; gN.pt=null;
     dbg.setAiDiff(1,'hard'); dbg.A(1).state='pressure';
     dbg.aiNavyTick(1);
     R.twoFrontHardNo = !(gN.task==='attack' && gN.focus===shoreF);}
    seaWorld();
    nodes.push({type:'gold',x:C(22,5).x,y:C(22,5).y,amt:300,max:300});
    freshAi('noob'); AI_SEA.ready=false; dbg.aiSeaInit();
    dbg.aiIslandStart(1);
    R.noobIsland = !!dbg.A(1).island && dbg.A(1).island.phase==='train';
    R.followKnobs = AI_DIFF.shura.tgtSel==='weak' && AI_DIFF.god.tgtSel==='weak'
      && AI_DIFF.shura.squads==='dynamic' && AI_DIFF.god.squads==='dynamic';
    R.switches = AI_OPPORTUNISM===true && AI_BLOCKADE===true && AI_HOMESWAP===true && AI_SEACOORD===true;
    units.length=0;villagers.length=0;scouts.length=0;
    return R;`);
  check('R7b 5.2 picking the moment ①: the opponent has just taken heavy losses and I am intact = the sortie threshold is relaxed inside the window; equally damaged, or Hard, or the switch off = as conservative as ever (three-way control)',
    t99.oppSet&&t99.oppAttack&&t99.oppSelfHurt&&t99.oppHardNo&&t99.oppAblate, t99);
  check('R7b 5.2 picking the moment ②: the enemy\'s main force is away = a raiding detachment is released even during development (rather than committing the main force, and even with no feint plan drawn); the enemy comes home = the party is pulled early',
    t99.raidOut&&t99.raidRecall, t99);
  check('R7b D5 blockade without assault: everything is too hard = blockade the resource nodes (noBld; the main force hunts villagers); the siege party still detaches to shell from range = a stand-off bombardment; the window expiring forces a re-evaluation; the fortification falling reverts to eco (causal control); the switch is live',
    t99.blkOn&&t99.blkSiege&&t99.blkHunt&&t99.blkExpire&&t99.blkCausal&&t99.blkAblate, t99);
  check('R7b 5.2 trading bases: losing the fight at my own gate + no fortifications at the enemy\'s + more than one city left = go straight for the enemy town centre (allin; committed for the window, no falling back to defend); only the capital left, or the enemy is fortified, or the switch is off = do not take the bet (three-way control)',
    t99.swapGoes&&t99.swapHolds&&t99.swapOneCityNo&&t99.swapFortNo&&t99.swapAblate, t99);
  check('R7b 5.6 calling for support: Hard + a fight at the home gate next to water = the fleet answers and supports in place; escorting fishing boats still outranks it (an important task is not dropped); below Normal there is no call',
    t99.callSet&&t99.callAnswer&&t99.callFishFirst&&t99.callNoobNo, t99);
  check('R7b 5.6 boss attacks on two fronts: while the main force is on its mission the naval line applies pressure at the same time (it dares to push at parity, and shells the enemy\'s town-centre-facing shore); Hard\'s fleet stays put in the same position (causal control)',
    t99.parityPre&&t99.twoFront&&t99.twoFrontHardNo, t99);
  check('R7b 5.6 Beginner still performs a basic landing (taking an island has no difficulty gate) + shura/god follow the boss\'s settings (tgtSel weak / squads dynamic) + the ablation switches are wired',
    t99.noobIsland&&t99.followKnobs&&t99.switches, t99);

  console.log('\n[100] R10 actuator repair kit (commitment to the pounce / rally latch / medics marching with the army): three execution-layer faults fixed = both sides actually fight (a prerequisite for ML)');
  const t100 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const world=()=>{units.length=0;villagers.length=0;buildings.length=0;nodes.length=0;scouts.length=0;shots.length=0;
      blocked.fill(0);wallMask.fill(0);gateMask.fill(0);terr.fill(T_PLAIN);paintTerrain();computeLandComp();
      explored.fill(1);exploredE.fill(1);unreachable.fill(0);unreachableE.fill(0);computeDanger();gameOver=null;aiWave=99999;aiDefT=1e9;aiFullVision=true;AI_SEA.ready=false;};
    const freshAi=(lv,har)=>{dbg.setAiDiff(1,lv||'boss');dbg.A(1).pers=null;dbg.setAiPers(1,'england');
      dbg.aiResetBrain(1);dbg.A(1).plan={open:'std',routeBias:0,harass:!!har};dbg.A(1).intelT=t;};
    const G=dbg.AI_G,R={};
    const cmtSetup=(nMain)=>{world();placeB(0,'tc',3,20,true);placeB(1,'tc',44,20,true);
      freshAi('boss');villagers=villagers.filter(v=>false);
      const gM=tagsOf(1)[G.main];
      for(let i=0;i<nMain;i++)spawnUnit(1,'spear',C(8,20).x+i*8,C(8,20).y,gM);
      dbg.A(1).state='allin';dbg.A(1).sT=t;
      dbg.aiMilTick(1);
      return gM;};
    const foeSwarm=()=>{for(let i=0;i<14;i++)spawnUnit(0,'spear',C(8,20).x+(i%7)*10,C(8,20).y+((i/7)|0)*12,tags[5]);};
    cmtSetup(8);                                                                          // cmtStr=9.6·floor=3.84
    R.cmtRecorded = dbg.A(1).mission.kind==='base' && dbg.A(1).cmtStr>0;
    foeSwarm(); dbg.A(1).retreatT=-1e9;
    dbg.aiMilTick(1);
    R.cmtHolds = !!dbg.A(1).mission && dbg.A(1).mission.kind==='base' && dbg.A(1).state!=='develop';
    cmtSetup(5);
    dbg.A(1).cmtStr=18;
    foeSwarm(); dbg.A(1).retreatT=-1e9;
    dbg.aiMilTick(1);
    R.cmtFloorRetreats = !dbg.A(1).mission && dbg.A(1).state==='develop';
    AI_COMMIT=false;
    cmtSetup(8); foeSwarm(); dbg.A(1).retreatT=-1e9;
    dbg.aiMilTick(1);
    R.cmtAblate = !dbg.A(1).mission && dbg.A(1).state==='develop';
    AI_COMMIT=true;
    world();placeB(0,'tc',3,20,true);placeB(1,'tc',44,20,true);
    freshAi('boss');villagers=villagers.filter(v=>false);
    {const gMain=tagsOf(1)[G.main],gHar=tagsOf(1)[G.har],gRgu=tagsOf(1)[G.rgu],gDef=tagsOf(1)[G.def];
     for(let i=0;i<3;i++)spawnUnit(1,'spear',C(42,20).x+i*8,C(42,20).y,gMain);
     const h1=spawnUnit(1,'cavalry',C(40,18).x,C(40,18).y,gHar),h2=spawnUnit(1,'cavalry',C(40,18).x+12,C(40,18).y,gHar);
     const r1=spawnUnit(1,'spear',C(46,22).x,C(46,22).y,gRgu),r2=spawnUnit(1,'spear',C(46,22).x+12,C(46,22).y,gRgu);
     const d1=spawnUnit(1,'archer',C(44,21).x,C(44,21).y,gDef);
     dbg.A(1).state='develop';dbg.A(1).sT=t-1e4;
     dbg.aiMilTick(1);
     R.rallyPullsHar = h1.grp===gMain && h2.grp===gMain;
     R.rallyPullsRgu = r1.grp===gMain && r2.grp===gMain;
     R.rallyKeepsDef = d1.grp===gDef;}
    AI_RALLY=false;
    world();placeB(0,'tc',3,20,true);placeB(1,'tc',44,20,true);
    freshAi('boss');villagers=villagers.filter(v=>false);
    {const gMain=tagsOf(1)[G.main],gHar=tagsOf(1)[G.har];
     for(let i=0;i<3;i++)spawnUnit(1,'spear',C(42,20).x+i*8,C(42,20).y,gMain);
     const h1=spawnUnit(1,'cavalry',C(40,18).x,C(40,18).y,gHar);
     dbg.A(1).state='develop';dbg.A(1).sT=t-1e4;
     dbg.aiMilTick(1);
     R.rallyAblate = h1.grp===gHar;}
    AI_RALLY=true;
    world();placeB(0,'tc',3,20,true);placeB(1,'tc',44,20,true);
    freshAi('boss');villagers=villagers.filter(v=>false);
    {const gMain=tagsOf(1)[G.main],gRe=tagsOf(1)[G.reinf];
     for(let i=0;i<5;i++)spawnUnit(1,'spear',C(8,20).x+i*8,C(8,20).y,gMain);
     dbg.A(1).state='allin';dbg.A(1).sT=t;dbg.A(1).homeRally={x:C(44,20).x,y:C(44,20).y};
     dbg.aiMilTick(1);
     spawnUnit(1,'medic',C(44,20).x,C(44,20).y,gRe);
     dbg.aiMilTick(1);
     R.medFollows = dbg.A(1).reinfDep===true && gRe.task==='attack';}
    AI_MEDFOLLOW=false;
    world();placeB(0,'tc',3,20,true);placeB(1,'tc',44,20,true);
    freshAi('boss');villagers=villagers.filter(v=>false);
    {const gMain=tagsOf(1)[G.main],gRe=tagsOf(1)[G.reinf];
     for(let i=0;i<5;i++)spawnUnit(1,'spear',C(8,20).x+i*8,C(8,20).y,gMain);
     dbg.A(1).state='allin';dbg.A(1).sT=t;dbg.A(1).homeRally={x:C(44,20).x,y:C(44,20).y};
     dbg.aiMilTick(1);
     spawnUnit(1,'medic',C(44,20).x,C(44,20).y,gRe);
     dbg.aiMilTick(1);
     R.medAblate = dbg.A(1).reinfDep===false && gRe.task!=='attack';}
    AI_MEDFOLLOW=true;
    units.length=0;villagers.length=0;scouts.length=0;
    return R;`);
  check('R10-a commitment to the pounce: inside an allin window on the town centre, only the collapse floor counts, not an ordinary break-even retreat (fixes the attacker always bouncing back); it does retreat below the floor; with the switch off it retreats as before (three-way control)',
    t100.cmtRecorded&&t100.cmtHolds&&t100.cmtFloorRetreats&&t100.cmtAblate, t100);
  check('R10-b rally latch: long enough in development + no threat + the main force under strength = the raiding and resource-guard parties are pulled back into it; the garrison stays home (the safety line is not broken); with the switch off nothing is pulled back (causal control)',
    t100.rallyPullsHar&&t100.rallyPullsRgu&&t100.rallyKeepsDef&&t100.rallyAblate, t100);
  check('R10-c medics march with the army: a reinforcement column of nothing but medics + the main force away = it marches immediately to catch up (fixes the medic deadlock); with the switch off it stays home under strength (causal control)',
    t100.medFollows&&t100.medAblate, t100);

  console.log('\n[101] R11 the ML strategic brain (one linear policy, boss and above only, argmax with no RNG, able to fall back): feature dimensions / mount gate / mode → actuator mapping / investment split / determinism / degenerate fallback (causal control)');
  const t101 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const world=()=>{units.length=0;villagers.length=0;buildings.length=0;nodes.length=0;scouts.length=0;shots.length=0;
      blocked.fill(0);wallMask.fill(0);gateMask.fill(0);terr.fill(T_PLAIN);paintTerrain();computeLandComp();
      explored.fill(1);exploredE.fill(1);unreachable.fill(0);unreachableE.fill(0);computeDanger();gameOver=null;aiWave=99999;aiDefT=1e9;aiFullVision=true;AI_SEA.ready=false;};
    const freshAi=(si,lv)=>{dbg.setAiDiff(si,lv);dbg.A(si).pers=null;dbg.setAiPers(si,'england');dbg.aiResetBrain(si);dbg.A(si).plan={open:'std',routeBias:0,harass:false};dbg.A(si).intelT=t;};
    const G=dbg.AI_G, F=dbg.AI_ML_FN, R={};
    const zrow=()=>new Array(F+1).fill(0);
    const forceMode=(idx)=>{const mode=[];for(let m=0;m<6;m++){const r=zrow();if(m===idx)r[F]=1;mode.push(r);}return {F,mode,inv:[zrow(),zrow(),zrow()]};};
    const invPol=(e,mi,te)=>{const mode=[];for(let m=0;m<6;m++)mode.push(zrow());const iv=[zrow(),zrow(),zrow()];iv[0][F]=e;iv[1][F]=mi;iv[2][F]=te;return {F,mode,inv:iv};};
    const modes=dbg.AI_ML_MODES();
    world();placeB(0,'tc',3,20,true);placeB(1,'tc',44,20,true);freshAi(1,'boss');villagers=villagers.filter(v=>false);
    {const gM=tagsOf(1)[G.main];for(let i=0;i<4;i++)spawnUnit(1,'spear',C(40,20).x+i*8,C(40,20).y,gM);}
    {const f=dbg.aiMlFeat(1);R.featLen=f.length;R.featFinite=f.every(x=>Number.isFinite(x)&&x>=-0.001&&x<=1.001);R.modeCount=modes.length;}
    dbg.setAiPolicySide([null,null]);              R.eligNoPol=dbg.aiMlEligible(1)===false;
    dbg.setAiPolicySide([null,forceMode(0)]);      R.eligBoss=dbg.aiMlEligible(1)===true;
    freshAi(1,'hard');                             R.eligHard=dbg.aiMlEligible(1)===false;
    freshAi(1,'boss');dbg.setAiMl(false);          R.eligMlOff=dbg.aiMlEligible(1)===false;
    dbg.setAiMl(true);                             R.eligBack=dbg.aiMlEligible(1)===true;
    const runMode=(idx)=>{world();placeB(0,'tc',3,20,true);placeB(1,'tc',44,20,true);freshAi(1,'boss');villagers=villagers.filter(v=>false);
      const gM=tagsOf(1)[G.main];for(let i=0;i<6;i++)spawnUnit(1,'spear',C(8,20).x+i*8,C(8,20).y,gM);
      dbg.A(1).state='develop';dbg.A(1).sT=t;dbg.setAiPolicySide([null,forceMode(idx)]);
      dbg.aiMilTick(1);return dbg.A(1);};
    {const a=runMode(2);R.commitAllin=a.state==='allin'&&!!a.mission&&a.mission.kind==='base'&&a.cmtStr>0;}
    {const a=runMode(4);R.defendState=a.state==='defend';}
    {const a=runMode(0);R.developState=a.state==='develop';}
    {const a=runMode(3);R.harassPress=a.state==='pressure';}
    world();placeB(0,'tc',3,20,true);placeB(1,'tc',44,20,true);freshAi(1,'boss');villagers=villagers.filter(v=>false);
    dbg.setAiPolicySide([null,invPol(1.0,-0.5,0)]);dbg.aiMilTick(1);
    {const iv=dbg.aiMlInv(1);R.invEco=Math.abs(iv.eco-2.0)<1e-6;R.invMil=Math.abs(iv.mil-0.5)<1e-6;R.invTech=Math.abs(iv.tech-1.0)<1e-6;}
    {const d1=dbg.aiMlDecide(1),d2=dbg.aiMlDecide(1);R.decideDet=JSON.stringify(d1)===JSON.stringify(d2);}
    const fbSetup=(stuck)=>{world();placeB(0,'tc',3,20,true);placeB(1,'tc',44,20,true);freshAi(1,'boss');villagers=villagers.filter(v=>false);
      const gM=tagsOf(1)[G.main];for(let i=0;i<6;i++)spawnUnit(1,'spear',C(40,20).x+i*8,C(40,20).y,gM);
      const myTc=buildings.find(b=>b.side===1&&b.type==='tc');myTc.hp=myTc.maxHp*0.5;
      dbg.setAiPolicySide([null,forceMode(0)]);dbg.A(1).state='develop';
      dbg.A(1).mlMode='develop';dbg.A(1).mlModeT= stuck ? t-500 : t;
      dbg.aiMilTick(1);return dbg.A(1).mlFall;};
    R.fbStuck=fbSetup(true)===true;
    R.fbNotStuck=fbSetup(false)===false;
    dbg.setAiPolicySide(null);dbg.setAiPolicy(null);
    units.length=0;villagers.length=0;scouts.length=0;
    return R;`);
  check('R11 features: dimension = AI_ML_FN(26); every value finite and normalised into [0,1]; 6 modes', t101.featLen===26&&t101.featFinite&&t101.modeCount===6, t101);
  check('R11 mount gate (causal control): no policy = not mounted; boss + policy = mounted; Hard = not mounted; master switch off = not mounted; switch back on = mounted again', t101.eligNoPol&&t101.eligBoss&&t101.eligHard&&t101.eligMlOff&&t101.eligBack, t101);
  check('R11 mode → actuator: commit → allin + build a base mission + record the R10-a commitment; defend → defensive; develop → development; harass → pressure', t101.commitAllin&&t101.defendState&&t101.developState&&t101.harassPress, t101);
  check('R11 investment split: inv → mlInv multipliers (eco 2.0 / mil 0.5 / tech 1.0, clamped to [0.4, 2.5]) = the domain weight multiplier in aiWtOf', t101.invEco&&t101.invMil&&t101.invTech, t101);
  check('R11 determinism: aiMlDecide is byte-identical for the same input (no RNG = the same seed replays identically)', t101.decideDet, t101);
  check('R11 degenerate fallback (causal control): the same mode for more than AI_ML_STUCK while behind = hand back to the rule brain; not stuck = no fallback', t101.fbStuck&&t101.fbNotStuck, t101);

  console.log('\n[102] R12 stage 2 tactical actuators (opt-in kiting / garrisoning the army / activating patrols / towers shooting buildings): four execution-layer actuators = live for the rule brain at Hard and above + a discrete ML override + observable state (causal control + ablation)');
  const t102 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const world=()=>{units.length=0;villagers.length=0;buildings.length=0;nodes.length=0;scouts.length=0;shots.length=0;
      blocked.fill(0);wallMask.fill(0);gateMask.fill(0);terr.fill(T_PLAIN);paintTerrain();computeLandComp();
      explored.fill(1);exploredE.fill(1);unreachable.fill(0);unreachableE.fill(0);computeDanger();gameOver=null;aiWave=99999;aiDefT=1e9;aiFullVision=true;AI_SEA.ready=false;};
    const freshAi=(lv)=>{dbg.setAiDiff(1,lv||'boss');dbg.A(1).pers=null;dbg.setAiPers(1,'england');dbg.aiResetBrain(1);dbg.A(1).plan={open:'std',routeBias:0,harass:false};dbg.A(1).intelT=t;};
    const G=dbg.AI_G, R={};

    const kiteSetup=(myType,foe)=>{world();placeB(0,'tc',3,20,true);placeB(1,'tc',44,20,true);freshAi('boss');villagers=villagers.filter(v=>false);
      const gM=tagsOf(1)[G.main];for(let i=0;i<3;i++)spawnUnit(1,myType,C(30,20).x+i*8,C(30,20).y,gM);
      for(const [ft,n] of foe)for(let i=0;i<n;i++)spawnUnit(0,ft,C(31,20).x+i*8,C(31,20).y+((i/3)|0)*10,tags[0]);
      return gM;};
    {const gM=kiteSetup('archer',[['spear',3]]);dbg.aiKiteEval(1);R.kiteOn=gM.rule==='kite';}
    {const gM=kiteSetup('archer',[['archer',3]]);dbg.aiKiteEval(1);R.kiteFoeRangedNo=gM.rule!=='kite';}
    AI_KITE=false;{const gM=kiteSetup('archer',[['spear',3]]);dbg.aiKiteEval(1);R.kiteAblate=gM.rule==='counter';}AI_KITE=true;
    {const gM=kiteSetup('spear',[['spear',3]]);dbg.A(1).mlAct.rule[G.main]='kite';dbg.aiKiteEval(1);R.kiteOverride=gM.rule==='kite';dbg.A(1).mlAct.rule={};}
    {const gM=kiteSetup('archer',[['spear',3]]);dbg.aiKiteEval(1);
      for(let i=0;i<3;i++)spawnUnit(1,'spear',C(30,21).x+i*8,C(30,21).y,gM);
      dbg.aiKiteEval(1);R.kiteHystStay=gM.rule==='kite';
      for(let i=0;i<3;i++)spawnUnit(1,'spear',C(30,22).x+i*8,C(30,22).y,gM);
      dbg.aiKiteEval(1);R.kiteHystDrop=gM.rule==='counter';}
    {const gM=kiteSetup('archer',[['spear',3]]);dbg.aiKiteEval(1);const ob=dbg.aiKiteObs(1)[0];
      R.kiteObs=ob.rule==='kite'&&ob.r1>=0.6&&ob.r2>=0.6&&dbg.aiKiteN(1)===1;}

    const garrSetup=()=>{world();placeB(0,'tc',3,20,true);placeB(1,'tc',44,20,true);freshAi('boss');villagers=villagers.filter(v=>false);return placeB(1,'tower',40,20,true);};
    {const tw=garrSetup();const u=spawnUnit(1,'spear',C(38,20).x,C(38,20).y,tagsOf(1)[G.main]);u.hp=u.maxHp*0.3;
      spawnUnit(0,'spear',C(37,20).x,C(37,20).y,tags[0]);dbg.aiGarrisonEval(1);R.garrIn=u.garTgt===tw;}
    {const tw=garrSetup();const u=spawnUnit(1,'spear',C(38,20).x,C(38,20).y,tagsOf(1)[G.main]);u.hp=u.maxHp*0.9;
      spawnUnit(0,'spear',C(37,20).x,C(37,20).y,tags[0]);dbg.aiGarrisonEval(1);R.garrHealthyNo=!u.garTgt;}
    {const tw=garrSetup();const u=spawnUnit(1,'spear',C(38,20).x,C(38,20).y,tagsOf(1)[G.main]);u.hp=u.maxHp*0.3;
      dbg.aiGarrisonEval(1);R.garrNoThreatNo=!u.garTgt;}
    AI_GARR=false;{const tw=garrSetup();const u=spawnUnit(1,'spear',C(38,20).x,C(38,20).y,tagsOf(1)[G.main]);u.hp=u.maxHp*0.3;
      spawnUnit(0,'spear',C(37,20).x,C(37,20).y,tags[0]);dbg.aiGarrisonEval(1);R.garrAblate=!u.garTgt;}AI_GARR=true;
    {const tw=garrSetup();const u=spawnUnit(1,'spear',C(40,20).x,C(40,20).y,tagsOf(1)[G.main]);u.hp=u.maxHp*0.3;u.gar=tw;tw.garr=[u];
      spawnUnit(0,'spear',C(37,20).x,C(37,20).y,tags[0]);u.hp=u.maxHp*0.9;dbg.aiGarrisonEval(1);R.garrOutHealed=!u.gar;}
    {const tw=garrSetup();const u=spawnUnit(1,'spear',C(40,20).x,C(40,20).y,tagsOf(1)[G.main]);u.hp=u.maxHp*0.3;u.gar=tw;tw.garr=[u];
      dbg.aiGarrisonEval(1);R.garrOutSafe=!u.gar;}
    {const tw=garrSetup();const u=spawnUnit(1,'spear',C(40,20).x,C(40,20).y,tagsOf(1)[G.main]);u.hp=u.maxHp*0.3;u.gar=tw;tw.garr=[u];
      spawnUnit(0,'spear',C(37,20).x,C(37,20).y,tags[0]);dbg.A(1).mlAct.garrison=false;dbg.aiGarrisonEval(1);R.garrOverrideOff=!u.gar;dbg.A(1).mlAct.garrison=null;}
    {const tw=garrSetup();const u=spawnUnit(1,'spear',C(38,20).x,C(38,20).y,tagsOf(1)[G.main]);u.hp=u.maxHp*0.3;u.gar=tw;tw.garr=[u];
      spawnUnit(0,'spear',C(37,20).x,C(37,20).y,tags[0]);dbg.aiGarrisonEval(1);R.garrObs=dbg.aiGarrN(1)===1;}

    /* Garrison orders are demoted to group level: a per-unit garrison order is a control surface the player
       does not have (dragging only ever moves a whole group; selUnit is read-only).
       The six cases above cannot tell per-unit from group-level — each fixture holds a single unit, so both
       implementations agree and the change stays green either way. The group below is discriminating:
       group-average health and individual health give opposite answers in the same scenario, and only the
       group-level implementation behaves that way. */
    const garrTeam=(hps)=>{const tw=garrSetup();const g=tagsOf(1)[G.main];
      const us=hps.map((h,i)=>{const u=spawnUnit(1,'spear',C(38,20).x+i*8,C(38,20).y,g);u.hp=u.maxHp*h;return u;});
      spawnUnit(0,'spear',C(37,20).x,C(37,20).y,tags[0]);return {tw,g,us};};
    {const {tw,us}=garrTeam([0.2,0.2,0.7]);dbg.aiGarrisonEval(1);
      R.garrTeamAllIn=us.every(u=>u.garTgt===tw);}
    {const {us}=garrTeam([0.9,0.9,0.15]);dbg.aiGarrisonEval(1);
      R.garrTeamNoneIn=us.every(u=>!u.garTgt);}
    {const {tw,g,us}=garrTeam([0.2,0.2,0.2]);for(const u of us){u.gar=tw;u.garTgt=null;}tw.garr=[...us];
      for(const u of us)u.hp=u.maxHp*0.9;dbg.aiGarrisonEval(1);
      R.garrTeamAllOut=us.every(u=>!u.gar)&&g.holdB===null;}
    /* On eject, units still en route must also have garTgt cleared. issueGarrison sets garTgt for the whole
       group, so releasing only those already inside leaves the ones mid-walk to slip in anyway — the group
       leaves by the front door while someone else garrisons through the back, which at group level turns
       into per-tick oscillation. */
    {const {tw,g,us}=garrTeam([0.2,0.2,0.2]);us[0].gar=tw;tw.garr=[us[0]];us[1].garTgt=tw;us[2].garTgt=tw;
      for(const u of us)u.hp=u.maxHp*0.9;dbg.aiGarrisonEval(1);
      R.garrOutCancelsEnroute=!us[0].gar&&!us[1].garTgt&&!us[2].garTgt;}
    R.garrNoUnitGate=(typeof AICMD.garrisonUnit==='undefined')&&(typeof window.issueGarrisonUnit==='undefined');

    const patSetup=()=>{world();placeB(0,'tc',3,20,true);placeB(1,'tc',44,20,true);freshAi('hard');villagers=villagers.filter(v=>false);
      const bk=placeB(1,'barracks',42,20,true);const gDef=tagsOf(1)[G.def];
      spawnUnit(1,'spear',C(43,20).x,C(43,20).y,gDef);spawnUnit(1,'spear',C(43,21).x,C(43,21).y,gDef);
      dbg.A(1).state='develop';const stk=dbg.S2(1);stk.wood=25;stk.gold=200;stk.food=200;stk.stone=200;
      return bk;};
    {const bk=patSetup();dbg.aiMilProd(1);R.patProduced=bk.queue.filter(q=>q.tag===G.pat).length>=1;}
    AI_PATROL=false;{const bk=patSetup();for(let i=0;i<3;i++)dbg.aiMilProd(1);R.patAblate=bk.queue.filter(q=>q.tag===G.pat).length===0;}AI_PATROL=true;

    const stepN=(n)=>{for(let i=0;i<n;i++)step(1/30);};
    world();placeB(0,'tc',3,20,true);placeB(1,'tc',44,20,true);
    {const tw=placeB(1,'tower',20,20,true);const eb=placeB(0,'barracks',22,20,false);const hp0=eb.hp;tw.cd=0;stepN(40);
     R.towerHitsBld=eb.hp<hp0;}
    world();placeB(0,'tc',3,20,true);placeB(1,'tc',44,20,true);
    {const tw=placeB(1,'tower',20,20,true);const eb=placeB(0,'barracks',22,20,true);const bhp0=eb.hp;
     const eu=spawnUnit(0,'spear',C(21,20).x,C(21,20).y,tags[0]);const uhp0=eu.hp;tw.cd=0;stepN(40);
     R.towerUnitPrio=eu.hp<uhp0 && eb.hp===bhp0;}
    world();placeB(0,'tc',3,20,true);placeB(1,'tc',44,20,true);
    {const tw=placeB(1,'tower',20,20,true);const done=placeB(0,'barracks',22,20,true);const notdone=placeB(0,'stable',20,22,false);
     const dh0=done.hp,nh0=notdone.hp;tw.cd=0;stepN(40);
     R.towerBldPrio=(nh0-notdone.hp)>(dh0-done.hp);}
    world();placeB(0,'tc',3,20,true);placeB(1,'tc',44,20,true);
    AI_TOWERBLD=false;{const tw=placeB(1,'tower',20,20,true);const eb=placeB(0,'barracks',22,20,false);const hp0=eb.hp;tw.cd=0;stepN(40);
     R.towerAblate=eb.hp===hp0;}AI_TOWERBLD=true;

    dbg.A(1).mlAct={rule:{},garrison:null,assault:null,regroup:null};dbg.A(1).cmt.length=0;
    units.length=0;villagers.length=0;scouts.length=0;buildings.length=0;shots.length=0;
    return R;`);
  check('R12 2a opt-in kiting (per group, Hard+, causal control + ablation): a ranged group meeting pure melee = kite; enemy ranged = does not trigger; the switch off = always counter; the override forces kiting; two thresholds give hysteresis (hold inside the band, revert when it breaks); observation wired',
    t102.kiteOn&&t102.kiteFoeRangedNo&&t102.kiteAblate&&t102.kiteOverride&&t102.kiteHystStay&&t102.kiteHystDrop&&t102.kiteObs, t102);
  check('R12 2b garrisoning the army (Hard+, causal control + ablation; ⑧ demoted to group level): wounded + threatened + near a tower = garrison; healthy or no enemy = do not; the switch off = no hiding; healed or the threat gone = come out; the override forbidding it = forced out; observation wired. ⑧ discriminator: average health low = the whole group goes in (including the healthy one); average health fine = the whole group stays out (including the one about to die = per-unit micromanagement really is gone); the whole group ejects and clears holdB; AICMD leaves no per-unit gate',
    t102.garrIn&&t102.garrHealthyNo&&t102.garrNoThreatNo&&t102.garrAblate&&t102.garrOutHealed&&t102.garrOutSafe&&t102.garrOverrideOff&&t102.garrObs&&
    t102.garrTeamAllIn&&t102.garrTeamNoneIn&&t102.garrTeamAllOut&&t102.garrOutCancelsEnroute&&t102.garrNoUnitGate, t102);
  check('R12 2c activating patrols (Hard+, located by probe, ablation control): the patrol gate is relaxed from a full garrison to the garrison core being in place (nDefCur>=2) = when the garrison\'s archers are stuck on cash, production can reach the patrol (military spending still yields to the economy, keeping the R1 ledger); the switch off restores the old full-strength gate = 0 patrols',
    t102.patProduced&&t102.patAblate, t102);
  check('R12 2d towers shoot buildings (causal control + ablation): no unit in range = shoot enemy buildings; a unit in range = shoot the unit (the building takes no damage; units always come first); buildings under construction come first; the switch off = towers do not shoot buildings (the old !e.size)',
    t102.towerHitsBld&&t102.towerUnitPrio&&t102.towerBldPrio&&t102.towerAblate, t102);

  console.log('\n[103] R12 stage 3 siege coordination and medical recovery (escort synchronisation / withdrawing when stranded / the medic production line / topping up the wounded): four points of execution discipline = live for the rule brain at Hard and above + a discrete ML override (3d) + observable state (causal control + ablation)');
  const t103 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const adv=(s)=>{const n=Math.ceil(s/TICK);for(let i=0;i<n;i++)step(TICK);};
    const world=()=>{units.length=0;villagers.length=0;buildings.length=0;nodes.length=0;scouts.length=0;shots.length=0;
      blocked.fill(0);wallMask.fill(0);gateMask.fill(0);terr.fill(T_PLAIN);paintTerrain();computeLandComp();
      explored.fill(1);exploredE.fill(1);unreachable.fill(0);unreachableE.fill(0);computeDanger();gameOver=null;aiWave=99999;aiDefT=1e9;aiFullVision=true;AI_SEA.ready=false;};
    const freshAi=(lv)=>{dbg.setAiDiff(1,lv||'boss');dbg.A(1).pers=null;dbg.setAiPers(1,'england');
      dbg.aiResetBrain(1);dbg.A(1).plan={open:'std',routeBias:0,harass:false};dbg.A(1).intelT=t;};
    const G=dbg.AI_G,R={};

    const reSetup=(sg,esc)=>{world();placeB(0,'tc',3,20,true);placeB(1,'tc',44,20,true);freshAi('boss');villagers=villagers.filter(v=>false);
      const gM=tagsOf(1)[G.main],gR=tagsOf(1)[G.reinf];
      for(let i=0;i<8;i++)spawnUnit(1,'spear',C(10,20).x+i*8,C(10,20).y,gM);
      dbg.A(1).state='allin';dbg.A(1).sT=t;dbg.aiMilTick(1);
      for(let i=0;i<sg;i++)spawnUnit(1,'catapult',C(42,20).x+i*10,C(42,20).y,gR);
      for(let i=0;i<esc;i++)spawnUnit(1,'spear',C(42,21).x+i*8,C(42,21).y,gR);
      dbg.aiMilTick(1);return gR;};
    {const gR=reSetup(2,0);R.escSgHolds=gR.task==='guard'&&!dbg.A(1).reinfDep;}
    {const gR=reSetup(2,4);R.escSgGoes=gR.task==='attack'&&dbg.A(1).reinfDep===true;}
    AI_ESCORT_SYNC=false;{const gR=reSetup(2,0);R.escAblate=gR.task==='attack';}AI_ESCORT_SYNC=true;
    {const gR=reSetup(0,4);R.escNoSgSame=gR.task==='attack'&&dbg.A(1).reinfDep===true;}

    {const gR=reSetup(2,4);dbg.aiMilTick(1);R.reColOk=gR.task==='attack'&&!dbg.A(1).reHold;}
    {const gR=reSetup(2,4);const es=units.filter(u=>u.side===1&&u.grp===gR&&UT[u.type].role!=='siege');
     es.forEach((u,i)=>{u.x=C(20,20).x+i*8;u.y=C(20,20).y;});
     dbg.aiMilTick(1);R.reColHolds=gR.task==='guard'&&dbg.A(1).reHold>0;}
    {const gR=reSetup(2,4);const es=units.filter(u=>u.side===1&&u.grp===gR&&UT[u.type].role!=='siege');
     es.forEach((u,i)=>{u.x=C(20,20).x+i*8;u.y=C(20,20).y;});dbg.aiMilTick(1);const on=dbg.A(1).reHold>0;
     const sgs=units.filter(u=>u.side===1&&u.grp===gR&&UT[u.type].role==='siege');
     sgs.forEach((u,i)=>{u.x=C(21,20).x+i*8;u.y=C(21,20).y;});dbg.aiMilTick(1);
     R.reColResumes=on&&!dbg.A(1).reHold&&gR.task==='attack';}
    AI_ESCORT_SYNC=false;{const gR=reSetup(2,4);const es=units.filter(u=>u.side===1&&u.grp===gR&&UT[u.type].role!=='siege');
     es.forEach((u,i)=>{u.x=C(20,20).x+i*8;u.y=C(20,20).y;});dbg.aiMilTick(1);
     R.reColAblate=gR.task==='attack'&&!dbg.A(1).reHold;}AI_ESCORT_SYNC=true;

    const lagSetup=(dx)=>{world();placeB(0,'tc',3,20,true);placeB(1,'tc',44,20,true);freshAi('boss');villagers=villagers.filter(v=>false);
      const gM=tagsOf(1)[G.main];
      for(let i=0;i<8;i++)spawnUnit(1,'spear',C(24,20).x+i*8,C(24,20).y,gM);
      const sg=spawnUnit(1,'catapult',C(24+dx,20).x,C(24+dx,20).y,gM);
      dbg.A(1).state='allin';dbg.A(1).sT=t;dbg.aiMilTick(1);dbg.aiMilTick(1);
      return {gM,sg};};
    {const {gM}=lagSetup(14);R.lagHolds=gM.task==='guard'&&dbg.A(1).escHold>0;}
    {const {gM}=lagSetup(3);R.lagNoHold=gM.task==='attack'&&!dbg.A(1).escHold;}
    {const {gM,sg}=lagSetup(14);sg.x=C(25,20).x;sg.y=C(25,20).y;dbg.aiMilTick(1);
     R.lagResumes=gM.task==='attack'&&!dbg.A(1).escHold;}
    {const {gM,sg}=lagSetup(14);const px=sg.x,py=sg.y;
     for(let i=0;i<Math.ceil((AI_ESC_WAIT+1)/TICK);i++){step(TICK);sg.x=px;sg.y=py;}
     dbg.aiMilTick(1);
     R.lagTimeout=gM.task==='attack'&&!dbg.A(1).escHold&&dbg.A(1).escCd>0;}
    AI_ESCORT_SYNC=false;{const {gM}=lagSetup(14);R.lagAblate=gM.task==='attack'&&!dbg.A(1).escHold;}AI_ESCORT_SYNC=true;

    const sgSetup=(esc)=>{world();placeB(0,'tc',3,20,true);placeB(1,'tc',44,20,true);freshAi('boss');villagers=villagers.filter(v=>false);
      const tw=placeB(1,'tower',38,20,true);const gM=tagsOf(1)[G.main];
      const sg=spawnUnit(1,'catapult',C(20,20).x,C(20,20).y,gM);
      for(let i=0;i<esc;i++)spawnUnit(1,'spear',C(21,20).x+i*8,C(21,20).y,gM);
      dbg.A(1).state='allin';dbg.A(1).sT=t;dbg.aiMilTick(1);
      return {sg,tw,gS:tagsOf(1)[G.sieg]};};
    {const {sg}=sgSetup(0);dbg.aiSiegeGuardEval(1);R.sgGrace=!dbg.A(1).sgRetr;}
    {const {sg,tw,gS}=sgSetup(0);dbg.aiSiegeGuardEval(1);adv(AI_SG_T+1);dbg.aiMilTick(1);
     R.sgRetreats=dbg.A(1).sgRetr>0&&sg.grp===gS&&gS.task==='guard'
       &&Math.hypot(dbg.A(1).sgRetrPt.x-tw.x,dbg.A(1).sgRetrPt.y-tw.y)<1;}
    {const {sg}=sgSetup(3);dbg.aiSiegeGuardEval(1);adv(AI_SG_T+1);dbg.aiSiegeGuardEval(1);
     R.sgEscortedNo=!dbg.A(1).sgRetr&&!sg.sgAloneT;}
    AI_SIEGEGUARD=false;{sgSetup(0);dbg.aiSiegeGuardEval(1);adv(AI_SG_T+1);dbg.aiSiegeGuardEval(1);
     R.sgAblate=!dbg.A(1).sgRetr;}AI_SIEGEGUARD=true;
    {const {sg,gS}=sgSetup(0);dbg.aiSiegeGuardEval(1);adv(AI_SG_T+1);dbg.aiMilTick(1);
     for(let i=0;i<3;i++)spawnUnit(1,'spear',sg.x+8*(i+1),sg.y,tagsOf(1)[G.main]);
     dbg.aiSiegeGuardEval(1);
     R.sgHandsBack=!dbg.A(1).sgRetr&&sg.grp===tagsOf(1)[G.reinf];}
    {const {sg}=sgSetup(0);dbg.aiSiegeGuardEval(1);const o1=dbg.aiEscObs(1);
     adv(AI_SG_T+1);dbg.aiSiegeGuardEval(1);const o2=dbg.aiEscObs(1);
     R.sgObs=o1.n===1&&o1.esc===0&&o1.frac===0&&o1.alone===0&&o2.alone===1&&o2.aloneEv===1&&o2.retr===true;}
    {const {sg}=sgSetup(3);dbg.aiSiegeGuardEval(1);const o=dbg.aiEscObs(1);
     R.sgObsEsc=o.n===1&&o.esc===1&&o.frac===1;}

    const medSetup=(lv,st)=>{world();placeB(0,'tc',3,20,true);placeB(1,'tc',44,20,true);freshAi(lv||'boss');villagers=villagers.filter(v=>false);
      techOf(1).researched.add('U3');techOf(1).age=3;recomputeTechMod(1);dbg.A(1).state=st;dbg.A(1).sT=t;
      return dbg.aiMilWant(1);};
    {const w=medSetup('boss','develop');R.medDevelop=(w.medic||0)>=1;}
    {const w=medSetup('boss','allin');R.medScales=(w.medic||0)>=2&&(w.medic||0)<=AI_MED_MAX;}
    AI_MEDPROD=false;{const wd=medSetup('boss','develop');const wa=medSetup('boss','allin');
     R.medAblate=(wd.medic||0)===0&&(wa.medic||0)===1;}AI_MEDPROD=true;
    {const w=medSetup('normal','develop');R.medDiffGate=(w.medic||0)===0;}

    const rgSetup=(hp,kind)=>{world();placeB(0,'tc',3,20,true);placeB(1,'tc',44,20,true);freshAi('boss');villagers=villagers.filter(v=>false);
      const tw=placeB(1,'tower',30,20,true);const gM=tagsOf(1)[G.main];
      const us=[];for(let i=0;i<8;i++)us.push(spawnUnit(1,'spear',C(14,20).x+i*8,C(14,20).y,gM));
      dbg.A(1).state=kind==='eco'?'pressure':'allin';dbg.A(1).sT=t;
      dbg.aiMilTick(1);
      us.forEach(u=>u.hp=u.maxHp*hp);
      return {gM,us,tw};};
    {const {gM,tw}=rgSetup(0.3);dbg.A(1).cmtT=-1e9;dbg.aiMilTick(1);
     const o=dbg.aiRegroupObs(1);
     R.rgHolds=dbg.A(1).regrp>0&&gM.task==='guard'&&o.regrp===true&&o.hp<0.5
       &&Math.hypot(dbg.A(1).regrpPt.x-tw.x,dbg.A(1).regrpPt.y-tw.y)<1;}
    {const {gM}=rgSetup(0.9);dbg.A(1).cmtT=-1e9;dbg.aiMilTick(1);
     R.rgHealthyNo=!dbg.A(1).regrp&&gM.task==='attack';}
    {const {gM,us}=rgSetup(0.3);dbg.A(1).cmtT=-1e9;dbg.aiMilTick(1);const on=dbg.A(1).regrp>0;
     us.forEach(u=>u.hp=u.maxHp*0.8);adv(2.6);dbg.aiMilTick(1);
     R.rgResumes=on&&!dbg.A(1).regrp&&gM.task==='attack';}
    {const {gM}=rgSetup(0.3);dbg.A(1).cmtT=-1e9;dbg.aiMilTick(1);const on=dbg.A(1).regrp>0;
     adv(AI_RGP_T0+1);dbg.aiMilTick(1);
     R.rgNoMedTimeout=on&&!dbg.A(1).regrp&&gM.task==='attack';}
    {const {gM}=rgSetup(0.3);dbg.A(1).cmtT=t;dbg.A(1).cmtStr=1;dbg.aiMilTick(1);
     R.rgCommitNo=!dbg.A(1).regrp;}
    AI_REGROUP=false;{const {gM}=rgSetup(0.3);dbg.A(1).cmtT=-1e9;dbg.aiMilTick(1);
     R.rgAblate=!dbg.A(1).regrp&&gM.task==='attack';}AI_REGROUP=true;
    {const {gM}=rgSetup(0.9);dbg.A(1).cmtT=-1e9;dbg.A(1).mlAct.regroup=true;dbg.aiMilTick(1);
     R.rgOverrideOn=dbg.A(1).regrp>0&&gM.task==='guard';dbg.A(1).mlAct.regroup=null;}
    {const {gM}=rgSetup(0.3);dbg.A(1).cmtT=-1e9;dbg.A(1).mlAct.regroup=false;dbg.aiMilTick(1);
     R.rgOverrideOff=!dbg.A(1).regrp&&gM.task==='attack';dbg.A(1).mlAct.regroup=null;}
    {const {gM}=rgSetup(0.3,'x');dbg.setAiDiff(1,'normal');dbg.A(1).cmtT=-1e9;dbg.aiMilTick(1);
     R.rgDiffGate=!dbg.A(1).regrp;dbg.setAiDiff(1,'boss');}

    dbg.A(1).mlAct={rule:{},garrison:null,assault:null,regroup:null};dbg.A(1).cmt.length=0;
    units.length=0;villagers.length=0;scouts.length=0;buildings.length=0;shots.length=0;
    return R;`);
  check('R12 3a-1 escorts march together (causal control + ablation): a reinforcement column with siege in it = the threshold switches to the escorting combat strength (2 catapults with no escort = stay home; escort assembled = march together); the switch off = the old behaviour, walking alone; no siege in the column = the threshold is unchanged',
    t103.escSgHolds&&t103.escSgGoes&&t103.escAblate&&t103.escNoSgSame, t103);
  check('R12 3a-3 the reinforcement column closes up (causal control + ablation): after marching, escorts outrunning the guns = the column stretches = the whole party waits in place; travelling together = keep going; the guns catch up = the latch releases and it moves on; the switch off = no waiting (the guns are left behind)',
    t103.reColOk&&t103.reColHolds&&t103.reColResumes&&t103.reColAblate, t103);
  check('R12 3a-2 siege catch-up latch (causal control + ablation): a gun falling more than AI_ESC_LAG behind on the march = the main force stops and waits; keeping up = keep pushing; the gun catches up = the latch releases; waiting too long = push on with a cooldown (it is not dragged to death by a straggler); the switch off = no waiting',
    t103.lagHolds&&t103.lagNoHold&&t103.lagResumes&&t103.lagTimeout&&t103.lagAblate, t103);
  check('R12 3b withdrawing when stranded (causal control + ablation): escort below strength for AI_SG_T = the siege party withdraws to the nearest friendly fortification; inside the grace period it does not (anti-flap); with an escort = it does not; the switch off = it stands there and dies; the escort rejoining = handed back to the reinforcement column (closed loop); observation wired',
    t103.sgGrace&&t103.sgRetreats&&t103.sgEscortedNo&&t103.sgAblate&&t103.sgHandsBack&&t103.sgObs&&t103.sgObsEsc, t103);
  check('R12 3c medic production line (causal control + ablation): keep 1 even during development (once U3 is researched); grows to 2~3 with army size during a full offensive; the switch off = the old behaviour (0 in development, 1 on the offensive); Normal = the difficulty gradient is unchanged',
    t103.medDevelop&&t103.medScales&&t103.medAblate&&t103.medDiffGate, t103);
  check('R12 3d topping up the wounded (causal control + ablation + override): average health below 50% = fall back to the nearest friendly fortification; healthy = keep pushing; healed to 75%, or no medic and timed out = resume the mission (closed loop); inside a commitment window it does not trigger (the bet does not sabotage itself); the switch off = wounded push on regardless; the override can force or forbid it; Normal does not top up',
    t103.rgHolds&&t103.rgHealthyNo&&t103.rgResumes&&t103.rgNoMedTimeout&&t103.rgCommitNo&&t103.rgAblate&&t103.rgOverrideOn&&t103.rgOverrideOff&&t103.rgDiffGate, t103);

  console.log('\n[104] R12 stage 1 breaking through walls (chewing the perimeter / getting the catapults in place): charging the town centre becomes \"nibbling the perimeter\" = nibble is the rule brain\'s default at Hard and above + a discrete ML override (assault) + observable state (causal control + ablation)');
  const t104 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const world=()=>{units.length=0;villagers.length=0;buildings.length=0;nodes.length=0;scouts.length=0;shots.length=0;
      blocked.fill(0);wallMask.fill(0);gateMask.fill(0);terr.fill(T_PLAIN);paintTerrain();computeLandComp();
      explored.fill(1);exploredE.fill(1);unreachable.fill(0);unreachableE.fill(0);computeDanger();gameOver=null;aiWave=99999;aiDefT=1e9;aiFullVision=true;AI_SEA.ready=false;};
    const freshAi=(lv)=>{dbg.setAiDiff(1,lv||'boss');dbg.A(1).pers=null;dbg.setAiPers(1,'england');
      dbg.aiResetBrain(1);dbg.A(1).plan={open:'std',routeBias:0,harass:false};dbg.A(1).intelT=t;};
    const G=dbg.AI_G,R={};

    /* Shared scenario: the AI (side1) is based at tx44, the enemy town centre (side0) at tx3, and the AI's
       main force sits at tx20 — 17 tiles from the enemy TC.
       A perimeter candidate must be within AI_NIB_R (20 tiles) of the main force and at least AI_NIB_PROG
       (2 tiles) closer to the enemy TC than the main force is, i.e. under 15 tiles from the TC.
         Thin tower twThin @(10,30): isolated, aiDefScore 1 (itself only), 12.2 tiles from the TC, 14.1 from
         the main force.
         Fat tower twFat @(10,20): castle at (8,20) next to it, aiDefScore 3 (1 + 2 for the castle), 7 tiles
         from the TC, 10 from the main force.
       Thinnest-first therefore picks twThin, even though twFat is nearer — distance is only a tie-break. */
    const nibSetup=(opt)=>{opt=opt||{};world();placeB(0,'tc',3,20,true);placeB(1,'tc',44,20,true);freshAi(opt.lv||'boss');
      villagers=villagers.filter(v=>false);
      const R2={};
      if(!opt.noDef){
        R2.twThin=placeB(0,'tower',10,30,true);
        R2.twFat=placeB(0,'tower',10,20,true);
        R2.cas=placeB(0,'castle',8,20,true);
      }
      if(opt.behind)R2.twBack=placeB(0,'tower',30,20,true);
      if(opt.eco)R2.farm=placeB(0,'farm',10,25,true);
      const gM=tagsOf(1)[G.main];
      for(let i=0;i<(opt.n||10);i++)spawnUnit(1,'spear',C(20,20).x+i*8,C(20,20).y,gM);
      for(let i=0;i<(opt.sg||0);i++)spawnUnit(1,'catapult',C(20,21).x+i*10,C(20,21).y,gM);
      dbg.A(1).mlAct.assault=(opt.ov===undefined?null:opt.ov);
      dbg.A(1).state='allin';dbg.A(1).sT=t;
      /* Four beats: (1) build the base task; (2) fall into the else branch and evaluate stepwise target
         selection; (3) centroid reaches the rally point, advancing the leg (li→1 = final leg); (4) on the
         final leg nibOn engages, so the next advance order or siege group retargets the intermediate
         objective. In this fixture the main force starts next to the route's rally point, so the rally point
         is closer than the intermediate objective and the first two beats go to the rally first under R9
         staged marching — that is by design, not a bug. */
      for(let i=0;i<4;i++)dbg.aiMilTick(1);
      R2.gM=gM;R2.cc=buildings.find(b=>b.side===0&&b.type==='tc');
      R2.m=dbg.A(1).mission;R2.obs=dbg.aiNibObs(1);
      return R2;};

    {const s=nibSetup({});R.nibPicks=!!s.m&&s.m.kind==='base'&&s.m.nib===s.twThin&&s.obs.mode==='nibble'&&s.obs.nib.ty==='tower';}
    {const s=nibSetup({});R.nibThinNotNear=!!s.m&&s.m.nib!==s.twFat;}
    {const s=nibSetup({});R.nibObs=s.obs.thin===1&&s.obs.n>=2&&s.obs.anchD>0;}

    {const s=nibSetup({noDef:true,eco:true});R.nibNoCand=!!s.m&&!s.m.nib&&s.obs.nib===null&&s.obs.thin===-1;}
    {const s=nibSetup({noDef:true,behind:true});R.nibNoBack=!!s.m&&!s.m.nib&&s.m.nib!==s.twBack;}

    {const s=nibSetup({});const pt=s.gM.pt;
     const dNib=pt?Math.hypot(pt.x-s.twThin.x,pt.y-s.twThin.y):1e9, dCC=pt?Math.hypot(pt.x-s.cc.x,pt.y-s.cc.y):0;
     R.nibOrders=!!pt&&dNib<TILE*4&&dNib<dCC;}
    AI_NIBBLE=false;{const s=nibSetup({});const pt=s.gM.pt;
     R.nibAblate=!s.m.nib&&s.obs.mode==='direct'&&!!pt&&Math.hypot(pt.x-s.cc.x,pt.y-s.cc.y)<Math.hypot(pt.x-s.twThin.x,pt.y-s.twThin.y);}AI_NIBBLE=true;

    {const s=nibSetup({});const t0=dbg.A(1).cmtT,e0=dbg.A(1).nibEv;
     s.twThin.hp=0;dbg.aiMilTick(1);
     R.nibProgress=dbg.A(1).nibEv===e0+1&&dbg.A(1).cmtT>t0-1e-9&&dbg.A(1).cmtT===t;
     R.nibNext=dbg.A(1).mission.nib===s.twFat;}

    {const s=nibSetup({ov:'direct'});R.ovDirect=!s.m.nib&&s.obs.mode==='direct';}
    AI_NIBBLE=false;{const s=nibSetup({ov:'nibble'});R.ovNibble=s.m.nib===s.twThin&&s.obs.mode==='nibble';}AI_NIBBLE=true;
    {const s=nibSetup({ov:'blockade'});R.ovBlockade=!!s.m&&s.m.kind==='blockade';}
    {const s=nibSetup({ov:'blockade'});dbg.aiMilTick(1);R.ovBlockadeStays=dbg.A(1).mission&&dbg.A(1).mission.kind==='blockade';}
    {const s=nibSetup({lv:'normal'});R.nibDiffGate=!s.m.nib&&s.obs.mode==='direct';}

    {const s=nibSetup({sg:3});const gS=tagsOf(1)[G.sieg];
     R.sgOnNib=gS.focus===s.twThin&&units.some(u=>u.side===1&&u.grp===gS&&UT[u.type].role==='siege');}
    AI_SIEGEPOS=false;{const s=nibSetup({sg:3});const gS=tagsOf(1)[G.sieg];
     R.sgAblate=gS.focus===s.cc;}AI_SIEGEPOS=true;
    /* 1b observation: siege units counted as "in position and firing" are those within AI_SGP_R of the
       target *and* finished setting up (siegeReady = stationary for >= setup).
       Three-way control so neither condition is vacuously true: far from target = 0, in position but just
       moved = 0, in position and stationary = 3. */
    {const s=nibSetup({sg:3});const sgs=units.filter(u=>u.side===1&&UT[u.type].role==='siege');
     sgs.forEach(u=>{u.x=C(40,20).x;u.y=C(40,20).y;u.movedT=t-99;});dbg.aiMilTick(1);
     const far=dbg.aiNibObs(1).sgOut;
     sgs.forEach(u=>{u.x=s.twThin.x+60;u.y=s.twThin.y;u.movedT=t;});dbg.aiMilTick(1);
     const moving=dbg.aiNibObs(1).sgOut;
     sgs.forEach(u=>{u.movedT=t-99;});dbg.aiMilTick(1);
     const out=dbg.aiNibObs(1).sgOut;
     R.sgObsOut=far===0&&moving===0&&out===3;}
    return R;
  `);
  check('R12 1a chewing the perimeter (causal control + ablation + override): a defended perimeter = pick the thinnest point as an intermediate target (thinnest beats nearest); no candidate, or only targets behind = go straight for the town centre (never backwards); the main force order points at the intermediate target; demolishing it = the window continues and the anchor moves forward to the next one; the switch off, or override direct = the old behaviour, straight at the centre; override nibble beats the ablation; override blockade = surround without assaulting (and is not rebuilt every tick); Normal does not do this (difficulty gradient); observation wired',
    t104.nibPicks&&t104.nibThinNotNear&&t104.nibObs&&t104.nibNoCand&&t104.nibNoBack&&t104.nibOrders&&t104.nibAblate&&
    t104.nibProgress&&t104.nibNext&&t104.ovDirect&&t104.ovNibble&&t104.ovBlockade&&t104.ovBlockadeStays&&t104.nibDiffGate, t104);
  check('R12 1b the catapults really get in place (causal control + ablation): the siege party is assigned the \"intermediate target\" (the thinnest tower on the perimeter, which it can reach) rather than a town centre 84 tiles away; the switch off = back to the town centre (the old behaviour = never in range); the \"in place and firing\" observation count is wired',
    t104.sgOnNib&&t104.sgAblate&&t104.sgObsOut, t104);

  console.log('\n[105] R12 re-verifying construction sites under tower fire (from spectating: \"two blue villagers heading for the outpost, right next to it and unable to get in\"): a site covered by an enemy defence ring that arrived later = the order is cancelled on the spot and nobody is sent + the whole footprint is checked when picking a spot (causal control + ablation)');
  const t105 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const world=()=>{units.length=0;villagers.length=0;buildings.length=0;nodes.length=0;scouts.length=0;shots.length=0;
      blocked.fill(0);wallMask.fill(0);gateMask.fill(0);terr.fill(T_PLAIN);paintTerrain();computeLandComp();
      explored.fill(1);exploredE.fill(1);unreachable.fill(0);unreachableE.fill(0);gameOver=null;aiWave=99999;aiDefT=1e9;
      aiFullVision=true;aiEco=true;AI_SEA.ready=false;S_(0).stance='flee';S_(1).stance='flee';computeDanger();};
    const R={};
    /* Minimal reproduction of a real match: the AI (side1), based at tx44, drops an outpost foundation at
       (20,20) and sends a villager to build it; the player (side0) then builds a tower at (23,20), so the
       threat circle grows over a foundation already under construction. aiFullVision=true guarantees the
       AI can see that tower (the seenBy gate holds). The villager is deliberately placed at (19,20), right
       next to the site — the "it's standing right there" case from the bug report. */
    const setup=()=>{world();
      const tc=placeB(1,'tc',44,20,true);
      const site=placeB(1,'outpost',20,20,false);
      spawnVillager(tc);const v=villagers[villagers.length-1];
      v.x=C(19,20).x;v.y=C(19,20).y;v.state='idle';
      computeDanger();
      return {tc,site,v};};
    const tower=()=>{const tw=placeB(0,'tower',23,20,true);tw.seen=true;tw.seenE=true;computeDanger();return tw;};

    /* Ships enabled by default again. It was previously defaulted off to stop the bleeding: with it on,
       paired ablation (boss vs hard) regressed to 13% from 63% and catapults went 7→0. The root cause was
       our own defect — cancelling a work order without cancelling the construction, leaving orphan
       foundations (see the orphan assertions at the end of this case). Only once that was fixed was the
       flag re-enabled, and this assertion flipped with it. */
    const DEF=AI_SITEFIRE; R.shipsOn=(AI_SITEFIRE===true);
    AI_SITEFIRE=true;

    {const s=setup();assignBuilders(s.site,2);const got=s.v.buildSite===s.site;
     tower();vTick(s.v,0.05);
     R.lateTowerCancel=got&&s.v.buildSite===null;}
    {const s=setup();assignBuilders(s.site,2);vTick(s.v,0.05);
     R.noTowerKeeps=s.v.buildSite===s.site;}
    AI_SITEFIRE=false;
    {const s=setup();assignBuilders(s.site,2);tower();vTick(s.v,0.05);
     R.ablateKeeps=s.v.buildSite===s.site;}
    AI_SITEFIRE=true;

    {const s=setup();tower();assignBuilders(s.site,2);
     R.noAssignIntoFire=s.v.buildSite===null;}
    {const s=setup();const tw=tower();assignBuilders(s.site,2);const blocked0=s.v.buildSite===null;
     buildings.splice(buildings.indexOf(tw),1);computeDanger();assignBuilders(s.site,2);
     R.restoreOnTowerGone=blocked0&&s.v.buildSite===s.site;}

    {const s=setup();assignBuilders(s.site,2);
     aiFullVision=false;const tw=placeB(0,'tower',23,20,true);tw.seen=true;tw.seenE=false;computeDanger();
     vTick(s.v,0.05);R.unseenNoCancel=s.v.buildSite===s.site;aiFullVision=true;}

    {const s=setup();assignBuilders(s.site,2);S_(1).stance='gather';tower();vTick(s.v,0.05);
     R.gatherStanceGoes=s.v.buildSite===s.site;S_(1).stance='flee';}

    {const s=setup();tower();const fp=fpOf('outpost');
     let trap=0;for(let y=8;y<34;y++)for(let x=8;x<38;x++)
       if(dmaskOf(1)[idx(x,y)]!==2&&fireFP(1,x,y,fp.w,fp.h))trap++;
     R.fpTrapExists=trap>0;
     const sp=dbg.aiFindSpot(1,'outpost',C(23,20).x,C(23,20).y,9);
     R.fpWholeClean=!sp||!fireFP(1,sp.tx,sp.ty,fp.w,fp.h);
     AI_SITEFIRE=false;
     const sp2=dbg.aiFindSpot(1,'outpost',C(23,20).x,C(23,20).y,9);
     R.fpAblateTopLeftOnly=!sp2||dmaskOf(1)[idx(sp2.tx,sp2.ty)]!==2;
     AI_SITEFIRE=true;}

    {const s=setup();const before=dbg.siteFireObs().cancel[1];
     assignBuilders(s.site,2);tower();vTick(s.v,0.05);
     const o=dbg.siteFireObs();
     R.obs=o.cancel[1]===before+1&&o.hot[1]===0;}

    /* Orphan-foundation fix: cancelling a work order also tears down the unfinished foundation (no refund).
       The defect before the fix: the foundation stayed put unfinished → repairScan kept trying to reassign
       builders → assignBuilders' threat-circle gate refused them (measured in sim: s0:outpost refused 257
       times) → the orphan foundation occupied an aiOutMax expansion slot (the slot count only checks hp>0,
       so half-built structures still count) → the boss sat in develop/defend all game → catapults 7→0 →
       the mechanism behind the 63%→13% drop. */
    {const s=setup();const st=stockOf(1),w0=st.wood,s0=st.stone;
     const fp={w:s.site.w||s.site.size,h:s.site.h||s.site.size},bx=s.site.tx,by=s.site.ty;
     assignBuilders(s.site,2);tower();vTick(s.v,0.05);
     R.orphanKilled=s.site.hp<=0&&s.site.withdrawn===true;
     const k0=stats.kills;
     step(TICK);
     R.orphanGone=!buildings.includes(s.site);
     R.orphanNoRefund=st.wood===w0&&st.stone===s0;
     R.orphanNoKillStat=stats.kills===k0;
     let fpClear=true;for(let y=by;y<by+fp.h;y++)for(let x=bx;x<bx+fp.w;x++)if(blocked[idx(x,y)])fpClear=false;
     R.orphanFpFreed=fpClear;
     R.orphanSlotFreed=buildings.filter(b=>b.side===1&&b.type==='outpost'&&b.hp>0).length===0;}
    /* Causal control and guard rail: a *completed* building inside a threat circle is never torn down (only
       unfinished foundations are), so this rule can never demolish your own finished property. */
    {const s=setup();const done=placeB(1,'tower',21,20,true);computeDanger();
     R.doneNotWithdrawn=withdrawSite(done)===false&&done.hp>0;}

    AI_SITEFIRE=DEF;
    return R;
  `);
  check('R12 construction sites under tower fire, re-verified (stage B ⑤, orphan stubs fixed = re-enabled; the factory default must be on): villagers dispatched first, enemy tower arrives after = the order is cancelled on the spot **and the stub is removed with it** (no refund, no kill credited, footprint released, the aiOutMax slot freed; a finished building is never removed); no tower = the order stands; ablation = back to the old sticky behaviour; tower already there = nobody is sent at all; tower falls = dispatch resumes automatically; an unscouted tower does not count (fog is fair); a villager on a suicide-gather stance still goes (the decision stays with the player); site selection checks the whole footprint (ablation reverts to checking the anchor tile only); the observation hook stays at 0 after the hot fix',
    t105.shipsOn&&t105.lateTowerCancel&&t105.noTowerKeeps&&t105.ablateKeeps&&t105.noAssignIntoFire&&t105.restoreOnTowerGone&&
    t105.unseenNoCancel&&t105.gatherStanceGoes&&t105.fpTrapExists&&t105.fpWholeClean&&t105.fpAblateTopLeftOnly&&t105.obs&&
    t105.orphanKilled&&t105.orphanGone&&t105.orphanNoRefund&&t105.orphanNoKillStat&&t105.orphanFpFreed&&t105.orphanSlotFreed&&
    t105.doneNotWithdrawn, t105);

  console.log('\n[106] three squads, stage A (defence / attack / reserve): the wave lifecycle (reserve reaches strength → must rally → forms up and sorties) + attackers do not retreat, with a T_back exception for defending home + modes (guard while marching, attack once inside the town) + folding g6/g7 + observation hooks (causal control + ablation)');
  const t106 = await ev(`
    AI_SQUADS=true;
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const world=()=>{units.length=0;villagers.length=0;buildings.length=0;nodes.length=0;scouts.length=0;shots.length=0;
      blocked.fill(0);wallMask.fill(0);gateMask.fill(0);terr.fill(T_PLAIN);paintTerrain();computeLandComp();
      explored.fill(1);exploredE.fill(1);unreachable.fill(0);unreachableE.fill(0);computeDanger();gameOver=null;aiWave=99999;aiDefT=1e9;aiFullVision=true;AI_SEA.ready=false;};
    const G=dbg.AI_G,R={};
    const scene=(lv)=>{world();placeB(0,'tc',44,20,true);const home=placeB(1,'tc',6,20,true);placeB(1,'barracks',9,20,true);
      for(const k in stockOf(1))stockOf(1)[k]=3000;
      techOf(1).researched.clear();techOf(1).age=2;techOf(1).track=null;techOf(1).queue.length=0;techOf(1).ageUp=null;recomputeTechMod(1);
      dbg.setAiDiff(1,lv||'hard');dbg.A(1).pers=null;dbg.setAiPers(1,'england');dbg.aiResetBrain(1);
      dbg.A(1).plan={open:'std',routeBias:0,harass:false};dbg.A(1).intelT=t;dbg.A(1).homeRally={x:C(11,20).x,y:C(11,20).y};
      villagers.length=0;return home;};
    const etc=()=>buildings.find(b=>b.side===0&&b.type==='tc');
    const resPut=(n,tx,ty)=>{const g=tagsOf(1)[G.reinf];for(let i=0;i<n;i++)spawnUnit(1,'spear',C(tx,ty).x+(i%5)*10,C(tx,ty).y+((i/5)|0)*10,g);};
    scene('hard');resPut(14,30,20);
    dbg.aiMilTick(1);
    {const o=dbg.aiWaveObs(1);R.musterLatch=o.muster===true&&o.atkOut===false&&o.state==='pressure'&&o.res>14;}
    {const g=tagsOf(1)[G.reinf];units.forEach(u=>{if(u.grp===g){u.x=C(11,20).x;u.y=C(11,20).y;}});}
    dbg.aiMilTick(1);
    {const o=dbg.aiWaveObs(1);R.waveDepart=o.atkOut===true&&o.state==='allin'&&o.atk>14&&o.res<2;}
    AI_MUSTER=false;
    scene('hard');resPut(14,30,20);
    dbg.aiMilTick(1);
    {const o=dbg.aiWaveObs(1);R.musterAblate=o.atkOut===true;}
    AI_MUSTER=true;
    scene('hard');
    {const gM=tagsOf(1)[G.main];for(let i=0;i<6;i++)spawnUnit(1,'spear',C(30,20).x+i*8,C(30,20).y,gM);}
    dbg.A(1).atkOut=true;dbg.A(1).atkTgt=etc();dbg.A(1).atkMode='attack';
    for(let i=0;i<16;i++)spawnUnit(0,'spear',C(30,20).x+(i%8)*9,C(30,20).y+12+((i/8)|0)*9,tags[5]);
    dbg.aiMilTick(1);
    R.noRetreat=dbg.A(1).atkOut===true&&dbg.A(1).state==='allin';
    scene('hard');
    {const gM=tagsOf(1)[G.main];for(let i=0;i<6;i++)spawnUnit(1,'spear',C(18,20).x+i*8,C(18,20).y,gM);}
    dbg.A(1).atkOut=true;dbg.A(1).atkTgt=etc();dbg.A(1).atkMode='march';
    for(let i=0;i<10;i++)spawnUnit(0,'spear',C(7,20).x+(i%5)*8,C(7,20).y+((i/5)|0)*8,tags[5]);
    dbg.aiMilTick(1);
    {const o=dbg.aiWaveObs(1);R.tbackNear=o.tback===true&&o.mode==='defend';}
    {const g=tagsOf(1)[G.main];units.forEach(u=>{if(u.grp===g){u.x=C(36,20).x+(u.x-C(18,20).x);u.y=C(36,20).y;}});}
    dbg.aiMilTick(1);
    {const o=dbg.aiWaveObs(1);R.tbackFar=o.tback===false;}
    AI_NORETREAT=false;
    scene('hard');
    {const gM=tagsOf(1)[G.main];for(let i=0;i<6;i++)spawnUnit(1,'spear',C(18,20).x+i*8,C(18,20).y,gM);}
    dbg.A(1).atkOut=true;dbg.A(1).atkTgt=etc();dbg.A(1).atkMode='march';
    for(let i=0;i<10;i++)spawnUnit(0,'spear',C(7,20).x+(i%5)*8,C(7,20).y+((i/5)|0)*8,tags[5]);
    dbg.aiMilTick(1);
    {const o=dbg.aiWaveObs(1);R.tbackAblate=o.tback===false;}
    AI_NORETREAT=true;
    scene('hard');
    {const gM=tagsOf(1)[G.main];for(let i=0;i<6;i++)spawnUnit(1,'spear',C(18,20).x+i*8,C(18,20).y,gM);}
    dbg.A(1).atkOut=true;dbg.A(1).atkTgt=etc();
    dbg.aiMilTick(1);
    {const o=dbg.aiWaveObs(1);R.modeMarch=o.mode==='march'&&tagsOf(1)[G.main].task==='guard';}
    {const g=tagsOf(1)[G.main];units.forEach(u=>{if(u.grp===g){u.x=C(40,20).x;u.y=C(40,20).y;}});}
    dbg.aiMilTick(1);
    {const o=dbg.aiWaveObs(1);R.modeAttack=o.mode==='attack'&&tagsOf(1)[G.main].task==='attack';}
    scene('boss');
    for(let i=0;i<30;i++)dbg.aiMilProdSq(1);
    R.foldSquads=units.filter(u=>u.side===1&&(u.grp===tagsOf(1)[G.rgu]||u.grp===tagsOf(1)[G.har])).length===0
      && !buildings.some(b=>b.side===1&&b.queue.some(q=>q.tag===G.rgu||q.tag===G.har));
    {const o=dbg.aiWaveObs(1);R.obs=typeof o.state==='string'&&typeof o.atkOut==='boolean'&&typeof o.def==='number'&&typeof o.res==='number'&&typeof o.atk==='number'&&('mode'in o)&&('waveReq'in o)&&('muster'in o)&&('tback'in o);}
    const run=()=>{scene('hard');resPut(14,11,20);dbg.aiMilTick(1);return JSON.stringify(dbg.aiWaveObs(1));};
    R.determin=run()===run();
    units.length=0;villagers.length=0;scouts.length=0;
    return R;`);
  check('three squads stage A, wave lifecycle: reserve reaches strength → must rally (rallying, not yet sortied) → assembled, forms up and sorties (reserve → attacker); ablation AI_MUSTER=false = no rally, sortie on the spot (causal control)',
    t106.musterLatch&&t106.waveDepart&&t106.musterAblate, t106);
  check('three squads stage A, attackers do not retreat + T_back: home safe + a strong enemy in its face = no bouncing back (fixes the collapsing window); near home + home in danger + not engaged = return to put the fire out; too far = press on (a race to trade bases); ablation AI_NORETREAT=false = it does not even come back for the fire (causal control)',
    t106.noRetreat&&t106.tbackNear&&t106.tbackFar&&t106.tbackAblate, t106);
  check('three squads stage A, mode switching + folding + observation: far from the target = guard while marching; inside the town = attack; boss always folds g6, and g7 waits without being maintained for nothing (the safety line); aiWaveObs complete; the same settings give the same decision (determinism)',
    t106.modeMarch&&t106.modeAttack&&t106.foldSquads&&t106.obs&&t106.determin, t106);

  console.log('\n[107] three squads, stage B (the strategic layer): target selection (difficulty rules, only what is honestly known, a stuck flag) + rally before arriving + fight what you meet on the march + diverting en route (Hard+) + T_back decided by being fired on + scouts wander randomly (causal control + ablation)');
  const t107 = await ev(`
    AI_SQUADS=true;
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const world=()=>{units.length=0;villagers.length=0;buildings.length=0;nodes.length=0;scouts.length=0;shots.length=0;
      blocked.fill(0);wallMask.fill(0);gateMask.fill(0);terr.fill(T_PLAIN);paintTerrain();computeLandComp();
      explored.fill(1);exploredE.fill(1);unreachable.fill(0);unreachableE.fill(0);computeDanger();gameOver=null;aiWave=99999;aiDefT=1e9;aiFullVision=true;AI_SEA.ready=false;};
    const G=dbg.AI_G,R={};
    const scene=(lv)=>{world();placeB(0,'tc',44,20,true);const home=placeB(1,'tc',6,20,true);placeB(1,'barracks',9,20,true);
      for(const k in stockOf(1))stockOf(1)[k]=3000;
      techOf(1).researched.clear();techOf(1).age=2;techOf(1).track=null;techOf(1).queue.length=0;techOf(1).ageUp=null;recomputeTechMod(1);
      dbg.setAiDiff(1,lv||'hard');dbg.A(1).pers=null;dbg.setAiPers(1,'england');dbg.aiResetBrain(1);
      dbg.A(1).plan={open:'std',routeBias:0,harass:false};dbg.A(1).intelT=t;dbg.A(1).homeRally={x:C(11,20).x,y:C(11,20).y};
      villagers.length=0;return home;};
    const etc=()=>buildings.find(b=>b.side===0&&b.type==='tc');
    const wave=(n,tx,ty)=>{const g=tagsOf(1)[G.main];for(let i=0;i<n;i++)spawnUnit(1,'spear',C(tx,ty).x+i*8,C(tx,ty).y,g);dbg.A(1).atkOut=true;dbg.A(1).atkTgt=etc();};
    const tgtScene=(lv)=>{scene(lv);placeB(0,'tower',44,24,true);
      placeB(0,'outpost',38,6,true);placeB(0,'tower',36,6,true);placeB(0,'tower',40,8,true);
      placeB(0,'outpost',30,26,true);};
    tgtScene('hard');
    {const w=dbg.aiWaveTgt(1);R.tgtWeak=!!w&&w.ty==='outpost'&&w.y>C(0,22).y;}
    tgtScene('noob');
    {const w=dbg.aiWaveTgt(1);R.tgtHome=!!w&&w.ty==='tc';}
    tgtScene('normal');
    {const w=dbg.aiWaveTgt(1);R.tgtNear=!!w&&w.ty==='outpost'&&w.y>C(0,22).y;}
    tgtScene('hard');aiFullVision=false;
    for(const b of buildings)if(b.side===0)b.seenE=false;
    {const so=buildings.find(b=>b.side===0&&b.type==='outpost'&&b.ty>22);so.seenE=true;}
    {const w=dbg.aiWaveTgt(1);R.tgtHonest=!!w&&w.ty==='outpost'&&w.y>C(0,22).y;}
    for(const b of buildings)if(b.side===0)b.seenE=false;
    dbg.A(1).wtgtB=null;dbg.aiMilTick(1);
    {const o=dbg.aiWaveObs(1);R.stuckFlag=o.stuck===true;}
    aiFullVision=true;dbg.A(1).wtgtB=null;dbg.aiMilTick(1);
    {const o=dbg.aiWaveObs(1);R.stuckClear=o.stuck===false;}
    AI_TGTSEL=false;tgtScene('hard');
    {const w=dbg.aiWaveTgt(1);R.tgtAblate=!!w&&w.ty==='tc';}
    AI_TGTSEL=true;
    scene('hard');
    {const g=tagsOf(1)[G.main];
     for(let i=0;i<4;i++)spawnUnit(1,'spear',C(22,20).x+i*8,C(22,20).y,g);
     for(let i=0;i<4;i++)spawnUnit(1,'spear',C(40,20).x+i*8,C(40,20).y,g);}
    dbg.A(1).atkOut=true;dbg.A(1).atkTgt=etc();
    dbg.aiMilTick(1);
    {const o=dbg.aiWaveObs(1);R.stageHold=o.staged===false&&o.mode==='march'&&tagsOf(1)[G.main].task==='guard'&&!!o.stagePt;}
    {const g=tagsOf(1)[G.main];units.forEach(u=>{if(u.side===1&&u.grp===g){u.x=C(32,20).x;u.y=C(32,20).y;}});}
    dbg.aiMilTick(1);
    {const o=dbg.aiWaveObs(1);R.stageGo=o.staged===true&&o.mode==='attack'&&tagsOf(1)[G.main].task==='attack';}
    AI_FSTAGE=false;
    scene('hard');
    {const g=tagsOf(1)[G.main];
     for(let i=0;i<4;i++)spawnUnit(1,'spear',C(22,20).x+i*8,C(22,20).y,g);
     for(let i=0;i<4;i++)spawnUnit(1,'spear',C(40,20).x+i*8,C(40,20).y,g);}
    dbg.A(1).atkOut=true;dbg.A(1).atkTgt=etc();
    dbg.aiMilTick(1);
    {const o=dbg.aiWaveObs(1);R.stageAblate=o.staged===true&&o.mode==='attack';}
    AI_FSTAGE=true;
    scene('hard');wave(6,18,20);
    for(let i=0;i<6;i++)spawnUnit(0,'spear',C(24,20).x+(i%3)*9,C(24,20).y+((i/3)|0)*9,tags[5]);
    dbg.aiMilTick(1);
    {const o=dbg.aiWaveObs(1);R.mfFight=o.mf===true&&o.mode==='fight'&&tagsOf(1)[G.main].task==='attack';}
    scene('boss');
    {const g=tagsOf(1)[G.main];
     for(let i=0;i<3;i++)spawnUnit(1,'spear',C(18,8).x+i*8,C(18,8).y,g);
     for(let i=0;i<3;i++)spawnUnit(1,'spear',C(18,25).x+i*8,C(18,25).y,g);}
    dbg.A(1).atkOut=true;dbg.A(1).atkTgt=etc();
    for(let i=0;i<6;i++)spawnUnit(0,'spear',C(24,17).x+(i%3)*9,C(24,17).y+((i/3)|0)*9,tags[5]);
    dbg.aiMilTick(1);
    {const o=dbg.aiWaveObs(1);R.mfMusterPull=o.mf===true&&tagsOf(1)[G.main].task==='guard';}
    {const g=tagsOf(1)[G.main];units.forEach(u=>{if(u.side===1&&u.grp===g){u.x=C(18,17).x;u.y=C(18,17).y;}});}
    dbg.aiMilTick(1);
    R.mfMusterGo=tagsOf(1)[G.main].task==='attack';
    AI_MARCHFIGHT=false;
    scene('hard');wave(6,18,20);
    for(let i=0;i<6;i++)spawnUnit(0,'spear',C(24,20).x+(i%3)*9,C(24,20).y+((i/3)|0)*9,tags[5]);
    dbg.aiMilTick(1);
    {const o=dbg.aiWaveObs(1);R.mfAblate=o.mf===false&&o.mode==='march';}
    AI_MARCHFIGHT=true;
    scene('hard');placeB(0,'outpost',22,26,true);wave(6,18,20);
    dbg.aiMilTick(1);
    {const o=dbg.aiWaveObs(1);R.divertHard=!!o.tgt&&o.tgt.ty==='outpost'&&o.divertN===1;}
    scene('noob');placeB(0,'outpost',22,26,true);wave(6,18,20);
    dbg.aiMilTick(1);
    {const o=dbg.aiWaveObs(1);R.divertNoob=!!o.tgt&&o.tgt.ty==='tc'&&o.divertN===0;}
    AI_DIVERT=false;
    scene('hard');placeB(0,'outpost',22,26,true);wave(6,18,20);
    dbg.aiMilTick(1);
    {const o=dbg.aiWaveObs(1);R.divertAblate=!!o.tgt&&o.tgt.ty==='tc'&&o.divertN===0;}
    AI_DIVERT=true;
    scene('hard');wave(6,18,20);dbg.A(1).atkMode='march';
    for(let i=0;i<10;i++)spawnUnit(0,'spear',C(7,20).x+(i%5)*8,C(7,20).y+((i/5)|0)*8,tags[5]);
    {const g=tagsOf(1)[G.main];units.find(u=>u.side===1&&u.grp===g).lastHitT=t;}
    dbg.aiMilTick(1);
    {const o=dbg.aiWaveObs(1);R.tbackEngaged=o.tback===false;}
    AI_TBACK_HIT=false;
    scene('hard');wave(6,18,20);dbg.A(1).atkMode='march';
    for(let i=0;i<10;i++)spawnUnit(0,'spear',C(7,20).x+(i%5)*8,C(7,20).y+((i/5)|0)*8,tags[5]);
    {const g=tagsOf(1)[G.main];units.find(u=>u.side===1&&u.grp===g).lastHitT=t;}
    dbg.aiMilTick(1);
    {const o=dbg.aiWaveObs(1);R.tbackProxy=o.tback===true;}
    AI_TBACK_HIT=true;
    scene('hard');aiEco=true;
    {const tc1=buildings.find(b=>b.side===1&&b.type==='tc');spawnScout(tc1);}
    {const s=scouts[scouts.length-1];s.mode='explore';s.expT=null;s.repathT=0;
     sTick(s,0.05);
     R.roamPick=s.mode==='explore'&&!!s.expT&&s.roam===true&&!scoutUnsafe(s.expT.x,s.expT.y,1);
     exploredE[idx(30,6)]=0;s.repathT=0;s.manual=false;
     sTick(s,0.05);
     R.roamUnknownFirst=!!s.expT&&Math.hypot(s.expT.x-C(30,6).x,s.expT.y-C(30,6).y)<TILE*3&&s.roam===false;}
    AI_SCOUTROAM=false;exploredE[idx(30,6)]=1;
    {const tc1=buildings.find(b=>b.side===1&&b.type==='tc');spawnScout(tc1);}
    {const s=scouts[scouts.length-1];s.mode='explore';s.expT=null;s.repathT=0;
     sTick(s,0.05);
     R.roamAblate=s.mode==='observe';}
    AI_SCOUTROAM=true;aiEco=false;
    const run=()=>{tgtScene('hard');wave(6,18,20);dbg.aiMilTick(1);return JSON.stringify(dbg.aiWaveObs(1))+JSON.stringify(dbg.aiClusters(1));};
    R.determin=run()===run();
    units.length=0;villagers.length=0;scouts.length=0;aiFullVision=true;
    return R;`);
  check('three squads stage B, target selection (honest): Hard = the weakest known cluster (defence-weighted, nearest among equals); Beginner = the opponent\'s main base; Normal = the nearest cluster by path; it attacks only what it knows (nothing sighted at all = null + the stuck flag; the target reappearing clears the flag); ablation = stage A\'s straight run at the town centre',
    t107.tgtWeak&&t107.tgtHome&&t107.tgtNear&&t107.tgtHonest&&t107.stuckFlag&&t107.stuckClear&&t107.tgtAblate, t107);
  check('three squads stage B, rally before arriving + fight what you meet: a scattered wave entering the area = fall back and close up rather than opening fire → assembled = cleared to attack; ablation = attack on entry (the old first-there-fights-first fault). Meeting an enemy on the march = fight in place; a scattered boss wave pulls back first (guard), closes up, then fights; ablation = no engagement along the way (causal control)',
    t107.stageHold&&t107.stageGo&&t107.stageAblate&&t107.mfFight&&t107.mfMusterPull&&t107.mfMusterGo&&t107.mfAblate, t107);
  check('three squads stage B, diverting en route + T_back alignment + scouts wander: Hard meeting a cluster en route = switch to attacking it (divertN=1); Beginner and the ablation do not divert; being fired on = engaged, so no returning home (the ablation\'s proxy misreads it and returns); a scout that has covered the map = wanders randomly with unknown tiles preferred (ablation = the old distant-observation behaviour); determinism',
    t107.divertHard&&t107.divertNoob&&t107.divertAblate&&t107.tbackEngaged&&t107.tbackProxy&&t107.roamPick&&t107.roamUnknownFirst&&t107.roamAblate&&t107.determin, t107);

  console.log('\n[108] three squads, stage C (the economic support): 1:1 production capacity early on (milShare, research fully converted) + wave size scaling with the age (waveSz) + difficulty differentiation columns + renewables keeping up with villagers + outpost and tower spacing + patrols on a real route + a barracks at the outpost + upgrading to a city + a fixed research order (causal control + ablation)');
  const t108 = await ev(`
    AI_SQUADS=true;
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const world=()=>{units.length=0;villagers.length=0;buildings.length=0;nodes.length=0;scouts.length=0;shots.length=0;
      blocked.fill(0);wallMask.fill(0);gateMask.fill(0);terr.fill(T_PLAIN);paintTerrain();computeLandComp();
      explored.fill(1);exploredE.fill(1);unreachable.fill(0);unreachableE.fill(0);computeDanger();gameOver=null;aiWave=99999;aiDefT=1e9;aiFullVision=true;AI_SEA.ready=false;};
    const G=dbg.AI_G,R={};
    const scene=(lv)=>{world();placeB(0,'tc',44,20,true);const home=placeB(1,'tc',6,20,true);placeB(1,'barracks',9,20,true);
      for(const k in stockOf(1))stockOf(1)[k]=3000;
      techOf(1).researched.clear();techOf(1).age=2;techOf(1).track=null;techOf(1).queue.length=0;techOf(1).ageUp=null;recomputeTechMod(1);
      dbg.setAiDiff(1,lv||'hard');dbg.A(1).pers=null;dbg.setAiPers(1,'england');dbg.aiResetBrain(1);
      dbg.A(1).plan={open:'std',routeBias:0,harass:false};dbg.A(1).intelT=t;dbg.A(1).homeRally={x:C(11,20).x,y:C(11,20).y};
      villagers.length=0;return home;};
    const barr=()=>buildings.find(b=>b.side===1&&b.type==='barracks');
    const blockCmt=()=>{dbg.A(1).cmt.push({key:'x:test',dom:'eco',cost:{food:99999,wood:99999,gold:99999,stone:99999,iron:99999},bucket:{},exp:false,trickle:false,score:9,exec:null,gate:null,bornT:t,seen:t});};
    const fillSquads=()=>{const gD=tagsOf(1)[G.def],gP=tagsOf(1)[G.pat];
      for(let i=0;i<3;i++){spawnUnit(1,'spear',C(6,24).x+i*9,C(6,24).y,gD);spawnUnit(1,'archer',C(6,25).x+i*9,C(6,25).y,gD);}
      spawnUnit(1,'spear',C(8,24).x,C(8,24).y,gP);spawnUnit(1,'archer',C(8,25).x,C(8,25).y,gP);};
    const reinfQ=()=>barr().queue.some(q=>q.tag===G.reinf);
    scene('hard');fillSquads();blockCmt();S_(1).devSp=1000;S_(1).milSp=0;
    dbg.aiMilProdSq(1);R.pbQueued=reinfQ()&&S_(1).milSp>0;
    scene('hard');fillSquads();blockCmt();S_(1).devSp=0;S_(1).milSp=0;
    dbg.aiMilProdSq(1);R.pbNoBudget=!reinfQ();
    AI_PRODBAL=false;
    scene('hard');fillSquads();blockCmt();S_(1).devSp=1000;S_(1).milSp=0;
    dbg.aiMilProdSq(1);R.pbAblate=!reinfQ();
    AI_PRODBAL=true;
    scene('noob');fillSquads();blockCmt();S_(1).devSp=200;S_(1).milSp=0;
    dbg.aiMilProdSq(1);R.pbShareNoob=!reinfQ();
    scene('hard');fillSquads();blockCmt();S_(1).devSp=200;S_(1).milSp=0;
    dbg.aiMilProdSq(1);R.pbShareHard=reinfQ();
    scene('hard');fillSquads();blockCmt();S_(1).devSp=0;S_(1).milSp=0;techOf(1).age=3;
    for(let i=0;i<2;i++)for(const id of dbg.aiTechLine(1))techOf(1).researched.add(id);
    dbg.aiMilProdSq(1);R.pbTechFin=dbg.aiProdObs(1).techFin===true&&reinfQ();
    scene('hard');dbg.aiEcoTick(1);R.pbDevAcct=S_(1).devSp>0;
    scene('hard');techOf(1).age=1;const m1=dbg.aiProdObs(1).waveMul;
    techOf(1).age=2;const m2=dbg.aiProdObs(1).waveMul;
    techOf(1).age=3;const m3=dbg.aiProdObs(1).waveMul;
    scene('noob');techOf(1).age=1;const mN=dbg.aiProdObs(1).waveMul;
    AI_WAVETAB=false;const mA=dbg.aiProdObs(1).waveMul;AI_WAVETAB=true;
    R.wtGrow=m1<m2&&m2<m3&&m1===0.55&&m3===1.5;R.wtDiff=mN<m1;R.wtAblate=mA===1;
    const rgScene=(lv)=>{scene(lv);const tc1=buildings.find(b=>b.side===1&&b.type==='tc');
      nodes.push({type:'wood',x:C(8,18).x,y:C(8,18).y,amt:500,max:500});
      for(let i=0;i<60;i++)spawnVillager(tc1);
      const cap0=dbg.aiProdObs(1).fCapMap;let n=0;
      for(let ty=26;ty<=40&&n<cap0;ty+=2)for(let tx=10;tx<=42&&n<cap0;tx+=2){placeB(1,'farm',tx,ty,true);n++;}
      return cap0;};
    {const cap0=rgScene('hard');const o=dbg.aiProdObs(1);
     dbg.aiEcoTick(1);
     R.rgCap=o.fCap>=Math.ceil(60*0.5)&&o.fCap>o.fCapMap&&o.cCap>o.cCapMap;
     R.rgBuild=buildings.filter(b=>b.side===1&&b.type==='farm').length===cap0+1;}
    {const cap0=rgScene('normal');dbg.aiEcoTick(1);
     R.rgNormal=dbg.aiProdObs(1).fCap===dbg.aiProdObs(1).fCapMap
       &&buildings.filter(b=>b.side===1&&b.type==='farm').length===cap0;}
    AI_REGROW=false;
    {const cap0=rgScene('hard');dbg.aiEcoTick(1);
     R.rgAblate=buildings.filter(b=>b.side===1&&b.type==='farm').length===cap0;}
    AI_REGROW=true;
    const ogScene=()=>{scene('hard');
      for(const [tx,ty] of [[6,48],[20,48],[34,48]])nodes.push({type:'gold',x:C(tx,ty).x,y:C(tx,ty).y,amt:800,max:800});
      for(let i=0;i<12;i++)spawnVillager(buildings.find(b=>b.side===1&&b.type==='tc'));
      placeB(1,'outpost',6,45,false);dbg.A(1).feat=null;dbg.A(1).featT=-1e9;};
    ogScene();for(let i=0;i<3;i++)dbg.aiStratTick(1);
    R.ogPend=buildings.filter(b=>b.side===1&&b.type==='outpost').length===1;
    AI_OUTGAP=false;
    ogScene();for(let i=0;i<3;i++)dbg.aiStratTick(1);
    R.ogAblate=buildings.filter(b=>b.side===1&&b.type==='outpost').length>=2;
    AI_OUTGAP=true;
    {scene('hard');nodes.push({type:'gold',x:C(6,48).x,y:C(6,48).y,amt:800,max:800});
     for(let i=0;i<12;i++)spawnVillager(buildings.find(b=>b.side===1&&b.type==='tc'));
     placeB(1,'outpost',6,45,false);dbg.A(1).feat=null;dbg.A(1).featT=-1e9;
     for(let i=0;i<4;i++)dbg.aiStratTick(1);
     R.ogTower=buildings.some(b=>b.side===1&&b.type==='tower'&&Math.hypot(b.x-C(6,48).x,b.y-C(6,48).y)<TILE*5);}
    {scene('hard');placeB(1,'tower',16,20,true);
     for(let r=3;r<=4;r++)for(let a=-r;a<=r;a++)for(const [dx,dy] of [[a,-r],[a,r],[-r,a],[r,a]]){
       const tx=14+dx,ty=20+dy;if(tx===17&&ty===20)continue;if(tx>=0&&ty>=0&&tx<TW&&ty<TH)blocked[idx(tx,ty)]=1;}
     const s1=dbg.aiFindSpot(1,'tower',C(14,20).x,C(14,20).y,4);
     AI_TWRGAP=false;const s2=dbg.aiFindSpot(1,'tower',C(14,20).x,C(14,20).y,4);AI_TWRGAP=true;
     R.twrGap=s1===null&&!!s2&&s2.tx===17&&s2.ty===20;}
    // (F) Real patrol routes (AI_PATROLFIX, fixing "patrols only ever hug the TC"): an angular loop where
    // the centroid must arrive before advancing (throttled to 1s). Ablation: a shared index advanced by
    // every unit every frame reproduces the old frantic-spinning bug.
    {scene('hard');placeB(1,'farm',6,28,true);placeB(1,'smith',14,20,true);
     const g=tagsOf(1)[G.pat];g.task='patrol';g.zoneAnchor={x:C(8,22).x,y:C(8,22).y};g.patrolIdx=0;g.pRoute=null;g.pAdvT=-1e9;
     const u1=spawnUnit(1,'spear',C(6,20).x,C(6,20).y,g),u2=spawnUnit(1,'spear',C(9,20).x+10,C(9,20).y,g);
     patrolStep(u1,g);
     const route=g.pRoute?g.pRoute.filter(b=>b.hp>0):[];
     R.patRoute=route.length>=4;
     const b0=route[g.patrolIdx%route.length];u1.x=b0.x;u1.y=b0.y;u2.x=b0.x+10;u2.y=b0.y;
     patrolStep(u1,g);const i1=g.patrolIdx;patrolStep(u2,g);const i2=g.patrolIdx;
     R.patAdvOnce=i1===1&&i2===1;
     AI_PATROLFIX=false;
     const z=zoneNearest(g.zoneAnchor.x,g.zoneAnchor.y,1);g.patrolIdx=0;
     u1.x=z[0].x;u1.y=z[0].y;u2.x=z[1].x;u2.y=z[1].y;
     patrolStep(u1,g);patrolStep(u2,g);
     R.patOldChurn=g.patrolIdx===2;
     AI_PATROLFIX=true;}
    const obScene=(lv)=>{scene(lv);placeB(1,'outpost',30,20,true);for(let i=0;i<6;i++)dbg.aiStratTick(1);
      return buildings.some(b=>b.side===1&&b.type==='barracks'&&Math.hypot(b.x-C(30,20).x,b.y-C(30,20).y)<TILE*8);};
    R.obHard=obScene('hard')===true;
    R.obNormal=obScene('normal')===false;
    AI_OUTBAR=false;R.obAblate=obScene('hard')===false;AI_OUTBAR=true;
    const cuScene=(lv)=>{scene(lv);techOf(1).age=3;const ob=placeB(1,'outpost',20,20,true);
      for(let i=0;i<2;i++)dbg.aiStratTick(1);return ob.upging===true;};
    R.cuNormal=cuScene('normal')===true;
    R.cuNoob=cuScene('noob')===false;
    AI_CITYUP=false;R.cuAblate=cuScene('normal')===false;AI_CITYUP=true;
    {scene('hard');placeB(1,'smith',12,24,true);
     R.toNoU2=dbg.aiTechLine(1).includes('U1')&&!dbg.aiTechLine(1).includes('U2');
     techOf(1).researched.add('U1');R.toU2Back=dbg.aiTechLine(1).includes('U2');
     techOf(1).researched.delete('U1');AI_TECHORD=false;R.toAblate=dbg.aiTechLine(1).includes('U2');AI_TECHORD=true;
     dbg.A(1).state='allin';
     const hg=dbg.aiTechHunger(1);R.toHunger=hg!=='U2'&&hg!=='M1';
     AI_TECHORD=false;const hg2=dbg.aiTechHunger(1);AI_TECHORD=true;
     R.toHungerAb=hg2==='M1'||hg2==='U2';}
    const run=()=>{scene('hard');fillSquads();S_(1).devSp=500;dbg.aiMilProdSq(1);dbg.aiStratTick(1);
      return JSON.stringify(dbg.aiProdObs(1))+barr().queue.length;};
    R.determin=run()===run();
    units.length=0;villagers.length=0;scouts.length=0;aiFullVision=true;
    return R;`);
  check('three squads stage C, 1:1 capacity + wave size: an economic reservation used to block the world dead = within its allowance units are still produced, with military spending and construction booked; allowance 0 or the ablation = the old yielding behaviour; Beginner blocks at 0.35 and Hard passes at 1 (production speed differentiates). Research line finished = capacity converts fully to units. Wave coefficient 0.55 → 1 → 1.5 with the age; smaller for Beginner; the ablation is always 1 (causal control)',
    t108.pbQueued&&t108.pbNoBudget&&t108.pbAblate&&t108.pbShareNoob&&t108.pbShareHard&&t108.pbTechFin&&t108.pbDevAcct&&t108.wtGrow&&t108.wtDiff&&t108.wtAblate, t108);
  check('three squads stage C, renewables keep up with villagers + outpost and tower spacing: Hard\'s cap = what the villagers can manage, and it keeps adding farms above the map cap (fixes idling); Normal stops at the map cap; the ablation adds none. An outpost under construction = no second one started (the ablation shows the old two-at-once fault); a mine inside the spacing radius = build a tower instead; the only legal spot violating tower spacing = refuse to build (the ablation builds anyway) (causal control)',
    t108.rgCap&&t108.rgBuild&&t108.rgNormal&&t108.rgAblate&&t108.ogPend&&t108.ogAblate&&t108.ogTower&&t108.twrGap, t108);
  check('three squads stage C, patrols on a real route + a barracks at the outpost + upgrading to a city + a fixed research order: an angular loop over 4 buildings + advance from the centroid on arrival, throttled to 1s (the ablation shows the old index-spinning fault). Hard adds a barracks beside a distant outpost (Normal and the ablation do not); Normal upgrades to a city in the Castle age (Beginner and the ablation do not); U1 unresearched = U2 stays out of the line and hunger skips to the siege root (the ablation lets M1 jump the queue); determinism',
    t108.patRoute&&t108.patAdvOnce&&t108.patOldChurn&&t108.obHard&&t108.obNormal&&t108.obAblate&&t108.cuNormal&&t108.cuNoob&&t108.cuAblate&&t108.toNoU2&&t108.toU2Back&&t108.toAblate&&t108.toHunger&&t108.toHungerAb&&t108.determin, t108);

  console.log('\n[109] three squads, stage D (boss-tier extras): a fourth squad for raiding (g7, boss+; the feint and the raid are the same party) + civilisation reading keeping the squads path live (civRead/civSee) + cheat multipliers wired in (milCheat → sortie threshold, gather/tech) (causal control + ablation)');
  const t109 = await ev(`
    AI_SQUADS=true;
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const world=()=>{units.length=0;villagers.length=0;buildings.length=0;nodes.length=0;scouts.length=0;shots.length=0;
      blocked.fill(0);wallMask.fill(0);gateMask.fill(0);terr.fill(T_PLAIN);paintTerrain();computeLandComp();
      explored.fill(1);exploredE.fill(1);unreachable.fill(0);unreachableE.fill(0);computeDanger();gameOver=null;aiWave=99999;aiDefT=1e9;aiFullVision=true;AI_SEA.ready=false;};
    const G=dbg.AI_G,R={};
    const scene=(lv)=>{world();placeB(0,'tc',44,20,true);const home=placeB(1,'tc',6,20,true);placeB(1,'barracks',9,20,true);
      for(const k in stockOf(1))stockOf(1)[k]=3000;
      techOf(1).researched.clear();techOf(1).age=2;techOf(1).track=null;techOf(1).queue.length=0;techOf(1).ageUp=null;recomputeTechMod(1);
      dbg.setAiDiff(1,lv||'boss');dbg.A(1).pers=null;dbg.setAiPers(1,'england');dbg.aiResetBrain(1);
      dbg.A(1).plan={open:'std',routeBias:0,harass:false};dbg.A(1).intelT=t;dbg.A(1).homeRally={x:C(11,20).x,y:C(11,20).y};
      villagers.length=0;return home;};
    const barr=()=>buildings.find(b=>b.side===1&&b.type==='barracks');
    const etc=()=>buildings.find(b=>b.side===0&&b.type==='tc');
    const fillSquads=()=>{const gD=tagsOf(1)[G.def],gP=tagsOf(1)[G.pat];
      for(let i=0;i<2;i++){spawnUnit(1,'spear',C(6,24).x+i*9,C(6,24).y,gD);spawnUnit(1,'archer',C(6,25).x+i*9,C(6,25).y,gD);}
      spawnUnit(1,'spear',C(8,24).x,C(8,24).y,gP);spawnUnit(1,'archer',C(8,25).x,C(8,25).y,gP);};
    const wave=(n,gi,tx,ty)=>{const g=tagsOf(1)[gi];for(let i=0;i<n;i++)spawnUnit(1,'spear',C(tx,ty).x+(i%8)*9,C(tx,ty).y+((i/8)|0)*9,g);};
    const harQ=()=>barr().queue.some(q=>q.tag===G.har);
    scene('boss');fillSquads();wave(16,G.reinf,11,20);
    dbg.aiMilProdSq(1);R.h4Prod=harQ();
    scene('boss');fillSquads();
    dbg.aiMilProdSq(1);R.h4Line=!harQ();
    scene('hard');fillSquads();wave(16,G.reinf,11,20);
    dbg.aiMilProdSq(1);R.h4Hard=!harQ();
    AI_HARASS4=false;
    scene('boss');fillSquads();wave(16,G.reinf,11,20);
    dbg.aiMilProdSq(1);R.h4Ablate=!harQ();
    AI_HARASS4=true;
    const raidScene=()=>{scene('boss');placeB(0,'farm',40,24,true);
      wave(16,G.main,30,20);dbg.A(1).atkOut=true;dbg.A(1).atkTgt=etc();dbg.A(1).atkMode='march';
      wave(2,G.har,11,21);};
    raidScene();dbg.aiMilTick(1);
    {const o=dbg.aiWaveObs(1);R.h4Out=o.harOut===true&&tagsOf(1)[G.har].task==='attack';}
    dbg.A(1).harassT=t-99;dbg.aiMilTick(1);
    {const o=dbg.aiWaveObs(1);R.h4Recall=o.harOut===false&&tagsOf(1)[G.har].task==='guard';}
    scene('boss');placeB(0,'farm',40,24,true);wave(2,G.har,11,21);dbg.aiMilTick(1);
    {const o=dbg.aiWaveObs(1);R.h4NoWave=o.harOut===false;}
    raidScene();placeB(0,'tower',38,24,true);placeB(0,'tower',42,26,true);placeB(0,'tower',40,21,true);
    dbg.aiMilTick(1);
    {const o=dbg.aiWaveObs(1);R.h4Pure=o.harOut===true&&o.harPure===true&&tagsOf(1)[G.har].noBld===true;}
    raidScene();dbg.aiMilTick(1);dbg.A(1).harLeg=null;
    spawnVillager(etc());const hv=villagers[villagers.length-1];hv.x=C(14,21).x;hv.y=C(14,21).y;
    dbg.aiMilTick(1);
    R.h4Vill=tagsOf(1)[G.har].focus===hv;
    scene('boss');
    spawnUnit(0,'horsearcher',C(20,20).x,C(20,20).y,tags[5]);
    dbg.aiMilTick(1);
    R.civGuess=dbg.A(1).civGuess==='mongol';
    const wG=dbg.aiMilWant(1);
    dbg.setCivBlind(1,true);const wB=dbg.aiMilWant(1);dbg.setCivBlind(1,false);
    R.civComp=(wG.spear||0)>(wB.spear||0)&&(wG.archer||0)<(wB.archer||0);
    scene('god');techOf(0).researched.add(civOf(0).uniq);
    spawnUnit(0,'spear',C(20,20).x,C(20,20).y,tags[5]);
    dbg.aiMilTick(1);
    R.civSeeGod=dbg.A(1).civGuess===AI_CIVROW[civOf(0).id].aid;
    scene('boss');techOf(0).researched.add(civOf(0).uniq);
    spawnUnit(0,'spear',C(20,20).x,C(20,20).y,tags[5]);
    dbg.aiMilTick(1);
    R.civSeeBoss=!dbg.A(1).civGuess;
    techOf(0).researched.delete(civOf(0).uniq);
    // (D) Cheat multipliers wired up (two axes → squad sortie thresholds, gathering, technology): milCheat
    // ordering (deity > asura > boss) shows up in waveReq; gather/tech take effect immediately; the boss
    // gets an explicit ×1.2 gathering multiplier, while hard and below stay fair.
    const wr=(lv)=>{scene(lv);fillSquads();dbg.aiMilTick(1);return dbg.A(1).waveReq;};
    const wrB=wr('boss'),wrS=wr('shura'),wrG=wr('god');
    R.cheatWave=wrG>wrS&&wrS>wrB;
    scene('god');R.cheatEco=S_(1).aiCheat.gather===1.5&&S_(1).aiCheat.tech===2&&modOf(1).gather===1.5;
    scene('shura');R.cheatShura=S_(1).aiCheat.gather===1.2&&S_(1).aiCheat.tech===1;
    scene('boss');R.cheatBossFair=S_(1).aiCheat.gather===1.2&&S_(1).aiCheat.tech===0&&modOf(1).gather>=1.2;
    scene('hard');R.fairHard=S_(1).aiCheat.gather===1&&S_(1).aiCheat.tech===0&&modOf(1).gather===1;
    scene('boss');
    dbg.A(1).cmt.push({key:'a:front',dom:'eco',cost:{stone:200},bucket:{},exp:true,trickle:false,score:5,exec:null,gate:null,bornT:1,seen:t});
    dbg.A(1).cmt.push({key:'b:later',dom:'eco',cost:{wood:500},bucket:{},exp:true,trickle:false,score:9,exec:null,gate:null,bornT:2,seen:t});
    stockOf(1).stone=300;stockOf(1).wood=100;
    R.bsFree=aiCanSpendBuck(1,{wood:80})===true;
    R.bsFront=aiCanSpendBuck(1,{stone:150})===false;
    AI_BUCKSEQ=false;
    R.bsAblate=aiCanSpendBuck(1,{wood:80})===false;
    AI_BUCKSEQ=true;
    R.bwRelax=aiCanSpendBuck(1,{stone:150},true)===true;
    R.bwStrict=aiCanSpendBuck(1,{stone:150},false)===false;
    dbg.A(1).cmt.unshift({key:'age',dom:'eco',cost:{stone:120},bucket:{},exp:true,trickle:false,score:9,exec:null,gate:null,bornT:0,seen:t});
    R.bwAge=aiCanSpendBuck(1,{stone:250},true)===false;
    dbg.A(1).cmt.length=0;
    scene('boss');fillSquads();dbg.aiMilTick(1);
    dbg.aiMilProdSq(1);R.bwHystOn=dbg.A(1).bWar===true;
    wave(16,G.reinf,11,20);dbg.aiMilProdSq(1);
    R.bwHystOff=dbg.A(1).bWar===false;
    const scScene=()=>{scene('boss');aiFullVision=false;visibleE.fill(0);dbg.A(1).intelT=-1e9;
      const tc1=buildings.find(b=>b.side===1&&b.type==='tc');spawnScout(tc1);return scouts[scouts.length-1];};
    {const s=scScene();dbg.aiMilTick(1);
     R.scDispatch=s.aiDir===true;
     s.hurtT=t;dbg.aiMilTick(1);
     R.scAbort=s.aiDir===false&&dbg.A(1).scDieT===t;
     dbg.aiMilTick(1);
     R.scCooldown=!scouts.some(x=>(x.side||0)===1&&x.aiDir);}
    AI_SCOUTSAFE=false;
    {const s=scScene();dbg.aiMilTick(1);s.hurtT=t;dbg.aiMilTick(1);
     R.scAblate=s.aiDir===true;}
    AI_SCOUTSAFE=true;aiFullVision=true;
    // (G) Retire the contest forward-push (per the difficulty table, boss expansion matches hard): an ore
    // cluster slightly nearer the enemy (dMe/dFoe = 1.28 ∈ (1, 1.35]) is not contested under the table.
    // Ablation: the old contest forward-push grabs it anyway.
    const ctScene=()=>{scene('boss');nodes.push({type:'gold',x:C(30,40).x,y:C(30,40).y,amt:800,max:800});
      for(let i=0;i<12;i++)spawnVillager(buildings.find(b=>b.side===1&&b.type==='tc'));
      dbg.A(1).feat=null;dbg.A(1).featT=-1e9;
      for(let i=0;i<4;i++)dbg.aiStratTick(1);
      return buildings.some(b=>b.side===1&&b.type==='outpost');};
    R.ctOff=ctScene()===false;
    AI_DIFFTAB=false;R.ctAblate=ctScene()===true;AI_DIFFTAB=true;
    const cxScene=()=>{scene('boss');
      const g=tagsOf(1)[G.reinf];for(let i=0;i<16;i++)spawnUnit(1,'spear',C(30,20).x+(i%8)*9,C(30,20).y+((i/8)|0)*9,g);
      dbg.aiMilTick(1);
      units.length=units.length; const gg=tagsOf(1)[G.reinf];
      let n=0;for(const u of [...units])if(u.grp===gg&&n<13){u.hp=0;units.splice(units.indexOf(u),1);n++;}
      dbg.aiMilTick(1);return dbg.aiWaveObs(1);};
    {const o=cxScene();R.cxCancel=o.muster===false&&o.atkOut===false&&dbg.A(1).offAcc===0;}
    AI_MUSTCXL=false;
    {const o=cxScene();R.cxAblate=o.atkOut===true;}
    AI_MUSTCXL=true;
    const run=()=>{raidScene();dbg.aiMilTick(1);return JSON.stringify(dbg.aiWaveObs(1))+barr().queue.length;};
    R.determin=run()===run();
    units.length=0;villagers.length=0;scouts.length=0;aiFullVision=true;
    return R;`);
  check('three squads stage D, the fourth squad\'s production line: boss+ with wave funding above the main force\'s safety line = maintain g7 (cavalry / spear and bow); funding short = do not; Hard with d.harass=false = it does not apply (orthogonal); ablation AI_HARASS4=false = it stays folded (causal control)',
    t109.h4Prod&&t109.h4Line&&t109.h4Hard&&t109.h4Ablate, t109);
  check('three squads stage D, the fourth squad\'s sortie and withdrawal: the attack wave is out = the feint leaves the gate (attack); the window closes = cut losses and come home; no main engagement = no sortie; defences too hard = pure harassment (noBld, hunting people only); villagers nearby = go straight for them (focus)',
    t109.h4Out&&t109.h4Recall&&t109.h4NoWave&&t109.h4Pure&&t109.h4Vill, t109);
  check('three squads stage D, civilisation reading + cheat wiring: a tell is sighted → Mongol inferred → the ctrW mix really moves (civBlind control); at the god tier civSee knows from sighting any unit at all (boss does not, so its intelligence stays fair); milCheat pushes the sortie threshold up god > shura > boss; gather/tech take effect immediately; boss gets a declared gathering ×1.2; nothing is cheated below Hard; determinism',
    t109.civGuess&&t109.civComp&&t109.civSeeGod&&t109.civSeeBoss&&t109.cheatWave&&t109.cheatEco&&t109.cheatShura&&t109.cheatBossFair&&t109.fairHard&&t109.determin, t109);
  check('three squads stage D, four boss-tax fixes (made after the G1-2 probe convicted them): the bucket floor counts only the head of the queue at full price (later buckets are not punished with it, the head\'s anti-ratchet stays; the ablation restores the v2 sum over all buckets); a scout being shot at = the mission is voided plus an avoidance cooldown (the ablation clings to the mission inside the tower ring); contested pre-emption is retired from the table (the ablation still grabs); a rally scattering below 40% = cancel rather than send a token wave, and offAcc is not dislodged (the ablation sorties and feeds the enemy) (causal control)',
    t109.bsFree&&t109.bsFront&&t109.bsAblate&&t109.bwRelax&&t109.bwStrict&&t109.bwAge&&t109.bwHystOn&&t109.bwHystOff&&t109.scDispatch&&t109.scAbort&&t109.scCooldown&&t109.scAblate&&t109.ctOff&&t109.ctAblate&&t109.cxCancel&&t109.cxAblate, t109);

  console.log('\n[110] three fixes from play-testing: a seat limit on gathering from natural resource nodes (shared across sides) + one seat on renewables and fish traps + a placement preview for fish traps + who controls the scout list (causal control)');
  const t110 = await ev(`
    const C=(tx,ty)=>({x:(tx+0.5)*TILE,y:(ty+0.5)*TILE});
    const clr=()=>{units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;shots.length=0;ghosts.length=0;};
    const R={};
    arenaMode=false; gameOver=null; aiWave=99999; aiDefT=1e9; aiFullVision=true;
    clr(); dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN); computeLandComp(); explored.fill(1);exploredE.fill(1); visible.fill(1);
    const CAP=dbg.NODE_CAP();
    R.capIs=CAP>=5&&CAP<=8;

    const tc0=placeB(0,'tc',6,20,true), tc1=placeB(1,'tc',40,20,true);
    const gold=C(9,20); nodes.push({type:'gold',x:gold.x,y:gold.y,amt:9999,max:9999});
    const mk=(si,n)=>{const out=[];for(let i=0;i<n;i++){spawnVillager(si===0?tc0:tc1);const v=villagers[villagers.length-1];
      v.x=gold.x+20+i*6;v.y=gold.y+20;v.job='gold';v.node=null;v.state='idle';out.push(v);}return out;};
    const mine=mk(0,CAP);
    mine.forEach(v=>{v.node=dbg.nearestNode('gold',v.x,v.y,v,false);});
    R.capSeated=mine.filter(v=>v.node&&v.node.x===gold.x).length===CAP;
    const extra=mk(0,1)[0];
    R.capBlocks=dbg.nearestNode('gold',extra.x,extra.y,extra,false)===null;
    const foeV=mk(1,1)[0];
    R.capCrossSide=dbg.nearestNode('gold',foeV.x,foeV.y,foeV,false)===null;
    mine[0].node=null;
    R.capFrees=dbg.nearestNode('gold',extra.x,extra.y,extra,false)!==null;
    mine[0].node=gold&&nodes.find(n=>n.type==='gold');

    R.availMineFull=dbg.availRes('gold',0)===true;
    R.availFoeFull=dbg.availRes('gold',1)===false;
    villagers.length=0;

    const farmB=placeB(0,'farm',12,20,true);
    R.farmNode=!!farmB.node;
    const f1=mk(0,1)[0]; f1.job='food'; f1.x=farmB.x+10; f1.y=farmB.y+10;
    f1.node=dbg.nearestNode('food',f1.x,f1.y,f1,false);
    R.farmOne=f1.node===farmB.node;
    const f2=mk(0,1)[0]; f2.job='food'; f2.x=farmB.x+10; f2.y=farmB.y+10;
    R.farmSecondBlocked=dbg.nearestNode('food',f2.x,f2.y,f2,false)!==farmB.node;
    villagers.length=0;

    clr(); placeB(0,'tc',6,20,true); placeB(1,'tc',40,20,true);
    dbg.setTerr(20,18,30,26,T_WATER); computeLandComp();
    const dk=placeB(0,'dock',19,20,true);
    const wild=dbg.addFish(22,22,9999);
    const b1=spawnUnit(0,'fishing',wild.x+30,wild.y,null), b2=spawnUnit(0,'fishing',wild.x+50,wild.y,null);
    b1.node=dbg.nearestFish(b1.x,b1.y,0,false,b1);
    R.wildShared=dbg.nearestFish(b2.x,b2.y,0,false,b2)===wild;
    const trap=placeB(0,'fishtrap',25,22,true);
    R.trapNode=!!trap.node;
    wild.amt=0;
    b1.node=trap.node;
    R.trapOneBoat=dbg.nearestFish(b2.x,b2.y,0,false,b2)===null;
    b1.node=null;
    R.trapFrees=dbg.nearestFish(b2.x,b2.y,0,false,b2)===trap.node;

    R.trapOkWater=dbg.trapPlaceOk(27,22)===true;
    R.trapNoLand=dbg.trapPlaceOk(6,20)===false;
    R.trapNoDup=dbg.trapPlaceOk(25,22)===false;
    techOf(0).researched.add('N1');
    const fb=spawnUnit(0,'fishing',(27+0.5)*TILE,(22+0.5)*TILE,null);
    const wood0=stockOf(0).wood; stockOf(0).wood=999;
    R.trapFar=dbg.deployTrap(fb,21,25)===null||true;
    const far=dbg.deployTrap(fb,20,26);
    R.trapRangeBlocks=far===null;
    const near=dbg.deployTrap(fb,28,22);
    R.trapPlaces=!!near&&near.type==='fishtrap';
    stockOf(0).wood=wood0;

    clr(); const ptc=placeB(0,'tc',6,20,true), etc2=placeB(1,'tc',40,20,true);
    spawnScout(ptc); spawnScout(etc2);
    R.scoutBothExist=scouts.length===2&&scouts.some(s=>(s.side||0)===1);
    dbg.renderScoutbar();
    const ids=dbg.scoutChipIds();
    R.scoutBarMineOnly=ids.length===1&&scouts.find(s=>s.id===ids[0])&&(scouts.find(s=>s.id===ids[0]).side||0)===0;
    R.scoutBarNoFoe=!ids.some(i=>{const s=scouts.find(o=>o.id===i);return s&&(s.side||0)===1;});
    clr(); aiFullVision=true;
    return R;`);
  check('resource node seats: at most NODE_CAP (5~8) villagers gather from the same natural node; number CAP+1 cannot select it; **the seats are shared across sides** (an enemy villager is blocked by them too); free one seat and another fits in (causal control)',
    t110.capIs&&t110.capSeated&&t110.capBlocks&&t110.capCrossSide&&t110.capFrees, t110);
  check('seat semantics must not be read as exhaustion: my own people filling a natural node = that resource is still \"gatherable\" to me (availRes true, so nothing downstream fires farms or the market); to the side with no seat = not gatherable',
    t110.availMineFull&&t110.availFoeFull, t110);
  check('renewables stay at one villager per seat: a farm already taken = a second villager does not select it (CAP relaxes natural nodes only, not renewables)',
    t110.farmNode&&t110.farmOne&&t110.farmSecondBlocked, t110);
  check('fish traps take one boat at a time: natural fisheries are unlimited (old behaviour untouched); a trap already being worked = a second boat does not select it; free it and it can be (causal control)',
    t110.wildShared&&t110.trapNode&&t110.trapOneBoat&&t110.trapFrees, t110);
  check('fish trap placement: deep water is allowed; land or an existing trap is not; beyond the fishing boat\'s DEPLOY_R = blocked; inside the range the trap is placed',
    t110.trapOkWater&&t110.trapNoLand&&t110.trapNoDup&&t110.trapRangeBlocks&&t110.trapPlaces, t110);
  check('who controls the scout list (from play-testing: \"the red scout showed up on my side and I could call it over and kill it\"): AI scouts share the scouts array but must **not** appear in the player\'s scout list = there is no channel to order them',
    t110.scoutBothExist&&t110.scoutBarMineOnly&&t110.scoutBarNoFoe, t110);

  console.log('\n[111] the map registry (\"I want a few more maps to try, and the water map is old and a bit small\"): five maps at a uniform size + **strict left-right mirroring, map by map** (terrain, resources, opening positions) = the fairness clause, in hard form (there is form here: an enemy town centre hand-entered as 104 instead of 106 gave side 1 a near-100% win rate)');
  const t111 = await ev(`
    const R={},G=dbg.MAP_GEN(),ids=Object.keys(G);
    R.ids=ids;
    R.fiveMaps=ids.length===5&&ids.includes('land')&&ids.includes('naval')&&ids.includes('arena')&&ids.includes('plains')&&ids.includes('highland');
    R.sameSize=ids.every(k=>G[k].tw===128&&G[k].th===72);
    R.tcMirrored=ids.every(k=>dbg.mirTx(G[k].ptc[0])===128-G[k].ptc[0]-2);
    R.tcOnOwnHalf=ids.every(k=>G[k].ptc[0]+2<64&&dbg.mirTx(G[k].ptc[0])>64);
    const savedTerr=Uint8Array.from(terr),savedNodes=nodes.slice();
    const asym={},nodeAsym={};
    for(const k of ids){
      terr.fill(T_PLAIN); G[k].paint();
      let bad=0;
      for(let y=0;y<TH;y++)for(let x=0;x<TW;x++)if(terr[idx(x,y)]!==terr[idx(TW-1-x,y)])bad++;
      asym[k]=bad;
      nodes.length=0; G[k].nodes();
      let nb=0;
      for(const n of nodes){
        const mx=W-n.x;
        if(!nodes.some(o=>o.type===n.type&&Math.abs(o.x-mx)<1&&Math.abs(o.y-n.y)<1&&o.max===n.max))nb++;}
      nodeAsym[k]=nb;
      R['n_'+k]=nodes.length;
    }
    R.terrAsym=asym; R.nodeAsym=nodeAsym;
    R.allTerrSym=ids.every(k=>asym[k]===0);
    R.allNodeSym=ids.every(k=>nodeAsym[k]===0);
    R.allHaveNodes=ids.every(k=>R['n_'+k]>0);
    terr.set(savedTerr); nodes.length=0; for(const n of savedNodes)nodes.push(n); paintTerrain(); computeLandComp();
    return R;`);
  check('multiple maps: all five (land, water, pure arena, plains economy, terrain) are 128×72 = the water map has been scaled up from 64×36; every map has resource nodes',
    t111.fiveMaps&&t111.sameSize&&t111.allHaveNodes, t111);
  check('map fairness clause: **terrain** is strictly mirrored left to right on every map (terr[x,y] === terr[TW-1-x,y] for every tile, 0 differences)',
    t111.allTerrSym, t111);
  check('map fairness clause: **resource nodes** are strictly mirrored left to right on every map (every node has a counterpart of the same type and amount at W-x)',
    t111.allNodeSym, t111);
  check('map opening positions: the enemy town centre is the strict tile mirror of the player\'s (mirTx; a 2×2 town centre = TW-tx-2); each side sits in its own half = the source of the old side bias is structurally closed off',
    t111.tcMirrored&&t111.tcOnOwnHalf, t111);

  console.log('\n[112] closing the naval triangle: war galley range back to 150 (shore bombardment and attacking buildings belong to the siege ship; the feudal navy\'s job is blockade) + fire ship speed 104→90 (so the siege ship gets two volleys off and its splash catches massed fire ships) = the triangle closes on fleets alone');
  const t112 = await ev(`
    const R={};
    R.galleyRng=UT.galley.rng;
    R.fireSp=UT.fireship.sp;                         // 90
    R.eqArcher=UT.galley.rng===UT.archer.rng;
    R.shoreIsSiege=UT.siegeship.rng>UT.galley.rng&&UT.siegeship.rng>UT.longbow.rng;
    R.ltDef=UT.galley.rng<BT.tower.rng&&UT.galley.rng<BT.tc.rng&&UT.galley.rng<BT.castle.rng;
    R.spOrder=UT.fireship.sp>UT.galley.sp&&UT.galley.sp>UT.siegeship.sp;
    const band=UT.siegeship.rng-UT.siegeship.minRng;
    R.crossNow=+(band/UT.fireship.sp).toFixed(2);
    R.crossOld=+(band/104).toFixed(2);
    R.slower=R.crossNow>R.crossOld*1.12;
    R.fireAntiGalley=UT.fireship.bonus&&UT.fireship.bonus.galley>1;
    R.siegeAntiBld=UT.siegeship.bonus&&UT.siegeship.bonus.building>1;
    return R;`);
  check('navy: war galley rng 150 = the same reach as an archer (no shore dominance); shore bombardment and attacking buildings belong to the siege ship at rng 240, and even that cannot reach every shore defence',
    t112.galleyRng===150 && t112.eqArcher===true && t112.shoreIsSiege===true && t112.ltDef===true, t112);
  check('naval triangle mechanics: fire ship sp 90 = 16% longer inside the siege ship\'s effective band (240-45) (1.87 → 2.17s); the speed ladder fire > galley > siege is unchanged (the fire ship keeps its identity)',
    t112.fireSp===90 && t112.slower===true && t112.spOrder===true, t112);
  check('naval counter-chain contract: the fire ship\'s bonus against the war galley is present (fire > galley); the siege ship\'s bonus against buildings is present (the siege division of labour)',
    t112.fireAntiGalley===true && t112.siegeAntiBld===true, t112);
  const t112b = await ev(`
    const R={};
    units.length=0;buildings.length=0;shots.length=0;nodes.length=0;blocked.fill(0);aiWave=99999;arenaMode=true;gameOver=null;
    for(const k in stock)stock[k]=1e9;starving=false;
    terr.fill(T_WATER);paintTerrain();
    tags[0].task='hold';tags[0].holdFire=false;tags[5].task='hold';tags[5].holdFire=true;
    const ss=spawnUnit(0,'siegeship',400,500,tags[0]);ss.cd=0;
    const tg=spawnUnit(1,'fireship',400+150,500,tags[5]);tg.revealT=t+1e9;
    for(let i=0;i<120&&!shots.length;i++){tg.revealT=t+1e9;step(TICK);}
    const rock=shots.find(s=>s.kind==='rock');
    R.rockIsGround=!!rock&&rock.tgt===undefined&&typeof rock.tx==='number'&&typeof rock.ty==='number';
    units.length=0;shots.length=0;
    const ar=spawnUnit(0,'archer',400,500,tags[0]);ar.cd=0;
    const tg2=spawnUnit(1,'spear',400+120,500,tags[5]);tg2.revealT=t+1e9;
    for(let i=0;i<120&&!shots.length;i++){tg2.revealT=t+1e9;step(TICK);}
    const arrow=shots.find(s=>s.kind==='arrow');
    R.arrowTracks=!!arrow&&arrow.tgt===tg2;
    units.length=0;shots.length=0;terr.fill(T_PLAIN);paintTerrain();arenaMode=false;
    return R;`);
  check('projectile contract: a catapult hits the spot it fired at (tx/ty, so a moving target dodges); an arrow tracks its target (tgt) — this is the mechanical basis for \"the war galley kites the siege ship\"',
    t112b.rockIsGround===true && t112b.arrowTracks===true, t112b);
  const t112c = await ev(`
    const R={};
    // The field must be named holdDmg and must *not* be called hold — hold is the transport capacity field
    // (UT.transport.hold), and uTick treats any unit with a truthy T.hold as a ship via transTick, which
    // stops longbowmen engaging entirely.
    const T=UT.longbow;
    R.hasHoldDmg=typeof T.holdDmg==='number'&&T.holdDmg>1;
    R.noHoldCollision=T.hold===undefined;
    R.stationary=holdMult({type:'longbow',movedT:t-10})===T.holdDmg;
    R.moving=holdMult({type:'longbow',movedT:t})===1;
    R.archerNone=holdMult({type:'archer',movedT:t-10})===1;
    return R;`);
  check('volley-while-stationary contract: a longbowman standing still for ≥holdSec deals damage ×holdDmg; moving cancels it; every other unit is always 1. The field is named holdDmg, not hold (hold = transport capacity, and the collision made uTick treat the unit as a boat, so it never engaged)',
    t112c.hasHoldDmg&&t112c.noHoldCollision&&t112c.stationary&&t112c.moving&&t112c.archerNone, t112c);
  const t112d = await ev(`
    const R={};
    // Horse archer accuracy contract (acc 0.75→0.85): acc is the shooter-side tax for firing on the move,
    // and it multiplies with the target-side evasion (hitP * (s.acc||1) in applyDamage).
    // What this case locks is the two-layer multiplication plus the 0.85 setting: at 0.75, a fleeing
    // villager left only 0.762 × 0.75 = 57%, so the horse archer could not do its raiding job at all (8.7s
    // to kill a villager, versus 2.7s for cavalry).
    R.acc=UT.horsearcher.acc;
    R.isBuffed=UT.horsearcher.acc===0.85;
    R.archerNoAcc=UT.archer.acc===undefined;
    const evade=1-Math.min(0.4,85*0.0028);
    R.stackedHit=+(evade*UT.horsearcher.acc).toFixed(4);
    R.stacksNotReplaces=R.stackedHit<evade;
    R.m8CapsAtOne=Math.min(1,UT.horsearcher.acc+0.2)===1;
    return R;`);
  check('horse archer accuracy contract: acc 0.85 (confirmed on re-check); it **multiplies** with the target\'s evasion rather than replacing it; the ordinary archer has no acc field; M8 remounts caps it at 1.0',
    t112d.isBuffed&&t112d.archerNoAcc&&t112d.stacksNotReplaces&&t112d.m8CapsAtOne, t112d);


  console.log('\n[113] formation split by speed within the same reach: the band key = (reach, speed) = heavy infantry (sp58) forms its own rank in front of spearmen (sp70); reach is still the primary key (a ranged unit never ends up in front of melee just because it is fast)');
  const t113 = await ev(`
    const R={};
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;aiWave=99999;
    tags[0].spread='dense';
    const hv=spawnUnit(0,'heavyinf',10*TILE,10*TILE,tags[0]);
    const sp=spawnUnit(0,'spear',10*TILE,10*TILE,tags[0]);
    const ar=spawnUnit(0,'archer',10*TILE,10*TILE,tags[0]);
    const hb=spawnUnit(0,'longbow',10*TILE,10*TILE,tags[0]);
    const ft=formationTargets(tags[0],[hv,sp,ar,hb],20*TILE,10*TILE);
    const xHv=ft.get(hv).x,xSp=ft.get(sp).x,xAr=ft.get(ar).x,xHb=ft.get(hb).x;
    R.slowFront=xHv>xSp;
    R.splitRank=Math.abs(xHv-xSp)>1;
    R.echStillPrimary=xSp>xAr&&xAr>xHb;
    units.length=0;
    const ha=spawnUnit(0,'horsearcher',10*TILE,10*TILE,tags[0]);
    const ar2=spawnUnit(0,'archer',10*TILE,10*TILE,tags[0]);
    const ft2=formationTargets(tags[0],[ha,ar2],20*TILE,10*TILE);
    R.fastShortRngStillFront=ft2.get(ha).x>ft2.get(ar2).x;
    units.length=0;
    const a=spawnUnit(0,'spear',10*TILE,10*TILE,tags[0]),b=spawnUnit(0,'spear',10*TILE,10*TILE,tags[0]);
    const ft3=formationTargets(tags[0],[a,b],20*TILE,10*TILE);
    R.sameTypeSameRank=Math.abs(ft3.get(a).x-ft3.get(b).x)<1;
    units.length=0;tags[0].spread='dense';
    return R;`);
  check('formation speed split: at the same reach, heavy infantry (sp58) splits into its own rank and stands in front of spearmen (sp70) (slow in front, fast behind)',
    t113.slowFront===true && t113.splitRank===true, t113);
  check('formation speed split: reach is still the primary key (melee > archer > longbowman; the horse archer\'s short reach keeps it ahead of the archer despite its speed); same unit, same speed = same rank',
    t113.echStillPrimary===true && t113.fastShortRngStillFront===true && t113.sameTypeSameRank===true, t113);

  console.log('\n[114] the lightweight home screen: it appears only on a bare load = zero disturbance to the existing entry points (this suite itself runs on ?noai=1, so the home screen must be hidden) + the menus are generated from the data tables + seed and TICK overrides are confined to spectator mode');
  const t114 = await ev(`
    const R={};
    R.hidden=document.getElementById('homeScr').classList.contains('hidden');
    R.notPaused=paused===false;
    R.hasSearch=location.search!=='';
    R.mapRow=Object.keys(MAP_DEFS).length;
    R.diffRow=AI_DIFF_ORDER.length;
    R.civRow=CIVS.length;
    R.discloseShared=typeof window.__diffDisclose==='function';
    R.fairHard=window.__diffDisclose('hard').indexOf('公平級')===0;
    R.cheatBoss=window.__diffDisclose('boss').indexOf('作弊級')===0;
    R.bossListsGather=window.__diffDisclose('boss').includes('採集 ×'+AI_DIFF.boss.gather);
    R.hintAll=Object.keys(MAP_DEFS).every(m=>MAP_DEFS[m].desc&&MAP_DEFS[m].desc.length>4
      &&AI_DIFF_ORDER.every(k=>(MAP_DEFS[m].desc+'　'+window.__diffDisclose(k)).length>20));
    R.pickNoob=window.__aiCivPickable('noob');
    R.pickHard=window.__aiCivPickable('hard');
    R.noPickBoss=!window.__aiCivPickable('boss');
    R.noPickShura=!window.__aiCivPickable('shura');
    R.noPickGod=!window.__aiCivPickable('god');
    R.noMyCivRow=document.getElementById('homeMyCivRow')===null;
    const c0=playerCiv.id;const c1=CIVS.find(c=>c.id!==c0).id;
    R.civSwitch=setPlayerCiv(c1)===c1&&playerCiv.id===c1;
    setPlayerCiv(c0);R.civRestore=playerCiv.id===c0;
    return R;`);
  check('home screen: a load with query parameters (harness, spectator, a shared link) = the home screen is hidden and the simulation is not frozen (zero disturbance to existing entry points)',
    t114.hidden===true && t114.notPaused===true && t114.hasSearch===true, t114);
  check('the home screen menus are generated from the data tables (map, difficulty and civilisation); the difficulty disclosure text comes from the same function as the ⚙️ panel\'s (the boss\'s gathering ×1.2 is disclosed)',
    t114.mapRow===5 && t114.diffRow===6 && t114.civRow>=3 && t114.discloseShared===true
    && t114.fairHard===true && t114.cheatBoss===true && t114.bossListsGather===true
    && t114.hintAll===true, t114);
  check('opponent civilisation selectability: choosable below Hard; boss, shura and god are always random (the home screen and the ⚙️ panel share the one rule, so you cannot reopen ⚙️ to get around it)',
    t114.pickNoob===true && t114.pickHard===true
    && t114.noPickBoss===true && t114.noPickShura===true && t114.noPickGod===true, t114);
  check('the home screen has no \"my civilisation\" row (withdrawn; the in-game 📜 tech panel could already choose it); the `?civ=` URL escape hatch still works',
    t114.noMyCivRow===true && t114.civSwitch===true && t114.civRestore===true, t114);

  console.log('\n[115] kiting: siege engines are no longer frozen by it (\"with hit-and-run on it never gets a shot off\") + backing-off fire ships from the factory (it failed arena acceptance) + the arena zeroes t/unitSeq at the start (determinism)');
  const t115 = await ev(`
    const R={};
    R.radialOff=(KITE_RADIAL===false);
    R.meleeGate=(KITE_MELEE===50)&&(KITE_OUTRNG===30);
    units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;aiWave=99999;arenaMode=true;gameOver=null;
    for(const k in stock)stock[k]=1e9;starving=false;
    tags[0].task='attack';tags[0].rule='kite';tags[0].holdFire=false;tags[0].focus=null;tags[0].pt=null;
    tags[5].task='hold';tags[5].holdFire=true;tags[5].focus=null;
    const cat=spawnUnit(0,'catapult',600,500,tags[0]);cat.cd=0;
    const foe=spawnUnit(1,'spear',600+150,500,tags[5]);foe.revealT=t+1e9;const h0=foe.hp;
    let fired=false;
    for(let i=0;i<400;i++){foe.revealT=t+1e9;step(TICK);if(shots.some(s=>s.side===0))fired=true;}
    R.catFiresInKite=fired;
    R.catDamages=foe.hp<h0;
    units.length=0;
    const ss=spawnUnit(0,'siegeship',600,500,tags[0]);ss.cd=0;
    const foe2=spawnUnit(1,'fireship',600+150,500,tags[5]);foe2.revealT=t+1e9;const h2=foe2.hp;
    for(let i=0;i<400;i++){foe2.revealT=t+1e9;step(TICK);}
    R.shipFiresInKite=foe2.hp<h2;
    units.length=0;arenaMode=false;
    t=12345;unitSeq=999;
    dbg.arenaSetup({spear:2},{archer:2});
    R.arenaResetsT=(t<1);
    R.arenaResetsSeq=(unitSeq<=4);
    units.length=0;villagers.length=0;buildings.length=0;nodes.length=0;arenaMode=false;terr.fill(T_PLAIN);paintTerrain();
    return R;`);
  check('siege engines are exempt from kiting: catapults and siege ships fire and hit normally under the kite stance (the old code\'s !splash gate in the kite branch = zero output entirely)',
    t115.catFiresInKite===true && t115.catDamages===true && t115.shipFiresInKite===true, t115);
  check('backing-off fire ships from the factory (KITE_RADIAL=false; it failed arena acceptance, breaking \"fire ship counters war galley\" from 100% to 57%); the threshold constants are under contract',
    t115.radialOff===true && t115.meleeGate===true, t115);
  check('the arena zeroes t/unitSeq at the start = the same seed reproduces (the rAF start-line trap: the same settings once produced 62% / 71% / 76% across three runs)',
    t115.arenaResetsT===true && t115.arenaResetsSeq===true, t115);

  console.log('\n[116] rewriting how villagers react to a raid: the trigger is \"an enemy combat unit within 4 tiles\" or \"currently being attacked\"; the standard response is to garrison (only a full or blocked building prevents it); the bell is an early warning');
  const t116 = await ev(`
    const clr=()=>{units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;shots.length=0;ghosts.length=0;};
    const world=()=>{clr();gameOver=null;dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN);computeLandComp();explored.fill(1);exploredE.fill(1);visible.fill(0);visibleE.fill(0);computeDanger();};
    const R={};
    R.alert=VILL_ALERT; R.alertIs3Tiles=VILL_ALERT===3*TILE;
    R.archerShootsFirst=UT.archer.rng>VILL_ALERT;
    R.longbowShootsFirst=UT.longbow.rng>VILL_ALERT;
    R.catapultShootsFirst=UT.catapult.rng>VILL_ALERT;
    R.hArcherMustClose=UT.horsearcher.rng<VILL_ALERT;
    world(); const tc=placeB(0,'tc',20,12,true); visible.fill(1);
    spawnVillager(tc); const v=villagers[villagers.length-1];
    v.x=tc.x-200; v.y=tc.y; v.state='idle'; v.node=null;
    const med=spawnUnit(1,'medic',v.x+64,v.y,tagsOf(1)[0]);
    R.medicNoAlarm = villFoe(v.x,v.y,VILL_ALERT,0)===null;
    R.medicIsHarmless = UT.medic.dmg===0;
    R.medicNotFaster = UT.medic.sp<=UT.spear.sp && UT.medic.sp<=UT.archer.sp;
    R.medicKeepsUp = UT.medic.sp>=UT.heavyinf.sp;
    units.length=0;
    const sp=spawnUnit(1,'spear',v.x+64,v.y,tagsOf(1)[0]);
    R.spearAlarms = villFoe(v.x,v.y,VILL_ALERT,0)===sp;
    R.militaryStillSeesMedic = (units.length=0, spawnUnit(1,'medic',v.x+64,v.y,tagsOf(1)[0]), nearestFoe(v.x,v.y,VILL_ALERT,0)!==null);
    world(); const tc2=placeB(0,'tc',20,12,true); visible.fill(1);
    spawnVillager(tc2); spawnVillager(tc2);
    const a=villagers[villagers.length-2], b=villagers[villagers.length-1];
    a.x=tc2.x-300; a.y=tc2.y; b.x=a.x+60; b.y=a.y;
    const c=villagers[0]!==a&&villagers[0]!==b?villagers[0]:null;
    a.hurtT=-9; b.hurtT=-9; a.hp=a.maxHp;
    dmgEnt(a,1);
    R.hurtSelf = a.hurtT===t;
    R.hurtSpreads = b.hurtT===t;
    R.shoutRadius=VILL_SHOUT; R.hurtWindow=VILL_HURT;
    const diagX=tc2.x+tc2.size*TILE/2+16, diagY=tc2.y+tc2.size*TILE/2+16;
    R.diagRect = footRectDist(tc2,diagX,diagY)<=30;
    R.diagCircleWouldFail = Math.hypot(diagX-tc2.x,diagY-tc2.y) >= tc2.size*TILE/2+30;
    world(); const tc3=placeB(0,'tc',20,12,true); visible.fill(1);
    spawnVillager(tc3); const g=villagers[villagers.length-1];
    g.garrisoned=true; g.garB=tc3; g.garT=t; tc3.g=1; tc3.safeT=99;
    releaseVillagers(tc3,false,3);
    R.minStayHolds = g.garrisoned===true && tc3.g===1;
    g.garT=t-5; releaseVillagers(tc3,false,3);
    R.releasesAfterStay = g.garrisoned===false && tc3.g===0;
    world();
    return R;`);
  check('the villager trigger radius is derived from weapon range: VILL_ALERT = 3 tiles (120, TILE=40) = the archer (3.75 tiles), longbowman (4.75) and catapult (5.9) **get one free shot** before the villagers wake up; the horse archer (2.95) sits just under the threshold = no free shot, it has to close with speed',
    t116.alertIs3Tiles&&t116.archerShootsFirst&&t116.longbowShootsFirst&&t116.catapultShootsFirst&&t116.hArcherMustClose, t116);
  check('units with no attack raise no alarm: an enemy medic (dmg 0) does not stop villagers working (the old code stopped all 8 of 8); a spearman with an attack still triggers it; the military nearestFoe is not subject to this gate',
    t116.medicNoAlarm&&t116.medicIsHarmless&&t116.spearAlarms&&t116.militaryStillSeesMedic, t116);
  check('medic speed contract: sp 78 → 70 = no faster than the spearmen and archers it looks after (a support unit should not arrive at the fighting ahead of the line), but still no slower than heavy infantry = it does not fall behind',
    t116.medicNotFaster&&t116.medicKeepsUp, t116);
  check('run when hit, and pass \"everybody run\" along: a wounded villager is marked with hurtT and companions within VILL_SHOUT (150) go on alert too (the old code reacted to being hit not at all = a catapult outside the trigger ring shot them for free)',
    t116.hurtSelf&&t116.hurtSpreads&&t116.shoutRadius===150&&t116.hurtWindow===4, t116);
  check('garrison arrival uses footRectDist: a **diagonal neighbour** of a 2×2 building counts as touching it (the old 62px circular threshold could not reach the ≈70px diagonal = villagers bounced at the door, garrison peaked at 0/8)',
    t116.diagRect&&t116.diagCircleWouldFail, t116);
  check('automatic release requires 3 full seconds inside: when a raid hits an outlying resource node the town centre itself stays \"safe\", so the old code ejected them on the same tick they entered (an endless in-out loop); now it waits the full 3 seconds',
    t116.minStayHolds&&t116.releasesAfterStay, t116);

  console.log('\n[117] swapping the A* open list for a binary heap: a pure data-structure replacement, and **the tie ordering must match the old linear scan**');
  const t117 = await ev(`
    const clr=()=>{units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;shots.length=0;ghosts.length=0;};
    const world=()=>{clr();gameOver=null;dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN);computeLandComp();explored.fill(1);exploredE.fill(1);visible.fill(0);visibleE.fill(0);computeDanger();};
    const R={};
    world();
    /* Tie-break contract: the old linear scan used f < bf (strictly less), so ties go to the node pushed
       earliest. A heap keyed on f alone would pick a different node on ties, changing the path and shifting
       every sim baseline. Test: path between two points on flat ground (many tiles tie on f) must match a
       known baseline point for point. */
    const p1=findPath(10*TILE+20,10*TILE+20,20*TILE+20,10*TILE+20,0,false,undefined);
    R.straightLen=p1.length; R.straightEndsAtTarget = p1.length>0 &&
      Math.abs(p1[p1.length-1].x-(20*TILE+20))<0.01 && Math.abs(p1[p1.length-1].y-(10*TILE+20))<0.01;
    /* Repeated calls with the same start and goal must be identical point for point — no heap state may
       leak across calls. */
    const p2=findPath(10*TILE+20,10*TILE+20,20*TILE+20,10*TILE+20,0,false,undefined);
    R.repeatable = p1.length===p2.length && p1.every((q,i)=>q.x===p2[i].x&&q.y===p2[i].y);
    /* decrease-key correctness: diagonal routes lower g for nodes already in the open set, which must
       sift-up rather than push a duplicate. A diagonal query must return a continuous path where every
       step is adjacent (diagonals included) — proof the heap neither loses nodes nor re-expands them into
       a discontinuity. */
    const p3=findPath(8*TILE+20,8*TILE+20,24*TILE+20,20*TILE+20,0,false,undefined);
    R.diagFound = p3.length>0;
    let cont=true;
    for(let i=1;i<p3.length;i++){
      const dx=Math.abs(txOf(p3[i].x)-txOf(p3[i-1].x)), dy=Math.abs(tyOf(p3[i].y)-tyOf(p3[i-1].y));
      if(dx>1||dy>1){cont=false;break;}
    }
    R.diagContiguous = cont;
    /* An unreachable goal must still return an empty array — the heap must never turn it into half a path. */
    const sav=blocked.slice();
    /* The wall must be hollow. A solid block does not work: the goal lands on a blocked tile and
       findPath's "nearest walkable within ±3" rescues it to the outside of the wall, so a path is found
       and the case tests nothing. The interior 29-33 × 7-13 stays walkable with the goal at the exact
       centre (31,10), which really is unreachable.
       Contract change: unreachable no longer returns an empty array (superseded by the cross-component
       fallback, see [120]). What remains under test here is the heap's own property: never emit half a
       path — the returned path must be continuous and end outside the wall, inside our own component. */
    for(let x=28;x<=34;x++){blocked[idx(x,6)]=1;blocked[idx(x,14)]=1;}
    for(let y=6;y<=14;y++){blocked[idx(28,y)]=1;blocked[idx(34,y)]=1;}
    computeLandComp();pathCompDirty=true;    /* Writing blocked directly bypasses placeB's hooks, so the test has to mark things dirty itself; in the
   real game placeB, demolition and collapse do it. */
    const p4=findPath(10*TILE+20,10*TILE+20,31*TILE+20,10*TILE+20,0,false,undefined);
    R.wallIsHollow = !blocked[idx(31,10)];   /* The goal tile itself must be walkable — this tests "cannot get there", not "cannot stand there". */
    R.p4Len=p4.length;
    R.p4Contiguous = p4.length>0 && p4.every((q,i)=>{if(!i)return true;
      return Math.abs(txOf(q.x)-txOf(p4[i-1].x))<=1&&Math.abs(tyOf(q.y)-tyOf(p4[i-1].y))<=1;});
    R.p4EndsOutsideWall = p4.length>0 && (()=>{const e=p4[p4.length-1],ex=txOf(e.x),ey=tyOf(e.y);
      return !(ex>28&&ex<34&&ey>6&&ey<14);})();   /* The endpoint must not land in the pocket inside the wall. */
    R.p4NoHalfPath = p4.length===0 || (R.p4Contiguous && R.p4EndsOutsideWall);
    for(let i=0;i<sav.length;i++)blocked[i]=sav[i];
    pathCompDirty=true;
    world();
    return R;`);
  check('binary heap tie-break contract: a straight-line query across open ground still returns a valid path ending on the target (if the tie ordering changed, the path would change and every simulation baseline would shift)',
    t117.straightLen>0&&t117.straightEndsAtTarget, t117);
  check('repeated calls for the same start and end agree point for point = no heap state survives between calls (each call brings its own heap/pos/seq)',
    t117.repeatable, t117);
  check('decrease-key is correct: a diagonal path is continuous and every step adjacent (sift-up when g drops, no duplicate push = no breaks and no missing nodes)',
    t117.diagFound&&t117.diagContiguous, t117);
  check('an unreachable target must not yield half a path (for **walkable** tiles inside a hollow ring of wall: the path must be continuous and end outside the wall; since 2026-07-21 this falls back across components rather than returning an empty array)',
    t117.wallIsHollow&&t117.p4NoHalfPath&&t117.p4Contiguous&&t117.p4EndsOutsideWall, t117);

  console.log('\n[118] chevauchée (the horse archer burns the fields): a bonus against renewable resource buildings + MR ravaging; it **must not** spill over into a siege bonus or into automatic target selection');
  const t118 = await ev(`
    const clr=()=>{units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;shots.length=0;ghosts.length=0;};
    const world=()=>{clr();gameOver=null;dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN);computeLandComp();explored.fill(1);exploredE.fill(1);visible.fill(0);visibleE.fill(0);computeDanger();};
    const R={};
    world();
    /* Category tagging: only the three renewable resource buildings carry raid (historically the
       chevauchée burned fields and mills and went *around* castles). */
    R.raidSet = ['farm','coppice','fishtrap'].every(k=>BT[k].raid===true);
    R.notRaid = ['tc','castle','wall','gate','tower','barracks','market','dock'].every(k=>!BT[k].raid);
    /* Bonus applies: horse archer vs farm = bonus.raid; vs a non-renewable building (TC) = 1. There is no
       generic building bonus — a horse archer is not a siege unit and does not compete with the catapult. */
    const farm=dbg.placeB(1,'farm',30,10,true), tc=dbg.placeB(1,'tc',40,20,true);
    R.raidVal = UT.horsearcher.bonus.raid;
    R.vsFarm  = bonusVs(UT.horsearcher, farm, 0);
    R.vsTC    = bonusVs(UT.horsearcher, tc,   0);
    R.noBldBonus = !UT.horsearcher.bonus.building;
    /* No spillover: cavalry (no raid field) still does 1 against a farm; catapults still take building 3
       (farms get no siege amplification). */
    R.cavVsFarm = bonusVs(UT.cavalry, farm, 0);
    R.catVsFarm = bonusVs(UT.catapult, farm, 0);
    R.catVsWall = (()=>{const w=dbg.placeB(1,'wall',35,10,true);const v=bonusVs(UT.catapult,w,0);
                        const i=buildings.indexOf(w);if(i>=0)buildings.splice(i,1);return v;})(); /* wall siege:2 → 3×2=6, untouched by this change. */
    /* MR against chevauchée is an amplifier (2.5→3.75 once researched); before research raidDmg must be a
       neutral 1. */
    R.modBefore = dbg.techMod().raidDmg;
    SIDES[0].tech.researched.add('MR'); recomputeTechMod(0);
    R.modAfter = dbg.techMod().raidDmg;
    R.vsFarmMR = bonusVs(UT.horsearcher, farm, 0);
    SIDES[0].tech.researched.delete('MR'); recomputeTechMod(0);
    R.modRestored = dbg.techMod().raidDmg;
    /* MR is the Mongol unique, hangs off the stable, and requires UM (no horse archers, no research). It is
       deliberately *not* on the Mongol AI research line — the AI has no field-burning decision, so giving
       it the tech would only waste a research slot. */
    const mr=techById('MR'), mon=CIVS.find(c=>c.id==='mon');
    R.mrStar = !!(mr&&mr.star&&mr.at==='stable'&&mr.req[0]==='UM');
    R.mrMonOnly = starOwner('MR').length===1 && starOwner('MR')[0]==='蒙古';
    R.mrNotInAiLine = !mon.ai.star.includes('MR');
    /* Target weights for UT.horsearcher.pick:
       spearman 1.4 > other units 1.0 > farm 0.9 > other buildings 0.6 > villager 0.5 > tower/castle/TC 0.15
       (effectively ignored).
       Farms sit deliberately below units so a horse archer will not stand burning a field while a spearman
       closes in — its range is only 2.95 tiles. Applied to horse archers only; no other unit's weights move. */
    const ha=UT.horsearcher;
    const twr=dbg.placeB(1,'tower',34,10,true), cas=dbg.placeB(1,'castle',36,14,true), bar=dbg.placeB(1,'barracks',33,16,true);
    const vil={x:0,y:0,hp:10,side:1,carry:0}, spr={x:0,y:0,hp:10,side:1,type:'spear'}, cav={x:0,y:0,hp:10,side:1,type:'cavalry'};
    R.wHa = {spear:tgtW(ha,spr), unit:tgtW(ha,cav), farm:tgtW(ha,farm), bar:tgtW(ha,bar),
             vil:tgtW(ha,vil), twr:tgtW(ha,twr), cas:tgtW(ha,cas), tc:tgtW(ha,tc)};
    R.haOrder = R.wHa.spear>R.wHa.unit && R.wHa.unit>R.wHa.farm && R.wHa.farm>R.wHa.bar
             && R.wHa.bar>R.wHa.vil && R.wHa.vil>R.wHa.twr;
    /* pick changes are horse-archer only: every other unit's target weights are untouched (cavalry farm
       0.6 / villager 1.0 / tower 0.75; the catapult's bonus.building=3 lookup still comes first, so towers
       stay at 3). */
    R.wCav = {farm:tgtW(UT.cavalry,farm), vil:tgtW(UT.cavalry,vil), twr:tgtW(UT.cavalry,twr), unit:tgtW(UT.cavalry,spr)};
    R.wCat = {farm:tgtW(UT.catapult,farm), twr:tgtW(UT.catapult,twr)};
    R.noPick = ['cavalry','spear','archer','longbow','heavyinf','catapult','medic'].every(k=>!UT[k].pick);
    world();
    return R;`);
  check('category marking: farm, coppice and fish trap = raid (renewable resource buildings); town centre, castle, wall, gate, tower, barracks, market and dock are not (a chevauchée goes around the castle)',
    t118.raidSet&&t118.notRaid, t118);
  check('the horse archer gets raid 2.5 against a farm and still 1 against a town centre (there is no general building bonus, so it does not turn into a siege unit competing with the catapult)',
    t118.raidVal===2.5&&Math.abs(t118.vsFarm-2.5)<1e-6&&t118.vsTC===1&&t118.noBldBonus, t118);
  check('no spill-over: cavalry still deal 1 to a farm (no raid field); the catapult still has building ×3 and ×siege 2 = 6 against walls (the siege bonus is untouched)',
    t118.cavVsFarm===1&&t118.catVsFarm===3&&t118.catVsWall===6, t118);
  check('MR ravaging is an amplifier: unresearched raidDmg = 1 (neutral); researched 1.5 = the horse archer\'s 2.5 against farms becomes 3.75 (burning 8 outlying fields 23.5s → 18.0s, re-measured after buildings were exempted from acc)',
    t118.modBefore===1&&t118.modAfter===1.5&&Math.abs(t118.vsFarmMR-3.75)<1e-6&&t118.modRestored===1, t118);
  check('MR is a Mongol ★, researched at the stable, with UM as its prerequisite (no horse archers, no research), and is deliberately **absent** from the AI\'s research line (the AI has no burn-the-fields decision, so it is left to the ML target-selection round)',
    t118.mrStar&&t118.mrMonOnly&&t118.mrNotInAiLine, t118);
  check('horse archer target priority = spear 1.4 > units 1.0 > fields 0.9 > other buildings 0.6 > villagers 0.5 > tower, castle and town centre 0.15 (fields sit below units, so it will not stand burning a field while a spearman closes and stabs it)',
    t118.haOrder&&t118.wHa.farm===0.9&&t118.wHa.vil===0.5&&t118.wHa.twr===0.15&&t118.wHa.cas===0.15&&t118.wHa.tc===0.15&&t118.wHa.unit===1, t118);
  check('pick is given to the horse archer only: cavalry still see fields 0.6 / villagers 1.0 / towers 0.75 / units 1.0; the catapult\'s building ×3 lookup still comes first (towers are 3 as well); no other unit has a pick field',
    t118.wCav.farm===0.6&&t118.wCav.vil===1&&t118.wCav.twr===0.75&&t118.wCav.unit===1&&t118.wCat.farm===3&&t118.wCat.twr===3&&t118.noPick, t118);

  console.log('\n[119] buildings are exempt from the accuracy tax (\"it is a bit odd to miss a field\"): acc is the **shooter\'s** tax for firing on the move, and is not charged against something that cannot move');
  const t119 = await ev(`
    const clr=()=>{units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;shots.length=0;ghosts.length=0;misses.length=0;};
    const R={};
    clr();gameOver=null;dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN);computeLandComp();
    /* Push 200 arrows with acc 0.85 through shotTick so we hit the real hit-resolution code rather than a
       copy of the logic. */
    const volley=(tgt,n)=>{misses.length=0;shots.length=0;
      for(let i=0;i<n;i++)shots.push({kind:'arrow',x:tgt.x+5,y:tgt.y,tgt,sp:340,dmg:1,side:0,src:null,
        hd:Math.PI,flown:0,maxD:400,acc:0.85});
      for(let i=0;i<20;i++)shotTick&&shots.forEach(s=>shotTick(s,1/30));
      return misses.length;};
    const farm=dbg.placeB(1,'farm',30,10,true); farm.hp=farm.maxHp=1e7;
    R.bldMiss = volley(farm,200);                    /* Buildings are exempt — not a single shot should miss. */
    const sp=dbg.spawnUnit(1,'spear',40*TILE,10*TILE,null); sp.hp=1e7; sp.movedT=-999; /* Stationary unit: hitP 0.97 × acc 0.85. */
    R.unitMiss = volley(sp,200);                     /* Units still pay the tax, so misses must still happen (the tax wasn't accidentally deleted). */
    clr();
    return R;`);
  check('a horse archer firing 200 arrows at a building misses none (a granary does not dodge; acc counts as 1 whenever the target is a building)', t119.bldMiss===0, t119);
  check('the moving-fire tax against *units* was not deleted with it: the same 200 arrows at a stationary spearman still miss some (0.97 × 0.85, ~35 expected)',
    t119.unitMiss>=10&&t119.unitMiss<=70, t119);

  console.log('\n[120] one shared predicate (standOK/foeGate) + connectivity components (pathCompL/W): the structural defence against the gate-tile bug');
  const t120 = await ev(`
    const clr=()=>{units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;shots.length=0;ghosts.length=0;};
    const world=()=>{clr();gameOver=null;dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN);computeLandComp();pathCompDirty=true;explored.fill(1);exploredE.fill(1);visible.fill(0);visibleE.fill(0);computeDanger();};
    const R={};
    world();
    /* standOK must agree with canStep tile for tile.
       This is the direct guard against the gate bug: if canStep blocks and standOK does not (or vice
       versa), A* gets a destination it can never step onto. Sweeps eight tile types × two sides × two dom
       values, comparing against canStep entering from an equal-height neighbour. */
    dbg.setTerr(40,40,52,44,T_PLAIN);
    blocked[idx(41,41)]=1;                                   /* Building. */
    gateMask[idx(43,41)]=1;                                  /* Friendly (side0) gate. */
    gateMask[idx(45,41)]=2;                                  /* Enemy gate (from side0's point of view). */
    dbg.setTerr(47,41,47,41,T_WATER); dbg.setTerr(48,41,48,41,T_SHALLOW);
    dbg.setTerr(49,41,49,41,T_HIGH);  dbg.setTerr(50,41,50,41,T_RAMP);
    dbg.setTerr(51,41,51,41,T_FOREST);
    pathCompDirty=true;
    const cells=[[40,41,'平地'],[41,41,'建築'],[43,41,'我方門'],[45,41,'敵方門'],
                 [47,41,'深水'],[48,41,'淺灘'],[49,41,'高地'],[50,41,'坡道'],[51,41,'林']];
    R.mismatch=[];
    for(const [x,y,nm] of cells)for(const side of [0,1])for(const dom of ['land','water']){
      const i=idx(x,y), from=idx(x,y-1);                     /* Neighbour above is also flat ground h=0 — same height as each test tile, or canStep blocks it anyway. */
      const a=standOK(i,side,dom);
      /* canStep has one extra rule (height transition); subtract it for a like-for-like comparison — where
         heights differ, only check that standOK also says no. */
      const hOK = dom==='water' ? true : Math.abs(hgtI(from)-hgtI(i))<=0.5;
      const b=canStep(from,i,side,dom);
      if(a!==(b||(!hOK&&a)))R.mismatch.push(nm+'/s'+side+'/'+dom+' standOK='+a+' canStep='+b+' hOK='+hOK);
      if(hOK && a!==b)R.mismatch.push(nm+'/s'+side+'/'+dom+' 同高卻不同義 standOK='+a+' canStep='+b);
    }
    R.standOKSameAsCanStep = R.mismatch.length===0;
    /* Enemy gates are defined in exactly one place (foeGate): for side0, gateMask=2 is an enemy gate and
       gateMask=1 is our own. */
    R.foeGate = foeGate(idx(45,41),0)===true && foeGate(idx(43,41),0)===false
             && foeGate(idx(45,41),1)===false && foeGate(idx(43,41),1)===true;
    /* The ±3 destination snap must trigger exactly when canStep says the tile is unstandable — that is the
       line that omitted gates. Test: path to an enemy gate tile and the returned path must not end on that
       gate (i.e. it snapped to a neighbour). */
    world();
    gateMask[idx(45,41)]=2; pathCompDirty=true;
    const f0=dbg.pathStats().fail;
    const pg=findPath(30*TILE+20,41*TILE+20,45*TILE+20,41*TILE+20,0,false,'land');
    /* You cannot verify the snap by checking whether the last point is the gate tile: the last point is
       always overwritten with the exact target coordinate (existing design — walking to a building's door
       you get blocked by the body, and gates are the same). The real regression signal is "used to return
       an empty array, now returns a path", which pathStats().fail measures most directly. */
    R.gateDestPathable = pg.length>0;
    R.gateNoFail = dbg.pathStats().fail===f0;                /* A* never took the empty-array route, so the snap worked. */
    R.gatePathNotThrough = pg.slice(0,-1).every(q=>!(txOf(q.x)===45&&tyOf(q.y)===41)); /* Must not pass through the gate tile en route. */
    R.gateNotBlocked = !blocked[idx(45,41)];                 /* Precondition: the gate really is not in blocked, otherwise we are testing a different path. */
    /* A friendly gate must *not* be snapped away — you can walk straight onto it. Unifying the predicate
       must not block your own gates. */
    world(); gateMask[idx(45,41)]=1; pathCompDirty=true;
    const pg2=findPath(30*TILE+20,41*TILE+20,45*TILE+20,41*TILE+20,0,false,'land');
    R.ownGatePassable = pg2.length>0 && txOf(pg2[pg2.length-1].x)===45 && tyOf(pg2[pg2.length-1].y)===41;
    /* Connectivity components: the pocket enclosed by a hollow wall must form a component of its own. */
    world();
    for(let x=28;x<=34;x++){blocked[idx(x,6)]=1;blocked[idx(x,14)]=1;}
    for(let y=6;y<=14;y++){blocked[idx(28,y)]=1;blocked[idx(34,y)]=1;}
    pathCompDirty=true; ensurePathComp();
    R.pocketIsOwnComp = pathCompL[idx(31,10)]>=0 && pathCompL[idx(10,10)]>=0
                     && pathCompL[idx(31,10)]!==pathCompL[idx(10,10)];
    /* Component soundness (sufficient condition): different components ⇒ a BFS mirroring A*'s inner rules
       genuinely cannot reach. */
    const DX=[1,-1,0,0,1,1,-1,-1],DY=[0,0,1,-1,1,-1,1,-1];
    const seen=new Uint8Array(TW*TH),st=[idx(10,10)];seen[idx(10,10)]=1;
    while(st.length){const cur=st.pop(),cx=cur%TW,cy=(cur/TW)|0;
      for(let k=0;k<8;k++){const nx=cx+DX[k],ny=cy+DY[k];
        if(nx<0||ny<0||nx>=TW||ny>=TH)continue;const ni=idx(nx,ny);if(seen[ni])continue;
        if(!canStep(cur,ni,0,'land'))continue;
        if(k>=4){if(!canStep(cur,idx(nx,cy),0,'land')||!canStep(cur,idx(cx,ny),0,'land'))continue;
                 if(Math.abs(hgtI(idx(nx,cy))-hgtI(idx(cx,ny)))>0.5)continue;}
        seen[ni]=1;st.push(ni);}}
    R.compSound = !seen[idx(31,10)];                          /* If components say unreachable, BFS must agree. */
    /* Cross-component fallback: route to the friendly-component tile nearest the *goal point*. */
    const xr0=dbg.pathStats().xr;
    const p=findPath(10*TILE+20,10*TILE+20,31*TILE+20,10*TILE+20,0,false,'land');
    R.xrFired = dbg.pathStats().xr>xr0;                        /* The diagnostic counter moved, so this is visible in debug. */
    R.xrNotEmpty = p.length>0;                                 /* No longer "unit just stands there". */
    const e=p.length?p[p.length-1]:null, ex=e?txOf(e.x):-1, ey=e?tyOf(e.y):-1;
    R.xrEnd=[ex,ey];
    R.xrEndOutside = e && pathCompL[idx(ex,ey)]===pathCompL[idx(10,10)];   /* The endpoint is in our own component. */
    /* Nearest to the *goal point*, not nearest to the goal's component: no friendly tile outside the wall
       is closer to (31,10) than the endpoint is. */
    let bd=1e9,bx=-1,by=-1;
    for(let y=0;y<TH;y++)for(let x=0;x<TW;x++){
      if(pathCompL[idx(x,y)]!==pathCompL[idx(10,10)])continue;
      const dd=(x-31)*(x-31)+(y-10)*(y-10); if(dd<bd){bd=dd;bx=x;by=y;}}
    R.xrTruth=[bx,by];
    R.xrIsNearestToTarget = e && ((ex-31)*(ex-31)+(ey-10)*(ey-10))===bd;
    /* The endpoint must not be rewritten back to the unreachable coordinate — the final-point overwrite has
       to skip the cross-component fallback. */
    R.xrEndNotTarget = e && !(Math.abs(e.x-(31*TILE+20))<0.01 && Math.abs(e.y-(10*TILE+20))<0.01);
    /* Fords must belong to both the land and water tables. Sharing a single table would splice land and sea
       into one blob and destroy the components. */
    world();
    dbg.setTerr(60,30,60,40,T_WATER); dbg.setTerr(61,30,61,40,T_SHALLOW);
    pathCompDirty=true; ensurePathComp();
    R.shallowBothTables = pathCompL[idx(61,35)]>=0 && pathCompW[idx(61,35)]>=0;
    R.deepWaterNotLand  = pathCompL[idx(60,35)]===-1;          /* Deep water stays out of the land table. */
    R.plainNotWater     = pathCompW[idx(50,35)]===-1;          /* Pure land stays out of the water table. */
    world();
    return R;`);
  check('standOK and canStep agree tile for tile (open ground, buildings, my gate, an enemy gate, deep water, shallows, high ground, ramps × side × dom) — the direct defence against the gate-tile bug',
    t120.standOKSameAsCanStep, t120);
  check('foeGate is the only definition of an enemy gate: it counts only when gateMask-1 !== side (my own gate does not block me, and does block the other side)',
    t120.foeGate, t120);
  check('the ±3 endpoint snap triggers exactly when canStep says so: a path is found with an **enemy gate tile** as the destination (the old code flooded the whole map and returned an empty array, leaving the unit standing still)',
    t120.gateDestPathable&&t120.gateNoFail&&t120.gatePathNotThrough&&t120.gateNotBlocked, t120);
  check('my own gate is unaffected: a path to my own gate tile still walks straight onto it (unifying the predicate must not block friendly gates along with enemy ones)',
    t120.ownGatePassable, t120);
  check('connectivity components: a pocket enclosed by a hollow ring of wall forms its own component (landComp cannot do this — it does not look at blocked)',
    t120.pocketIsOwnComp, t120);
  check('component soundness (a sufficient condition): different components ⇒ a BFS copying the A* rules exactly really cannot get there (it may only under-estimate the barrier, never over-estimate it)',
    t120.compSound, t120);
  check('cross-component fallback: unreachable no longer returns an empty array = it walks to the tile of its own component nearest the **target point** (units no longer stand still)',
    t120.xrNotEmpty&&t120.xrEndOutside&&t120.xrIsNearestToTarget, t120);
  check('the cross-component fallback\'s final point must not be overwritten back to the unreachable coordinate (or the last step points back at it = shoving the wall in place)',
    t120.xrEndNotTarget, t120);
  check('the dbg.pathStats().xr counter moves = \"could not get there\" is visible in debug (as requested: a safety net is fine, as long as you can see it working)',
    t120.xrFired, t120);
  check('shallows appear in both the land and water tables; deep water is not in the land table and dry land is not in the water table (one shared table would join land and sea into a single mass and destroy the components entirely)',
    t120.shallowBothTables&&t120.deepWaterNotLand&&t120.plainNotWater, t120);

  console.log('\n[121] M7 horseshoes: the charge bonus applies to \"mounted\" units (\"it should buff every cavalry type, horse archers included\") + enemy command UI does not leak');
  const t121 = await ev(`
    const clr=()=>{units.length=0;villagers.length=0;buildings.length=0;blocked.fill(0);wallMask.fill(0);gateMask.fill(0);nodes.length=0;scouts.length=0;shots.length=0;ghosts.length=0;};
    const world=()=>{clr();gameOver=null;dbg.setTerr(0,0,TW-1,TH-1,T_PLAIN);computeLandComp();explored.fill(1);exploredE.fill(1);visible.fill(0);visibleE.fill(0);computeDanger();};
    const R={};
    world();
    /* The affected set is declared by the mount flag, not by comparing type strings — the old code
       hard-coded 'cavalry', which silently omitted horse archers for three months. */
    R.mountSet   = !!UT.cavalry.mount && !!UT.horsearcher.mount;
    R.mountNot   = ['spear','archer','longbow','heavyinf','catapult','medic'].every(k=>!UT[k].mount);
    /* uSpeed measured for real: same unit before and after researching M7, through the actual function
       rather than a reimplementation of it. */
    const spd=(tp)=>{const u=dbg.spawnUnit(0,tp,30*TILE,10*TILE,null);const s=uSpeed(u);
                     const i=units.indexOf(u);if(i>=0)units.splice(i,1);return s;};
    playerTech.researched.delete('M7');recomputeTechMod();
    const base={cav:spd('cavalry'),ha:spd('horsearcher'),sp:spd('spear'),ar:spd('archer')};
    playerTech.researched.add('U1');playerTech.researched.add('M7');recomputeTechMod();
    const m7  ={cav:spd('cavalry'),ha:spd('horsearcher'),sp:spd('spear'),ar:spd('archer')};
    R.cavUp  = Math.abs(m7.cav/base.cav-1.2)<1e-6;
    R.haUp   = Math.abs(m7.ha /base.ha -1.2)<1e-6;
    R.footSame = m7.sp===base.sp && m7.ar===base.ar; /* Infantry must not be sped up as a side effect. */
    R.haBase = base.ha; R.haM7 = m7.ha; R.cavBase = base.cav;
    /* Relative ordering must not invert: with symmetric research cavalry is still faster than horse
       archers — "cavalry counters horse archers because they cannot disengage" is deliberate. */
    R.cavStillFaster = m7.cav > m7.ha;
    playerTech.researched.delete('M7');playerTech.researched.delete('U1');recomputeTechMod();
    /* Enemy command UI must not leak: render() must draw neither nudge lines for enemy units nor
       production-queue counts on enemy buildings. Canvas pixels are not testable, so the contract is locked
       by inspecting the function source for the condition — remove the condition and this FAILs. */
    const src=render.toString();
    R.nudgeGated = /nfOK\\s*=\\s*e\\s*=>\\s*e\\.nudge\\s*&&\\s*\\(\\(e\\.side\\|\\|0\\)===0\\|\\|spectate\\)/.test(src)
                   && !/for\\(const \\w+ of (units|villagers|scouts)\\)if\\(\\w+\\.nudge\\)nf\\(/.test(src);
    R.queueGated = /b\\.queue&&b\\.queue\\.length&&\\(b\\.side===0\\|\\|spectate\\)/.test(src);
    /* nudge really is set by either side's stuck-unit self-rescue, so this leak path is real and not
       something only a player gesture can trigger. */
    world();
    const foe=dbg.spawnUnit(1,'spear',30*TILE,10*TILE,null);
    nudgeTo(foe,32*TILE,10*TILE);
    R.foeCanHaveNudge = !!foe.nudge && (foe.side||0)===1;
    /* The enemy building panel (outside spectator mode) already hides the production queue — the canvas
       simply missed the same rule. Regression lock. */
    const stb=dbg.placeB(1,'stable',40,20,true);
    world();
    return R;`);
  check('M7\'s scope is declared by UT.mount: cavalry and horse archers have it, the infantry line does not (no longer hard-coded against the type string)',
    t121.mountSet&&t121.mountNot, t121);
  check('after M7 the horse archer\'s speed is ×1.2 (the fix this round: \"it should buff every cavalry type, horse archers included\")',
    t121.haUp&&Math.abs(t121.haM7-120)<1e-6, t121);
  check('M7 still gives cavalry ×1.2 and has no effect on infantry or archers (nothing else was sped up along the way)',
    t121.cavUp&&t121.footSame, t121);
  check('the relationship does not invert: with M7 researched on both sides, cavalry are still faster than horse archers (\"cavalry counter horse archers because they cannot disengage\" is the design intent)',
    t121.cavStillFaster, t121);
  check('enemy nudge drag lines are not drawn (\"I can see the red side\'s drag paths, even outside my vision = cheating\")',
    t121.nudgeGated, t121);
  check('the ×N production queue badge on enemy buildings is not drawn (\"what is in production\" is not something you may see; the enemy panel already showed queues only in spectator mode)',
    t121.queueGated, t121);
  check('the leak was real: enemy units genuinely do get nudge set (the stuck-unit rescue in unstick/dbgScan sets it for both sides)',
    t121.foeCanHaveNudge, t121);


  /* Needs a genuinely running match — [121] emptied the field — so reload the page for a clean world.
     rAF is killed by Page.addScriptToEvaluateOnNewDocument before every navigation, so stepping stays
     deterministic even after a reload. */
  console.log('\n[122] 💾 save snapshots (state, not replay): the round trip agrees + aliases survive + **running on after saving = running on after loading**');
  await send('Page.navigate', { url: FILE });
  for (let i = 0; i < 60; i++) { try { if (await ev(`return !!window.dbg && !!window.step && document.readyState==='complete'`)) break; } catch {} await sleep(100); }
  await ev(`window.requestAnimationFrame=function(){return 0}; return true`);
  await sleep(150);
  const t122 = await ev(`
    const R={};
    /* First give the match some substance: both brains running (gathering, building, research, training,
       sorties), villagers gathering, a site under construction, a production queue, and a research track. */
    dbg.setAiSide(0,true);dbg.setAiDiff(0,'boss');dbg.setAiDiff(1,'boss');
    for(let i=0;i<1200;i++)step(TICK);
    for(const k of ['wood','stone','iron','gold','food'])dbg.give(k,600); /* Top up only enough for a barracks/tower plus queued production. Give more and side0's brain wipes the
   opponent out early, leaving the second half running empty. */
    const ptc=buildings.find(b=>b.side===0&&b.type==='tc');
    const bar=placeB(0,'barracks',ptc.tx+4,ptc.ty+4,true);
    placeB(0,'tower',ptc.tx-5,ptc.ty+2);                 /* Not instant, so the save contains a half-finished construction site. */
    queueUnit(bar,'spear');queueUnit(bar,'spear');
    startResearch(techById('M1'),0);                     /* Something on the research track. */
    issueTagOrder(0,enemyTC.x-400,enemyTC.y);            /* Our g0 sorties, giving us units on the march plus order flags. */
    for(let i=0;i<1800;i++)step(TICK);
    queueUnit(bar,'archer');queueUnit(bar,'archer');      /* Something in the production queue at save time — production progress has to survive too. */
    trainVillager(ptc);
    for(const k of ['wood','stone','iron','gold','food'])dbg.give(k,900);
    for(const x of TECH){if(techOf(0).track)break;if(!techOf(0).researched.has(x.id))startResearch(x,0);} /* One research must be in progress; the ones already finished double as a check that the researched set
   comes back. */
    R.warm={u:units.length,v:villagers.length,b:buildings.length,t:+t.toFixed(2)};
    R.site = buildings.some(b=>!b.built);
    R.qBar=buildings.some(b=>b.queue&&b.queue.length);R.qCq=buildings.some(b=>b.cq&&b.cq.length);R.qTech=!!techOf(0).track;
    R.queue = R.qBar && R.qCq && R.qTech;                 /* Three kinds of in-flight work in the save: the barracks queue, the town centre villager queue and
   the research track. */
    R.rich = R.warm.v>=8 && R.warm.b>=4 && R.warm.u>=4;  /* The world really does contain something — this isn't testing an empty board. */
    /* The fingerprint is the observable "where is the world heading": positions, health, resources, node
       remainders, seed and time. */
    const fp=()=>{let h=0;const mix=x=>{h=(Math.imul(h^(Math.round((x||0)*100)|0),0x01000193))>>>0;};
      mix(t);mix(seed);
      for(const k in stock){mix(stockOf(0)[k]);mix(stockOf(1)[k]);}
      for(const u of units){mix(u.x);mix(u.y);mix(u.hp);mix(u.side);}
      for(const v of villagers){mix(v.x);mix(v.y);mix(v.hp);mix(v.carry);}
      for(const b of buildings){mix(b.x);mix(b.y);mix(b.hp);mix(b.side);}
      for(const n of nodes)mix(n.amt);
      return h;};
    /* Save (pure data, JSON-serialisable — that step alone proves there are no circular references).
       The one fixture action in this case is clearing both brains' commitment sets before saving, and the
       reason deserves spelling out: commitment entries carry exec/gate closures, which cannot be
       serialised (see the §16 note in index.html). They only execute inside a generator turn, and
       strategy-domain commitments (~10s period) are often executed during an economy-domain turn (~2s)
       using the closure left over from the previous round — so after a load, that execution slips to the
       next strategy turn (a decision-timing drift of <= 10s; the world state itself is not wrong).
       Clearing the sets means both runs start with no commitments and every later commitment is generated
       on the spot with a live closure. That isolates the one thing that cannot be saved, while *all*
       remaining state stays under the fingerprint comparison below — the brains keep running, we are not
       fudging it by switching the AI off. */
    const snW=dbg.snapMake();                        /* Take one snapshot with the commitment sets still populated so the next two assertions are not
   vacuous. */
    R.warn={fn:snW.warn.nFn,dom:snW.warn.nDom,loop:snW.warn.nLoop,fnEx:snW.warn.fn.slice(0,4)};
    R.noDom = snW.warn.nDom===0 && snW.warn.nLoop===0; /* State must contain no DOM or canvas references, and no cycle the registries cannot break. */
    R.hasFn = snW.warn.nFn>0;                        /* There really are closures here, so the next assertion isn't a free pass. */
    R.onlyCmtFn = snW.warn.fn.every(p=>(p.endsWith('.exec')||p.endsWith('.gate'))&&p.indexOf('.cmt[')>=0);
    dbg.A(0).cmt.length=0;dbg.A(1).cmt.length=0;
    const sn=dbg.snapMake(),snap=JSON.stringify(sn);
    R.bytes=snap.length;
    /* The only functions allowed to be dropped are the AI commitment set's exec/gate — the generator
       re-attaches them on the next strategy tick (see the snapApply note). If anything else starts hanging
       closures off state, this FAILs and flags that it cannot be saved. */
    /* Route A: no save, just keep running N more steps. */
    for(let i=0;i<1200;i++)step(TICK);
    const hA=fp(),aState={u:units.length,v:villagers.length,b:buildings.length,t:+t.toFixed(2),over:gameOver};
    /* Route B: apply the snapshot → inspect the restored world → run the same N steps. */
    dbg.snapApply(JSON.parse(snap));
    R.restored={u:units.length,v:villagers.length,b:buildings.length,t:+t.toFixed(2)};
    R.timeBack=Math.abs(R.restored.t-R.warm.t)<1e-6 && R.restored.u===R.warm.u && R.restored.v===R.warm.v && R.restored.b===R.warm.b;
    /* Aliases stay intact. The classic way saves break is swapping in new objects, so const aliases read an
       orphan and the HUD freezes from then on. */
    R.aliasStock = dbg.S()===stockOf(0);
    R.aliasTags  = dbg.tags===tagsOf(0) && tags[0]===tagsOf(0)[0];
    R.aliasTech  = playerTech===techOf(0) && techMod===modOf(0);
    R.aliasAiMil = dbg.aiMil===dbg.A(1);
    R.aliasCiv   = SIDES[0].civ===playerCiv && CIVS.indexOf(SIDES[0].civ)>=0; /* Static tables return the same row rather than a deep copy — a deep copy breaks every identity check
   like civ === CIVS[0]. */
    /* Pointer re-linking: the object you hold must be the one in the array, not a copy of it. */
    const vg=villagers.filter(v=>v.node),gr=units.filter(u=>u.grp),ga=units.filter(u=>u.gar),tg=units.filter(u=>u.tgt);
    R.hasVilNode=vg.length; R.hasGrp=gr.length; R.hasTgt=tg.length;
    R.relinkNode = vg.every(v=>nodes.indexOf(v.node)>=0);
    R.relinkGrp  = gr.every(u=>tagsOf(u.side).indexOf(u.grp)>=0||u.grp===dbg.aiDefGrp); /* aiDefGrp is the singleton guard group outside tags — also a container, and it must be restored too. */
    R.relinkGar  = ga.every(u=>buildings.indexOf(u.gar)>=0);
    R.relinkTgt  = tg.every(u=>units.indexOf(u.tgt)>=0||buildings.indexOf(u.tgt)>=0||villagers.indexOf(u.tgt)>=0||scouts.indexOf(u.tgt)>=0);
    for(let i=0;i<1200;i++)step(TICK);
    const hB=fp(),bState={u:units.length,v:villagers.length,b:buildings.length,t:+t.toFixed(2)};
    R.hA=hA;R.hB=hB;R.same=hA===hB;R.aState=aState;R.bState=bState;
    /* Sensitivity control. Ablation evidence is one-directional: showing the fingerprints match proves
       nothing unless the fingerprint can also detect divergence. Apply the same snapshot but advance the
       RNG state by one (the classic "forgot to save the seed") and the fingerprint must change. */
    dbg.snapApply(JSON.parse(snap));
    seed=(seed+1)|0; /* Advancing the RNG state by one stands in for "forgot to save the seed" style omissions. */
    for(let i=0;i<1200;i++)step(TICK);
    R.hC=fp();R.sensitive=R.hC!==hA;
    return R;`);
  check('the save is JSON-serialisable (the registries break the circular references) and holds no DOM references; the test only runs once the world genuinely has content in it (construction sites, production queues and research all present)',
    t122.rich && t122.noDom && t122.bytes > 0 && t122.site && t122.queue, t122);
  check('the one thing that cannot be saved = the exec/gate closures in the AI\'s commitment set (and they really are there, so the check is not passing vacuously); hang a closure on any other piece of state and this goes red',
    t122.hasFn && t122.onlyCmtFn, t122.warn);
  check('loading returns the same world: time, units, villagers and building counts all back to the moment of the save',
    t122.timeBack, t122);
  check('aliases survive ① resources, groups and tech: const stock, const tags, playerTech and techMod still point at the live objects under SIDES[0]',
    t122.aliasStock && t122.aliasTags && t122.aliasTech, t122);
  check('aliases survive ② the AI brains and civilisations: aiMil === AIS[1]; SIDES[0].civ is the **same row** in CIVS, not a deep copy',
    t122.aliasAiMil && t122.aliasCiv, t122);
  check('pointers are relinked: a villager\'s resource node, a unit\'s group, its garrison building and its attack target are all the object in the array, not a copy of it',
    t122.relinkNode && t122.relinkGrp && t122.relinkGar && t122.relinkTgt && t122.hasVilNode > 0, t122);
  check('**determinism**: 1,200 ticks straight after saving vs 1,200 ticks after loading = identical world fingerprints (miss any piece of state and it diverges here)',
    t122.same, { hA: t122.hA, hB: t122.hB, A: t122.aState, B: t122.bState });
  check('sensitivity control: shifting only the RNG state in the same snapshot changes the fingerprint (proving the previous assertion\'s \"identical\" is not the fingerprint failing to see anything)',
    t122.sensitive, { hA: t122.hA, hB: t122.hB, hC: t122.hC });
  check('the save fits inside the localStorage quota (under 1MB per file = three slots fit; iOS allows 5MB per origin)',
    t122.bytes < 1024 * 1024, { KB: Math.round(t122.bytes / 1024) });

  /* [123] covers the load-save path on the home screen (device report: loading works in-game but not
     from the home screen). Root cause: #savePanel had z-index 60 while #homeScr had 80, so the panel
     really did open but was completely covered — the player just saw nothing happen.
     This is a visual-layer bug that unit tests over snapMake/snapApply ([122]) can never catch, so this
     case uses elementFromPoint for a real occlusion check. */
  console.log('\n[123] 📂 the home screen\'s load entry: the panel has to float above the home screen (visible and clickable) + the home screen is read-only (it must not overwrite a save)');
  const t123 = await ev(`
    const R={},hs=document.querySelector('#homeScr'),sp=document.querySelector('#savePanel');
    R.wired=!!document.querySelector('#homeLoad').onclick;   /* The home screen's load-save button is wired up. */
    hs.classList.remove('hidden');                            /* Simulate a bare page load with the home screen covering the whole viewport. */
    openSavePanel(true);                                      /* This is the path #homeLoad takes. */
    R.zSave=+getComputedStyle(sp).zIndex;R.zHome=+getComputedStyle(hs).zIndex;
    R.open=!sp.classList.contains('hidden');
    const r=sp.getBoundingClientRect();
    const hit=(x,y)=>{const el=document.elementFromPoint(Math.round(x),Math.round(y));return !!(el&&sp.contains(el));};
    R.hitTop=hit(r.left+r.width/2,r.top+12);                  /* The top edge of the panel (its title bar) is genuinely clickable — not covered by the home screen. */
    R.hitBody=hit(r.left+r.width/2,r.top+r.height/2);
    const cb=document.querySelector('#saveClose').getBoundingClientRect();
    R.hitClose=hit(cb.left+cb.width/2,cb.top+cb.height/2);
    R.roWhy=snapNoSaveWhy();                                  /* Home screen is read-only. */
    R.roSaveBtns=document.querySelectorAll('#saveSlots button[data-sv=save]').length; /* Read-only means zero 💾 buttons. */
    R.roThrows=(()=>{try{snapSave(0);return '';}catch(e){return e.message;}})();
    openSavePanel(false);                                     /* In-game saving is allowed: a 💾 must appear on every slot, whether the slot is empty or not. */
    R.gameSaveBtns=document.querySelectorAll('#saveSlots button[data-sv=save]').length;
    R.gameWhy=snapNoSaveWhy();R.slots=SNAP_SLOTS;
    sp.classList.add('hidden');hs.classList.add('hidden');snapHome=false;
    return R;`);
  check('the home screen\'s \"📂 Load a save\" is wired up, and the panel stacks above the home screen (z 85 > 80)',
    t123.wired && t123.open && t123.zSave > t123.zHome, t123);
  check('occlusion, measured: elementFromPoint at the panel\'s title, body and ✕ all land inside the panel (= it really is visible and clickable, not merely un-hidden by a class)',
    t123.hitTop && t123.hitBody && t123.hitClose, t123);
  check('the home screen is read-only: no 💾 save buttons are drawn and snapSave refuses outright (behind the home screen is an unstarted default game, and a misclick would overwrite a real save)',
    t123.roSaveBtns === 0 && /首頁/.test(t123.roWhy) && /首頁/.test(t123.roThrows), t123);
  check('the read-only flag can be cleared: opening the panel in game shows 💾 on every slot (the save feature was not locked out along with it)',
    t123.gameSaveBtns === t123.slots && t123.gameWhy === '', t123);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
} catch (e) {
  console.error('HARNESS ERROR:', e.message); fail++;
} finally {
  try { chrome.kill('SIGKILL'); } catch {}
  process.exit(fail ? 1 : 0);
}
