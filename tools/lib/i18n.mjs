// Swaps the game's Chinese interface text for English at build time.
//
// Keys are the exact original strings, so a translation survives the source
// moving around and only genuinely new text is reported as missing. Two units
// of translation are used:
//   - a whole quoted string literal          'a{n}b'  ->  'x{n}y'
//   - one chunk of a template literal        `...${x} 剩 ${y}`  -> the text
//     between interpolations, translated chunk by chunk
// Translating whole literals rather than word runs keeps English free to
// reorder around the {placeholders}.

import { lex, spliceSpans, hasCJK } from './scan.mjs';

const escapeFor = (span, text) => {
  let out = text.replace(/\\/g, '\\\\');
  if (span.kind === 'template') return out.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return out.replace(new RegExp(span.quote, 'g'), `\\${span.quote}`);
};

/**
 * @param {string} source JS (comments already stripped) or markup
 * @param {Record<string,string>} map original text -> English
 * @param {{missingStrings:string[]}} report
 * @param {{markup:boolean}} opts
 */
export function translateStrings(source, map, report, opts) {
  if (opts.markup) return translateMarkup(source, map, report);

  const { strings } = lex(source);
  return spliceSpans(source, strings, (span) => {
    if (!hasCJK(span.text)) return span.text;
    // A handful of one-character labels collide across contexts (the stone
    // resource and the siege ship are both "石"), so an object key immediately
    // before the literal can qualify it: "uc_siegeship:石".
    const field = fieldNameBefore(source, span.start);
    const en = (field !== null ? map[`${field}:${span.text}`] : undefined) ?? map[span.text];
    if (en === undefined) {
      report.missingStrings.push(field !== null && span.text.length <= 2
        ? `${field}:${span.text}` : span.text);
      return span.text;
    }
    return escapeFor(span, en);
  });
}

// "  nm:'槍兵'" -> "nm"; anything else -> null.
function fieldNameBefore(source, start) {
  let i = start - 1;
  if (source[i] !== "'" && source[i] !== '"') return null;
  i--;
  while (i >= 0 && /\s/.test(source[i])) i--;
  if (source[i] !== ':') return null;
  i--;
  while (i >= 0 && /\s/.test(source[i])) i--;
  const end = i + 1;
  while (i >= 0 && /[\w$]/.test(source[i])) i--;
  return end > i + 1 ? source.slice(i + 1, end) : null;
}

// Markup carries far less text (button labels, tooltips, the document title) and
// mixes it with tags and attributes, so it is translated a whole line at a time.
// Substring replacement is deliberately not used here: single-character labels
// like 戰 or 開 also occur inside unrelated words and would corrupt the markup.
function translateMarkup(markup, map, report) {
  return markup.split('\n').map((line) => {
    if (!hasCJK(line)) return line;
    const indent = line.match(/^\s*/)[0];
    const en = map[line.trim()];
    if (en === undefined) {
      report.missingStrings.push(line.trim());
      return line;
    }
    return indent + en;
  }).join('\n');
}

/** Every translatable string in the build, for bootstrapping the dictionary. */
export function collectStrings(js, markup) {
  const seen = new Map();
  for (const s of lex(js).strings) {
    if (hasCJK(s.text) && !seen.has(s.text)) seen.set(s.text, '');
  }
  const markupText = markup.split('\n').filter(hasCJK).map((l) => l.trim());
  return { js: Object.fromEntries(seen), markupLines: markupText };
}
