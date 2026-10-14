#!/usr/bin/env node
/**
 * 扫描仓库中的 Markdown 文档，生成静态站点用的文件清单。
 *
 * 用法（在仓库根目录执行）：
 *   node tools/gen-md-index.mjs [--root .] [--out md-index.json]
 *
 * 产物 md-index.json 会被 .github/workflows/static.yml 转换成 md-index.js，
 * 由 index.html 在浏览器里读取；清单里同时带上 owner/repo/branch/base，
 * 这样前端列目录失败时还能回退调用 GitHub API。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 不参与扫描的目录（按路径段匹配） */
const IGNORE_DIRS = new Set([
  '.git',
  '.github',
  '.idea',
  '.vscode',
  'node_modules',
  'more',
]);

/** 不作为文档列出的文件名（小写比较） */
const IGNORE_BASENAMES = new Set([
  'readme.md',
  'index.md',
  'summary.md',
  'changelog.md',
  'license.md',
  // 临时草稿：内容不全且在本机为只读，不应出现在站点上
  'testclean.md',
]);

function fail(message) {
  console.error(`[gen-md-index] ${message}`);
  process.exit(1);
}

export function parseArgs(argv, cwd) {
  const opts = {
    root: path.join(HERE, '..'),
    out: 'md-index.json',
    owner: '',
    repo: '',
    base: '/',
    branch: 'main',
    name: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const [flag, inline] = raw.slice(2).split('=');
    const next = inline !== undefined ? inline : argv[++i];
    switch (flag) {
      case 'root':
        opts.root = path.resolve(cwd, next ?? '.');
        break;
      case 'out':
        opts.out = next ?? 'md-index.json';
        break;
      case 'owner':
        opts.owner = next ?? '';
        break;
      case 'repo':
        opts.repo = next ?? '';
        break;
      case 'base':
        opts.base = next ?? '/';
        break;
      case 'branch':
        opts.branch = next ?? 'main';
        break;
      case 'name':
        opts.name = next ?? '';
        break;
      case 'help':
        console.log('node tools/gen-md-index.mjs [--root .] [--out md-index.json]');
        process.exit(0);
        break;
      default:
        fail(`未知参数：--${flag}`);
    }
  }
  return opts;
}

const normSlashes = (value) => value.split(path.sep).join('/');
const dirKey = (value) => value.split(path.sep).join('/').toLowerCase();

/** 递归收集 Markdown 文件，返回相对仓库根目录、以 / 分隔的路径 */
export function collectMarkdown(root) {
  const found = [];
  const walk = (absDir, relDir) => {
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(dirKey(rel))) continue;
        if (entry.name.startsWith('.')) continue;
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(md|markdown)$/i.test(entry.name)) continue;
      if (IGNORE_BASENAMES.has(entry.name.toLowerCase())) continue;
      found.push(normSlashes(rel));
    }
  };
  walk(root, '');
  // 忽略大小写 + 路径深度优先的稳定排序
  return found.sort((a, b) => {
    const segsA = a.split('/');
    const segsB = b.split('/');
    for (let i = 0; i < Math.max(segsA.length, segsB.length); i += 1) {
      const x = segsA[i];
      const y = segsB[i];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      const cmp = x.localeCompare(y, 'zh-Hans-CN');
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
}

/** 从 Markdown 正文里抽取标题层级、首个标题与纯文本摘要 */
export function summarize(markdown, fallback) {
  const text = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const headings = [];
  let firstHeading = '';
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const level = match[1].length;
    const value = cleanInline(match[2]);
    if (!value) continue;
    headings.push({ level, text: value });
    if (!firstHeading) firstHeading = value;
  }
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}[>#\-*+]\s*/gm, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[*_~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // 侧边栏用文件名更直观，首个标题只作为副标题/搜索提示
  return {
    title: fallback,
    heading: firstHeading,
    headings,
    words: [...plain].length,
    preview: plain.slice(0, 120),
  };
}

/** 去掉标题里的 HTML 标签与强调符，压平空白 */
function cleanInline(value) {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/[*`_~\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 依据 CI 环境变量、git 远端推断 owner、仓库名与 Pages 子路径 */
export function detectRepo(root, env = process.env) {
  const info = { owner: '', repo: '', branch: 'main' };
  if (env.GITHUB_REPOSITORY) {
    const [owner, repo] = env.GITHUB_REPOSITORY.split('/');
    info.owner = owner ?? '';
    info.repo = repo ?? '';
  }
  if (!info.repo) {
    let remote = '';
    try {
      remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      remote = '';
    }
    const match =
      /^(?:https?:\/\/|git@|ssh:\/\/git@)(?:[^/:]+)[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(remote);
    if (match) {
      info.owner = match[1];
      info.repo = match[2];
    }
  }
  const ref = env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME;
  if (ref) info.branch = ref;
  if (env.GITHUB_PAGES_BASE) info.base = env.GITHUB_PAGES_BASE;
  return info;
}

export function buildManifest(options, env = process.env) {
  const root = options.root;
  if (!fs.existsSync(root)) fail(`仓库根目录不存在：${root}`);
  const files = collectMarkdown(root);

  const tip = (env.GITHUB_SHA || '').slice(0, 7) || 'local';
  const detected = detectRepo(root, env);
  const owner = options.owner || detected.owner;
  const repo = options.repo || detected.repo;
  const branch = options.branch || detected.branch;

  let base = options.base || detected.base || '/';
  if (!base.startsWith('/')) base = `/${base}`;
  if (!base.endsWith('/')) base = `${base}/`;
  if (!options.base && env.GITHUB_PAGES_BASE === undefined && env.GITHUB_REPOSITORY) {
    // 项目站点 owner.github.io/<repo> 的子路径；用户站点（仓库名以 .github.io 结尾）则挂在根上
    base = /\.github\.io$/i.test(repo) ? '/' : `/${repo}/`;
  }

  const documents = files.map((file) => {
    const absolute = path.join(root, ...file.split('/'));
    const buffer = fs.readFileSync(absolute);
    const fallbackName = path.basename(file, path.extname(file));
    const summary = summarize(buffer.toString('utf8'), fallbackName);
    return { file, ...summary, bytes: buffer.length };
  });

  const dirs = new Set();
  for (const doc of documents) {
    const segments = doc.file.split('/');
    if (segments.length > 1) dirs.add(segments[0]);
  }

  const manifest = {
    name: options.name || repo || '考研复习',
    source: 'gen-md-index',
    tip,
    owner,
    repo,
    branch,
    base,
    generatedAt: new Date().toISOString(),
    counts: { files: documents.length },
    dirs: [...dirs].sort(),
    documents: documents.map(({ file, title, heading, headings, words, preview }) => ({
      file,
      title,
      heading,
      headings,
      words,
      preview,
    })),
  };
  manifest.fingerprint = createHash('sha1')
    .update(JSON.stringify(manifest.documents))
    .digest('hex')
    .slice(0, 12);
  return manifest;
}

function main() {
  const options = parseArgs(process.argv.slice(2), process.cwd());
  const manifest = buildManifest(options);
  const outPath = path.isAbsolute(options.out)
    ? options.out
    : path.join(options.root, options.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(
    `[gen-md-index] 已生成 ${options.out}：${manifest.counts.files} 个文档 @ ${manifest.tip}`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
