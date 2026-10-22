// Original synthetic TypeScript for the PR 18 path tests. None is a real application, and none is ever built or
// run: a test captures it, parses it with the public parser and reads the graph. getUser hands request input to a
// SQL string across three files; getCount reaches the same function with a constant. A call path cannot tell them
// apart; only flow evidence could.
export const PATHS_APP: Record<string, string> = {
  'package.json': '{ "name": "sentinel-paths-fixture", "private": true, "type": "module" }\n',
  'src/routes.ts': `import { findUser } from './service.js';
import { reportCount } from './reports.js';

export function getUser(req: { query: { id: string } }) {
  return findUser(req.query.id);
}

export function getCount() {
  return reportCount();
}
`,
  'src/service.ts': `import { query } from './db.js';

export function findUser(id: string) {
  return query(\`select * from users where id = '\${id}'\`);
}
`,
  'src/reports.ts': `import { query } from './db.js';

export function reportCount() {
  return query('select count(*) from reports');
}
`,
  'src/db.ts': `export function query(sql: string) {
  return sql.length;
}
`,
  'src/cycle.ts': `import { query } from './db.js';

export function ping(n: number): number {
  return n > 0 ? pong(n - 1) : 0;
}

export function pong(n: number): number {
  return n % 2 ? ping(n) : query('select 1');
}
`,
  'src/dynamic.ts': `const handlers: Record<string, () => void> = {};

export function flush() {
  return 0;
}

export function dispatch(name: string, obj: { run(): void }) {
  handlers[name]();
  obj.run();
}

export function pick() {
  return [flush];
}

export function logged() {
  console.log('logged');
}
`,
  'src/chain.ts': `export function a1() {
  return a2();
}

export function a2() {
  return a3();
}

export function a3() {
  return a4();
}

export function a4() {
  return 4;
}

export function hub() {
  return c1() + c2() + c3();
}

export function c1() {
  return 1;
}

export function c2() {
  return 2;
}

export function c3() {
  return 3;
}
`,
};
