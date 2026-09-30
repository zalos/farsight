/**
 * Decision points inside Java method bodies — the forks a Journey narrates.
 * Same semantics as the TS extractor (if/switch/ternary/try-catch, AST-aware
 * negation, `exits` guard-clause flag, `// @business` fork/arm labels);
 * `switch` additionally folds fall-through case groups into one arm.
 */
import type { BranchPoint, BranchArm } from '@farsight/core';
import { walkTS, childrenOfType, type TSNode } from '../treesitter/harness.js';
import { capLabel, leadingBranchLabel, trailingBranchLabel, NEGATE_FLIP } from '../shared/labels.js';

const MAX_BRANCH_POINTS = 24; // per node — zero graph bloat beyond the field

/** See through `(…)` — if conditions in Java are always parenthesized. */
function unparen(n: TSNode): TSNode {
  let cur = n;
  while (cur.type === 'parenthesized_expression' && cur.namedChildren[0]) cur = cur.namedChildren[0]!;
  return cur;
}

const condText = (n: TSNode) => capLabel(unparen(n).text);

/** AST-aware negation: comparisons flip, `!x` unwraps, anything else wraps in `!(…)`. */
function negate(cond: TSNode): string {
  const t = unparen(cond);
  if (t.type === 'unary_expression' && t.text.startsWith('!')) {
    const operand = t.childForFieldName('operand');
    if (operand) return condText(operand);
  }
  if (t.type === 'binary_expression') {
    const op = t.childForFieldName('operator')?.text ?? '';
    const left = t.childForFieldName('left');
    const right = t.childForFieldName('right');
    if (NEGATE_FLIP[op] && left && right) {
      return `${condText(left)} ${NEGATE_FLIP[op]} ${condText(right)}`.slice(0, 120);
    }
  }
  return `!(${condText(t)})`.slice(0, 120);
}

/** Does the subtree gate flow — contain a call or object creation? Bare value ternaries are noise. */
function containsFlow(n: TSNode | null): boolean {
  let found = false;
  walkTS(n, (b) => {
    if (found) return false;
    if (b.type === 'method_invocation' || b.type === 'object_creation_expression' || b.type === 'throw_statement') { found = true; return false; }
  });
  return found;
}

/** Does an arm end in return/throw (its last top-level statement)? Guard-clause signal. */
function armExits(arm: TSNode): boolean {
  const stmts = arm.type === 'block' ? arm.namedChildren.filter((c): c is TSNode => !!c) : [arm];
  const last = stmts.at(-1);
  return !!last && (last.type === 'return_statement' || last.type === 'throw_statement');
}

const span = (n: TSNode) => ({ line: n.startPosition.row + 1, endLine: n.endPosition.row + 1 });

