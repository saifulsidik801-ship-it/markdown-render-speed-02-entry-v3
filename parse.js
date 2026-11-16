// parse.js — a fast, dependency-free markdown renderer producing exactly the
// HTML marked 18.1.3 renders with its default options (GFM on).
// Single file, no imports. Index-based scanning, minimal allocation,
// array-joined output. Written from the CommonMark 0.31.2 + GFM 0.29 rules
// and checked against marked's own practice set case by case.

// ---------- character classes ----------
const SPACE = 32, TAB = 9, LF = 10, CR = 13;
const STAR = 42, UNDER = 95, TICK = 96, TILDE = 126, BSLASH = 92;
const LBRACK = 91, RBRACK = 93, LANGLE = 60, RANGLE = 62, AMP = 38;
const BANG = 33, HASH = 35, AMP2 = 64;

function isSpace(c) { return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12; }
function isBlankLine(s) { for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c !== 32 && c !== 9) return false; } return true; }

// Unicode punctuation (CommonMark) = P or S categories — ASCII fast path.
const ASCII_PUNCT = /[!-\/:-@\[-`{-~]/;
const PUNCT_U = /[\p{P}\p{S}]/u;
function isPunctCh(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return ASCII_PUNCT.test(ch);
  return PUNCT_U.test(ch);
}
function isWhiteCh(ch) {
  const c = ch.charCodeAt(0);
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 160 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

// ---------- escaping ----------
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
function esc(s) { return s.replace(ESC_RE, (c) => ESC_MAP[c]); }

// Escape for href/src/title attributes: & is left alone when it starts a
// valid entity (&name; or &#...;), everything else is escaped.
function escAttr(s) {
  let out = '';
  let i = 0, n = s.length, start = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) { // &
      const m = matchEntityAt(s, i);
      if (m > 0) { i += m; continue; }
      out += s.slice(start, i) + '&amp;'; i++; start = i; continue;
    }
    if (c === 60 || c === 62 || c === 34 || c === 39) {
      out += s.slice(start, i) + ESC_MAP[s[i]]; i++; start = i; continue;
    }
    i++;
  }
  return start === 0 ? s : out + s.slice(start);
}

// Match an entity starting at s[i] === '&'. Returns its length, or 0.
// Named: &Name; (letters/digits, first a letter). Numeric: &#123; / &#x1F;.
function matchEntityAt(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n) return 0;
  if (s.charCodeAt(j) === 35) { // #
    j++;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) {
      j++;
      const st = j;
      while (j < n && j - st < 6) {
        const c = s.charCodeAt(j);
        if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102))) break;
        j++;
      }
      if (j === st || j >= n || s.charCodeAt(j) !== 59) return 0;
      return j + 1 - i;
    }
    const st = j;
    while (j < n && j - st < 7) {
      const c = s.charCodeAt(j);
      if (c < 48 || c > 57) break;
      j++;
    }
    if (j === st || j >= n || s.charCodeAt(j) !== 59) return 0;
    return j + 1 - i;
  }
  const c0 = s.charCodeAt(j);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return 0;
  j++;
  while (j < n && j - i < 33) {
    const c = s.charCodeAt(j);
    if (c === 59) return j + 1 - i;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57))) return 0;
    j++;
  }
  return 0;
}

// Decode a numeric entity body ('#123' or '#x1F600') to its character.
// Invalid values (0, surrogates, > 0x10FFFF) become U+FFFD.
function decodeNumeric(body) {
  let v;
  if (body[1] === 'x' || body[1] === 'X') v = parseInt(body.slice(2), 16);
  else v = parseInt(body.slice(1), 10);
  if (!v || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) return '\uFFFD';
  return String.fromCodePoint(v);
}

// URL handling: marked percent-encodes the destination (encodeURI) and then
// escapes it for the attribute, preserving valid entities.
function cleanUrl(url) {
  let u;
  try { u = encodeURI(url).replace(/%25/g, '%'); } catch { u = url; }
  return escAttr(u);
}

// Autolink hrefs: marked escapes EVERY '&' (its autolink renderer uses
// the full escape, not the entity-preserving one), so '&amp;' in an
// autolink URL becomes '&amp;amp;' in the href.
function cleanUrlAuto(url) {
  let u;
  try { u = encodeURI(url).replace(/%25/g, '%'); } catch { u = url; }
  return esc(u);
}

// Normalize a link reference label: collapse whitespace, trim, lowercase.
function normLabel(s) {
  // Unicode case folding: ß/ẞ -> ss, final sigma ς -> σ (after lowercase).
  return s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ');
}

// True if s contains an unescaped '[' or ']' (invalid in a link label).
function hasUnescapedBracket(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) { i++; continue; }
    if (s[i] === '[' || s[i] === ']') return true;
  }
  return false;
}

// ---------- inline parsing ----------
// Nodes: string (already-escaped HTML/text), delimiter object, em/strong/del
// object {k:3|4|5, c:[children]}. Delimiters carry `top`: the top-level node
// containing them (themselves, or an em/strong ancestor).

function isDelimChar(c) { return c === 42 || c === 95 || c === 126; }

// Can this delimiter run open / close? (CommonMark flanking rules.)
function flanking(text, i, j) {
  // run is text[i..j), char before is text[i-1], after is text[j]
  const before = i > 0 ? text[i - 1] : '';
  const after = j < text.length ? text[j] : '';
  const beforeWs = before === '' || isWhiteCh(before);
  const afterWs = after === '' || isWhiteCh(after);
  const beforePunct = before !== '' && isPunctCh(before);
  const afterPunct = after !== '' && isPunctCh(after);
  return { left: !afterWs && (!afterPunct || beforeWs || beforePunct), right: !beforeWs && (!beforePunct || afterWs || afterPunct) };
}

function inlineParse(text, links, inLink) {
  const nodes = [];
  const delims = [];
  const n = text.length;
  let i = 0;
  let runStart = 0; // start of current plain-text run (raw)
  const flushText = (end) => {
    if (end > runStart) { nodes.push(esc(text.slice(runStart, end))); }
  };

  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === BSLASH) {
      if (i + 1 < n) {
        const d = text.charCodeAt(i + 1);
        if (d === LF) { // backslash newline = hard break
          flushText(i);
          nodes.push('<br>');
          i += 2;
          // leading spaces/tabs on the next line are stripped (cm-637)
          while (i < n && (text.charCodeAt(i) === SPACE || text.charCodeAt(i) === TAB)) i++;
          runStart = i; continue;
        }
        if (d < 128 && ASCII_PUNCT.test(text[i + 1])) {
          // escaped punctuation: emit the literal char (backslash excluded)
          flushText(i);
          nodes.push(esc(text[i + 1]));
          i += 2; runStart = i; continue;
        }
      }
      i++; continue; // lone backslash stays in run
    }
    if (c === TICK) {
      // code span: find a closing run of the same length
      let j = i, len = 0;
      while (j < n && text.charCodeAt(j) === TICK) { j++; len++; }
      let k = j, found = -1;
      while (k < n) {
        if (text.charCodeAt(k) === TICK) {
          let m = k, l2 = 0;
          while (m < n && text.charCodeAt(m) === TICK) { m++; l2++; }
          if (l2 === len) { found = k; break; }
          k = m;
        } else k++;
      }
      if (found < 0) { i = j; continue; } // no closer: literal backticks
      flushText(i);
      let content = text.slice(j, found);
      content = content.replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      nodes.push('<code>' + esc(content) + '</code>');
      i = found + len; runStart = i; continue;
    }
    if (c === STAR || c === UNDER) {
      let j = i;
      while (j < n && text.charCodeAt(j) === c) j++;
      const len = j - i;
      const fl = flanking(text, i, j);
      const ch = c === STAR ? '*' : '_';
      let canOpen, canClose;
      if (ch === '*') { canOpen = fl.left; canClose = fl.right; }
      else { canOpen = fl.left && (!fl.right || (i > 0 && isPunctCh(text[i - 1]))); canClose = fl.right && (!fl.left || (j < n && isPunctCh(text[j]))); }
      if (!canOpen && !canClose) { i = j; continue; } // dead delimiter: literal text
      flushText(i);
      const d = { k: 1, ch, len, canOpen, canClose, top: null };
      d.top = d;
      nodes.push(d);
      delims.push(d);
      i = j; runStart = i; continue;
    }
    if (c === TILDE) {
      let j = i;
      while (j < n && text.charCodeAt(j) === TILDE) j++;
      const len = j - i;
      // Strikethrough is '~' or '~~'; a run of 3+ tildes is literal
      // (gfm-493: '~~~not~~~' stays literal; gfm-491: '~there~' is <del>).
      if (len > 2) { i = j; continue; }
      const before = i > 0 ? text[i - 1] : '';
      const after = j < n ? text[j] : '';
      const canOpen = after !== '' && !isWhiteCh(after);
      const canClose = before !== '' && !isWhiteCh(before);
      if (!canOpen && !canClose) { i = j; continue; } // dead delimiter: literal text
      flushText(i);
      const d = { k: 1, ch: '~', len, canOpen, canClose, top: null };
      d.top = d;
      nodes.push(d);
      delims.push(d);
      i = j; runStart = i; continue;
    }
    if (c === LBRACK || (c === BANG && i + 1 < n && text.charCodeAt(i + 1) === LBRACK)) {
      const isImg = c === BANG;
      const b = isImg ? i + 1 : i;
      const res = tryLink(text, b, links, isImg);
      if (res) {
        flushText(i);
        nodes.push(res.html);
        i = res.end; runStart = i; continue;
      }
      // not a link: literal '[' (and '!' if image attempt)
      i = isImg ? i + 1 : i + 1; continue;
    }
    if (c === LANGLE) {
      let res = tryAutolink(text, i);
      if (!res) res = tryAngle(text, i, links);
      if (res) {
        flushText(i);
        nodes.push(res.html);
        i = res.end; runStart = i; continue;
      }
      i++; continue; // literal '<' stays in run
    }
    if (c === AMP) {
      const m = matchEntityAt(text, i);
      if (m > 0) {
        const body = text.slice(i + 1, i + m - 1);
        if (body.charCodeAt(0) === 35) {
          // numeric: decode into the text run (escaped at flush)
          flushText(i);
          nodes.push(esc(decodeNumeric(body)));
          i += m; runStart = i; continue;
        }
        // named: pass through verbatim
        flushText(i);
        nodes.push(text.slice(i, i + m));
        i += m; runStart = i; continue;
      }
      i++; continue; // lone &: escaped at flush
    }
    if (c === LF) {
      // hard break if the text run ends with 2+ spaces
      let sp = 0, k = i - 1;
      while (k >= runStart && text.charCodeAt(k) === SPACE) { sp++; k--; }
      if (sp >= 2) {
        flushText(i - sp);
        nodes.push('<br>');
        i++;
        // leading spaces/tabs on the next line are stripped (cm-636)
        while (i < n && (text.charCodeAt(i) === SPACE || text.charCodeAt(i) === TAB)) i++;
        runStart = i; continue;
      }
      i++; continue; // soft break: newline stays in run
    }
    if (c === 119 || c === 104 || c === 87 || c === 72) { // w / h / W / H: extended autolink
      // GFM bare autolinks are plain text inside link text (marked: a
      // bare URL in a link's text is not linked).
      if (!inLink && (i === 0 || isWhiteCh(text[i - 1]) || text[i - 1] === '*' || text[i - 1] === '_' || text[i - 1] === '~' || text[i - 1] === '(' || text[i - 1] === '<')) {
        const res = tryExtendedAutolink(text, i);
        if (res) {
          flushText(i);
          nodes.push(res.html);
          i = res.end; runStart = i; continue;
        }
      }
      i++; continue;
    }
    if (c === 58) { // ':': scheme autolink (mailto:, xmpp:, ...)
      if (!inLink) {
        const res = trySchemeAutolink(text, i, runStart, delims);
        if (res) {
          flushText(res.start);
          nodes.push(res.html);
          i = res.end; runStart = i; continue;
        }
      }
      i++; continue;
    }
    if (c === AMP2) { // @: extended email autolink
      if (!inLink) {
        const res = tryExtendedEmail(text, i, runStart, delims);
        if (res) {
          flushText(res.start);
          nodes.push(res.html);
          i = res.end; runStart = i; continue;
        }
      }
      i++; continue;
    }
    i++;
  }
  flushText(n);
  processEmphasis(nodes, delims);
  return renderNodes(nodes);
}

function renderNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (typeof nd === 'string') out += nd;
    else if (nd.k === 1) out += nd.ch.repeat(nd.len);
    else if (nd.k === 3) out += '<em>' + renderNodes(nd.c) + '</em>';
    else if (nd.k === 4) out += '<strong>' + renderNodes(nd.c) + '</strong>';
    else if (nd.k === 5) out += '<del>' + renderNodes(nd.c) + '</del>';
  }
  return out;
}

function stripTags(html) {
  // An <img> contributes its alt text (cm-574).
  return html.replace(/<img\b[^>]*>/g, (m) => {
    const a = /alt=(?:"([^"]*)"|'([^']*)')/.exec(m);
    return a ? (a[1] !== undefined ? a[1] : a[2]) : '';
  }).replace(/<[^>]*>/g, '');
}

// ---------- link parsing ----------
function skipWs(text, i) {
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) i++;
    else break;
  }
  return i;
}

// Process backslash escapes in a raw string (destinations, titles).
function unescape(s) {
  if (!s.includes('\\')) return s;
  let out = '', i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) === BSLASH && i + 1 < s.length && s.charCodeAt(i + 1) < 128 && ASCII_PUNCT.test(s[i + 1])) { out += s[i + 1]; i += 2; }
    else { out += s[i]; i++; }
  }
  return out;
}

// Find the ']' matching the '[' at b (depth counts nested brackets, skips
// code spans and escaped chars). Returns its index, or -1.
function findCloseBracket(text, b) {
  const n = text.length;
  let j = b + 1, depth = 1;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === BSLASH) { j += 2; continue; }
    if (c === TICK) {
      let k = j, len = 0;
      while (k < n && text.charCodeAt(k) === TICK) { k++; len++; }
      let m = k, found = -1;
      while (m < n) {
        if (text.charCodeAt(m) === TICK) {
          let p = m, l2 = 0;
          while (p < n && text.charCodeAt(p) === TICK) { p++; l2++; }
          if (l2 === len) { found = m; break; }
          m = p;
        } else m++;
      }
      // An unclosed backtick run is literal text: skip it and keep
      // scanning for ']' (doc-24: '[client ``commit` tests next](...)').
      if (found < 0) { j = k; continue; }
      j = found + len; continue;
    }
    if (c === LBRACK) depth++;
    else if (c === RBRACK) { depth--; if (depth === 0) return j; }
    j++;
  }
  return -1;
}

