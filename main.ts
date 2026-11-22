// main.ts is mend, the CLI SPEC.md specifies: it applies an edit an AI model wrote, in one of four formats
// (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), to a tree of text files, matching lines at three
// tiers of looseness, and writes every change or none. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  private readonly dirs = new Map<string, boolean>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  private isDir(p: string): boolean {
    if (!this.dirs.has(p)) {
      let d = false;
      try {
        d = statSync(p).isDirectory();
      } catch {
        d = false;
      }
      this.dirs.set(p, d);
    }
    return this.dirs.get(p)!;
  }
  /** True when the path exists in the tree as the edits leave it, as a file or a directory. */
  exists(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    if (this.original(p) !== null) return true;
    if (this.isDir(p)) return true;
    for (const [k, v] of this.now) {
      if (v !== null && k.startsWith(`${p}/`)) return true;
    }
    return false;
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.exists(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Files as lines, and matching lines at three tiers (SPEC.md 3 and 5) */
/* ------------------------------------------------------------------ */

/** A file's text as lines: its line break, its lines, whether it ends with a line break. */
function splitFile(text: string): { br: string; lines: string[]; final: boolean } {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** The lowest tier at which two lines match, or -1 when they match at none. */
function lineTier(a: string, b: string): number {
  if (a === b) return 0;
  if (trimEndWs(a) === trimEndWs(b)) return 1;
  if (trimWs(a) === trimWs(b)) return 2;
  return -1;
}

/** Every 0-based position at or after `from` where O matches the file's lines at the tier. */
function occurrencesAt(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      const lt = lineTier(o[k]!, lines[i + k]!);
      if (lt < 0 || lt > tier) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its positions, or null. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line is written as the file's own matched line. */
interface NewLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Replace O at `pos` by N, applying the context-line and tier-2 re-indentation rules. */
function buildNew(lines: string[], pos: number, o: string[], n: NewLine[], tier: number): string[] {
  const out = lines.slice();
  const f = tier === 2 && o.length > 0 ? leadWs(lines[pos]!) : '';
  const p = tier === 2 && o.length > 0 ? leadWs(o[0]!) : '';
  const built: string[] = [];
  for (const e of n) {
    if (e.ctx) {
      built.push(lines[pos + e.oIdx]!);
      continue;
    }
    if (tier === 2 && e.text !== '' && e.text.trim() !== '' && e.text.startsWith(p)) built.push(f + e.text.slice(p.length));
    else built.push(e.text);
  }
  out.splice(pos, o.length, ...built);
  return out;
}

/** One body line of a hunk or a chunk: context, old, new, or a `\` line. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

/** Split a hunk or chunk body into its old lines O and its new lines N. */
function splitON(body: BodyLine[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const e of body) {
    if (e.kind === 'ctx') {
      o.push(e.text);
      n.push({ text: e.text, ctx: true, oIdx: o.length - 1 });
    } else if (e.kind === 'old') o.push(e.text);
    else if (e.kind === 'new') n.push({ text: e.text, ctx: false, oIdx: -1 });
  }
  return { o, n };
}

/** True when a `\` line follows the body's last context or `+` line. */
function noEol(body: BodyLine[]): boolean {
  let last = -1;
  for (let j = 0; j < body.length; j++) {
    if (body[j]!.kind === 'ctx' || body[j]!.kind === 'new') last = j;
  }
  return last >= 0 && body[last + 1] !== undefined && body[last + 1]!.kind === 'bs';
}

/* ------------------------------------------ */
/* Unified diffs (SPEC.md section 6)          */
/* ------------------------------------------ */

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  dashOld: string | null;
  dashNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function dashPath(line: string): string {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** Apply a section's hunks in order to a file's text. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const parts = splitFile(before);
  let lines = parts.lines;
  let final = parts.final;
  const br = parts.br;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitON(h.body);
    if (o.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), lines.length);
      const wasEnd = at === lines.length;
      const built = n.map((e) => e.text);
      lines.splice(at, 0, ...built);
      if (wasEnd) final = !noEol(h.body);
      d += n.length;
      continue;
    }
    const found = findTier(lines, o, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    for (const p of found.occ) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const atEnd = best + o.length === lines.length;
    lines = buildNew(lines, best, o, n, found.tier);
    if (atEnd) final = !noEol(h.body);
    d += n.length - o.length;
  }
  return joinFile(lines, br, final);
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  const oldPath = s.dashOld !== null ? (s.dashOld === '/dev/null' ? null : s.dashOld) : s.renameFrom !== null ? s.renameFrom : s.diffOld;
  const newPath = s.dashNew !== null ? (s.dashNew === '/dev/null' ? null : s.dashNew) : s.renameTo !== null ? s.renameTo : s.diffNew;
  const isCreate = oldPath === null || s.create;
  const isDelete = !isCreate && (newPath === null || s.del);
  const isMove = !isCreate && !isDelete && oldPath !== null && newPath !== null && oldPath !== newPath;
  if (isCreate) {
    if (newPath === null) return () => {};
    const p = newPath;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.exists(p)) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastPlus: { hunk: Hunk; idx: number } | null = null;
      for (const h of s.hunks) {
        for (let j = 0; j < h.body.length; j++) {
          if (h.body[j]!.kind === 'new') {
            plus.push(h.body[j]!.text);
            lastPlus = { hunk: h, idx: j };
          }
        }
      }
      const finalBr = lastPlus === null ? true : lastPlus.hunk.body[lastPlus.idx + 1]?.kind !== 'bs';
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (finalBr ? '\n' : ''));
    };
  }
  if (isDelete) {
    const p = oldPath!;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (isMove) {
    const o = oldPath!;
    const n = newPath!;
    return (tree) => {
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(n)) throw new Fail('unsafe', n);
      const before = tree.get(o);
      if (before === null) throw new Fail('missing', o);
      if (tree.exists(n)) throw new Fail('exists', n);
      const result = applyHunks(before, s.hunks, strict, o);
      tree.now.set(o, null);
      tree.now.set(n, result);
      tree.moves.push([o, n]);
    };
  }
  const p = oldPath!;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, s.hunks, strict, p));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const startSection = (diffOld: string | null, diffNew: string | null): Section => {
    const s: Section = { diffOld, diffNew, dashOld: null, dashNew: null, renameFrom: null, renameTo: null, create: false, del: false, hunks: [] };
    sections.push(s);
    return s;
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = startSection(m[1]!, m[2]!);
      inHeader = true;
      i += 1;
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && cur.dashOld === null) {
        cur.dashOld = dashPath(l);
        cur.dashNew = dashPath(lines[i + 1]!);
      } else {
        cur = startSection(null, null);
        cur.dashOld = dashPath(l);
        cur.dashNew = dashPath(lines[i + 1]!);
        inHeader = true;
      }
      i += 2;
    } else if (cur !== null && inHeader && l.startsWith('--- ')) {
      throw new Exit2(`error: parse ${i + 2}`);
    } else if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      i += 1;
      const body: BodyLine[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          body.push({ kind: 'ctx', text: '' });
          i += 1;
        } else if (b[0] === ' ') {
          body.push({ kind: 'ctx', text: b.slice(1) });
          i += 1;
        } else if (b[0] === '-') {
          body.push({ kind: 'old', text: b.slice(1) });
          i += 1;
        } else if (b[0] === '+') {
          body.push({ kind: 'new', text: b.slice(1) });
          i += 1;
        } else if (b[0] === '\\') {
          body.push({ kind: 'bs', text: b.slice(1) });
          i += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
    } else if (cur !== null && inHeader) {
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.del = true;
      i += 1;
    } else {
      i += 1;
    }
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/* ------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)  */
/* ------------------------------------------ */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.exists(path)) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const parts = splitFile(before);
    const found = findTier(parts.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const n: NewLine[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    tree.now.set(path, joinFile(buildNew(parts.lines, found.occ[0]!, oldLines, n, found.tier), parts.br, parts.final));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchNo = i + 1;
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq < 0) throw new Exit2(`error: parse ${searchNo}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep < 0) throw new Exit2(`error: parse ${searchNo}`);
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const t = lines[j]!.trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchNo}`);
        path = prevPath;
      }
      edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
      prevPath = path;
      prevEnd = rep + 1;
      i = rep + 1;
    } else {
      i += 1;
    }
  }
  return edits;
}