export function extractJavaBranches(body: TSNode | null, source: string): BranchPoint[] {
  const out: BranchPoint[] = [];
  const bpBiz = (stmtOffset: number, testOffset?: number): { business?: string } => {
    const b = leadingBranchLabel(source, stmtOffset)
      ?? (testOffset != null ? trailingBranchLabel(source, testOffset) : undefined);
    return b ? { business: b } : {};
  };
  const armBiz = (offset: number, leadingToo = false): { business?: string } => {
    const b = trailingBranchLabel(source, offset)
      ?? (leadingToo ? leadingBranchLabel(source, offset) : undefined);
    return b ? { business: b } : {};
  };

  walkTS(body, (n) => {
    if (out.length >= MAX_BRANCH_POINTS) return false;
    // nested types own their branches — a method body walk stops at their door
    if (n.type.endsWith('_declaration') && n.type !== 'local_variable_declaration') return false;

    if (n.type === 'if_statement') {
      const cond = n.childForFieldName('condition');
      const consequence = n.childForFieldName('consequence');
      if (!cond || !consequence) return;
      const alternative = n.childForFieldName('alternative');
      const arms: BranchArm[] = [{ label: 'then', requires: condText(cond), ...span(consequence), ...armBiz(consequence.startIndex) }];
      // else-if chains need no special case: this `else` arm spans the whole
      // alternate, so the nested if's own BranchPoint + containment give the conjunction
      if (alternative) arms.push({ label: 'else', requires: negate(cond), ...span(alternative), ...armBiz(alternative.startIndex) });
      const exits = armExits(consequence) || (!!alternative && armExits(alternative));
      out.push({
        kind: 'if', line: cond.startPosition.row + 1, condition: condText(cond),
        ...(exits ? { exits: true as const } : {}), ...bpBiz(n.startIndex, cond.startIndex), arms,
      });
      return;
    }

    if (n.type === 'switch_expression') {
      const cond = n.childForFieldName('condition');
      const blk = n.childForFieldName('body');
      if (!cond || !blk) return;
      const disc = condText(cond);
      const arms: BranchArm[] = [];
      let exits = false;
      // classic groups (labels + statements, fall-through folded) and arrow rules alike
      for (const arm of blk.namedChildren.filter((c): c is TSNode => !!c && (c.type === 'switch_block_statement_group' || c.type === 'switch_rule'))) {
        const labels = childrenOfType(arm, 'switch_label');
        if (!labels.length) continue;
        const caseVals = labels.flatMap((l) => l.namedChildren.filter((c): c is TSNode => !!c).map((c) => capLabel(c.text)));
        const isDefault = labels.some((l) => l.text.trim().startsWith('default'));
        const requires = [
          ...caseVals.map((v) => `${disc} == ${v}`),
          ...(isDefault ? ['no case matched'] : []),
        ].join(' || ').slice(0, 120);
        arms.push({
          label: caseVals.length ? `case ${caseVals.join(', ')}${isDefault ? ', default' : ''}` : 'default',
          requires: requires || 'no case matched',
          ...span(arm),
          ...armBiz(labels[0]!.startIndex, true), // trailing on `case X:` / `case X ->`, or a leading comment above it
        });
        if (armExits(arm.type === 'switch_rule' ? (arm.namedChildren.at(-1) ?? arm) : arm)) exits = true;
      }
      if (arms.length) out.push({
        kind: 'switch', line: cond.startPosition.row + 1, condition: disc,
        ...(exits ? { exits: true as const } : {}), ...bpBiz(n.startIndex, cond.startIndex), arms,
      });
      return;
    }

    if (n.type === 'ternary_expression') {
      const cond = n.childForFieldName('condition');
      const consequence = n.childForFieldName('consequence');
      const alternative = n.childForFieldName('alternative');
      if (!cond || !consequence || !alternative) return;
      if (!containsFlow(consequence) && !containsFlow(alternative)) return;
      out.push({
        kind: 'ternary', line: cond.startPosition.row + 1, condition: condText(cond),
        ...bpBiz(n.startIndex, cond.startIndex),
        arms: [
          { label: 'then', requires: condText(cond), ...span(consequence), ...armBiz(consequence.startIndex) },
          { label: 'else', requires: negate(cond), ...span(alternative), ...armBiz(alternative.startIndex) },
        ],
      });
      return;
    }

    if (n.type === 'try_statement' || n.type === 'try_with_resources_statement') {
      const blk = n.childForFieldName('body');
      const handler = childrenOfType(n, 'catch_clause')[0];
      if (!blk || !handler) return; // try/finally without a catch clause is not a fork
      const catchBody = handler.childForFieldName('body') ?? handler;
      const exits = armExits(blk) || armExits(catchBody);
      out.push({
        kind: 'catch', line: n.startPosition.row + 1, condition: 'exception in try',
        ...(exits ? { exits: true as const } : {}),
        ...bpBiz(n.startIndex), // try has no discriminant line — leading comment only
        arms: [
          { label: 'try', requires: 'no exception thrown', ...span(blk), ...armBiz(blk.startIndex) },
          { label: 'catch', requires: 'exception thrown', ...span(handler), ...armBiz(handler.startIndex) },
        ],
      });
      return;
    }
  });
  return out;
}