// Parse (dest "title") starting at k (just after '('). Returns
// {dest, title|null, end} or null.
function parseParenLink(text, k) {
  const n = text.length;
  k = skipWs(text, k);
  if (k >= n) return null;
  let dest;
  if (text.charCodeAt(k) === LANGLE) {
    let j = k + 1;
    while (j < n) {
      if (text.charCodeAt(j) === BSLASH && j + 1 < n && text.charCodeAt(j + 1) < 128 && ASCII_PUNCT.test(text[j + 1])) { j += 2; continue; }
      if (text.charCodeAt(j) === RANGLE || text.charCodeAt(j) === LF) break;
      j++;
    }
    if (j >= n || text.charCodeAt(j) !== RANGLE) return null;
    dest = unescape(text.slice(k + 1, j));
    k = j + 1;
  } else {
    const st = k;
    let depth = 0;
    while (k < n) {
      const c = text.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10 || c === 13) break;
      if (c === 40) depth++;
      else if (c === 41) { if (depth === 0) break; depth--; }
      else if (c === BSLASH && k + 1 < n && text.charCodeAt(k + 1) < 128 && ASCII_PUNCT.test(text[k + 1])) { k += 2; continue; }
      k++;
    }
    dest = unescape(text.slice(st, k));
  }
  k = skipWs(text, k);
  let title = null;
  if (k < n) {
    const c = text.charCodeAt(k);
    if (c === 34 || c === 39) { // " or '
      const q = text[k];
      let j = k + 1, ok = false;
      while (j < n) {
        if (text.charCodeAt(j) === BSLASH && j + 1 < n && text.charCodeAt(j + 1) < 128 && ASCII_PUNCT.test(text[j + 1])) { j += 2; continue; }
        if (text[j] === q) { ok = true; break; }
        j++;
      }
      if (!ok) return null;
      title = unescape(text.slice(k + 1, j));
      k = j + 1;
    } else if (c === 40) { // (title)
      let j = k + 1, depth = 1, ok = false;
      while (j < n) {
        if (text.charCodeAt(j) === BSLASH && j + 1 < n && text.charCodeAt(j + 1) < 128 && ASCII_PUNCT.test(text[j + 1])) { j += 2; continue; }
        if (text.charCodeAt(j) === 40) depth++;
        else if (text.charCodeAt(j) === 41) { depth--; if (depth === 0) { ok = true; break; } }
        j++;
      }
      if (!ok) return null;
      title = unescape(text.slice(k + 1, j));
      k = j + 1;
    }
  }
  k = skipWs(text, k);
  if (k >= n || text.charCodeAt(k) !== 41) return null;
  return { dest, title, end: k + 1 };
}

// Try to parse a link or image starting at '[' (index b). Returns
// {html, end} or null. isImg tells whether a '!' precedes b.
// True if s contains a '<' that starts an invalid HTML tag/autolink
// (a '<' followed by a letter, '/', '!' or '?' that tryAngle rejects).
// Such a '<' in link text makes the whole link fail (cm-524/536).
function hasInvalidTag(s, links) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) !== 60) continue;
    const nx = s[i + 1];
    if (nx === undefined) continue;
    const c = nx.charCodeAt(0);
    const isTagStart = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 47 || c === 33 || c === 63;
    if (!isTagStart) continue;
    // A <...> autolink is valid here too, not just a raw HTML tag.
    const r = tryAutolink(s, i) || tryAngle(s, i, links);
    if (!r) return true;
    i = r.end - 1;
  }
  return false;
}

