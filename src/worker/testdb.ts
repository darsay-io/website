/**
 * A D1 stand-in for the test suite: real SQLite (`node:sqlite`) with the
 * repository's own migrations applied, behind the four D1 calls the
 * worker uses (prepare/bind, first, all, run, batch). Tests therefore run
 * the same SQL production does — a query the schema cannot answer fails
 * here first. `batch` is one transaction, as on D1.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(process.cwd(), "migrations");

function bindValue(v: unknown): SQLInputValue {
	if (v === undefined) return null;
	if (typeof v === "boolean") return v ? 1 : 0;
	return v as SQLInputValue;
}

export class TestStatement {
	private binds: unknown[] = [];
	constructor(
		private readonly db: TestD1,
		readonly sql: string,
	) {}
	bind(...args: unknown[]): this {
		this.binds = args;
		return this;
	}
	async first<T = Record<string, unknown>>(): Promise<T | null> {
		const row = this.db.raw.prepare(this.sql).get(...this.binds.map(bindValue));
		return (row as T | undefined) ?? null;
	}
	async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true }> {
		const results = this.db.raw.prepare(this.sql).all(...this.binds.map(bindValue)) as T[];
		return { results, success: true };
	}
	async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
		const res = this.db.raw.prepare(this.sql).run(...this.binds.map(bindValue));
		return { success: true, meta: { changes: Number(res.changes), last_row_id: Number(res.lastInsertRowid) } };
	}
}

export class TestD1 {
	readonly raw: DatabaseSync;

	constructor() {
		this.raw = new DatabaseSync(":memory:");
		this.raw.exec("PRAGMA foreign_keys = ON;");
		for (const f of readdirSync(MIGRATIONS).sort()) {
			if (f.endsWith(".sql")) this.raw.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
		}
	}

	prepare(sql: string): TestStatement {
		return new TestStatement(this, sql);
	}

	async batch(stmts: TestStatement[]) {
		this.raw.exec("BEGIN");
		try {
			const out = [];
			for (const s of stmts) out.push(await s.run());
			this.raw.exec("COMMIT");
			return out;
		} catch (err) {
			this.raw.exec("ROLLBACK");
			throw err;
		}
	}

	/** Test-side peeks and seeds; production code never calls these. */
	get<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): T | null {
		return (this.raw.prepare(sql).get(...binds.map(bindValue)) as T | undefined) ?? null;
	}
	rows<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): T[] {
		return this.raw.prepare(sql).all(...binds.map(bindValue)) as T[];
	}
	exec(sql: string, ...binds: unknown[]): void {
		this.raw.prepare(sql).run(...binds.map(bindValue));
	}
	meta(key: string): string | null {
		return this.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value ?? null;
	}
	setMeta(key: string, value: string): void {
		this.exec("UPDATE meta SET value = ? WHERE key = ?", value, key);
	}
}
