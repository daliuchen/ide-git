// Usage: node test/e2e/run.mjs [suite …]   (build first: pnpm run build)
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { launch, scratchDirectory, shot } from './lib.mjs';

const suitesDirectory = join(import.meta.dirname, 'suites');
const available = readdirSync(suitesDirectory)
  .filter((file) => file.endsWith('.mjs'))
  .map((file) => file.replace(/\.mjs$/u, ''))
  .sort();
const selected = process.argv.slice(2);
const unknown = selected.filter((name) => !available.includes(name));
if (unknown.length) {
  console.error(`Unknown suite(s): ${unknown.join(', ')}. Available: ${available.join(', ')}`);
  process.exit(2);
}

const summary = [];
for (const name of selected.length ? selected : available) {
  const suite = (await import(join(suitesDirectory, `${name}.mjs`))).default;
  const directory = scratchDirectory(name);
  const results = [];
  const check = (label, ok, detail = '') => {
    results.push({ label, ok });
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  };
  console.log(`\n${name}`);
  let session;
  try {
    const workspace = suite.setup(directory);
    session = await launch(workspace, suite.launch ?? {});
    await suite.run({ page: session.page, check, workspace, shot: (label) => shot(session.page, `${name}-${label}`) });
  } catch (error) {
    check('suite ran to the end', false, error instanceof Error ? error.message.split('\n')[0] : String(error));
    if (session) await shot(session.page, `${name}-error`).catch(() => undefined);
  } finally {
    await session?.close();
    rmSync(directory, { recursive: true, force: true });
  }
  summary.push({ name, passed: results.filter((result) => result.ok).length, total: results.length });
}

console.log('\nSummary');
for (const { name, passed, total } of summary) console.log(`  ${passed === total ? 'ok  ' : 'FAIL'} ${name} ${String(passed)}/${String(total)}`);
process.exitCode = summary.every(({ passed, total }) => passed === total) ? 0 : 1;