function tryLink(text, b, links, isImg) {
  const j = findCloseBracket(text, b);
  if (j < 0) return null;
  const linkText = text.slice(b + 1, j);
  const n = text.length;
  let dest = null, title = null, end = -1;
  if (j + 1 < n && text.charCodeAt(j + 1) === 40) { // inline (dest)
    const r = parseParenLink(text, j + 2);
    if (r) { dest = r.dest; title = r.title; end = r.end; }
    else {
      // Inline link failed: fall back to shortcut reference [text].
      if (hasUnescapedBracket(linkText)) return null;
      const ref = links.get(normLabel(linkText));
      if (!ref) return null;
      dest = ref.href; title = ref.title; end = j + 1;
    }
  } else if (j + 1 < n && text.charCodeAt(j + 1) === LBRACK) { // [text][label]
    const j2 = findCloseBracket(text, j + 1);
    if (j2 < 0) return null;
    const labelRaw = text.slice(j + 2, j2);
    if (hasUnescapedBracket(labelRaw)) return null;
    const label = normLabel(labelRaw === '' ? linkText : labelRaw);
    const ref = links.get(label);
    if (!ref) return null;
    dest = ref.href; title = ref.title; end = j2 + 1;
  } else { // shortcut [text]
    if (hasUnescapedBracket(linkText)) return null;
    const ref = links.get(normLabel(linkText));
    if (!ref) return null;
    dest = ref.href; title = ref.title; end = j + 1;
  }
  // A link's text must not contain an invalid '<' (an unclosed HTML tag).
  if (hasInvalidTag(linkText, links)) return null;
  // Bare GFM autolinks are plain text inside link text (inLink=true);
  // <...> autolinks still nest. A '['-style nested link is rejected below.
  const content = inlineParse(linkText, links, true);
  // A link's text must not contain another '['-style link or a raw HTML
  // <a>, but autolinks inside link text are fine (doc-24). An autolink's
  // text equals its href (up to a 'mailto:' prefix); any other <a> is a
  // nested link.
  if (!isImg) {
    const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const re = /<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    const spans = [];
    while ((m = re.exec(content)) !== null) {
      const href = unesc(m[1]);
      const txt = unesc(stripTags(m[2]));
      const bare = href.startsWith('mailto:') ? href.slice(7) : href;
      if (txt !== href && txt !== bare) return null;
      spans.push([m.index, m.index + m[0].length]);
    }
    // Remove vetted autolinks; any remaining <a is a nested link.
    let cleaned = '', last = 0;
    for (const [a, b] of spans) { cleaned += content.slice(last, a); last = b; }
    cleaned += content.slice(last);
    if (/<a[\s>]/.test(cleaned)) return null;
  }
  if (isImg) {
    const alt = escAttr(stripTags(content));
    return { html: '<img src="' + cleanUrl(dest) + '" alt="' + alt + '"' + (title !== null ? ' title="' + escAttr(title) + '"' : '') + '>', end };
  }
  return { html: '<a href="' + cleanUrl(dest) + '"' + (title !== null ? ' title="' + escAttr(title) + '"' : '') + '>' + content + '</a>', end };
}

// ---------- angle-bracket constructs: autolinks and raw HTML ----------
const DISALLOWED = new Set(['title', 'textarea', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'script', 'plaintext']);

function tryAngle(text, i, links) {
  const n = text.length;
  // raw HTML comment; <!--> and <!---> are complete (empty) comments.
  if (text.startsWith('<!--', i)) {
    if (text[i + 4] === '>') return { html: tagOut(text.slice(i, i + 5)), end: i + 5 };
    if (text[i + 4] === '-' && text[i + 5] === '>') return { html: tagOut(text.slice(i, i + 6)), end: i + 6 };
    const e = text.indexOf('-->', i + 4);
    if (e < 0) return null;
    return { html: tagOut(text.slice(i, e + 3)), end: e + 3 };
  }
  if (text.startsWith('<?', i)) {
    const e = text.indexOf('?>', i + 2);
    if (e < 0) return null;
    return { html: tagOut(text.slice(i, e + 2)), end: e + 2 };
  }
  if (text.startsWith('<!', i)) {
    // declaration <!A... or CDATA <![CDATA[...
    if (text.startsWith('<![CDATA[', i)) {
      const e = text.indexOf(']]>', i + 9);
      if (e < 0) return null;
      return { html: tagOut(text.slice(i, e + 3)), end: e + 3 };
    }
    let j = i + 2;
    if (j < n && text[j] >= 'A' && text[j] <= 'Z') {
      const e = text.indexOf('>', j);
      if (e < 0) return null;
      return { html: tagOut(text.slice(i, e + 1)), end: e + 1 };
    }
    return null;
  }
  // tag: </name ...> or <name ...>
  let j = i + 1, closing = false;
  if (j < n && text[j] === '/') { closing = true; j++; }
  if (j >= n || !/[A-Za-z]/.test(text[j])) return null;
  const nameStart = j;
  while (j < n && /[A-Za-z0-9-]/.test(text[j])) j++;
  const name = text.slice(nameStart, j);
  if (closing) {
    // A closing tag takes no attributes (cm-624).
    while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9 || text.charCodeAt(j) === 10 || text.charCodeAt(j) === 13)) j++;
    if (j < n && text.charCodeAt(j) === 62) {
      return { html: tagOut(text.slice(i, j + 1), name), end: j + 1 };
    }
    return null;
  }
  // attributes; each must be preceded by whitespace (cm-622), and only
  // whitespace, '/' or '>' may follow the tag name (cm-609: '<m:abc>').
  while (j < n) {
    let hadSpace = false;
    while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9 || text.charCodeAt(j) === 10 || text.charCodeAt(j) === 13)) { j++; hadSpace = true; }
    if (j >= n) return null;
    const c = text.charCodeAt(j);
    if (c === 62) { // >
      const tag = text.slice(i, j + 1);
      return { html: tagOut(tag, name), end: j + 1 };
    }
    if (c === 47 && j + 1 < n && text.charCodeAt(j + 1) === 62) { // />
      const tag = text.slice(i, j + 2);
      return { html: tagOut(tag, name), end: j + 2 };
    }
    if (!hadSpace) return null;
    if (/[A-Za-z_:]/.test(text[j]) || text.charCodeAt(j) >= 128) {
      while (j < n && /[A-Za-z0-9_.:-]/.test(text[j])) j++;
      let k = j;
      while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
      if (k < n && text.charCodeAt(k) === 61) { // =
        k++;
        while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
        if (k < n && (text[k] === '"' || text[k] === "'")) {
          const q = text[k]; k++;
          while (k < n && text[k] !== q) k++;
          if (k >= n) return null;
          j = k + 1; continue;
        }
        while (k < n && !/[ \t\n\r"'=<>`]/.test(text[k])) k++;
        if (k === j) return null;
        j = k; continue;
      }
      // Boolean attribute (no '='): leave j right after the name so the
      // next loop pass re-skips the whitespace (cm-616).
      continue;
    }
    return null;
  }
  return null;
}

function tagOut(tag, name) {
  return tag;
}

// Autolink <scheme:...> or <email> at i. Returns {html, end} or null.
function tryAutolink(text, i) {
  const n = text.length;
  let j = i + 1;
  while (j < n && text.charCodeAt(j) !== RANGLE) {
    const c = text.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 60) return null;
    j++;
  }
  if (j >= n) return null;
  const inner = text.slice(i + 1, j);
  if (inner.length === 0) return null;
  const m = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.exec(inner);
  if (m) {
    const href = cleanUrlAuto(inner);
    return { html: '<a href="' + href + '">' + esc(inner) + '</a>', end: j + 1 };
  }
  if (/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(inner)) {
    return { html: '<a href="mailto:' + esc(inner) + '">' + esc(inner) + '</a>', end: j + 1 };
  }
  return null;
}

// ---------- emphasis (delimiter stack) ----------
function processEmphasis(nodes, delims) {
  let ci = 0;
  while (ci < delims.length) {
    const closer = delims[ci];
    if (!closer.canClose || closer.len === 0 || closer.dead) { ci++; continue; }
    let matched = false;
    for (let oi = ci - 1; oi >= 0; oi--) {
      const opener = delims[oi];
      if (opener.len === 0 || opener.dead || opener.ch !== closer.ch || !opener.canOpen) continue;
      // Rule of 3: skip when the sum is a multiple of 3, unless BOTH
      // lengths are multiples of 3 (cm-416: '***bar***' matches).
      if ((opener.canClose || closer.canOpen) && ((opener.len + closer.len) % 3 === 0) && (opener.len % 3 !== 0 || closer.len % 3 !== 0)) continue;
      const use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
      wrapEmphasis(nodes, opener, closer, use);
      // Delimiters strictly between the opener and closer are now inside
      // the emphasis and can no longer match (cm-469: the '_' in '_bar'
      // inside '*foo _bar*' must stay literal). Mark them dead (their
      // literal characters still render).
      for (let k = oi + 1; k < ci; k++) delims[k].dead = true;
      matched = true;
      break;
    }
    // A partially-consumed closer is retried against earlier openers.
    if (!matched || closer.len === 0) ci++;
  }
}

function retop(list, top) {
  for (const nd of list) {
    if (typeof nd === 'string') continue;
    if (nd.k === 1) nd.top = top;
    else retop(nd.c, top);
  }
}

function wrapEmphasis(nodes, opener, closer, use) {
  const kind = opener.ch === '~' ? 5 : (use === 2 ? 4 : 3);
  const oTop = opener.top, cTop = closer.top;
  const oi = nodes.indexOf(oTop), ci = nodes.indexOf(cTop);
  const content = [];
  if (oTop !== opener) {
    const kids = oTop.c;
    const opIdx = kids.indexOf(opener);
    content.push(...kids.slice(opIdx + 1));
    oTop.c = kids.slice(0, opIdx + 1);
  }
  for (let k = oi + 1; k < ci; k++) content.push(nodes[k]);
  if (cTop !== closer) {
    const kids = cTop.c;
    const clIdx = kids.indexOf(closer);
    content.push(...kids.slice(0, clIdx));
    cTop.c = kids.slice(clIdx);
  }
  const node = { k: kind, c: content };
  retop(content, node);
  opener.len -= use;
  closer.len -= use;
  const mid = [];
  if (oTop === opener) { if (opener.len > 0) mid.push(opener); }
  else mid.push(oTop);
  mid.push(node);
  if (cTop === closer) { if (closer.len > 0) mid.push(closer); }
  else mid.push(cTop);
  const before = nodes.slice(0, oi);
  const after = nodes.slice(ci + 1);
  nodes.length = 0;
  nodes.push(...before, ...mid, ...after);
}

