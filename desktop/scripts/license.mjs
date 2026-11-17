#!/usr/bin/env node
// Writes the repo-root LICENSE (MIT) with the copyright holder derived from
// desktop/package.json `productName`, so a rename only needs one edit.
//
//   node desktop/scripts/license.mjs          # (re)write LICENSE
//   node desktop/scripts/license.mjs --check  # exit 1 if LICENSE is out of date (CI)
import fs from 'node:fs';
import path from 'node:path';
import { copyrightHolder, copyrightYear, rootDir } from './product.mjs';

const text = `MIT License

Copyright © ${copyrightYear} ${copyrightHolder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const file = path.join(rootDir, 'LICENSE');
const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

if (process.argv.includes('--check')) {
  if (current !== text) {
    console.error('✖ LICENSE is out of date with desktop/package.json productName — run `npm run license`.');
    process.exit(1);
  }
  console.log('✔ LICENSE up to date');
} else if (current !== text) {
  fs.writeFileSync(file, text);
  console.log(`✔ wrote LICENSE (${copyrightHolder})`);
}
