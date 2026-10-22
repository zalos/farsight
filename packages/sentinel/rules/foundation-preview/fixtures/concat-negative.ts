export const find = (id: string) => db.query("SELECT * FROM users WHERE id = $1", [id]);
export const label = "SELECT" + " is a word";
// "SELECT * FROM users WHERE id = " + id
