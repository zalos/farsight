#!/usr/bin/env node
// Proves a formatting commit changed no program: for every changed JS/TS file, the TypeScript AST of the
// old and new text must be identical once trivia is ignored (whitespace, line breaks, trailing commas,
// redundant parentheses, stray semicolons, quote style, number spelling, regex flag order). Comments are
// compared as a separate sequence and reported as warnings (--strict-comments makes them fail too).
// Exit 1 on any AST difference, an added/deleted/renamed code file, or (strict) a comment difference.
//
//   node scripts/ast-equivalence.mjs <base-rev> [<head-rev>]     (head defaults to the working tree)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const K = ts.SyntaxKind;
const F = ts.NodeFlags;
const FLAGS =
  F.Let | F.Const | F.Using | F.AwaitUsing | F.OptionalChain | F.Namespace | F.NestedNamespace | F.GlobalAugmentation;

const CODE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const kindOf = (p) =>
  /\.tsx$/.test(p)
    ? ts.ScriptKind.TSX
    : /\.jsx$/.test(p)
      ? ts.ScriptKind.JSX
      : /\.[cm]?ts$/.test(p)
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;

/** A trivia-free, formatting-free spelling of the program. */
export function shape(path, text) {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kindOf(path));
  const out = [];
  const parseErrors = sf.parseDiagnostics?.length ?? 0;
  const skipInList = (n) => n.kind === K.EmptyStatement || n.kind === K.SemicolonClassElement;
  const visit = (n) => {
    switch (n.kind) {
      case K.ParenthesizedExpression:
      case K.ParenthesizedType:
        return visit(n.expression ?? n.type);
      case K.Identifier:
      case K.PrivateIdentifier:
        out.push('I:' + n.text);
        return;
      case K.StringLiteral:
        out.push('S:' + JSON.stringify(n.text));
        return;
      case K.NoSubstitutionTemplateLiteral:
      case K.TemplateHead:
      case K.TemplateMiddle:
      case K.TemplateTail:
        out.push(K[n.kind] + ':' + JSON.stringify(n.rawText ?? n.text));
        return;
      case K.NumericLiteral:
        out.push('N:' + Number(n.text.replace(/_/g, '')));
        return;
      case K.BigIntLiteral:
        out.push('B:' + n.text.replace(/_/g, '').toLowerCase());
        return;
      case K.RegularExpressionLiteral: {
        const i = n.text.lastIndexOf('/');
        out.push('R:' + n.text.slice(0, i + 1) + [...n.text.slice(i + 1)].sort().join(''));
        return;
      }
      case K.BinaryExpression: {
        const operator = n.operatorToken.kind;
        if (
          operator !== K.BarBarToken &&
          operator !== K.AmpersandAmpersandToken &&
          operator !== K.QuestionQuestionToken
        )
          break;
        // Only these same-operator chains preserve operand order and short-circuiting across regrouping.
        out.push('(LogicalChain:' + K[operator]);
        const operand = (child) => {
          while (child.kind === K.ParenthesizedExpression) child = child.expression;
          if (child.kind === K.BinaryExpression && child.operatorToken.kind === operator) {
            operand(child.left);
            operand(child.right);
          } else visit(child);
        };
        operand(n);
        out.push(')');
        return;
      }
    }
    // Flags that carry meaning but are not child nodes: let/const/using, an optional chain's extent, namespaces.
    const flags = n.flags & FLAGS;
    out.push('(' + K[n.kind] + (flags ? '#' + flags : ''));
    // An empty list and an absent one print alike (`new Foo` is `new Foo()`).
    ts.forEachChild(n, visit, (list) => {
      if (!list.length) return;
      out.push('[');
      for (const c of list) if (!skipInList(c)) visit(c);
      out.push(']');
    });
    out.push(')');
  };
  visit(sf);
  // All comments, in source order: every comment is leading trivia of some token (or of end-of-file).
  const comments = [];
  const seen = new Set();
  const collect = (node) => {
    for (const r of ts.getLeadingCommentRanges(text, node.pos) ?? [])
      if (!seen.has(r.pos)) {
        seen.add(r.pos);
        comments.push(r);
      }
    for (const r of ts.getTrailingCommentRanges(text, node.end) ?? [])
      if (!seen.has(r.pos)) {
        seen.add(r.pos);
        comments.push(r);
      }
    for (const c of node.getChildren(sf)) collect(c);
  };
  collect(sf);
  comments.sort((a, b) => a.pos - b.pos);
  const commentText = comments.map((r) =>
    text
      .slice(r.pos, r.end)
      .replace(/^\s*\*/gm, '*')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  return { ast: out, comments: commentText, shebang: ts.getShebang(text) ?? '', parseErrors };
}

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i;
}

export function compare(path, before, after) {
  const A = shape(path, before),
    B = shape(path, after);
  const problems = [];
  if (A.parseErrors !== B.parseErrors)
    problems.push({ level: 'ast', msg: `parse errors ${A.parseErrors} → ${B.parseErrors}` });
  if (A.shebang !== B.shebang) problems.push({ level: 'ast', msg: 'shebang changed' });
  if (A.ast.length !== B.ast.length || A.ast.some((t, i) => t !== B.ast[i])) {
    const i = firstDiff(A.ast, B.ast);
    problems.push({
      level: 'ast',
      msg: `AST differs at token ${i}: …${A.ast.slice(Math.max(0, i - 6), i + 4).join(' ')}… vs …${B.ast.slice(Math.max(0, i - 6), i + 4).join(' ')}…`,
    });
  }
  const ca = JSON.stringify(A.comments),
    cb = JSON.stringify(B.comments);
  if (ca !== cb) {
    const sorted = (x) => JSON.stringify([...x].sort());
    problems.push({
      level: 'comment',
      msg:
        sorted(A.comments) === sorted(B.comments)
          ? 'comments reordered'
          : `comments changed (${A.comments.length} → ${B.comments.length})`,
    });
  }
  return problems;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const strict = process.argv.includes('--strict-comments');
  const [base, head] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!base) {
    console.error('usage: ast-equivalence.mjs <base-rev> [<head-rev>]');
    process.exit(64);
  }
  const range = head ? [base, head] : [base];
  const files = git('diff', '--name-only', '--diff-filter=M', '-z', ...range, '--')
    .split('\0')
    .filter((p) => CODE.test(p));
  const added = git('diff', '--name-only', '--diff-filter=ADR', '-z', ...range, '--')
    .split('\0')
    .filter((p) => CODE.test(p));
  let ast = 0,
    comment = 0;
  for (const p of files) {
    const before = git('show', `${base}:${p}`);
    const after = head ? git('show', `${head}:${p}`) : readFileSync(p, 'utf8');
    for (const pr of compare(p, before, after)) {
      console.log(`${pr.level === 'ast' ? '::error file=' + p + '::' : '::warning file=' + p + '::'}${pr.msg}`);
      pr.level === 'ast' ? ast++ : comment++;
    }
  }
  if (added.length) {
    console.log(`::error::a formatting change may not add, delete or rename files: ${added.join(', ')}`);
    ast++;
  }
  console.log(`${files.length} files compared · ${ast} AST differences · ${comment} comment differences`);
  process.exit(ast || (strict && comment) ? 1 : 0);
}