// ---------- GFM extended autolinks ----------
function parseDomain(text, j) {
  // Parse a domain starting at j. Returns the end index, or -1.
  // Requires >= 2 labels, last label >= 2 chars and containing a letter.
  const n = text.length;
  let labels = 0, lastLabel = '';
  while (j < n) {
    const ls = j;
    if (!/[A-Za-z0-9]/.test(text[j])) return -1;
    j++;
    while (j < n && /[A-Za-z0-9-]/.test(text[j])) j++;
    if (text[j - 1] === '-') return -1;
    lastLabel = text.slice(ls, j);
    labels++;
    if (j < n && text[j] === '.') {
      if (j + 1 >= n || !/[A-Za-z0-9]/.test(text[j + 1])) break;
      j++;
      continue;
    }
    break;
  }
  if (labels < 2) return -1;
  if (!/[A-Za-z]/.test(lastLabel)) return -1;
  return j;
}

// Parse an email domain starting at j (after the '@'), per marked's GFM
// email regex: first label [A-Za-z0-9_-]+, later labels
// [A-Za-z0-9_-]*[A-Za-z0-9] (must end with an alphanumeric, so a trailing
// '_' or '-' is NOT part of the domain). Requires >= 2 labels. Returns the
// domain end, or -1 if structurally invalid. The caller checks the char
// after the domain (marked's (?![\w-]) lookahead).
function parseEmailDomain(text, j) {
  const n = text.length;
  let k = j;
  while (k < n && /[A-Za-z0-9_-]/.test(text[k])) k++;
  if (k === j) return -1;
  let labels = 1;
  while (k < n && text[k] === '.') {
    let m = k + 1, lastAlnum = -1;
    while (m < n && /[A-Za-z0-9_-]/.test(text[m])) {
      if (/[A-Za-z0-9]/.test(text[m])) lastAlnum = m;
      m++;
    }
    if (lastAlnum < 0) break; // no alphanumeric in this label: stop
    k = lastAlnum + 1;
    labels++;
  }
  if (labels < 2) return -1;
  return k;
}

// The most recent '_' delimiter scanned so far can open an emphasis span.
// Used for the trailing-'_' email rule: marked resolves emphasis first, so
// a '_' that closes an open '_' span is not part of the email (and does
// not block it); a '_' with no open span does block it.
function hasOpenUnderscoreDelim(delims) {
  for (let k = delims.length - 1; k >= 0; k--) {
    if (delims[k].ch === '_') return delims[k].canOpen;
  }
  return false;
}

function tryExtendedAutolink(text, i) {
  const n = text.length;
  let j, scheme;
  // The scheme (http/https) is case-insensitive (GFM), but 'www.' is
  // lowercase-only (doc-09: 'Www.atlas.com' is plain text). The original
  // case is preserved in the href.
  const low = text.slice(i, i + 8).toLowerCase();
  if (text.startsWith('www.', i)) { j = i + 4; scheme = 'http://'; }
  else if (low.startsWith('https://')) { j = i + 8; scheme = ''; }
  else if (low.startsWith('http://')) { j = i + 7; scheme = ''; }
  else return null;
  const dEnd = parseDomain(text, j);
  if (dEnd < 0) return null;
  // optional path: any chars except whitespace and '<'. A backslash IS
  // part of the URL (marked's [^\s<]* includes it; it is percent-encoded
  // as %5C in the href), even before a newline or a space.
  let pEnd = dEnd;
  while (pEnd < n) {
    const c = text.charCodeAt(pEnd);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 60) break;
    pEnd++;
  }
  // trim trailing punctuation; a ')' is trimmed only when unmatched
  let end = pEnd;
  while (end > dEnd) {
    const ch = text[end - 1];
    if (ch === ')') {
      let open = 0, close = 0;
      for (let k = i; k < end; k++) {
        if (text[k] === '(') open++;
        else if (text[k] === ')') close++;
      }
      if (close > open) { end--; continue; }
      break;
    }
    if (ch === ';') {
      // Marked's _backpedal drops a trailing '&...;' only when it looks
      // like an entity ('&' + alphanumerics + ';'); '&page=9;' keeps the
      // '&page=9' and drops just the ';'. A real entity ('&amp;') is
      // dropped too — it is not kept.
      const ampIdx = text.lastIndexOf('&', end - 1);
      if (ampIdx >= dEnd && /^&[A-Za-z0-9]+;$/.test(text.slice(ampIdx, end))) { end = ampIdx; continue; }
      end--;
      continue;
    }
    if (/[?!.,:*_~]/.test(ch)) { end--; continue; }
    break;
  }
  const url = text.slice(i, end);
  return { html: '<a href="' + cleanUrlAuto(scheme + url) + '">' + esc(url) + '</a>', end };
}

function trySchemeAutolink(text, colonIdx, runStart, delims) {
  const n = text.length;
  // look back for the scheme: [A-Za-z][A-Za-z0-9+.-]{1,31}
  let s = colonIdx - 1;
  while (s >= 0 && /[A-Za-z0-9+.-]/.test(text[s])) s--;
  s++;
  if (s === colonIdx) return null;
  if (s < runStart) return null; // scheme spans a token boundary
  const scheme = text.slice(s, colonIdx);
  if (scheme.length < 2 || scheme.length > 32) return null;
  if (!/^[A-Za-z]/.test(scheme)) return null;
  // The char before the scheme must not be alphanumeric (marked's text
  // rule only stops before a scheme after a non-alnum char); any
  // punctuation, quote or bracket allows it.
  if (s > 0 && /[A-Za-z0-9]/.test(text[s - 1])) return null;
  let j = colonIdx + 1;
  if (j >= n || isWhiteCh(text[j])) return null;
  // content: non-space chars, stopping at '<' and backslash (a backslash
  // before a newline is a hard break, not part of the URL)
  let end = j;
  while (end < n) {
    const ch = text.charCodeAt(end);
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 60 || ch === 92) break;
    end++;
  }
  if (end === j) return null;
  const lower = scheme.toLowerCase();
  if (lower === 'mailto') {
    // the content after mailto: must be a valid email (marked's narrow
    // local part [A-Za-z0-9._+-]+ and _-allowing domain)
    const content = text.slice(j, end);
    const atIdx = content.indexOf('@');
    if (atIdx <= 0) return null;
    const local = content.slice(0, atIdx);
    if (!/^[A-Za-z0-9._+-]+$/.test(local)) return null;
    const dEnd = parseEmailDomain(content, atIdx + 1);
    if (dEnd < 0) return null;
    if (dEnd < content.length && /[A-Za-z0-9_-]/.test(content[dEnd])) {
      if (content[dEnd] !== '_' || !hasOpenUnderscoreDelim(delims || [])) return null;
    }
    const emailEnd = j + dEnd;
    const href = scheme + ':' + text.slice(j, emailEnd);
    return { html: '<a href="' + cleanUrlAuto(href) + '">' + esc(href) + '</a>', end: emailEnd, start: s };
  }
  // general scheme (e.g. xmpp:): the part after the scheme must be a
  // valid user@domain, optionally followed by ONE path segment
  // (gfm-635: 'xmpp:foo@bar.baz/txt/bin' links only '/txt'; no query or
  // fragment, and no second segment). A bare 'foo:bar' is not a link.
  const content = text.slice(j, end);
  const atIdx = content.indexOf('@');
  if (atIdx <= 0) return null;
  const local = content.slice(0, atIdx);
  if (!/^[A-Za-z0-9._+-]+$/.test(local)) return null;
  const dEnd = parseEmailDomain(content, atIdx + 1);
  if (dEnd < 0) return null;
  let e2 = j + dEnd;
  // The char after the domain must not be a word char or '-' (marked's
  // (?![\w-])), except a '_' closing an open '_' emphasis span.
  if (e2 < end && /[A-Za-z0-9_-]/.test(text[e2])) {
    if (text[e2] !== '_' || !hasOpenUnderscoreDelim(delims || [])) return null;
  }
  if (e2 < end && text[e2] === '/') {
    // one path segment: up to the next '/', '?', '#', whitespace or '<'
    let p = e2 + 1;
    while (p < end) {
      const ch = text.charCodeAt(p);
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 60 || ch === 63 || ch === 35 || ch === 47) break;
      p++;
    }
    // trim trailing punctuation from the segment
    while (p > e2 + 1 && /[?!.,:*_~]/.test(text[p - 1])) p--;
    if (p > e2 + 1) e2 = p;
  }
  if (e2 === j) return null;
  const href = text.slice(s, e2);
  return { html: '<a href="' + cleanUrlAuto(href) + '">' + esc(href) + '</a>', end: e2, start: s };
}

function tryExtendedEmail(text, atIdx, runStart, delims) {
  const n = text.length;
  // Marked's GFM bare-email local part is the NARROW [A-Za-z0-9._+-]+
  // (not the wide CommonMark class): 'a=foo@bar.com' links only
  // 'foo@bar.com', '{foo@bar.com}' links only 'foo@bar.com'. There is no
  // pre-char restriction: the email may follow '@', ';', ':', '[', '"',
  // etc. (marked retries after the first '@' in 'a@b@c.com' and links
  // 'b@c.com').
  let s = atIdx - 1;
  // The local part must not cross the start of the current text run: a
  // '_' before runStart is an emphasis delimiter, not part of the local
  // part ('_foo@bar.com' links 'foo@bar.com', the '_' opens the em).
  while (s >= runStart && /[A-Za-z0-9._+-]/.test(text[s])) s--;
  s++;
  if (s === atIdx) return null;
  const dEnd = parseEmailDomain(text, atIdx + 1);
  if (dEnd < 0) return null;
  // The char after the domain must not be a word char or '-' (marked's
  // (?![\w-]) lookahead), EXCEPT a '_' that closes an open '_' emphasis
  // span (marked resolves emphasis first, so that '_' is a delimiter,
  // not part of the email).
  if (dEnd < n && /[A-Za-z0-9_-]/.test(text[dEnd])) {
    if (text[dEnd] !== '_' || !hasOpenUnderscoreDelim(delims || [])) return null;
  }
  const email = text.slice(s, dEnd);
  return { html: '<a href="mailto:' + esc(email) + '">' + esc(email) + '</a>', end: dEnd, start: s };
}

