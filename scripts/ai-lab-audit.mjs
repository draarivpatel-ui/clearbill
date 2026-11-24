import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
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
      }, 15_000);
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
  const end = Date.now() + 12_000;
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
  const events = { console: [], page: [], external: [] };
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
    void (async () => {
      try {
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
  async function fit(label) {
    const { scroll, client } = await evaluate('({scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth})');
    assert(scroll <= client && client === width, `${label}: document width ${scroll}, viewport ${client}`);
  }

  try {
    await Promise.all(['Page.enable', 'Network.enable', 'Runtime.enable', 'Log.enable', 'DOM.enable'].map(method => send(method)));
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 });
    const downloads = join(scratch, 'downloads');
    await mkdir(downloads, { recursive: true });
    await cdp.command('Browser.setDownloadBehavior', { behavior: 'allow', browserContextId, downloadPath: downloads });
    await navigate(route);
    await wait(`${q('#reasoning-panel')} && ${q('[data-view=reasoning]')}`, 'reasoning lab mounted');
    await wait(`${q('#offline-status')}.dataset.ready === 'true'`, 'active offline service worker');
    assert.equal(await evaluate(`${q('#reasoning-panel')}.hidden`), true);
    await click('[data-view=reasoning]');
    assert.equal(await evaluate(`${q('#reasoning-panel')}.hidden`), false);
    assert.match(await text('#reasoning-title'), /AI reasoning lab/);
    assert.match(await text('#reason-summary'), /\$120\.00 to \$163\.00/);
    assert.match(await text('#reason-summary'), /counts exact-duplicate overlaps once/);
    assert.match(await text('#reason-summary'), /\$177\.18; \$14\.18 is shared/);
    assert.match(await text('#reason-summary'), /nsa-emergency-review/);
    assert.equal(await evaluate(`document.querySelectorAll('#reason-trace > li').length`), 4);
    assert.match(await text('#reason-trace'), /markup 3\.73x, z 0\.38/);
    assert.match(await text('#reason-trace'), /NCCI PTP component pair/);
    assert.match(await text('#reason-trace'), /Questioned \$39\.00/);
    assert.match(await text('#reason-trace'), /YES - The fictional episode is emergency care/);
    assert.equal(await evaluate(`document.querySelectorAll('#reason-plan li').length`), 6);
    assert.match(await text('#reason-plan'), /patient-provider dispute|repeated charge/);
    await fit('reasoning default');
    mark(`${width}x${height} reasoning trace, benchmark table and plan render`);

    assert.match(await text('#reason-delta'), /Projected patient share \$189\.04 \(down \$110\.96/);
    await set('#reason-removal', '0', 'input');
    assert.match(await text('#reason-delta'), /down \$[0-9,]+\.[0-9]{2} from \$300\.00/);
    await set('#reason-removal', '100', 'input');
    await set('#reason-insurer', '0', 'input');
    await set('#reason-discount', '0', 'input');
    assert.match(await text('#reason-delta'), /Projected patient share \$280\.07 \(down \$19\.93/);
    await set('#reason-removal', '0', 'input');
    assert.match(await text('#reason-delta'), /Projected patient share \$300\.00 \(down \$0\.00/);
    assert.equal(await evaluate(`document.querySelectorAll('#reason-waterfall .wf-bar').length`), 5);
    assert.equal(await evaluate(`document.querySelectorAll('#reason-waterfall .wf-decrease').length`), 3);
    await evaluate(`${q('#reason-waterfall .wf-bar')}.focus()`);
    assert.equal(await evaluate(`document.activeElement === ${q('#reason-waterfall .wf-bar')}`), true);
    await fit('reasoning simulator');
    mark(`${width}x${height} sliders drive exact waterfall deltas and focusable SVG bars`);

    await click('#reason-letter-detail summary');
    assert.match(await text('#reason-letter'), /fictional dispute letter - practice copy/);
    assert.match(await text('#reason-letter'), /Questioned amount \$128\.00 \(L5, L6, L7\)/);
    assert.match(await text('#reason-digest'), /SHA-256 [a-f0-9]{64}/);
    await click('#reason-letter-download');
    const letter = await waitFor(() => readFile(join(downloads, 'clearbill-demo-er-dispute-letter.txt'), 'utf8'), 'letter download');
    assert.match(letter, /SHA-256 [a-f0-9]{64}/);
    assert.match(letter, /not legal or billing advice/);
    mark(`${width}x${height} digested dispute letter downloads into the routed folder`);

    await click('#reason-assist summary');
    await set('#assist-endpoint', 'http://api.example.com');
    await click('#assist-build');
    assert.match(await text('#assist-status'), /rejected \(https-required\)/);
    assert.match(await evaluate(`${q('#assist-payload')}.value`), /clearbill-assist-v1/);
    await set('#assist-endpoint', 'https://api.example.com/v1/chat/completions');
    await set('#assist-model', 'demo-model');
    await set('#assist-context', 'call (555) 010-2030', 'input');
    await click('#assist-build');
    assert.match(await text('#assist-status'), /looks sendable \(https\).*Scrubbed: 1 phone/);
    const payload = await evaluate(`${q('#assist-payload')}.value`);
    assert(payload.includes('clearbill-assist-v1') && payload.includes('demo-model'));
    assert(!payload.includes('010-2030') && !payload.includes('(555)'));
    await click('#assist-download');
    const file = await waitFor(() => readFile(join(downloads, 'clearbill-demo-er-assist-payload.json'), 'utf8'), 'payload download');
    assert(JSON.parse(file).schema === 'clearbill-assist-v1');
    assert.deepEqual(await evaluate('(async () => { const regs = await navigator.serviceWorker.getRegistrations(); return regs.length; })()'), 1);
    mark(`${width}x${height} BYOK payload is PII-scrubbed, gated and export-only`);

    await click('#reason-tests summary');
    await click('#reason-run');
    await wait(`${q('#reason-test-status')}.dataset.all === 'true'`, 'all reasoning self-tests passing');
    const count = await evaluate(`document.querySelectorAll('#reason-test-list li').length`);
    assert(count >= 12, `expected 12+ self-tests, saw ${count}`);
    assert.equal(await evaluate(`document.querySelectorAll('#reason-test-list li[data-pass="false"]').length`), 0);
    mark(`${width}x${height} in-page reasoning self-tests ${count}/${count} passing`);

    await click('[data-case=demo-imaging]');
    await click('[data-view=reasoning]');
    assert.match(await text('#reason-summary'), /potential-ppdr/);
    assert.match(await text('#reason-summary'), /\$475\.00/);
    assert.match(await text('#reason-trace'), /YES - The initial bill was 12 days old/);
    assert.match(await text('#reason-trace'), /at least \$400/);
    assert.match(await text('#reason-plan'), /patient-provider dispute/);
    await fit('reasoning imaging');
    mark(`${width}x${height} self-pay case routes through the GFE branch`);

    await click('[data-case=demo-er]');
    await click('#edit-details summary');
    await set('#edit-line', 'line-4');
    await set('#edit-modifier', '91');
    await set('#edit-evidence', 'repeat-lab');
    await set('#edit-charge', '40.00');
    await click('#edit-button');
    await click('[data-view=reasoning]');
    assert.match(await text('#reason-trace'), /Modifier evidence noted/);
    assert.match(await text('#reason-trace'), /NCCI PTP documented exception/);
    assert.match(await text('#reason-trace'), /reconciles|Reconciliation|do not reconcile|does not equal/i);
    await fit('reasoning edited bill');
    mark(`${width}x${height} user-edited line items re-analyze with documented evidence`);

    if (width === 1440) {
      await evaluate('scrollTo(0, 0)');
      const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      await writeFile(join(root, 'docs', 'reasoning.png'), Buffer.from(data, 'base64'));
    }
    const downloadCount = (await readdir(downloads)).length;
    assert.equal(downloadCount, 2, `expected 2 routed downloads, saw ${downloadCount}`);
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
  scratch = process.env.AI_AUDIT_SCRATCH || await mkdtemp('/tmp/clearbill-l30-');
  app = await serve(0);
  const response = await fetch(`${app.origin}/clearbill/`);
  assert.equal(response.status, 200);
  assert.equal((await fetch(`${app.origin}/clearbill/src/ai-appeal-reasoning.js`)).status, 200);
  const profile = join(scratch, 'profile');
  chrome = spawn(chromeBin, ['--headless=new', '--mute-audio', '--disable-background-networking', '--disable-extensions',
    '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] });
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
  for (const [width, height] of [[1440, 900], [390, 844]]) await runViewport(cdp, app, scratch, width, height);
  console.log('Saved docs/reasoning.png');
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
}
