export const find = (id: string) => db.query("SELECT * FROM users WHERE id = " + id);
export const drop = (name: string) => db.query(`DELETE FROM accounts WHERE name = ${name}`);
