// Prints the WCAG contrast of Coineda's colour tokens, both themes, as the
// Markdown table docs/accessibility.md embeds. `npm run contrast`.
// The maths is src/a11y/contrastCore.mjs - the same module the test
// (tests/contrast.test.ts) asserts against.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { markdownTable, measure } from '../src/a11y/contrastCore.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const css = ['src/styles/lumen.css', 'src/index.css']
  .map((file) => readFileSync(root + file, 'utf8'))
  .join('\n');

console.log(markdownTable(css));

const failing = [...measure(css, 'light'), ...measure(css, 'dark')].filter(
  (r) => !r.pass,
);
if (failing.length > 0) {
  console.error(`\n${failing.length} pair(s) below their threshold.`);
  process.exitCode = 1;
}