// ---------- block parsing ----------
function parse(md) {
  const src = md.replace(/\r\n?/g, '\n');
  const links = new Map();
  // Pre-collect link reference definitions so a link can use a definition
  // that appears later in the document (forward reference, doc-05/12).
  // Only lines at a block boundary count (first line, after a blank line,
  // or after another definition); a '[label]:' line inside a paragraph
  // is literal text, not a definition (cm-213). Fenced code is skipped.
  {
    const ls = src.split('\n');
    let inFence = null;
    let boundary = true;
    for (let k = 0; k < ls.length; k++) {
      const l = ls[k];
      if (inFence) {
        if (matchFenceClose(l, inFence.ch, inFence.len)) inFence = null;
        boundary = false;
        continue;
      }
      const f = matchFence(l);
      if (f) { inFence = f; boundary = false; continue; }
      if (isBlank(l)) { boundary = true; continue; }
      if (boundary) {
        const def = tryLinkRefDef(ls, k);
        if (def) {
          if (!links.has(normLabel(def.label))) links.set(normLabel(def.label), { href: def.href, title: def.title });
          k = def.end - 1;
          boundary = true;
          continue;
        }
      }
      boundary = false;
    }
  }
  const inner = parseBlocksInner(src, links);
  return renderBlocks(inner.blocks, links);
}

function isBlank(s) { return /^[ \t]*$/.test(s); }

// Indent in columns; a tab advances to the next multiple of 4.
function indentOf(s) {
  let col = 0, i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) === 32) { col++; i++; }
    else if (s.charCodeAt(i) === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  return col;
}

// Remove `cols` columns of leading whitespace; a tab that straddles the
// boundary becomes spaces for its remainder.
function stripCols(s, cols, keepTab) {
  // Strip `cols` columns of leading whitespace. Tabs expand to spaces by
  // original column (tab stops every 4). When cols is 0 nothing is
  // stripped and the line is returned untouched (tabs stay literal, which
  // is what fenced-code content wants). A tab encountered after the strip
  // amount is reached is content: with keepTab it stays a literal tab
  // (indented/fenced code, doc-02); otherwise it expands to spaces
  // (container stripping, cm-005).
  if (cols === 0) return s;
  let col = 0, i = 0;
  let out = '';
  while (i < s.length) {
    const ch = s.charCodeAt(i);
    if (ch === 32) {
      if (col < cols) { col++; i++; }
      else { out += ' '; col++; i++; }
    } else if (ch === 9) {
      const w = 4 - (col % 4);
      if (col + w <= cols) { col += w; i++; }
      else if (col < cols) { out += ' '.repeat(col + w - cols); col += w; i++; }
      else if (keepTab) { out += '\t'; col += w; i++; }
      else { out += ' '.repeat(w); col += w; i++; }
    } else break;
  }
  return out + s.slice(i);
}

function matchATX(line) {
  const ind = indentOf(line);
  if (ind >= 4) return null;
  let j = ind, level = 0;
  while (j < line.length && line[j] === '#') { level++; j++; }
  if (level === 0 || level > 6) return null;
  if (j < line.length && line[j] !== ' ' && line[j] !== '\t') return null;
  let text = line.slice(j).trim();
  text = text.replace(/\s+#+$/, '').replace(/^#+$/, '').trim();
  return { level, text };
}

function matchFence(line) {
  const ind = indentOf(line);
  if (ind >= 4) return null;
  let j = ind;
  const ch = line[j];
  if (ch !== '`' && ch !== '~') return null;
  let len = 0;
  while (j < line.length && line[j] === ch) { len++; j++; }
  if (len < 3) return null;
  const info = line.slice(j).trim();
  if (ch === '`' && info.includes('`')) return null;
  const lang = unescape(info.split(/\s+/)[0] || '') || null;
  return { ch, len, info, lang, indent: ind };
}

function matchFenceClose(line, ch, len) {
  const ind = indentOf(line);
  if (ind >= 4) return false;
  let j = ind, n = 0;
  while (j < line.length && line[j] === ch) { n++; j++; }
  if (n < len) return false;
  return /^[ \t]*$/.test(line.slice(j));
}

function matchSetext(line) {
  const ind = indentOf(line);
  if (ind >= 4) return null;
  let j = ind;
  const c = line[j];
  if (c !== '=' && c !== '-') return null;
  while (j < line.length && line[j] === c) j++;
  if (!/^[ \t]*$/.test(line.slice(j))) return null;
  return { level: c === '=' ? 1 : 2 };
}

function matchHr(line) {
  const ind = indentOf(line);
  if (ind >= 4) return false;
  let j = ind;
  const c = line[j];
  if (c !== '-' && c !== '*' && c !== '_') return false;
  let count = 0;
  while (j < line.length) {
    if (line[j] === c) { count++; j++; }
    else if (line[j] === ' ' || line[j] === '\t') j++;
    else return false;
  }
  return count >= 3;
}

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML6_RE = new RegExp('^<\\/?(?:' + BLOCK_TAGS + ')([\\s>\\/]|$)');
const HTML7_RE = /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>\s*$/;

function matchHtmlBlock(line) {
  const ind = indentOf(line);
  if (ind >= 4) return null;
  const s = line.slice(ind);
  if (s[0] !== '<') return null;
  if (/^<(script|pre|style|textarea)([\s>]|$)/i.test(s)) return { type: 1 };
  if (s.startsWith('<!--')) return { type: 2 };
  if (s.startsWith('<?')) return { type: 3 };
  if (/^<![A-Z]/i.test(s)) return { type: 4 };
  if (s.startsWith('<![CDATA[')) return { type: 5 };
  // A closing tag takes no attributes (cm-624: '</a href="foo">' is not HTML).
  if (s.startsWith('</') && !/^<\/[A-Za-z][A-Za-z0-9-]*\s*>/.test(s)) return null;
  if (HTML6_RE.test(s)) return { type: 6 };
  if (HTML7_RE.test(s)) {
    const name = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(s)[1].toLowerCase();
    if (name !== 'pre' && name !== 'script' && name !== 'style' && name !== 'textarea') return { type: 7 };
  }
  return null;
}

function matchListItem(line) {
  const ind = indentOf(line);
  if (ind >= 4) return null;
  const j = ind;
  const c = line[j];
  if (c === '-' || c === '+' || c === '*') {
    if (j + 1 < line.length && line[j + 1] !== ' ' && line[j + 1] !== '\t') return null;
    // whitespace after the marker, in columns
    let k = j + 1, cols = 0;
    while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
      cols += line[k] === '\t' ? 4 - ((ind + 1 + cols) % 4) : 1;
      k++;
    }
    if (cols === 0 && k < line.length) return null;
    let contentIndent, content;
    if (k >= line.length) { contentIndent = ind + 2; content = ''; }
    else if (cols >= 5) {
      // only 1 column of whitespace is consumed; the rest of the run
      // expands to spaces with correct column tracking (cm-007:
      // '-\t\tfoo' leaves 6 columns, i.e. indented code '  foo').
      contentIndent = ind + 2;
      content = ' '.repeat(cols - 1) + line.slice(k);
    }
    else { contentIndent = ind + 1 + cols; content = line.slice(k); }
    return { indent: ind, type: 'ul', delim: c, start: null, contentIndent, content };
  }
  if (c >= '0' && c <= '9') {
    let k = j;
    while (k < line.length && line[k] >= '0' && line[k] <= '9') k++;
    const digits = k - j;
    if (digits > 9 || k >= line.length) return null;
    const d = line[k];
    if (d !== '.' && d !== ')') return null;
    if (k + 1 < line.length && line[k + 1] !== ' ' && line[k + 1] !== '\t') return null;
    const start = parseInt(line.slice(j, k), 10);
    const markerWidth = digits + 1;
    let m = k + 1, cols = 0;
    while (m < line.length && (line[m] === ' ' || line[m] === '\t')) {
      cols += line[m] === '\t' ? 4 - ((ind + markerWidth + cols) % 4) : 1;
      m++;
    }
    if (cols === 0 && m < line.length) return null;
    let contentIndent, content;
    if (m >= line.length) { contentIndent = ind + markerWidth + 1; content = ''; }
    else if (cols >= 5) {
      contentIndent = ind + markerWidth + 1;
      content = ' '.repeat(cols - 1) + line.slice(m);
    }
    else { contentIndent = ind + markerWidth + cols; content = line.slice(m); }
    return { indent: ind, type: 'ol', delim: d, start, contentIndent, content };
  }
  return null;
}

