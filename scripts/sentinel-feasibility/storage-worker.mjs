// Private child of the feasibility probe. IPC barriers replace timing-based lock races.
import { DatabaseSync } from 'node:sqlite';

let db;
let phase;
process.on('message', message => {
  try {
    if (message.type === 'open') {
      phase = 'open'; db = new DatabaseSync(message.path);
      db.exec('PRAGMA busy_timeout=250');
      process.send({ type: 'opened' });
    } else if (message.type === 'acquire') {
      phase = 'begin'; db.exec('BEGIN EXCLUSIVE');
      phase = 'update'; db.prepare('UPDATE owner_marker SET marker=?').run('uncommitted-owner');
      process.send({ type: 'acquired' });
    } else if (message.type === 'release') {
      db.exec('ROLLBACK');
      db.close();
      db = undefined;
      process.send({ type: 'released' }, () => process.disconnect());
    }
  } catch (error) {
    const busy = error.errcode === 5 || error.errcode === 6;
    try { db?.close(); } catch { /* Parent still owns bounded child cleanup. */ }
    process.send({ type: busy ? 'busy' : 'error', code: busy ? 'SQLITE_BUSY' : 'SQLITE_FAILURE', phase }, () => process.disconnect());
  }
});
process.on('disconnect', () => {
  try { db?.close(); } catch { /* Process exit releases its own descriptors. */ }
});
process.send({ type: 'ready' });
