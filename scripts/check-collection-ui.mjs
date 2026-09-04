import fs from 'node:fs';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// Run against a built site served by local Wrangler and Chrome's local CDP.
// Creates disposable local boards; never accepts a production host or password default.
const base = process.env.COLLECTION_TEST_URL || 'http://127.0.0.1:8793';
const cdp = process.env.COLLECTION_CDP_URL || 'http://127.0.0.1:9231';
for (const address of [base, cdp]) assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(address).hostname), 'Local hosts only');
const password = process.env.COLLECTION_TEST_PASSWORD;
assert(password, 'Set COLLECTION_TEST_PASSWORD to the local Wrangler override');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'darsay-collection-ui-'));
const tabs = await (await fetch(`${cdp}/json`)).json();
const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(resolve => ws.addEventListener('open', resolve, {once:true}));
let next = 0;
const pending = new Map();
const exceptions = [];
ws.addEventListener('message', ({data}) => {
  const m = JSON.parse(data);
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.text);
  if (!m.id) return;
  const p = pending.get(m.id); pending.delete(m.id);
  if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
});
function send(method, params={}) {
  return new Promise((resolve,reject) => { const id=++next; pending.set(id,{resolve,reject}); ws.send(JSON.stringify({id,method,params})); });
}
async function evaluate(expression) {
  const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
const delay = n => new Promise(resolve=>setTimeout(resolve,n));
async function until(expression) {
  let retries=0;
  for(let i=0;i<300;i++) {
    if(await evaluate(expression)) return;
    if(expression.includes('.collection-variant') && retries<2 && await evaluate('!!document.querySelector(".collection-inspecting .collection-primary")')) {
      console.log('Inspection reported an upstream error; exercising its retry button.');
      await click('.collection-inspecting .collection-primary'); retries++;
    }
    await delay(100);
  }
  throw new Error(`Timed out: ${expression}. ${await evaluate('document.body.innerText.slice(-4000)')}`);
}
async function click(selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function key(key, code=key) { await send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:key==='Escape'?27:key==='Tab'?9:key==='Enter'?13:0}); await send('Input.dispatchKeyEvent',{type:'keyUp',key,code}); }
async function shot(name) {
  const screenshot=await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(artifacts, `${name}.png`),Buffer.from(screenshot.data,'base64'));
}
const source='unsloth/GLM-5.3-Flash-GGUF';
const revision='2975ab414d30340466d8c51533c6e91f0cca64c1';
await send('Page.enable'); await send('Runtime.enable');
await send('Network.enable'); await send('Network.setCacheDisabled',{cacheDisabled:true});
await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
for (const [name,width,height,mobile] of [['desktop',1440,1050,false],['mobile',390,844,true]]) {
  const created=await (await fetch(`${base}/api/boards`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:`Collection room ${name}`,password})})).json();
  const id=created.id;
  assert(id);
  await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});
  await send('Page.navigate',{url:`${base}/b/${id}`});
  await until('document.querySelector(".add-card")');
  await evaluate(`document.querySelector('#add-source').value=${JSON.stringify(source)}; document.querySelector('#add-rev').value=${JSON.stringify(revision)}; document.querySelector('.add-card [type=submit]').focus(); document.querySelector('.add-card').requestSubmit();`);
  await until('document.querySelectorAll(".collection-variant").length === 14');
  assert.equal(await evaluate('document.querySelectorAll(".collection-variant input:checked").length'),0);
  for(let i=0;i<24;i++) {
    await key('Tab');
    assert(await evaluate('document.querySelector(".collection-dialog").contains(document.activeElement)'), 'Focus must stay inside the dialog');
  }
  await evaluate('document.querySelector(".collection-body").scrollTop=0');
  assert.equal(await evaluate('document.querySelector(".collection-primary").disabled'),true);
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".collection-dialog")).backgroundColor'),'rgb(8, 7, 12)');
  let board=await (await fetch(`${base}/api/boards/${id}`)).json();
  assert.equal(board.revision,0); assert.equal(board.entries.length,0);
  await click('.collection-intent:nth-child(2)');
  assert.equal(await evaluate('document.querySelectorAll(".collection-variant input:checked").length'),2);
  await shot(`collection-${name}-choose`);
  if(mobile) {
    await evaluate('document.querySelectorAll(".collection-mobile-notes")[3].open=true; document.querySelectorAll(".collection-mobile-notes")[3].scrollIntoView({block:"start"})');
    await until('document.querySelector(".collection-mobile-notes[open] .collection-learning")');
    await shot('collection-mobile-learn');
    assert((await evaluate('document.querySelector(".collection-mobile-notes[open]").innerText')).includes('Exact recovery unverified'));
  }
  assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth || document.querySelector(".collection-dialog").scrollWidth > document.querySelector(".collection-dialog").clientWidth'),false);
  await click('.collection-primary');
  await until('document.querySelector(".collection-review")');
  assert((await evaluate('document.querySelector(".collection-review").innerText')).includes(revision));
  assert((await evaluate('document.querySelector(".collection-review").innerText')).includes('No projector selected'));
  await shot(`collection-${name}-review`);
  await key('Escape');
  await until('!document.querySelector(".collection-dialog")');
  assert.equal(await evaluate('document.querySelector("#add-source").value'),source);
  assert.equal(await evaluate('document.activeElement === document.querySelector(".add-card [type=submit]")'),true,'Cancel restores focus');
  board=await (await fetch(`${base}/api/boards/${id}`)).json();
  assert.equal(board.entries.length,0); assert.equal(board.revision,0);
  // Inspect again, collect Q4 plus one projector, review and save one row.
  await evaluate('document.querySelector(".add-card").requestSubmit()');
  await until('document.querySelectorAll(".collection-variant").length === 14');
  await evaluate(`document.querySelector('input[aria-label="Keep UD-Q4_K_XL/GLM-5.3-Flash-UD-Q4_K_XL"]').click()`);
  assert.equal(await evaluate('document.querySelector(".collection-amount").textContent'),'186.0 GiB');
  await evaluate('Array.from(document.querySelectorAll(".collection-variant input")).find(n=>n.getAttribute("aria-label").includes("mmproj")).click()');
  await click('.collection-primary');
  await until('document.querySelector(".collection-review")');
  assert(!(await evaluate('document.querySelector(".collection-review").innerText')).includes('No projector selected'));
  await click('.collection-primary');
  await until('!document.querySelector(".collection-dialog") && document.querySelectorAll(".work-card").length === 1');
  board=await (await fetch(`${base}/api/boards/${id}`)).json();
  assert.equal(board.entries.length,1); assert.equal(board.revision,1);
  assert.equal(board.entries[0].revision,revision);
  assert.equal(board.entries[0].include.length,2);
  assert.equal(board.entries[0].size_basis,'selection');
  // Reopening the exact identity cannot overwrite curation or create a second row.
  await evaluate(`document.querySelector('#add-source').value=${JSON.stringify(source)}; document.querySelector('#add-rev').value=${JSON.stringify(revision)}; document.querySelector('.add-card').requestSubmit();`);
  await until('document.querySelectorAll(".collection-variant").length === 14');
  await evaluate(`document.querySelector('input[aria-label="Keep UD-Q4_K_XL/GLM-5.3-Flash-UD-Q4_K_XL"]').click(); Array.from(document.querySelectorAll('.collection-variant input')).find(n=>n.getAttribute('aria-label').includes('mmproj')).click();`);
  assert.equal(await evaluate('document.querySelector(".collection-primary").textContent'),'Already on this board');
  assert.equal(await evaluate('document.querySelector(".collection-primary").disabled'),true);
  await key('Escape');
  assert.equal((await (await fetch(`${base}/api/boards/${id}`)).json()).revision,board.revision);

  // Exercise an unavailable public inventory and its deliberately uninspected fallback.
  await evaluate(`window.collectionOriginalFetch=window.fetch; window.fetch=(url,init)=>String(url).includes('/preview?') ? Promise.resolve(new Response(JSON.stringify({error:'Inventory unavailable for this browser lifecycle check'}),{status:502})) : window.collectionOriginalFetch(url,init); document.querySelector('#add-source').value='curator/uninspected-collection-test'; document.querySelector('#add-rev').value=''; document.querySelector('.add-card').requestSubmit();`);
  await until('document.querySelector(".collection-uninspected")');
  await click('.collection-uninspected');
  assert((await evaluate('document.querySelector(".collection-review").innerText')).includes('Size unknown'));
  await shot(`collection-${name}-uninspected`);
  // A transport failure while saving keeps the explicit review and offers retry.
  await evaluate(`window.fetch=(url,init)=>String(url).endsWith('/entries') && init?.method==='POST' ? Promise.reject(new Error('Simulated transport failure before save')) : window.collectionOriginalFetch(url,init)`);
  await click('.collection-primary');
  await until('document.querySelector(".collection-error")?.textContent.includes("Simulated transport failure")');
  assert.equal((await (await fetch(`${base}/api/boards/${id}`)).json()).entries.length,1);
  await evaluate('window.fetch=window.collectionOriginalFetch');
  await click('.collection-primary');
  await until('!document.querySelector(".collection-dialog") && document.querySelectorAll(".work-card").length === 2');
  const fallback=(await (await fetch(`${base}/api/boards/${id}`)).json()).entries.find(e=>e.source.includes('uninspected-collection-test'));
  assert.deepEqual(fallback.include,['/*']); assert.equal(fallback.revision,null);

  // A late inspection response cannot reopen a cancelled draft (even if a transport ignores abort).
  await evaluate(`window.fetch=(url,init)=>String(url).includes('/preview?') ? new Promise(resolve=>setTimeout(()=>resolve(new Response('{}')),500)) : window.collectionOriginalFetch(url,init); document.querySelector('#add-source').value=${JSON.stringify(source)}; document.querySelector('.add-card [type=submit]').focus(); document.querySelector('.add-card').requestSubmit();`);
  await until('document.querySelector(".collection-dialog")');
  await key('Escape'); await delay(700);
  assert.equal(await evaluate('!!document.querySelector(".collection-dialog")'),false);
  assert.equal(await evaluate('document.activeElement === document.querySelector(".add-card [type=submit]")'),true);
  await evaluate('window.fetch=window.collectionOriginalFetch');
  console.log(JSON.stringify({viewport:name,board:id,include:board.entries[0].include,bytes:board.entries[0].payload_bytes,overflow:false}));
}
assert.deepEqual(exceptions,[]);
console.log('Collection picker: live Hub inventory, desktop/mobile, cancel, review, combined save; no JS exceptions.');
console.log(`Browser lifecycle checks also passed: focus, duplicate identity, uninspected fallback, failed-save retry, late-response cancellation. Artifacts: ${artifacts}`);
ws.close();
