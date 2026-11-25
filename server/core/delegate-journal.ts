import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ToolItem } from '../../shared/protocol';

type Attempt = NonNullable<ToolItem['delegateAttempt']>;
export type DelegateRecord = { key: string; row: string; delivery: string } & (
  { attempt: Attempt; unissued?: true } | { terminal: Pick<ToolItem, 'status' | 'delegateReport' | 'endedAt' | 'result'> }
);

/** Tiny synchronous commits at the native offer and quit boundaries. A sealed session writer
 * cannot swallow one. Close each transaction's connection so late quit callbacks remain usable. */
export class DelegateJournal {
  private file: string;
  constructor(dir: string) { this.file = path.join(dir, 'sessions', 'delegate-journal.sqlite'); }

  private use<T>(run: (db: DatabaseSync) => T): T {
    const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
    const db = new sqlite.DatabaseSync(this.file);
    try {
      db.exec('PRAGMA busy_timeout=250; CREATE TABLE IF NOT EXISTS records (chat TEXT, key TEXT, body TEXT, PRIMARY KEY(chat,key)) WITHOUT ROWID');
      return run(db);
    } finally { db.close(); }
  }

  save(chat: string, records: DelegateRecord[]) {
    this.use(db => {
      db.exec('BEGIN IMMEDIATE');
      const insert = db.prepare('INSERT OR REPLACE INTO records VALUES (?, ?, ?)');
      for (const record of records) insert.run(chat, record.key, JSON.stringify(record));
      db.exec('COMMIT');
    });
  }

  read(chat: string): DelegateRecord[] {
    if (!existsSync(this.file)) return [];
    return this.use(db => db.prepare('SELECT body FROM records WHERE chat=?').all(chat).map(r => JSON.parse(String(r.body))));
  }

  remove(chat: string) {
    if (existsSync(this.file)) this.use(db => db.prepare('DELETE FROM records WHERE chat=?').run(chat));
  }

  forget(chat: string, keys: string[]) {
    if (!keys.length || !existsSync(this.file)) return;
    this.use(db => {
      const drop = db.prepare('DELETE FROM records WHERE chat=? AND key=?');
      for (const key of keys) drop.run(chat, key);
    });
  }
}
