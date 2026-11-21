import { readFile, stat } from 'node:fs/promises';
import { MAX_BUNDLE_BYTES, verifyBundle } from '../src/exchange.js';

const [path, ...rest] = process.argv.slice(2);
if (!path || rest.length) {
  console.error('Usage: npm run verify -- <fictional-audit.json>');
  process.exitCode = 2;
} else {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_BUNDLE_BYTES) throw new Error('Choose an audit JSON file under 128 KiB.');
    const result = await verifyBundle(await readFile(path, 'utf8'));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
