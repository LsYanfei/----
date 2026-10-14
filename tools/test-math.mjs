/**
 * LaTeX / mermaid 支持的可离线回归测试。
 *
 * 数学规则与 index.html 里的 createMathExtension 保持一致，
 * 并用真实的 .md 文档 + 真实 KaTeX 逐条校验公式能否解析。
 *
 * 依赖本地安装的 marked / katex（.mddeps，仅测试用）：
 *   npm install --prefix .mddeps marked@12.0.2 katex@0.16.11 --cache <可写缓存目录>
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.join(import.meta.dirname, '..');

// 缺少本地依赖时给出明确提示，而不是抛一个看不懂的解析错误
const DEPS = path.join(ROOT, '.mddeps', 'node_modules');
for (const pkg of ['marked', 'katex']) {
  if (!fs.existsSync(path.join(DEPS, pkg))) {
    console.error(
      `[test-math] 缺少本地测试依赖 ${pkg}。请先在仓库根目录执行：\n` +
      '  npm install --prefix .mddeps marked@12.0.2 katex@0.16.11 --cache .npm-cache\n' +
      '（.mddeps 已在 .gitignore 里，不会被提交）'
    );
    process.exit(1);
  }
}

const { Marked } = await import(
  pathToFileURL(path.join(DEPS, 'marked', 'lib', 'marked.esm.js')).href
);
const katex = (await import(
  pathToFileURL(path.join(DEPS, 'katex', 'dist', 'katex.mjs')).href
)).default;

/* ===== 与 index.html 保持一致：数学扩展 ===== */

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

function createMathExtension() {
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
          for (const pair of [{ open: '\\[', close: '\\]', display: true }, { open: '\\(', close: '\\)', display: false }]) {
            if (src.slice(0, pair.open.length) !== pair.open) continue;
            const end = src.indexOf(pair.close, pair.open.length);
            if (end < 0) continue;
            const content = src.slice(pair.open.length, end).replace(/^\s+|\s+$/g, '');
            if (!content) continue;
            return { type: 'inlineMath', raw: src.slice(0, end + pair.close.length), text: content, display: pair.display };
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

function normalizeDisplayDollars(markdown) {
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

function createEngine() {
  const instance = new Marked({ gfm: true, breaks: true });
  instance.use(createMathExtension());
  return instance;
}

/* ===== 断言框架 ===== */

let passed = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) passed += 1;
  else failures.push(`${label}${detail ? `\n      ${detail}` : ''}`);
}

const engine = createEngine();
const parse = (markdown) => engine.parse(normalizeDisplayDollars(markdown));

/* ===== 单元测试 ===== */

console.log('== 数学语法 ==');
const cases = [
  ['行内 $...$', '极限 $x=1$ 成立', (h) => h.includes('<span class="katex-wrap" data-display="0">x=1</span>')],
  ['行内夹在中文之间', '数列{$x_n$}收敛', (h) => h.includes('>x_n</span>}收敛')],
  ['加粗与公式混排', '**方法**：$\\frac00$ 型', (h) => h.includes('<strong>方法</strong>') && h.includes('>\\frac00</span>')],
  ['括号里的公式', '时间复杂度为 $O(|V|^2)$', (h) => h.includes('>O(|V|^2)</span>')],
  ['两侧带空格的公式', '$ \\lim\\limits_{x \\to 0}{\\frac{\\sin x}{x}} = 1$', (h) => h.includes('katex-wrap') && h.includes('\\lim\\limits')],
  ['公式后无空格接汉字', '有$d \\ge c$且', (h) => h.includes('katex-wrap') && h.includes('且')],
  ['两个公式在同一行', '这样 $a$ 和 $b$ 都行', (h) => (h.match(/katex-wrap/g) ?? []).length === 2],
  ['$$ 单行', '公式：$$a^2+b^2=c^2$$', (h) => h.includes('<div class="katex-block" data-display="1">')],
  ['$$ 独占多行', '$$\n\\int_0^1 x^2 dx = \\frac13\n$$', (h) =>
    h.includes('<div class="katex-block"') && h.includes('\\int_0^1 x^2 dx = \\frac13')],
  ['裸 $ 多行块（数学解法.md 写法）', '$\n\\sin^2a+\\cos^2a=1 \\\\\n\\cos(a\\pm b)=1 \\\\\n$\n\n# 标题', (h) =>
    h.includes('<div class="katex-block"') && h.includes('\\sin^2a+\\cos^2a=1 \\\\') && h.includes('<h1')],
  ['\\[ \\] 块', '\\[\nE = mc^2\n\\]', (h) => h.includes('<div class="katex-block"') && h.includes('E = mc^2')],
  ['\\( \\) 行内', '于是 \\(a+b\\) 成立', (h) => h.includes('<span class="katex-wrap"')],
  ['公式里的下划线不当斜体', '$a_1 + b_2$', (h) => h.includes('a_1 + b_2') && !h.includes('<em>')],
  ['公式里的星号不当强调', '$a*b*c$', (h) => h.includes('a*b*c') && !h.includes('<em>')],
  ['公式里的方括号不当链接', '$A[1][2]$', (h) => h.includes('A[1][2]') && !h.includes('<a ')],
  ['mhchem 化学式', '$\\ce{2H2 + O2 -> 2H2O}$', (h) => h.includes('katex-wrap')],

  ['货币文本不当公式', '单价 $5 和 $6 相比', (h) => !h.includes('katex')],
  ['$ 后空格不当公式', '$ x$ 与 $x $', (h) => !h.includes('katex')],
  ['未闭合 $ 不吞正文', '价格 $100 元\n\n下一段', (h) => h.includes('下一段') && !h.includes('katex')],
  ['代码围栏里的 $ 不动', '```\n$a+b$\n```', (h) => h.includes('$a+b$') && !h.includes('katex-wrap')],
  ['行内代码里的 $ 不动', '用 `$x$` 表示', (h) => h.includes('<code>$x$</code>') && !h.includes('katex-wrap')],
  ['mermaid 里的 $ 不动', '```mermaid\nsequenceDiagram\n  a->>b: x $y$\n```', (h) =>
    h.includes('language-mermaid') && !h.includes('katex')],
  ['表格里的公式', '| a | b |\n| - | - |\n| $x^2$ | $y_1$ |', (h) =>
    h.includes('<table>') && (h.match(/katex-wrap/g) ?? []).length === 2],
  ['公式不会被 <br> 打断', '第一行\n$\\frac{a}{b}$\n第二行', (h) =>
    !/<span class="katex-wrap"[^>]*>[^<]*<br>/.test(h) && h.includes('>\\frac{a}{b}</span>')],
  ['公式里的尖括号被转义', '$a<b>c$', (h) => h.includes('&lt;b&gt;') && !h.includes('<b>')],
  ['XSS 被转义', '$<script>alert(1)</script>$', (h) => !h.includes('<script>') && h.includes('&lt;script&gt;')]
];

for (const [label, input, assert] of cases) {
  const html = parse(input);
  check(label, assert(html), html.slice(0, 200).replace(/\n/g, '⏎'));
}

/* ===== 真实文档 + KaTeX 校验 ===== */

console.log('\n== 真实文档（真实 KaTeX 校验）==');
const files = fs.readdirSync(ROOT)
  .filter((f) => f.endsWith('.md') && !/^test/i.test(f))
  .sort();

const allMath = [];
for (const file of files) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const html = parse(source);
  const found = [];
  const re = /<(span|div) class="katex-(?:wrap|block)" data-display="([01])">([\s\S]*?)<\/\1>/g;
  let match;
  while ((match = re.exec(html))) {
    found.push({
      file,
      display: match[2] === '1',
      text: match[3].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    });
  }
  const failed = [];
  for (const item of found) {
    try {
      katex.renderToString(item.text, { displayMode: item.display, throwOnError: true, strict: false });
    } catch (error) {
      failed.push({ text: item.text, message: String(error.message).split('\n')[0] });
    }
  }
  allMath.push(...found);
  const leftover = (html.match(/\$/g) ?? []).length;
  const mermaid = (html.match(/language-mermaid/g) ?? []).length;
  console.log(
    `${file.padEnd(18)} 公式 ${String(found.length).padStart(4)}` +
    `（块级 ${String(found.filter((f) => f.display).length).padStart(2)}） | KaTeX 失败 ${String(failed.length).padStart(2)}` +
    ` | 未解析 \$ ${String(leftover).padStart(2)} | mermaid ${mermaid}`
  );
  check(`${file} 的公式全部通过 KaTeX`, failed.length === 0,
    failed.slice(0, 3).map((f) => `${JSON.stringify(f.text)} -> ${f.message}`).join('\n      '));
  check(`${file} 没有公式被 <br> 打断`, !/<span class="katex-wrap"[^>]*>[^<]*<br>/.test(html));
  check(`${file} 没有把数学渲染成斜体/链接`, !/<span class="katex-wrap"[^>]*>[^<]*<(?:em|a)\b/.test(html));
}