// Strip one blockquote marker and return the content line. Unlike
// matchQuoteMarker (index-based), this expands tabs with correct column
// tracking: the whitespace run after '>' is expanded to spaces and one
// column is consumed (cm-006: '>\t\tfoo' leaves 6 columns of indent,
// i.e. indented code with '  foo'). A tab that is content (after a
// space was consumed) is left alone — only the run right after the
// marker is expanded.
function stripQuoteMarker(line) {
  let i = 0, col = 0;
  while (i < line.length && col < 4) {
    if (line.charCodeAt(i) === 32) { col++; i++; }
    else if (line.charCodeAt(i) === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  if (col >= 4) return null;
  if (i >= line.length || line[i] !== '>') return null;
  i++; col++;
  let runCols = 0, j = i;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
    runCols += line[j] === '\t' ? 4 - ((col + runCols) % 4) : 1;
    j++;
  }
  if (runCols === 0) return line.slice(i);
  return ' '.repeat(runCols - 1) + line.slice(j);
}

// Index just after a blockquote marker ('>' plus one following space/tab),
// or -1 if the line does not start a blockquote.
function matchQuoteMarker(line) {
  let i = 0, col = 0;
  while (i < line.length && col < 4) {
    if (line.charCodeAt(i) === 32) { col++; i++; }
    else if (line.charCodeAt(i) === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  if (col >= 4) return -1;
  if (i < line.length && line[i] === '>') {
    i++;
    if (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
    return i;
  }
  return -1;
}

// A line that starts a block which can interrupt a paragraph. Inside a
// list item or quote (nested), an ordered list with any start number can
// interrupt (doc-01); at the top level only start 1 can.
function isBlockStartThatInterrupts(line, nested) {
  if (isBlank(line)) return false;
  if (matchATX(line)) return true;
  if (matchFence(line)) return true;
  if (matchHr(line)) return true;
  const hb = matchHtmlBlock(line);
  if (hb && hb.type !== 7) return true;
  if (matchQuoteMarker(line) >= 0) return true;
  const li = matchListItem(line);
  if (li) {
    if (li.content !== '' && (li.type === 'ul' || li.start === 1 || nested)) return true;
  }
  return false;
}

// Any block start (used to tell whether a line continues a paragraph).
function isAnyBlockStart(line) {
  if (isBlank(line)) return false;
  if (matchATX(line)) return true;
  if (matchFence(line)) return true;
  if (matchHr(line)) return true;
  if (matchHtmlBlock(line)) return true;
  if (matchQuoteMarker(line) >= 0) return true;
  if (matchListItem(line)) return true;
  return false;
}

// Try to parse a link reference definition starting at lines[i].
// Returns {label, href, title, end} (end = line index after the def) or null.
function tryLinkRefDef(lines, i) {
  const line = lines[i];
  const ind = indentOf(line);
  if (ind >= 4) return null;
  let j = ind;
  if (line[j] !== '[') return null;
  // Find the closing ']' (the label may span lines).
  let label, closeLine, closeCol;
  const close = findCloseBracket(line, j);
  if (close >= 0) {
    label = line.slice(j + 1, close);
    closeLine = i;
    closeCol = close;
  } else {
    const parts = [line.slice(j)];
    for (let m = 1; m <= 3; m++) {
      const l = lines[i + m];
      if (l === undefined) break;
      parts.push(l);
    }
    const joined = parts.join('\n');
    const c2 = findCloseBracket(joined, 0);
    if (c2 < 0) return null;
    label = joined.slice(1, c2);
    let pos = 0;
    closeLine = i; closeCol = -1;
    for (let m = 0; m < parts.length; m++) {
      if (c2 <= pos + parts[m].length) {
        closeLine = i + m;
        closeCol = (m === 0 ? j : 0) + (c2 - pos);
        break;
      }
      pos += parts[m].length + 1;
    }
    if (closeCol < 0) return null;
  }
  if (label.trim() === '') return null;
  if (hasUnescapedBracket(label)) return null;
  // The ':' must follow the ']' on the same line (after spaces).
  const cLine = lines[closeLine];
  let k = closeCol + 1;
  while (k < cLine.length && cLine[k] === ' ') k++;
  if (k >= cLine.length || cLine[k] !== ':') return null;
  k++;
  // The destination/title may span lines; gather lines until a blank line
  // (cap 8) so multi-line titles parse.
  const restParts = [cLine.slice(k)];
  for (let m = 1; m <= 8; m++) {
    const l = lines[closeLine + m];
    if (l === undefined || isBlank(l)) break;
    restParts.push(l);
  }
  const rest = restParts.join('\n');
  let p = 0;
  while (p < rest.length && (rest[p] === ' ' || rest[p] === '\t' || rest[p] === '\n')) p++;
  if (p >= rest.length) return null;
  let dest;
  if (rest[p] === '<') {
    let q = p + 1;
    while (q < rest.length && rest[q] !== '>' && rest[q] !== '\n') q++;
    if (q >= rest.length || rest[q] !== '>') return null;
    dest = unescape(rest.slice(p + 1, q));
    p = q + 1;
  } else {
    let q = p;
    while (q < rest.length && rest[q] !== ' ' && rest[q] !== '\t' && rest[q] !== '\n') {
      if (rest[q] === '\\' && q + 1 < rest.length && rest.charCodeAt(q + 1) < 128 && ASCII_PUNCT.test(rest[q + 1])) { q += 2; continue; }
      q++;
    }
    if (q === p) return null;
    dest = unescape(rest.slice(p, q));
    p = q;
  }
  // Optional title. If it is malformed or followed by garbage, fall back
  // to a destination-only definition (the title line becomes a paragraph).
  let title = null;
  let pEnd = p;
  let p2 = p;
  while (p2 < rest.length && (rest[p2] === ' ' || rest[p2] === '\t' || rest[p2] === '\n')) p2++;
  if (p2 < rest.length && (rest[p2] === '"' || rest[p2] === "'" || rest[p2] === '(')) {
    // A title must be separated from the destination by whitespace.
    if (p2 === p) return null;
    const q = rest[p2];
    const closeCh = q === '(' ? ')' : q;
    let r = p2 + 1, ok = false;
    while (r < rest.length) {
      if (rest[r] === '\\' && r + 1 < rest.length && rest.charCodeAt(r + 1) < 128 && ASCII_PUNCT.test(rest[r + 1])) { r += 2; continue; }
      if (rest[r] === closeCh) { ok = true; break; }
      r++;
    }
    if (ok) {
      let p3 = r + 1;
      while (p3 < rest.length && (rest[p3] === ' ' || rest[p3] === '\t')) p3++;
      if (p3 >= rest.length || rest[p3] === '\n') {
        title = unescape(rest.slice(p2 + 1, r));
        pEnd = r + 1;
      }
    }
  }
  let p3 = pEnd;
  while (p3 < rest.length && (rest[p3] === ' ' || rest[p3] === '\t')) p3++;
  // After the destination/title only whitespace + newline (or end of the
  // gathered lines) may follow; other content means an invalid definition.
  if (p3 < rest.length && rest[p3] !== '\n') return null;
  const consumed = rest.slice(0, p3).split('\n').length - 1;
  return { label, href: dest, title, end: closeLine + consumed + 1 };
}

function parseHtmlBlock(lines, i, nested = false) {
  const first = lines[i];
  const hb = matchHtmlBlock(first);
  const type = hb.type;
  let name = null;
  if (type === 1) {
    name = /^<(script|pre|style|textarea)/i.exec(first)[1].toLowerCase();
  }
  const endRe = type === 1 ? new RegExp('<\\/' + name + '>', 'i')
    : type === 2 ? /-->/
    : type === 3 ? /\?>/
    : type === 4 ? />/
    : type === 5 ? /\]\]>/
    : null;
  const n = lines.length;
  const out = [first];
  if (endRe && endRe.test(first)) {
    // end condition on the first line (types 1-5): trailing \n iff the
    // next line is non-blank, or is the trailing '' of a final newline
    let text = first;
    if (i + 1 < n && (!isBlank(lines[i + 1]) || i + 1 === n - 1)) text += '\n';
    return { block: { t: 'html', text }, next: i + 1 };
  }
  i++;
  while (i < n) {
    const line = lines[i];
    // Types 1-5 end only at their end condition (blank lines are included);
    // types 6-7 end at the first blank line.
    if (!endRe && isBlank(line)) break;
    out.push(line);
    i++;
    if (endRe && endRe.test(line)) break;
  }
  // Trailing newline rules:
  // - Types 1-5: add \n when the end line was followed by another line
  //   (the block ends mid-document or the source ends with a newline).
  // - Types 6-7: add \n only when the block ran to EOF at the top level,
  //   i.e. the blank line that ended it is the trailing '' from a final
  //   newline; a real blank line mid-document, or nested content, means
  //   no trailing \n.
  let text = out.join('\n');
  if (!text.endsWith('\n')) {
    if (endRe) {
      // types 1-5: trailing \n iff the next line is non-blank, or is the
      // trailing '' of a final newline (a real blank line after means none)
      if (i < n && (!isBlank(lines[i]) || i === n - 1)) text += '\n';
    } else if (!nested && i < n && i === n - 1 && isBlank(lines[i])) {
      text += '\n';
    }
  }
  return { block: { t: 'html', text }, next: i };
}

// Whether line c is (or contains, inside quote/list markers) an open
// paragraph line: a line that a lazy continuation may follow. Recurses
// through quote markers and list item markers (cm-292/293: a paragraph
// inside a nested quote inside a list item is open for lazy lines).
// A line that is itself a block start (fence, heading, list item with
// non-paragraph content, indented code) is not a paragraph line.
function paraOpen(c) {
  let s = c;
  for (;;) {
    if (isBlank(s)) return false;
    if (indentOf(s) >= 4) return false;
    const raw = stripQuoteMarker(s);
    if (raw !== null) { s = raw; continue; }
    const li = matchListItem(s);
    if (li) {
      if (li.content === '') return false;
      s = li.content;
      continue;
    }
    return !isAnyBlockStart(s);
  }
}

// Tracks whether content lines are inside a fenced code block or a type 1-5
// HTML block, so a lazy continuation line is only allowed after a real
// paragraph line. feed(line) returns whether a lazy line may follow it.
// inCode() reports whether a fence/HTML block is currently open.
// codeStarted() reports whether an indented content line has been seen
// inside the open fence/HTML block: marked only keeps a sub-indent line
// in a list item's fence after such a line (doc-02/05/06: an indented
// line first; A4: an indent-0 first content line escapes). isCodeClose()
// reports whether a line closes the open fence/HTML block — a closing
// fence below the item indent ends the list instead of being collected
// (B2/C5: the closing ``` becomes a top-level fence).
function makeCtxTracker() {
  let fence = null;
  let htmlEnd = null;
  let started = false;
  return {
    inCode() { return fence !== null || htmlEnd !== null; },
    codeStarted() { return started; },
    isCodeClose(c) {
      if (fence) return matchFenceClose(c, fence.ch, fence.len);
      if (htmlEnd) return htmlEnd.test(c);
      return false;
    },
    feed(c) {
      if (fence) {
        if (matchFenceClose(c, fence.ch, fence.len)) { fence = null; started = false; }
        else started = true;
        return false;
      }
      if (htmlEnd) {
        if (htmlEnd.test(c)) { htmlEnd = null; started = false; }
        else started = true;
        return false;
      }
      const f = matchFence(c);
      if (f) { fence = { ch: f.ch, len: f.len }; started = false; return false; }
      const hb = matchHtmlBlock(c);
      if (hb && hb.type !== 6 && hb.type !== 7) {
        let name = null;
        if (hb.type === 1) name = /^<(script|pre|style|textarea)/i.exec(c)[1].toLowerCase();
        htmlEnd = hb.type === 1 ? new RegExp('<\\/' + name + '>', 'i')
          : hb.type === 2 ? /-->/
          : hb.type === 3 ? /\?>/
          : hb.type === 4 ? />/
          : /\]\]>/;
        if (htmlEnd.test(c)) htmlEnd = null;
        return false;
      }
      // A paragraph line may hide inside quote/list markers (cm-292/293).
      return paraOpen(c);
    }
  };
}

