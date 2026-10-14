#!/usr/bin/env node
/**
 * 把 tools/gen-md-index.mjs 生成的 JSON 清单转成可用 <script> 直接引入的 JS 文件。
 *
 * 用法：node tools/md-index-to-js.mjs [--in md-index.json] [--out md-index.js]
 *
 * 这样做的好处：把 md-index.js 和 index.html 放在一起，页面无需额外请求
 * （也避开了 file:// 下的 fetch 限制），清单永远是同步可用的。
 */
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv, cwd) {
  const opts = { in: 'md-index.json', out: 'md-index.js' };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const [flag, inline] = raw.slice(2).split('=');
    const next = inline !== undefined ? inline : argv[++i];
    if (flag === 'in') opts.in = next;
    else if (flag === 'out') opts.out = next;
  }
  opts.in = path.resolve(cwd, opts.in);
  opts.out = path.resolve(cwd, opts.out);
  return opts;
}

const opts = parseArgs(process.argv.slice(2), process.cwd());
if (!fs.existsSync(opts.in)) {
  console.error(`[md-index-to-js] 找不到清单：${opts.in}`);
  process.exit(1);
}

const raw = fs.readFileSync(opts.in, 'utf8');
let manifest;
try {
  manifest = JSON.parse(raw);
} catch (error) {
  console.error(`[md-index-to-js] 清单不是合法 JSON：${error.message}`);
  process.exit(1);
}

const js = [
  '/* 由 tools/md-index-to-js.mjs 自动生成，请勿手工编辑。 */',
  `window.__MD_INDEX__ = ${JSON.stringify(manifest, null, 2)};`,
  '',
].join('\n');

fs.writeFileSync(opts.out, js, 'utf8');
console.log(
  `[md-index-to-js] 已生成 ${path.basename(opts.out)}：${manifest?.counts?.files ?? '?'} 个文档`
);
