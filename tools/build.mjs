#!/usr/bin/env node
// Builds the public, playable copies of the game from the development source.
//
//   node tools/build.mjs [path-to-source-index.html]
//
// Two artifacts come out of one source file:
//   index.html      English UI, developer tools hidden behind ?dev=1
//   zh/index.html   Original Chinese UI, same gating
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
import { translateStrings, collectStrings } from './lib/i18n.mjs';

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

// Translations are split by area (units, buildings, panels, ...) purely for
// reviewability; the build merges them into one dictionary.
const uiStrings = Object.assign({}, ...readdirSync(i18nDir)
  .filter((f) => f.startsWith('strings-') && f.endsWith('.json'))
  .sort()
  .map(readJSON));

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

const enMarkup = translateStrings(strippedMarkup, uiStrings, report, { markup: true });
// A few Chinese words are object *keys* rather than string literals, so the
// string translator never sees them; they are patched by exact text instead.
const enJs = readJSON('patches-en.json').reduce((js2, { from, to }) => {
  if (!js2.includes(from)) throw new Error(`patch no longer matches the source: ${from}`);
  return js2.split(from).join(to);
}, translateStrings(gatedJs, uiStrings, report, { markup: false }));
const en = emit('index.html', enMarkup, enJs, 'en');

// --- 4. report ---------------------------------------------------------------
const uniq = (a) => [...new Set(a)];
report.missingStrings = uniq(report.missingStrings);
report.missingComments = [...new Map(report.missingComments.map((c) => [c.key, c])).values()];

console.log(`source        ${srcPath}`);
console.log(`built         ${en.relPath} (${(en.bytes / 1024).toFixed(0)} KB, en)`);
console.log(`built         ${zh.relPath} (${(zh.bytes / 1024).toFixed(0)} KB, zh)`);
console.log(`comments      ${report.commentsKept} kept, ${report.commentsDropped} dropped`);

if (report.missingStrings.length) {
  console.log(`\n${report.missingStrings.length} UI string(s) have no English translation:`);
  for (const s of report.missingStrings.slice(0, 40)) console.log(`  ${JSON.stringify(s)}`);
  if (report.missingStrings.length > 40) console.log(`  ... and ${report.missingStrings.length - 40} more`);
  console.log('Add them to a tools/i18n/strings-*.json and rebuild.');
}

// The originals stay out of this repo, so the review dump is written wherever
// REPORT_COMMENTS points -- typically a scratch directory next to the source.
if (process.env.REPORT_COMMENTS) {
  writeFileSync(process.env.REPORT_COMMENTS, JSON.stringify(report.missingComments, null, 1));
  console.log(`\nWrote ${report.missingComments.length} untranslated comments to ${process.env.REPORT_COMMENTS}`);
}

if (process.env.DUMP_STRINGS) {
  writeFileSync(resolve(i18nDir, 'all-strings.json'),
    JSON.stringify(collectStrings(gatedJs, strippedMarkup), null, 1));
  console.log('Wrote every translatable string for review.');
}

if (process.env.STRICT && (report.missingStrings.length || report.missingComments.length)) {
  process.exitCode = 1;
}