function quotePrefix(s) {
  // Leading run of '>' markers (each '>' + at most one space/tab).
  let p = '', i = 0;
  while (i < s.length && s[i] === '>') {
    p += '>';
    i++;
    if (i < s.length && (s[i] === ' ' || s[i] === '\t')) { p += s[i]; i++; }
  }
  return p;
}

function parseQuote(lines, i, links) {
  const content = [];
  const n = lines.length;
  const tr = makeCtxTracker();
  let inPara = false;
  // The '>' prefix of the deepest open quote (cm-250/251: a plain-text
  // line following a nested quote line stays at that nested depth).
  let prefix = '';
  while (i < n) {
    const line = lines[i];
    // stripQuoteMarker returns null when the line is not a quote line
    // (same test as matchQuoteMarker, but it also yields the content
    // with correct tab expansion — one scan instead of two).
    const raw = stripQuoteMarker(line);
    if (raw !== null) {
      const own = quotePrefix(raw);
      let c = raw;
      // Plain text after the marker, while a nested paragraph is open,
      // is a lazy continuation of that paragraph: keep it at the nested
      // depth instead of dropping it to this level. (A plain-text line
      // with no blank line before it cannot start a new outer paragraph.)
      // Inside a fenced code block there is no paragraph: a fence line
      // stays literal (doc-10/12/14: '> function...' keeps no '>').
      if (!tr.inCode() && prefix && !own && !isBlockStartThatInterrupts(raw, true) && !matchSetext(raw)) {
        c = prefix + raw;
      }
      if (own) prefix = own;
      // A whitespace-only remainder is paragraph content (cm-241: '>  '
      // contributes a ' ' line to the paragraph) only when it is the
      // last line of the quote; mid-quote it is a blank line that
      // breaks the paragraph. (A tab remainder expands to spaces here,
      // e.g. '>\t' contributes '  ' when trailing.)
      if (inPara && c !== '' && /^[ \t]+$/.test(c)) {
        const nxt = lines[i + 1];
        const trailing = nxt === undefined || isBlank(nxt) || (matchQuoteMarker(nxt) < 0 && !prefix);
        c = trailing ? '\x00' + c : '';
      }
      content.push(c);
      inPara = tr.feed(c);
      i++;
      continue;
    }
    if (isBlank(line)) break;
    // A lazy line is allowed when a paragraph is open here, or when a
    // nested quote holds one (cm-250: 'bar' after '> > > foo' continues
    // the innermost paragraph). A line without a '>' marker never joins
    // a fenced code block inside a quote (cm-237: 'foo' after '> ```'
    // is a top-level paragraph, not fence content).
    if (!inPara && !prefix) break;
    if (isBlockStartThatInterrupts(line, true)) break;
    // A lazy continuation line loses its leading whitespace (cm-238).
    let c = line.replace(/^[ \t]+/, '');
    // A setext underline as a lazy line is paragraph text, not an
    // underline: indent it so it cannot form a heading (cm-093).
    if (matchSetext(c)) c = '    ' + c;
    // A lazy line that looks like a list item stays paragraph text
    // (cm-238: '- bar' under 'foo' is text, not a nested list).
    if (matchListItem(c)) c = '\x00' + c;
    // Keep a lazy line at the nested depth (cm-250).
    if (prefix && !c.startsWith('>') && !c.startsWith('\x00') && !isBlockStartThatInterrupts(c, true)) {
      c = prefix + c;
    }
    content.push(c);
    inPara = tr.feed(c);
    i++;
  }
  const inner = parseBlocksInner(content.join('\n'), links, true);
  return { block: { t: 'quote', children: inner.blocks }, next: i };
}

function parseList(lines, i, links) {
  const n = lines.length;
  const first = matchListItem(lines[i]);
  const listType = first.type, listDelim = first.delim;
  const listIndent = first.indent;
  const items = [];
  let loose = false;
  let cur = null;
  let pendingBlank = 0;
  let inPara = false;
  let tr = makeCtxTracker();
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { pendingBlank++; inPara = false; i++; continue; }
    // A thematic break ends the list (cm-060) — but only if it is not
    // indented content of the current item (cm-300: '  ---' under '- Bar'
    // is a setext underline, not a break).
    if (cur && matchHr(line) && indentOf(line) < cur.contentIndent) { i -= pendingBlank; break; }
    const m = matchListItem(line);
    if (m && m.type === listType && m.delim === listDelim && m.indent < (cur ? cur.contentIndent : Infinity)) {
      if (cur) {
        if (pendingBlank > 0) loose = true;
        items.push(cur);
      }
      cur = { lines: [], contentIndent: m.contentIndent, start: m.start };
      tr = makeCtxTracker();
      if (m.content !== '') { cur.lines.push(m.content); inPara = tr.feed(m.content); }
      else inPara = false;
      pendingBlank = 0;
      i++;
      continue;
    }
    if (cur) {
      const ind = indentOf(line);
      // An empty item followed by a blank line is closed: later indented
      // lines are not its content (cm-280).
      if (cur.lines.length === 0 && pendingBlank > 0) { i -= pendingBlank; break; }
      if (ind >= cur.contentIndent) {
        for (let k = 0; k < pendingBlank; k++) cur.lines.push('');
        pendingBlank = 0;
        const c = stripCols(line, cur.contentIndent);
        cur.lines.push(c);
        inPara = tr.feed(c);
        i++;
        continue;
      }
      // Inside a fenced code block or HTML block, a sub-indent content
      // line belongs to the item only once an indented content line has
      // been seen in that fence (codeStarted) and only if the line is
      // not the fence's closing line (doc-02/05/06 vs A4/B2/C5).
      if (tr.inCode() && tr.codeStarted() && !tr.isCodeClose(line)) {
        for (let k = 0; k < pendingBlank; k++) cur.lines.push('');
        pendingBlank = 0;
        const c = stripCols(line, cur.contentIndent);
        cur.lines.push(c);
        inPara = tr.feed(c);
        i++;
        continue;
      }
      // a list item marker of a different type/delimiter ends this list
      if (m) { i -= pendingBlank; break; }
      if (inPara && pendingBlank === 0 && !isBlockStartThatInterrupts(line, true)) {
        for (let k = 0; k < pendingBlank; k++) cur.lines.push('');
        pendingBlank = 0;
        // A lazy continuation line loses leading whitespace up to the
        // item's content indent (cm-291/312).
        const c = stripCols(line, cur.contentIndent);
        // If the stripped line looks like a list item, it must stay
        // paragraph text (cm-312: '- e' under 'd' is text, not a nested
        // list). Mark it so parseBlocksInner does not re-parse it as one.
        cur.lines.push(matchListItem(c) ? '\x00' + c : c);
        inPara = tr.feed(c);
        i++;
        continue;
      }
    }
    // Back up over trailing blank lines so the caller sees the separator
    // (cm-325: the blank line before 'baz' makes the outer item loose).
    i -= pendingBlank;
    break;
  }
  if (cur) items.push(cur);
  const parsed = items.map(it => {
    const ls = it.lines.slice();
    while (ls.length && isBlank(ls[ls.length - 1])) ls.pop();
    const inner = parseBlocksInner(ls.join('\n'), links, true);
    if (inner.blankSep) loose = true;
    return { children: inner.blocks, start: it.start };
  });
  return { block: { t: 'list', type: listType, start: first.start, items: parsed, loose }, next: i };
}