console.log(`\n合计公式 ${allMath.length}（块级 ${allMath.filter((m) => m.display).length}）`);

/* ===== 真实文档的 mermaid 块 ===== */

console.log('\n== 真实文档的 mermaid ==');
const mermaidFiles = files.filter((f) => /```mermaid/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
check('至少有一个文档包含 mermaid', mermaidFiles.length > 0);
for (const file of mermaidFiles) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const html = parse(source);
  const blocks = (html.match(/<pre><code class="language-mermaid">/g) ?? []).length;
  const inSource = (source.match(/```mermaid/g) ?? []).length;
  console.log(`  ${file}: 源码 ${inSource} 块，渲染成代码块的 ${blocks} 个`);
  check(`${file} 的 mermaid 块数量一致`, blocks === inSource, `源码 ${inSource} vs 输出 ${blocks}`);
  check(`${file} 的 mermaid 内容未被当作公式`, !/<pre><code class="language-mermaid">[\s\S]*?katex-wrap/.test(html));
}

/* ===== index.html 与测试实现是否同步 ===== */

console.log('\n== index.html 同步检查 ==');
const appHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
for (const needle of [
  'name: "inlineMath"',
  'name: "blockMath"',
  'function matchInlineMath',
  'function normalizeDisplayDollars',
  'function renderMathIn',
  'function renderMermaidIn',
  'function ensureMermaid',
  'katex.min.js',
  'katex.min.css',
  'mhchem.min.js',
  'copy-tex.min.js',
  'mermaid@11.4.1'
]) {
  check(`index.html 含 ${needle}`, appHtml.includes(needle));
}
check('index.html 不再用 auto-render 直接渲染公式',
  !/renderMathInElement\s*\(/.test(appHtml));

console.log('');
if (failures.length) {
  console.error(`✗ ${failures.length} 项失败（通过 ${passed} 项）`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  process.exit(1);
}
console.log(`✓ 全部 ${passed} 项检查通过`);
