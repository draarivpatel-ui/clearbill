import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { verifyBundle } from '../src/exchange.js';
import { serve } from './serve.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratchRoot = join(root, '.browser-scratch');
const chromeBin = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

class Session {
  id = 0;
  pending = new Map();
  handlers = new Map();

  constructor(socket) {
    this.socket = socket;
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
      } else {
        for (const handler of this.handlers.get(message.method) || []) handler(message.params, message.sessionId);
      }
    });
    socket.addEventListener('close', () => {
      for (const { timer, reject } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('Chrome disconnected'));
      }
      this.pending.clear();
    });
  }

  command(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out: ${method}`));
      }, 12_000);
      this.pending.set(id, { timer, resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(handler);
    return () => this.handlers.get(method).delete(handler);
  }
}

async function waitFor(read, description) {
  const end = Date.now() + 10_000;
  let last;
  do {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) { last = error; }
    await delay(60);
  } while (Date.now() < end);
  throw new Error(`No ${description}${last ? ` (${last.message})` : ''}`);
}

function mark(name) { console.log(`PASS ${name}`); }

async function runViewport(cdp, app, scratch, width, height) {
  const { browserContextId } = await cdp.command('Target.createBrowserContext');
  const { targetId } = await cdp.command('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await cdp.command('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.command(method, params, sessionId);
  const targetSessions = new Set([sessionId]);
  const unsub = [];
  const events = { console: [], page: [], external: [], serviceWorkers: [] };
  unsub.push(cdp.on('Network.requestWillBeSent', (event, id) => {
    if (!targetSessions.has(id)) return;
    const url = new URL(event.request.url);
    if (['http:', 'https:', 'blob:'].includes(url.protocol) && url.origin !== app.origin) events.external.push(url.href);
  }));
  unsub.push(cdp.on('Log.entryAdded', ({ entry }, id) => {
    if (targetSessions.has(id) && entry.level === 'error') events.console.push(entry.text);
  }));
  unsub.push(cdp.on('Runtime.consoleAPICalled', ({ type, args }, id) => {
    if (targetSessions.has(id) && ['error', 'assert'].includes(type)) events.console.push(args.map(arg => arg.value || arg.description).join(' '));
  }));
  unsub.push(cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }, id) => {
    if (targetSessions.has(id)) events.page.push(exceptionDetails.exception?.description || exceptionDetails.text);
  }));
  unsub.push(cdp.on('Target.attachedToTarget', ({ sessionId: worker, targetInfo, waitingForDebugger }, parent) => {
    if (parent !== sessionId) return;
    targetSessions.add(worker);
    if (targetInfo.type === 'service_worker') events.serviceWorkers.push(targetInfo.url);
    void (async () => {
      try {
        // Installation cannot progress while the service worker is debugger-paused.
        if (waitingForDebugger) await cdp.command('Runtime.runIfWaitingForDebugger', {}, worker);
        await Promise.allSettled(['Network.enable', 'Runtime.enable', 'Log.enable'].map(method => cdp.command(method, {}, worker)));
      } catch (error) { events.page.push(error.message); }
    })();
  }));

  async function evaluate(expression) {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  }
  const wait = (expression, label) => waitFor(() => evaluate(expression), label);
  const q = selector => `document.querySelector(${JSON.stringify(selector)})`;
  const text = selector => evaluate(`${q(selector)}?.textContent`);
  const route = `${app.origin}/clearbill/`;
  async function navigate(url) {
    const { errorText } = await send('Page.navigate', { url });
    assert.equal(errorText, undefined);
    if (url.startsWith(route)) await wait(`${q('#case-title')}?.textContent && document.readyState === 'complete'`, 'ready ClearBill document');
  }
  async function click(selector) {
    const { x, y, hit } = await evaluate(`(() => {
      const el = ${q(selector)};
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      return { x, y, hit: el.contains(document.elementFromPoint(x, y)) };
    })()`);
    assert(hit, `Click target ${selector} is not visible at ${x}, ${y}`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  async function set(selector, value, event = 'change') {
    await evaluate(`(() => { const field = ${q(selector)}; field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); })()`);
  }
  async function key(value, code) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code, windowsVirtualKeyCode: value.toUpperCase().charCodeAt(0), text: value });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code });
  }
  async function fit(label) {
    const { scroll, client } = await evaluate('({scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth})');
    assert(scroll <= client && client === width, `${label}: document width ${scroll}, viewport ${client}`);
  }
  async function screenshot(name, full = false) {
    await evaluate('scrollTo(0, 0)');
    const captureHeight = full ? Math.ceil((await send('Page.getLayoutMetrics')).cssContentSize.height) : height;
    const { data } = await send('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: full,
      clip: { x: 0, y: 0, width, height: captureHeight, scale: 1 },
    });
    const bytes = Buffer.from(data, 'base64');
    assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [width, captureHeight]);
    await writeFile(join(root, 'docs', name), bytes);
  }
  async function checkPrint(language) {
    assert.equal(await evaluate(`${q('#worksheet-paper')}.lang`), language);
    assert.equal(await evaluate(`document.body.dataset.print`), 'worksheet');
    await send('Emulation.setEmulatedMedia', { media: 'print' });
    try {
      assert.equal(await evaluate(`getComputedStyle(${q('.masthead')}).display`), 'none');
      assert.notEqual(await evaluate(`getComputedStyle(${q('#worksheet-paper')}).display`), 'none');
      assert((await text('#worksheet-title')).length > 15);
      const { data } = await send('Page.printToPDF', { preferCSSPageSize: true, printBackground: false });
      const pdf = Buffer.from(data, 'base64').toString('latin1');
      assert(pdf.startsWith('%PDF-'));
      assert.equal(pdf.match(/\/Type\s*\/Page\b/g)?.length, 1);
      assert.match(pdf, /\/Type\s*\/Pages\s*\/Count\s+1\b/);
      assert.match(pdf, /\/MediaBox\s*\[\s*0\s+0\s+612\s+792\s*\]/);
      assert(pdf.length > 8_000, 'Worksheet PDF unexpectedly short.');
    } finally { await send('Emulation.setEmulatedMedia', { media: 'screen' }); }
  }

  try {
    await Promise.all(['Page.enable', 'Network.enable', 'Runtime.enable', 'Log.enable', 'DOM.enable'].map(method => send(method)));
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 });
    const downloads = join(scratch, `downloads-${width}`);
    await mkdir(downloads);
    await cdp.command('Browser.setDownloadBehavior', { behavior: 'allow', browserContextId, downloadPath: downloads });
    await navigate(route);
    try {
      await wait(`${q('#offline-status')}.dataset.ready === 'true'`, 'active offline service worker');
    } catch (error) {
      const status = await evaluate(`(async () => ({
        label: ${q('#offline-status')}.textContent,
        secure: isSecureContext,
        registrations: (await navigator.serviceWorker.getRegistrations()).map(reg => ({
          scope: reg.scope, installing: reg.installing?.state, waiting: reg.waiting?.state, active: reg.active?.state,
        })),
      }))()`);
      throw new Error(`${error.message}. ${JSON.stringify({ status, events })}`);
    }
    assert.equal(await evaluate('navigator.serviceWorker.controller.scriptURL'), `${route}sw.js`);
    assert.equal(await evaluate('(async () => (await navigator.serviceWorker.ready).scope)()'), route);
    assert.equal(await text('#finding-count'), '4');
    assert.equal(await evaluate('document.querySelectorAll("#ledger tbody tr").length'), 7);
    assert.equal(await evaluate('document.querySelectorAll("#findings [data-level=review]").length'), 4);
    assert.match(await text('#ledger'), /\$123\.26\*/);
    await fit('ER audit');
    if (width === 1280) await screenshot('desktop.png', true);
    else {
      await screenshot('mobile.png');
      await click('#review-jump');
      assert.equal(await evaluate('document.activeElement.id'), 'findings-heading');
    }
    await click('[data-kind=exact-duplicate] button');
    assert.equal(await evaluate('document.activeElement.id'), 'bill-line-5');
    mark(`${width}x${height} ER audit and source-line focus`);

    await click('[data-case=demo-imaging]');
    assert.equal(await text('#finding-count'), '1');
    assert.match(await text('#findings'), /\$475\.00/);
    assert.match(await text('#settlement'), /\$650\.00/);
    assert.match(await text('#settlement'), /4 of 4 balance checks match/);
    await fit('self-pay audit');
    await click('[data-case=demo-clean]');
    assert.equal(await text('#finding-count'), '0');
    assert.match(await text('#findings'), /No flags/);
    await fit('clean audit');
    mark(`${width}x${height} threshold and clean control`);

    await click('[data-view=reference]');
    assert.match(await text('#reference-result'), /\$89\.23/);
    assert.match(await text('#fpl-result'), /146\.4%/);
    await set('#locality', 'houston');
    assert.match(await text('#reference-result'), /\$96\.33/);
    await set('#ref-code', '80053');
    assert.match(await text('#reference-result'), /No reference/);
    await set('#fpl-region', 'alaska', 'input');
    assert.match(await text('#fpl-result'), /117\.1%/);
    await fit('reference');
    await evaluate(`${q('#fpl-size')}.focus()`);
    await key('r', 'KeyR');
    await key('p', 'KeyP');
    assert.equal(await evaluate('document.activeElement.id'), 'fpl-size');
    assert.equal(await evaluate(`${q('#reference-panel')}.hidden`), false);
    mark(`${width}x${height} geographic references, FPL and keyboard safety`);

    await click('[data-case=demo-er]');
    await click('#edit-details summary');
    await set('#edit-line', 'line-4');
    await set('#edit-modifier', '91');
    await set('#edit-evidence', 'repeat-lab');
    await set('#edit-charge', '40.00');
    await click('#edit-button');
    assert.equal(await evaluate(`Boolean(${q('[data-kind=ptp-documented-review]')})`), true);
    assert.equal(await evaluate(`Boolean(${q('[data-kind=math-line-total]')})`), true);
    assert.match(await text('#edit-status'), /line-4 updated/);
    await click('#edit-reset');
    assert.equal(await text('#finding-count'), '4');
    mark(`${width}x${height} fictional edit, documentation, arithmetic and reset`);

    const cases = width === 1280 ? ['demo-er', 'demo-imaging', 'demo-clean'] : ['demo-er'];
    for (const id of cases) {
      await click(`[data-case=${id}]`);
      await click('#worksheet-open');
      await click('[data-language=en]');
      await fit('English worksheet');
      await checkPrint('en');
      await click('[data-language=es]');
      assert.match(await text('#worksheet-title'), /factura detallada/);
      await fit('Spanish worksheet');
      await checkPrint('es');
      if (width === 1280 && id === 'demo-er') await screenshot('dispute.png', true);
      mark(`${width}x${height} ${id} prints exactly one Letter page in EN and ES`);
    }

    await click('[data-case=demo-clean]');
    await click('#export-details summary');
    await click('#export-csv');
    const csv = await waitFor(() => readFile(join(downloads, 'clearbill-demo-clean.csv'), 'utf8'), 'CSV download');
    assert.match(csv, /"reference_per_unit_cents"/);
    assert.match(csv, /"Follow-up office visit"/);
    await click('#export-json');
    const path = join(downloads, 'clearbill-demo-clean.json');
    const json = await waitFor(() => readFile(path, 'utf8'), 'JSON download');
    const result = await verifyBundle(json);
    assert(result.ok && result.reviewCount === 0);
    const { root: dom } = await send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await send('DOM.querySelector', { nodeId: dom.nodeId, selector: '#replay-file' });
    await send('DOM.setFileInputFiles', { nodeId, files: [path] });
    await wait(`${q('#export-status')}.textContent.includes('Replay matched')`, 'browser replay');
    await click('#share-seal');
    await wait(`!${q('#share-output')}.hidden`, 'sealed link');
    const share = await evaluate(`${q('#share-link')}.value`);
    const keyText = await evaluate(`${q('#share-key')}.value`);
    assert(share.startsWith(`${route}#sealed=v1.`) && !share.includes(keyText));
    await navigate('about:blank');
    await navigate(share);
    assert.equal(await evaluate('location.hash'), '');
    assert.equal(await evaluate(`${q('#share-open-panel')}.hidden`), false);
    const wrong = `${keyText.startsWith('A') ? 'B' : 'A'}${keyText.slice(1)}`;
    await set('#open-key', wrong);
    await click('#share-open-form button[type=submit]');
    await wait(`${q('#share-open-status')}.textContent.includes('Could not open')`, 'wrong-key rejection');
    await set('#open-key', keyText);
    await click('#share-open-form button[type=submit]');
    await wait(`${q('#share-open-panel')}.hidden && ${q('#finding-count')}.textContent === '0'`, 'released fictional case');
    mark(`${width}x${height} CSV, audit replay, authenticated link and wrong-key rejection`);

    const again = await evaluate(`import('./src/exchange.js').then(m => m.sealSummary('demo-imaging', 'manhattan'))`);
    await send('Page.navigate', { url: `${route}${again.fragment}` });
    await wait(`!${q('#share-open-panel')}.hidden && location.hash === ''`, 'second sealed link in the same tab');
    await set('#open-key', again.key);
    await click('#share-open-form button[type=submit]');
    await wait(`${q('#share-open-panel')}.hidden && ${q('#case-title')}.textContent === 'Outpatient imaging'`, 'second fictional case released');
    mark(`${width}x${height} second sealed link replaces panel state and strips the fragment`);

    const third = await evaluate(`import('./src/exchange.js').then(m => m.sealSummary('demo-clean', 'iowa'))`);
    await click('[data-view=worksheet]');
    await send('Page.navigate', { url: `${route}${third.fragment}` });
    await wait(`!${q('#share-open-panel')}.hidden`, 'sealed panel over worksheet view');
    await click('#discard-share');
    assert.equal(await evaluate('document.activeElement.id'), 'worksheet-title');
    mark(`${width}x${height} share dismiss restores focus to the active view title`);

    const offline = { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 };
    app.intercepted.offline = true;
    await send('Network.emulateNetworkConditions', offline);
    try {
      await send('Network.setCacheDisabled', { cacheDisabled: true });
      await send('Page.reload');
      await wait(`!navigator.onLine && ${q('#case-title')}?.textContent === 'ER visit'`, 'offline reload from service worker');
      await click('[data-case=demo-clean]');
      assert.equal(await text('#finding-count'), '0');
      await fit('offline audit');
      await send('Page.navigate', { url: `${route}?offline=probe` });
      await wait(`!navigator.onLine && ${q('#case-title')}?.textContent === 'ER visit'`, 'offline reload with a query string');
    } finally {
      app.intercepted.offline = false;
      await send('Network.emulateNetworkConditions', { ...offline, offline: false, downloadThroughput: -1, uploadThroughput: -1 });
    }
    mark(`${width}x${height} offline reload and working interaction`);
    assert.deepEqual(events.console, [], 'Console errors');
    assert.deepEqual(events.page, [], 'Page errors');
    assert.deepEqual(events.external, [], 'External requests');
    mark(`${width}x${height} 0 console errors, 0 page errors, 0 external requests, no horizontal overflow`);
  } finally {
    unsub.forEach(fn => fn());
    await cdp.command('Target.disposeBrowserContext', { browserContextId });
  }
}

