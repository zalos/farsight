import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare } from '../ast-equivalence.mjs';

const same = [
  ['quotes', 'const x = "hello";', "const x = 'hello';"],
  ['trailing comma', 'const x = [1, 2];', 'const x = [1, 2,];'],
  ['hexadecimal', 'const x = 0x1F;', 'const x = 31;'],
  ['regex flag order', 'const x = /a/gi;', 'const x = /a/ig;'],
  ['empty constructor arguments', 'new Foo;', 'new Foo();'],
  ['arrow parentheses', 'const f = x => x;', 'const f = (x) => x;'],
  ['template expression spacing', 'const x = `a${b+c}`;', 'const x = `a${ b + c }`;'],
  ['import spacing', "import{a}from'm'", "import { a } from 'm';"],
  ['stray semicolons', 'const x = 1;', ';const x = 1;;;'],
  ['numeric separators', 'const x = 1_000;', 'const x = 1000;'],
  ['logical OR regrouping', 'a || b || (c || d);', 'a || b || c || d;'],
  ['logical AND regrouping', '(a && b) && c;', 'a && (b && c);'],
  ['nullish regrouping', 'a ?? (b ?? c);', 'a ?? b ?? c;'],
];

const different = [
  ['equality operator', 'a == b;', 'a === b;'],
  ['operator grouping', 'a && b || c;', 'a && (b || c);'],
  ['optional-chain extent', '(a?.b).c;', 'a?.b.c;'],
  ['declaration kind', 'let x = 1;', 'const x = 1;'],
  ['template raw text', 'const x = `hello`;', 'const x = `world`;'],
  ['quoted property', "const x = { 'a': 1 };", 'const x = { a: 1 };'],
  ['comma expression', 'x = (1, 2);', 'x = 1, 2;'],
  ['automatic semicolon insertion', 'a\n(b)', 'a;\n(b)'],
  ['added braces', 'if (a) b();', 'if (a) { b(); }'],
  ['loop declaration kind', 'for (const x of xs) f(x);', 'for (let x of xs) f(x);'],
  ['mixed logical grouping', '(a || b) && c;', 'a || b && c;'],
  ['addition grouping', 'a + (b + c);', 'a + b + c;'],
  ['logical operator boundary', 'a || (b && c);', '(a || b) && c;'],
  ['nullish operator boundary', 'a ?? (b || c);', '(a ?? b) || c;'],
  ['logical operand order', 'a || b || c;', 'a || c || b;'],
  ['subtraction grouping', '(a - b) - c;', 'a - (b - c);'],
  ['multiplication grouping', 'a * (b * c);', 'a * b * c;'],
  ['comparison grouping', '(a < b) < c;', 'a < (b < c);'],
  ['bitwise OR grouping', 'a | (b | c);', 'a | b | c;'],
  ['bitwise AND grouping', 'a & (b & c);', 'a & b & c;'],
  ['bitwise XOR grouping', 'a ^ (b ^ c);', 'a ^ b ^ c;'],
];

for (const [name, before, after] of same) {
  test(`formatting preserves the program: ${name}`, () => {
    assert.deepEqual(compare('fixture.ts', before, after), []);
  });
}

for (const [name, before, after] of different) {
  test(`program change is refused: ${name}`, () => {
    assert.ok(compare('fixture.ts', before, after).some((problem) => problem.level === 'ast'));
  });
}

test('comments are compared separately from program shape', () => {
  const problems = compare('fixture.ts', '// before\nconst x = 1;', '// after\nconst x = 1;');
  assert.deepEqual(
    problems.map((problem) => problem.level),
    ['comment'],
  );
});

test('the CLI checks revisions, working-tree edits, file changes and strict comments', () => {
  const root = mkdtempSync(join(tmpdir(), 'farsight-ast-'));
  const script = fileURLToPath(new URL('../ast-equivalence.mjs', import.meta.url));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  const check = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
  try {
    git('init', '-b', 'fixture');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'dev@example.com');
    writeFileSync(join(root, 'fixture.ts'), '// before\nconst x = "hello";\n');
    git('add', 'fixture.ts');
    git('commit', '-m', 'test: AST fixture');
    writeFileSync(join(root, 'fixture.ts'), "// before\nconst x = 'hello';\n");
    assert.equal(check('HEAD').status, 0);
    git('add', 'fixture.ts');
    git('commit', '-m', 'style: AST fixture');
    assert.equal(check('HEAD~1', 'HEAD').status, 0);
    writeFileSync(join(root, 'fixture.ts'), "// after\nconst x = 'hello';\n");
    assert.equal(check('HEAD').status, 0);
    assert.equal(check('HEAD', '--strict-comments').status, 1);
    writeFileSync(join(root, 'fixture.ts'), "// before\nconst x = 'changed';\n");
    assert.equal(check('HEAD').status, 1);
    git('restore', 'fixture.ts');
    writeFileSync(join(root, 'added.ts'), 'export {};\n');
    git('add', 'added.ts');
    assert.equal(check('HEAD').status, 1);
    git('rm', '-f', 'added.ts');
    git('mv', 'fixture.ts', 'renamed.ts');
    assert.equal(check('HEAD').status, 1);
    git('rm', '-f', 'renamed.ts');
    assert.equal(check('HEAD').status, 1);
    assert.equal(check().status, 64);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
