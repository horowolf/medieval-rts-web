// Minimal JavaScript lexer: reports every comment and every string-literal body.
//
// The game is one large hand-written file, so regex-based rewriting is not safe:
// "/*" appears inside string literals and "/" is ambiguous between division and
// the start of a regex literal. This scanner tracks just enough state to get
// both right:
//   - string literals ('...', "...") including escapes
//   - template literals (`...`) including nested ${ ... } interpolation
//   - regex literals, disambiguated from division by the previous real token
//
// It reports spans only; callers decide what to do with them.

const KEYWORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

// After these characters a "/" starts a regex literal, not a division.
const PUNCT_BEFORE_REGEX = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*',
  '%', '^', '~', '<', '>',
]);

const startsRegex = (prev) =>
  !prev || PUNCT_BEFORE_REGEX.has(prev) || KEYWORDS_BEFORE_REGEX.has(prev);

/**
 * @param {string} src JavaScript source
 * @returns {{comments:{start:number,end:number,kind:'line'|'block',text:string,indent:number}[],
 *            strings:{start:number,end:number,kind:'quoted'|'template',text:string}[]}}
 */
export function lex(src) {
  const comments = [];
  const strings = [];
  // Each entry is the brace depth to return to when a ${ ... } closes.
  const templateStack = [];
  let braceDepth = 0;
  let prevToken = null;
  let i = 0;

  const indentAt = (pos) => {
    const ls = src.lastIndexOf('\n', pos - 1) + 1;
    return /^\s*$/.test(src.slice(ls, pos)) ? pos - ls : 0;
  };

  // Consumes template text starting at `i`, stopping at ` or at ${.
  const readTemplateChunk = () => {
    const start = i;
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '`') {
        strings.push({ start, end: i, kind: 'template', text: src.slice(start, i) });
        i++;
        prevToken = 'str';
        return;
      }
      if (src[i] === '$' && src[i + 1] === '{') {
        strings.push({ start, end: i, kind: 'template', text: src.slice(start, i) });
        templateStack.push(braceDepth);
        braceDepth++;
        i += 2;
        prevToken = '{';
        return;
      }
      i++;
    }
  };

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      const start = i;
      const indent = indentAt(start);
      while (i < src.length && src[i] !== '\n') i++;
      comments.push({ start, end: i, kind: 'line', text: src.slice(start, i), indent });
      continue;
    }

    if (c === '/' && next === '*') {
      const start = i;
      const indent = indentAt(start);
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(i + 2, src.length);
      comments.push({ start, end: i, kind: 'block', text: src.slice(start, i), indent });
      continue;
    }

    if (c === '"' || c === "'") {
      i++;
      const start = i;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') i++;
        i++;
      }
      strings.push({ start, end: i, kind: 'quoted', quote: c, text: src.slice(start, i) });
      i++;
      prevToken = 'str';
      continue;
    }

    if (c === '`') { i++; readTemplateChunk(); continue; }

    if (c === '{') { braceDepth++; i++; prevToken = '{'; continue; }

    if (c === '}') {
      braceDepth--;
      i++;
      if (templateStack.length && templateStack[templateStack.length - 1] === braceDepth) {
        templateStack.pop();
        readTemplateChunk(); // resume the template this ${ } interrupted
        continue;
      }
      prevToken = '}';
      continue;
    }

    if (c === '/' && startsRegex(prevToken)) {
      i++;
      let inClass = false;
      while (i < src.length) {
        const r = src[i];
        if (r === '\\') { i += 2; continue; }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) { i++; break; }
        else if (r === '\n') break; // unterminated; bail out rather than run away
        i++;
      }
      while (i < src.length && /[a-z]/.test(src[i])) i++; // flags
      prevToken = 'regex';
      continue;
    }

    if (/\s/.test(c)) { i++; continue; }

    if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      while (i < src.length && /[\w$]/.test(src[i])) i++;
      prevToken = src.slice(start, i);
      continue;
    }

    if (/[0-9]/.test(c)) {
      while (i < src.length && /[\w.]/.test(src[i])) i++;
      prevToken = 'num';
      continue;
    }

    prevToken = c;
    i++;
  }

  return { comments, strings };
}

/** Rewrite non-overlapping spans in order; a `null` replacement deletes the span. */
export function spliceSpans(src, spans, mapper) {
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue;
    out += src.slice(cursor, span.start);
    const replacement = mapper(span);
    if (replacement != null) out += replacement;
    cursor = span.end;
  }
  return out + src.slice(cursor);
}

export const findComments = (src) => lex(src).comments;
export const findStrings = (src) => lex(src).strings;
export const rewriteComments = (src, mapper) => spliceSpans(src, lex(src).comments, mapper);
export const rewriteStrings = (src, mapper) => spliceSpans(src, lex(src).strings, mapper);

export const hasCJK = (s) => /[　-〿㐀-鿿豈-﫿＀-￯]/.test(s);
