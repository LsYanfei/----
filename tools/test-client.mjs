#!/usr/bin/env node
/**
 * 离线校验 index.html 里的纯逻辑函数（路径解析、锚点匹配、链接改写规则）。
 *
 * 用法：node tools/test-client.mjs
 *
 * 浏览器里手工验证渲染效果，但路径与锚点这类"看不见的规则"用脚本钉住，
 * 免得改一次 index.html 就悄悄退化。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// 从 index.html 里取出需要的函数源码（避免维护第二份实现）
function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = html.indexOf(marker);
  if (start < 0) throw new Error(`index.html 里找不到函数 ${name}`);
  let depth = 0;
  let index = html.indexOf('{', start);
  const open = index;
  for (; index < html.length; index += 1) {
    const char = html[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, index + 1);
    }
  }
  throw new Error(`函数 ${name} 的花括号不闭合（起点 ${open}）`);
}

const functionNames = [
  'stripExt', 'groupOf', 'baseName', 'normalizePath', 'encodePath',
  'resolveHref', 'knownDocument', 'locationBase', 'toSiteUrl', 'resolveRelative', 'resolveDocName',
  'slugify', 'looseKey', 'escapeHtml', 'parseHash', 'hashFor',
];

/** 把 index.html 里的纯函数装进一个可控的 vm 上下文 */
function createContext({ pathname = '/repo/', files = [], dirs = [] } = {}) {
  const sandbox = {
    console,
    location: { protocol: 'https:', pathname, hash: '' },
    decodeURIComponent,
    encodeURIComponent,
    URLSearchParams,
    String,
    Number,
    Boolean,
    Object,
    Array,
    RegExp,
    Math,
    JSON,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const source = [
    'var CONFIG = { rootGroup: "其他资料", groupOrder: [], fallbackDocuments: [] };',
    'var state = { documents: [], byFile: {}, dirs: {}, current: null };',
    ...functionNames.map(extractFunction),
    'var api = {' + functionNames.join(', ') + '};',
  ].join('\n\n');
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'index.html#pure' });
  files.forEach((file) => {
    const normalized = sandbox.api.normalizePath(file).path;
    sandbox.state.byFile[normalized] = { file: normalized };
    const segments = normalized.split('/');
    if (segments.length > 1) sandbox.state.dirs[segments[0].toLowerCase()] = true;
  });
  dirs.forEach((dir) => { sandbox.state.dirs[dir.toLowerCase()] = true; });
  return { sandbox, api: sandbox.api };
}

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1;
  else failures.push(`${label}\n    实际: ${JSON.stringify(actual)}\n    期望: ${JSON.stringify(expected)}`);
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'md-index.json'), 'utf8'));
const files = manifest.documents.map((doc) => doc.file);

// 场景 A：当前仓库的真实布局（文档都在根目录，more/ 只放 PDF）
const flat = createContext({ pathname: '/repo/', files, dirs: ['more'] });
const api = flat.api;
const sandbox = flat.sandbox;

// 场景 B：文档放进子目录时的布局（验证分组后的行为）
const nested = createContext({
  pathname: '/repo/',
  files: ['政治/马原.md', '政治/史纲.md', '计算机/数据结构31.md', 'QA.md'],
  dirs: ['more'],
});
const napi = nested.api;

console.log('== 路径解析 ==');
check('encodePath 中文', api.encodePath('思想、道德、法治.md'), '%E6%80%9D%E6%83%B3%E3%80%81%E9%81%93%E5%BE%B7%E3%80%81%E6%B3%95%E6%B2%BB.md');
check('normalizePath 折叠内部 ..', api.normalizePath('a/b/../c.md').path, 'a/c.md');
check('normalizePath 保留首部 ..', api.normalizePath('../b.md').path, '../b.md');
check('normalizePath 保留绝对标记', api.normalizePath('/x.md').absolute, true);
check('normalizePath 去锚点', api.normalizePath('毛中特.md#abc').path, '毛中特.md');
check('相对链接回到上级', api.resolveHref('sub/a.md', '../b.md'), 'b.md');
check('根级文档的绝对链接（GitHub 风格）', api.resolveHref('马原.md', '/QA.md'), 'QA.md');
check('根级文档指向子目录', api.resolveHref('QA.md', '/more/同济.pdf'), 'more/同济.pdf');
check('带锚点的跨文档链接保留锚点', api.hashFor('QA.md', '计组'), '#doc=QA.md&h=%E8%AE%A1%E7%BB%84');
check('toSiteUrl 追加 Pages 子路径', api.toSiteUrl('/more/x.pdf'), 'repo/more/x.pdf');
check('toSiteUrl 已在子路径内不重复', api.toSiteUrl('/repo/more/x.pdf'), 'repo/more/x.pdf');
check('toSiteUrl 根文档不重复前缀', api.toSiteUrl('/QA.md'), 'repo/QA.md');
check('resolveDocName 大小写不敏感', api.resolveDocName('qa.md'), 'QA.md');
check('resolveDocName 未命中返回空', api.resolveDocName('不存在.md'), null);

