#!/usr/bin/env node
/**
 * 把单个 Markdown 文档转成独立 HTML（离线预览 / 排查公式与图表识别）。
 *
 * 用法：
 *   node tools/render-md.mjs 数学解法.md                 # 输出到 stdout
 *   node tools/render-md.mjs 计网28.md -o out.html       # 写到文件
 *   node tools/render-md.mjs 计网28.md --body-only       # 只要正文片段
 *
 * 这里复用与 index.html 相同的数学规则，用来在终端里确认公式有没有被正确识别。
 * 线上真正的渲染仍由浏览器里的 index.html 负责。
 */
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv, cwd) {
  const opts = { input: '', out: '', bodyOnly: false, title: '', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--body-only') opts.bodyOnly = true;
    else if (arg === '-o' || arg === '--out') opts.out = argv[++i] ?? '';
    else if (arg === '--title') opts.title = argv[++i] ?? '';
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (!arg.startsWith('-') && !opts.input) opts.input = arg;
  }
  if (opts.input) opts.input = path.resolve(cwd, opts.input);
  return opts;
}

/* ===== 与 index.html 保持一致的数学规则 ===== */

const MATH_OPENERS = /\$|\\\(|\\\[/;

function matchInlineMath(src) {
  const pairs = [
    { open: 2, close: '$$' },
    { open: 1, close: '$' }
  ];
  for (const pair of pairs) {
    if (src.slice(0, pair.open) !== '$'.repeat(pair.open)) continue;
    if (pair.open === 1 && src.slice(0, 2) === '$$') continue;
    const end = src.indexOf(pair.close, pair.open);
    if (end < 0) continue;
    const content = src.slice(pair.open, end);
    const trimmed = content.replace(/^\s+/, '').replace(/\s+$/, '');
    if (!trimmed) continue;
    const latex = trimmed.indexOf('\\') >= 0;
    if (/^\s/.test(content) && !latex) continue;
    if (/\s$/.test(content) && !latex) continue;
    if (/[0-9]/.test(src.charAt(end + pair.close.length))) continue;
    return { raw: src.slice(0, end + pair.close.length), text: trimmed, display: pair.open === 2 };
  }
  return null;
}

const escapeHtml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function mathHtml(text, display) {
  const tag = display ? 'div' : 'span';
  const attribute = display ? ' class="katex-block" data-display="1"' : ' class="katex-wrap" data-display="0"';
  return `<${tag}${attribute}>${escapeHtml(text)}</${tag}>`;
}

/** 与 index.html 的 createMathExtension 相同 */
export function createMathExtension() {
  return {
    extensions: [
      {
        name: 'inlineMath',
        level: 'inline',
        start(src) {
          const index = src.search(MATH_OPENERS);
          return index < 0 ? undefined : index;
        },
        tokenizer(src) {
          if (src.charAt(0) === '$') {
            const hit = matchInlineMath(src);
            if (hit) return { type: 'inlineMath', raw: hit.raw, text: hit.text, display: hit.display };
          }
          for (const pair of [
            { open: '\\[', close: '\\]', display: true },
            { open: '\\(', close: '\\)', display: false }
          ]) {
            if (src.slice(0, pair.open.length) !== pair.open) continue;
            const end = src.indexOf(pair.close, pair.open.length);
            if (end < 0) continue;
            const content = src.slice(pair.open.length, end).replace(/^\s+|\s+$/g, '');
            if (!content) continue;
            return {
              type: 'inlineMath',
              raw: src.slice(0, end + pair.close.length),
              text: content,
              display: pair.display
            };
          }
          return undefined;
        },
        renderer(token) { return mathHtml(token.text, token.display); }
      },
      {
        name: 'blockMath',
        level: 'block',
        tokenizer(src) {
          for (const pair of [{ open: '$$', close: '$$' }, { open: '\\[', close: '\\]' }]) {
            if (src.slice(0, pair.open.length) !== pair.open) continue;
            const end = src.indexOf(pair.close, pair.open.length);
            if (end < 0) continue;
            const raw = src.slice(0, end + pair.close.length);
            const content = src.slice(pair.open.length, end).replace(/^\s*\n/, '').replace(/\n\s*$/, '');
            if (!content.replace(/\s+/g, '')) continue;
            return { type: 'blockMath', raw, text: content };
          }
          return undefined;
        },
        renderer(token) { return mathHtml(token.text, true); }
      }
    ]
  };
}

/** 独占一行的单个 $ 规范化为 $$（数学解法.md 的写法） */
export function normalizeDisplayDollars(markdown) {
  if (markdown.indexOf('$') < 0) return markdown;
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  let fenced = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*(?:```|~~~)/.test(lines[i])) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const standalone = /^(\s*)\$\s*$/.exec(lines[i]);
    if (standalone) lines[i] = `${standalone[1]}$$`;
  }
  return lines.join('\n');
}

/* ===== 命令行 ===== */

const opts = parseArgs(process.argv.slice(2), process.cwd());
if (opts.help || !opts.input) {
  console.log(`用法：node tools/render-md.mjs <文件.md> [-o 输出.html] [--body-only] [--title 标题]

这个脚本只在本地调试时使用，部署站点不需要它。
要看真正的排版效果，请用 tools/dev-server.mjs 起服务后打开页面。`);
  process.exit(opts.input || opts.help ? 0 : 1);
}

if (!fs.existsSync(opts.input)) {
  console.error(`[render-md] 找不到文件：${opts.input}`);
  process.exit(1);
}

const markdown = fs.readFileSync(opts.input, 'utf8');
const name = opts.title || path.basename(opts.input, path.extname(opts.input));

/** marked 可能装在本地 .mddeps 里（仅供测试），依次尝试 */
async function loadMarked() {
  try {
    const mod = await import('marked');
    return mod.Marked ?? mod.marked?.Marked ?? mod.marked;
  } catch (error) {
    const local = new URL('../.mddeps/node_modules/marked/lib/marked.esm.js', import.meta.url);
    if (fs.existsSync(local)) {
      const mod = await import(local.href);
      return mod.Marked ?? mod.marked?.Marked ?? mod.marked;
    }
    throw error;
  }
}

let body;
try {
  const MarkedCtor = await loadMarked();
  if (typeof MarkedCtor !== 'function') throw new Error('拿到的 marked 构造器不可用');
  const instance = new MarkedCtor({ gfm: true, breaks: true });
  instance.use(createMathExtension());
  body = instance.parse(normalizeDisplayDollars(markdown));
} catch (error) {
  // 没有安装 marked 时退化成纯文本预览，至少确认文件能读到
  console.warn(
    `[render-md] 未能使用 marked（${error.message}）。\n` +
    '           可在仓库里执行：npm install --prefix .mddeps marked@12.0.2'
  );
  body = `<pre>${escapeHtml(markdown)}</pre>`;
}

const mathCount = (body.match(/katex-(?:wrap|block)/g) ?? []).length;
const mermaidCount = (body.match(/language-mermaid/g) ?? []).length;
console.error(
  `[render-md] ${path.basename(opts.input)}：识别到公式 ${mathCount} 处，mermaid 块 ${mermaidCount} 个`
);

if (opts.bodyOnly) {
  process.stdout.write(body + '\n');
  process.exit(0);
}

const doc = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/mhchem.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script>
<style>
  body { max-width: 860px; margin: 0 auto; padding: 32px 20px 80px; line-height: 1.75;
         font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  img, svg { max-width: 100%; }
  pre { overflow-x: auto; padding: 12px; background: #f6f8fa; border-radius: 8px; }
  code { background: #f2f4f7; padding: 1px 4px; border-radius: 4px; }
  pre code { background: none; padding: 0; }
  .katex-wrap, .katex-block { max-width: 100%; overflow-x: auto; }
  .katex-block { display: block; margin: 1em 0; text-align: center; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #d0d7de; padding: 6px 12px; }
  .mermaid-figure { text-align: center; margin: 20px 0; }
</style>
</head>
<body>
${body}
<script>
  document.querySelectorAll('.katex-wrap, .katex-block').forEach(function (node) {
    try {
      katex.render(node.textContent, node, {
        displayMode: node.getAttribute('data-display') === '1',
        throwOnError: false, strict: 'ignore'
      });
    } catch (error) { console.warn(error); }
  });
  if (window.mermaid) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
    document.querySelectorAll('pre > code.language-mermaid').forEach(function (code, index) {
      var source = code.textContent.trim();
      var figure = document.createElement('figure');
      figure.className = 'mermaid-figure';
      var host = code.closest('pre');
      host.parentNode.replaceChild(figure, host);
      mermaid.render('mmd-render-' + index, source).then(function (result) {
        figure.innerHTML = result.svg;
      }).catch(function (error) {
        figure.textContent = String(error && error.message ? error.message : error);
      });
    });
  }
</script>
</body>
</html>
`;

if (opts.out) {
  fs.writeFileSync(path.resolve(process.cwd(), opts.out), doc, 'utf8');
  console.error(`[render-md] 已写入 ${opts.out}`);
} else {
  process.stdout.write(doc);
}