let app, chrome, socket, scratch;
try {
  await mkdir(scratchRoot, { recursive: true });
  scratch = await mkdtemp(join(scratchRoot, 'run-'));
  const profile = join(scratch, 'profile');
  app = await serve(0);
  const response = await fetch(`${app.origin}/clearbill/`);
  assert.equal(response.status, 200);
  const csp = response.headers.get('content-security-policy');
  assert(csp.includes("frame-ancestors 'none'") && csp.includes("worker-src 'self'") && !csp.includes('unsafe-inline'));
  const exposed = await fetch(`${app.origin}/clearbill/package.json`);
  assert.equal(exposed.status, 404);
  chrome = spawn(chromeBin, ['--headless=new', '--mute-audio', '--disable-background-networking', '--disable-extensions',
    '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
  let exitError;
  chrome.on('error', error => { exitError = error; });
  const port = await waitFor(async () => {
    if (exitError) throw exitError;
    return readFile(join(profile, 'DevToolsActivePort'), 'utf8');
  }, 'Chrome CDP port');
  const [number, endpoint] = port.trim().split('\n');
  socket = new WebSocket(`ws://127.0.0.1:${number}${endpoint}`);
  await once(socket, 'open');
  const cdp = new Session(socket);
  for (const [width, height] of [[1280, 800], [390, 844]]) await runViewport(cdp, app, scratch, width, height);
  console.log('Saved docs/desktop.png, docs/dispute.png and docs/mobile.png');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null && chrome.pid) {
    const closed = once(chrome, 'exit');
    chrome.kill();
    const stopped = await Promise.race([closed.then(() => true), delay(2000, false, { ref: false })]);
    if (!stopped) { chrome.kill('SIGKILL'); await closed; }
  }
  if (app) await app.close();
  if (scratch) await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
}
