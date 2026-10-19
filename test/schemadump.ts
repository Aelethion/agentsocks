import { DatabaseSync } from "node:sqlite";

export interface SchemaDump {
  master: { type: string; name: string; tbl_name: string; sql: string | null }[];
  tables: Record<string, { cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[]>;
  rows: Record<string, Record<string, unknown>[]>;
}

export function dumpDatabase(path: string): SchemaDump {
  const db = new DatabaseSync(path);
  try {
    const master = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY rowid").all() as unknown as SchemaDump["master"];
    const dump: SchemaDump = { master, tables: {}, rows: {} };
    for (const { name } of master.filter((m) => m.type === "table")) {
      dump.tables[name] = db.prepare(`PRAGMA table_info(${name})`).all() as unknown as SchemaDump["tables"][string];
      dump.rows[name] = db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() as Record<string, unknown>[];
    }
    return JSON.parse(JSON.stringify(dump)) as SchemaDump;
  } finally {
    db.close();
  }
}

export function buildDatabase(path: string, sql: string | undefined): void {
  if (sql === undefined) return;
  const db = new DatabaseSync(path);
  db.exec(sql);
  db.close();
}
