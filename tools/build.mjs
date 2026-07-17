#!/usr/bin/env node
// Builds the public, playable copies of the game from the development source.
//
//   node tools/build.mjs [path-to-source-index.html]
//
// For now one artifact comes out of the development source:
//   zh/index.html   the game, with its original Chinese UI
//
// The build is deterministic and content-keyed: translations live in
// tools/i18n/*.json keyed by the original text, so re-running the build after
// the source changes reuses every existing translation and reports only what is
// new. Nothing here is hand-edited downstream -- never patch the generated
// index.html directly, it will be overwritten.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { rewriteComments, hasCJK } from './lib/scan.mjs';
import { applyDevGating } from './lib/devtools.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const DEFAULT_SRC = resolve(repo, '../prototype/slice4-civ/index.html');

const srcPath = resolve(process.argv[2] || DEFAULT_SRC);
const src = readFileSync(srcPath, 'utf8');

const SCRIPT_OPEN = '<script>';
const SCRIPT_CLOSE = '</script>';
const jsStart = src.indexOf(SCRIPT_OPEN) + SCRIPT_OPEN.length;
const jsEnd = src.lastIndexOf(SCRIPT_CLOSE);
if (jsStart < SCRIPT_OPEN.length || jsEnd < 0) throw new Error('cannot locate the <script> block');

const markup = src.slice(0, jsStart);
const js = src.slice(jsStart, jsEnd);
const tail = src.slice(jsEnd);

const i18nDir = resolve(here, 'i18n');
const readJSON = (name) => JSON.parse(readFileSync(resolve(i18nDir, name), 'utf8'));

const comments = Object.assign({}, ...readdirSync(i18nDir)
  .filter((f) => f.startsWith('comments-') && f.endsWith('.json'))
  .sort()
  .map(readJSON));

const report = { commentsKept: 0, commentsDropped: 0, missingComments: [], missingStrings: [] };

// --- 1. comments -------------------------------------------------------------
// The development source carries years of Chinese design notes. Structural ones
// (section headers, function contracts) are replaced by an English rewrite from
// comments-en.json; everything else is cut.
//
// That dictionary is keyed by a hash of the original rather than by the original
// text, so this repo never republishes the private notes -- only the rewrites.
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const keyOf = (s) => createHash('sha1').update(norm(s)).digest('hex').slice(0, 12);

const strippedJs = rewriteComments(js, (cm) => {
  if (!hasCJK(cm.text)) { report.commentsKept++; return cm.text; }
  const en = comments[keyOf(cm.text)];
  if (en === undefined) {
    report.missingComments.push({ key: keyOf(cm.text), text: norm(cm.text) });
    report.commentsDropped++;
    return null;
  }
  if (en === '') { report.commentsDropped++; return null; } // explicitly dropped
  report.commentsKept++;
  const indent = ' '.repeat(cm.indent || 0);
  return cm.kind === 'line'
    ? `// ${en}`
    : en.includes('\n')
      ? `/* ${en.split('\n').join(`\n${indent}   `)} */`
      : `/* ${en} */`;
});

const strippedMarkup = markup
  .replace(/\/\*[\s\S]*?\*\//g, (m) => (hasCJK(m) ? '' : m)) // CSS comments
  .replace(/<!--[\s\S]*?-->/g, (m) => (hasCJK(m) ? '' : m))
  .replace(/[ \t]+$/gm, '');

// --- 2. developer tools ------------------------------------------------------
const gatedJs = applyDevGating(strippedJs);

// --- 3. emit -----------------------------------------------------------------
function emit(relPath, markupPart, jsPart, lang) {
  const out = markupPart + jsPart + tail;
  const dest = resolve(repo, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, out);
  return { relPath, bytes: out.length, lang };
}

const zh = emit('zh/index.html', strippedMarkup, gatedJs, 'zh');

// --- 4. report ---------------------------------------------------------------
const uniq = (a) => [...new Set(a)];
report.missingComments = [...new Map(report.missingComments.map((c) => [c.key, c])).values()];

console.log(`source        ${srcPath}`);
console.log(`built         ${zh.relPath} (${(zh.bytes / 1024).toFixed(0)} KB, zh)`);
console.log(`comments      ${report.commentsKept} kept, ${report.commentsDropped} dropped`);

// The originals stay out of this repo, so the review dump is written wherever
// REPORT_COMMENTS points -- typically a scratch directory next to the source.
if (process.env.REPORT_COMMENTS) {
  writeFileSync(process.env.REPORT_COMMENTS, JSON.stringify(report.missingComments, null, 1));
  console.log(`\nWrote ${report.missingComments.length} untranslated comments to ${process.env.REPORT_COMMENTS}`);
}

if (process.env.STRICT && (report.missingComments.length)) {
  process.exitCode = 1;
}