/* ------------------------------------------ */
/* V4A patches (SPEC.md section 8)            */
/* ------------------------------------------ */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function v4aEdit(kind: 'add' | 'del' | 'upd', path: string, content: { text: string; line: number }[], startLine: number, strict: boolean): Edit {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (const c of content) {
      if (c.text.startsWith('+')) fileLines.push(c.text.slice(1));
      else if (blank(c.text)) fileLines.push('');
      else throw new Exit2(`error: parse ${c.line}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.exists(path)) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (kind === 'del') {
    for (const c of content) {
      if (!blank(c.text)) throw new Exit2(`error: parse ${c.line}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let idx = 0;
  let moveTo: string | null = null;
  if (content.length > 0 && content[0]!.text.startsWith('*** Move to:')) {
    moveTo = content[0]!.text.slice('*** Move to:'.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (; idx < content.length; idx++) {
    const c = content[idx]!;
    if (c.text.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const anchor = c.text.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
    } else if (c.text.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${c.line}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
    } else if (c.text === '' || c.text[0] === ' ' || c.text[0] === '-' || c.text[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${c.line}`);
        cur = { anchor: null, eof: false, body: [] };
      }
      let k: BodyLine['kind'];
      if (c.text === '' || c.text[0] === ' ') k = 'ctx';
      else if (c.text[0] === '-') k = 'old';
      else k = 'new';
      cur.body.push({ kind: k, text: c.text === '' ? '' : c.text.slice(1) });
    } else {
      throw new Exit2(`error: parse ${c.line}`);
    }
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.exists(moveTo)) throw new Fail('exists', moveTo);
    const parts = splitFile(before);
    let lines = parts.lines;
    const br = parts.br;
    const final = parts.final;
    let cursor = 0;
    const tiers = strict ? [0] : [0, 1, 2];
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundLine = -1;
        for (const t of tiers) {
          for (let j = cursor; j < lines.length; j++) {
            const lt = lineTier(ch.anchor, lines[j]!);
            if (lt >= 0 && lt <= t) {
              foundLine = j;
              break;
            }
          }
          if (foundLine >= 0) break;
        }
        if (foundLine < 0) throw new Fail('no-match', path);
        cursor = foundLine + 1;
      }
      const { o, n } = splitON(ch.body);
      if (o.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const built = n.map((e) => e.text);
        lines.splice(at, 0, ...built);
        cursor = at + built.length;
      } else {
        let found: { tier: number; pos: number } | null = null;
        for (const t of tiers) {
          const occ = occurrencesAt(lines, o, t, cursor).filter((p) => !ch.eof || p + o.length === lines.length);
          if (occ.length > 0) {
            found = { tier: t, pos: occ[0]! };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', path);
        lines = buildNew(lines, found.pos, o, n, found.tier);
        cursor = found.pos + n.length;
      }
    }
    const result = joinFile(lines, br, final);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, result);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, result);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const l = lines[i]!;
    let kind: 'add' | 'del' | 'upd';
    let path: string;
    if (l.startsWith('*** Add File:')) {
      kind = 'add';
      path = l.slice('*** Add File:'.length).trim();
    } else if (l.startsWith('*** Delete File:')) {
      kind = 'del';
      path = l.slice('*** Delete File:'.length).trim();
    } else if (l.startsWith('*** Update File:')) {
      kind = 'upd';
      path = l.slice('*** Update File:'.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const startLine = i + 1;
    i += 1;
    const content: { text: string; line: number }[] = [];
    while (i < last) {
      const cl = lines[i]!;
      if (cl.startsWith('*** Add File:') || cl.startsWith('*** Delete File:') || cl.startsWith('*** Update File:')) break;
      content.push({ text: cl, line: i + 1 });
      i += 1;
    }
    while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
    edits.push(v4aEdit(kind, path, content, startLine, strict));
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (consumed.has(oldP) || consumed.has(newP)) continue;
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      consumed.add(oldP);
      consumed.add(newP);
      changed.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  const byPath = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  for (const p of [...tree.now.keys()].sort(byPath)) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  changed.sort((a, b) => byPath(a.key, b.key));
  const rows = changed.map((c) => c.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byPath)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