console.log('== 子目录布局（分组后） ==');
check('同级引用', napi.resolveHref('政治/马原.md', '史纲.md'), '政治/史纲.md');
check('相对写法回仓库根', napi.resolveHref('政治/马原.md', '../QA.md'), 'QA.md');
check('GitHub 绝对写法命中已知文件', napi.resolveHref('政治/马原.md', '/QA.md'), 'QA.md');
check('GitHub 绝对写法命中已知目录', napi.resolveHref('政治/马原.md', '/政治/史纲.md'), '政治/史纲.md');
check('跨目录引用', napi.resolveHref('政治/马原.md', '/计算机/数据结构31.md'), '计算机/数据结构31.md');
check('仓库内已知目录的绝对链接', napi.resolveHref('政治/马原.md', '/more/同济.pdf'), 'more/同济.pdf');
check('仓库外站点资源退回相对', napi.resolveHref('政治/马原.md', '/assets/x.png'), '政治/assets/x.png');

console.log('== 锚点规则 ==');
check('slugify 保留中文与数字', api.slugify('6.3 邓小平理论的主要内容'), '63-邓小平理论的主要内容');
check('slugify 去掉标点', api.slugify('1.2 层次结构'), '12-层次结构');
check('slugify HTML 标签', api.slugify('<font color="red">导论</font>'), 'font-colorred导论font');
for (const [anchor, heading] of [
  ['63-邓小平理论的主要内容', '6.3 邓小平理论的主要内容'],
  ['82-党在过渡时期的总路线及其实施', '8.2 党在过渡时期的总路线及其实施'],
  ['91-历史性的伟大转折和改革开放的起步', '9.1 历史性的伟大转折和改革开放的起步'],
  ['计组', '计组'],
]) {
  check(`锚点宽松匹配 ${anchor}`, api.looseKey(anchor), api.looseKey(heading));
}

console.log('== 真实文档里的跨文档链接 ==');
// 来自 习思想.md / 毛中特.md / 计组28.md 的实际写法
const linkCases = [
  ['习思想.md', '/毛中特.md#马克思主义中国化时代化', '毛中特.md', '马克思主义中国化时代化'],
  ['毛中特.md', '/史纲.md#82-党在过渡时期的总路线及其实施', '史纲.md', '82-党在过渡时期的总路线及其实施'],
  ['计组28.md', '/QA.md#计组', 'QA.md', '计组'],
];
for (const [from, href, expectedDoc, expectedAnchor] of linkCases) {
  const [target, anchor] = href.split('#');
  const resolved = api.resolveHref(from, target);
  check(`${from} -> ${href}`, [resolved, anchor], [expectedDoc, expectedAnchor]);
  const doc = sandbox.state.byFile[resolved];
  check(`  ↳ 目标在清单中 ${expectedDoc}`, Boolean(doc), true);
}

console.log('== 清单本身 ==');
check('清单文档数', manifest.documents.length, files.length);
const titles = manifest.documents.map((doc) => doc.title);
check('标题里没有 HTML', titles.some((title) => /[<>]/.test(title)), false);
check('每篇都有标题', titles.every((title) => typeof title === 'string' && title.length > 0), true);
const duplicates = titles.filter((title, index) => titles.indexOf(title) !== index);
check('标题无重复', duplicates, []);

console.log('');
if (failures.length) {
  console.error(`✗ ${failures.length} 项失败（通过 ${passed} 项）`);
  failures.forEach((item) => console.error(`  ✗ ${item}`));
  process.exit(1);
}
console.log(`✓ 全部 ${passed} 项检查通过`);
