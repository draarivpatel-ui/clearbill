// Optional BYOK sender for the AI reasoning lab's exported payload.
// ClearBill itself never makes a network call. This local script reads an
// exported clearbill-assist-v1 payload file and posts it to an endpoint the
// user explicitly supplies, with the key read from an environment variable.
//
// Usage:
//   CLEARBILL_LLM_KEY=your-key node scripts/llm-polish.mjs payload.json https://your-endpoint.example/v1/chat/completions
//   CLEARBILL_LLM_KEY=your-key node scripts/llm-polish.mjs payload.json http://localhost:11434/v1/chat/completions
//
// The key is sent only in the Authorization header of this one request and is
// never written to disk by this script. The payload stays fictional data.
import { readFile } from 'node:fs/promises';

const [file, endpoint] = process.argv.slice(2);
if (!file || !endpoint) {
  console.error('Usage: node scripts/llm-polish.mjs <payload.json> <endpoint-url>');
  process.exit(2);
}
const url = new URL(endpoint);
const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase())
  || url.hostname.toLowerCase().endsWith('.localhost');
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
  console.error('Endpoint must be https, or http on a loopback host only.');
  process.exit(2);
}
if (url.username || url.password) {
  console.error('Do not embed credentials in the endpoint URL. Use CLEARBILL_LLM_KEY.');
  process.exit(2);
}
const key = process.env.CLEARBILL_LLM_KEY;
if (!key && !loopback) {
  console.error('Set CLEARBILL_LLM_KEY for remote endpoints.');
  process.exit(2);
}
const doc = JSON.parse(await readFile(file, 'utf8'));
if (doc?.schema !== 'clearbill-assist-v1' || !doc.request?.messages?.length) {
  console.error('Not a clearbill-assist-v1 payload. Build one in the AI reasoning lab first.');
  process.exit(2);
}
const headers = { 'Content-Type': 'application/json' };
if (key) headers.Authorization = `Bearer ${key}`;
const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(doc.request) });
const text = await response.text();
console.log(`HTTP ${response.status}`);
console.log(text.slice(0, 20_000));
process.exit(response.ok ? 0 : 1);