function parseBlocksInner(src, links, nested = false) {
  const lines = src.split('\n');
  const blocks = [];
  let blankSep = false;
  let pendingBlank = false;
  let i = 0;
  const n = lines.length;
  let para = null;
  const flushPara = () => {
    if (para && para.length) {
      blocks.push(mkBlockFromPara(para, links));
      para = null;
      if (pendingBlank) { blankSep = true; pendingBlank = false; }
    }
  };
  const pushBlock = (b) => {
    if (pendingBlank) { blankSep = true; pendingBlank = false; }
    blocks.push(b);
  };
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      // A whitespace-only line inside a table paragraph is an empty table
      // row, not a paragraph break — but ONLY when it contains a tab
      // (doc-26: a '\t' line becomes a row of empty cells). A
      // spaces-only line is a blank line and ends the table (doc-03).
      if (para && para.length >= 2 && line !== '' && line.includes('\t') && isTablePara(para)) {
        para.push('');
        i++;
        continue;
      }
      flushPara();
      if (blocks.length > 0) pendingBlank = true;
      i++;
      continue;
    }
    // A '\x00'-prefixed line is a lazy continuation that looks like a
    // list item (cm-312): it is paragraph text, never a block start.
    if (line.charCodeAt(0) === 0) {
      if (!para) para = [];
      para.push(line.slice(1));
      i++;
      continue;
    }
    if (!para) {
      const def = tryLinkRefDef(lines, i);
      if (def) {
        if (!links.has(normLabel(def.label))) links.set(normLabel(def.label), { href: def.href, title: def.title });
        // A link ref def is a block: a blank line before it separates
        // blocks, so it counts toward looseness (cm-317).
        if (pendingBlank) { blankSep = true; pendingBlank = false; }
        i = def.end;
        continue;
      }
    }
    if (!para && indentOf(line) >= 4) {
      const codeLines = [];
      while (i < n) {
        const l = lines[i];
        if (isBlank(l)) {
          let j = i;
          while (j < n && isBlank(lines[j])) j++;
          if (j < n && indentOf(lines[j]) >= 4) {
            // A whitespace-only line with code indent keeps its remaining
            // spaces (cm-112: '      ' -> '  ').
            while (i < j) { codeLines.push(indentOf(lines[i]) >= 4 ? stripCols(lines[i], 4, true) : ''); i++; }
            continue;
          }
          break;
        }
        if (indentOf(l) >= 4) { codeLines.push(stripCols(l, 4, true)); i++; }
        else break;
      }
      while (codeLines.length && codeLines[codeLines.length - 1] === '') codeLines.pop();
      let text = codeLines.join('\n');
      // In nested content (quote/list) the last line was newline-terminated
      // in the source, so an indented code block there gets a trailing \n.
      if (codeLines.length && (i < n || nested)) text += '\n';
      pushBlock({ t: 'code', text, lang: null });
      continue;
    }
    const atx = matchATX(line);
    if (atx) { flushPara(); pushBlock({ t: 'h', level: atx.level, text: atx.text }); i++; continue; }
    const fence = matchFence(line);
    if (fence) {
      flushPara();
      const codeLines = [];
      i++;
      let closed = false;
      while (i < n) {
        const l = lines[i];
        if (matchFenceClose(l, fence.ch, fence.len)) { i++; closed = true; break; }
        // Backtick fences strip up to the opening fence's indent from
        // each content line; tilde fences strip nothing (marked's
        // indent compensation only matches backticks).
        codeLines.push(fence.ch === '`' ? stripCols(l, fence.indent, true) : l);
        i++;
      }
      // Pop at most one trailing blank line: the artifact of a final
      // newline for an unclosed fence, or the single blank line before a
      // closing fence (cm-318 keeps one of two trailing blanks).
      if (codeLines.length && codeLines[codeLines.length - 1] === '') codeLines.pop();
      let text = codeLines.join('\n');
      if (codeLines.length) text += '\n';
      pushBlock({ t: 'code', text, lang: fence.lang });
      continue;
    }
    if (para) {
      const setext = matchSetext(line);
      if (setext) {
        // Inside a table paragraph, a line of '='/'-' is a table row,
        // not a setext underline (doc-26: '=========' is a row).
        if (para.length >= 2 && isTablePara(para)) { para.push(line); i++; continue; }
        // Setext heading text is trimmed (leading space of the first line,
        // trailing space of the last line).
        const ls = para.slice();
        ls[0] = ls[0].replace(/^[ \t]+/, '');
        ls[ls.length - 1] = ls[ls.length - 1].replace(/[ \t]+$/, '');
        const b = { t: 'h', level: setext.level, lines: ls };
        para = null;
        pushBlock(b);
        i++;
        continue;
      }
    }
    if (matchHr(line)) { flushPara(); pushBlock({ t: 'hr' }); i++; continue; }
    const hb = matchHtmlBlock(line);
    if (hb && (hb.type !== 7 || !para)) {
      flushPara();
      const r = parseHtmlBlock(lines, i, nested);
      pushBlock(r.block);
      i = r.next;
      continue;
    }
    if (matchQuoteMarker(line) >= 0) {
      flushPara();
      const r = parseQuote(lines, i, links);
      pushBlock(r.block);
      i = r.next;
      continue;
    }
    const li = matchListItem(line);
    if (li) {
      const canInterrupt = li.content !== '' && (li.type === 'ul' || li.start === 1 || nested);
      if (!para || canInterrupt) {
        flushPara();
        const r = parseList(lines, i, links);
        pushBlock(r.block);
        i = r.next;
        continue;
      }
    }
    if (!para) para = [];
    para.push(line);
    i++;
  }
  flushPara();
  return { blocks, blankSep };
}

// ---------- tables (GFM) ----------
function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  const cells = [];
  let cur = '', i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length && s[i + 1] === '|') { cur += '|'; i += 2; continue; }
    if (s[i] === '\\' && i + 1 < s.length && s[i + 1] === '\\') { cur += '\\\\'; i += 2; continue; }
    if (s[i] === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += s[i]; i++;
  }
  cells.push(cur);
  if (cells.length > 1 && cells[cells.length - 1].trim() === '' && s.endsWith('|')) cells.pop();
  return cells;
}

function isTablePara(lines) {
  // True when the paragraph's first two lines form a GFM table header
  // and delimiter row (same test as mkBlockFromPara).
  if (lines.length < 2 || indentOf(lines[1]) >= 4) return false;
  const cells = splitTableRow(lines[0]);
  const delim = splitTableRow(lines[1]);
  return cells.length === delim.length && cells.length > 0 && delim.every(d => /^:?-+:?$/.test(d.trim()));
}

function mkBlockFromPara(lines, links) {
  if (lines.length >= 2 && indentOf(lines[1]) < 4) {
    const cells = splitTableRow(lines[0]);
    const delim = splitTableRow(lines[1]);
    if (cells.length === delim.length && cells.length > 0 && delim.every(d => /^:?-+:?$/.test(d.trim()))) {
      const align = delim.map(d => {
        const t = d.trim();
        if (t.startsWith(':') && t.endsWith(':')) return 'center';
        if (t.endsWith(':')) return 'right';
        if (t.startsWith(':')) return 'left';
        return null;
      });
      const header = cells.map(c => c.trim());
      const rows = lines.slice(2).map(l => {
        const cs = splitTableRow(l);
        while (cs.length < cells.length) cs.push('');
        return cs.slice(0, cells.length).map(c => c.trim());
      });
      return { t: 'table', align, header, rows };
    }
  }
  return { t: 'p', lines };
}

// ---------- rendering ----------
function renderBlocks(blocks, links) {
  let out = '';
  for (const b of blocks) out += renderBlock(b, links);
  return out;
}

function renderBlock(b, links) {
  switch (b.t) {
    case 'p': return '<p>' + inlineParse(b.lines.join('\n'), links) + '</p>\n';
    case 'h': {
      const text = b.text !== undefined ? b.text : b.lines.join('\n');
      return '<h' + b.level + '>' + inlineParse(text, links) + '</h' + b.level + '>\n';
    }
    case 'code': {
      const lang = b.lang ? ' class="language-' + escAttr(b.lang) + '"' : '';
      return '<pre><code' + lang + '>' + esc(b.text) + '</code></pre>\n';
    }
    case 'hr': return '<hr>\n';
    case 'quote': return '<blockquote>\n' + renderBlocks(b.children, links) + '</blockquote>\n';
    case 'html': return b.text;
    case 'list': {
      const tag = b.type === 'ul' ? 'ul' : 'ol';
      const startAttr = (b.type === 'ol' && b.start !== 1) ? ' start="' + b.start + '"' : '';
      let out = '<' + tag + startAttr + '>\n';
      for (const it of b.items) out += renderListItem(it, b.loose, links);
      return out + '</' + tag + '>\n';
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let k = 0; k < b.header.length; k++) {
        const a = b.align[k] ? ' align="' + b.align[k] + '"' : '';
        out += '<th' + a + '>' + inlineParse(b.header[k], links) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (b.rows.length) {
        out += '<tbody>';
        for (const row of b.rows) {
          out += '<tr>\n';
          for (let k = 0; k < row.length; k++) {
            const a = b.align[k] ? ' align="' + b.align[k] + '"' : '';
            out += '<td' + a + '>' + inlineParse(row[k], links) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
  }
  return '';
}

function renderListItem(it, loose, links) {
  // GFM task list: a leading "[ ]" / "[x]" on the item's first paragraph.
  let taskPrefix = '';
  let children = it.children;
  if (children.length && children[0].t === 'p' && children[0].lines.length) {
    const m = /^\[([ xX])\]( |$)/.exec(children[0].lines[0]);
    if (m) {
      taskPrefix = m[1] === ' '
        ? '<input disabled="" type="checkbox"> '
        : '<input checked="" disabled="" type="checkbox"> ';
      const first = children[0].lines[0].slice(m[0].length);
      const rest = children[0].lines.slice(1);
      children = [{ t: 'p', lines: [first, ...rest] }, ...children.slice(1)];
    }
  }
  if (!loose) {
    const parts = children.map(c => {
      if (c.t === 'p') return inlineParse(c.lines.join('\n'), links);
      return renderBlock(c, links);
    });
    return '<li>' + taskPrefix + parts.join('') + '</li>\n';
  }
  let out = '<li>';
  for (let idx = 0; idx < children.length; idx++) {
    const c = children[idx];
    // In a loose list the checkbox lives inside the first paragraph.
    if (idx === 0 && taskPrefix && c.t === 'p') {
      out += '<p>' + taskPrefix + inlineParse(c.lines.join('\n'), links) + '</p>\n';
    } else {
      out += renderBlock(c, links);
    }
  }
  return out + '</li>\n';
}

export { parse };
