/**
 * Webhooks: a listener the board tells the moment rows move. One delivery
 * per commit per hook, carrying the audit events that commit produced
 * (filtered to the ones the hook asked for), signed with the hook's
 * secret. Deliveries are best-effort: the board records the last status
 * and never retries — the audit trail is the durable record, and a
 * listener that missed one can read it.
 *
 * A delivery never carries the board id: the receiver is a third party.
 */
import type { AuditAction, AuditEvent } from "./ledger.ts";

export const MAX_WEBHOOKS = 5;
export const MAX_WEBHOOK_URL = 500;
export const MAX_WEBHOOK_SECRET = 128;
const DELIVERY_TIMEOUT_MS = 10_000;

/** What a hook may subscribe to; `*` is all of them. */
export const WEBHOOK_EVENTS: readonly AuditAction[] = [
	"board.updated",
	"row.added",
	"row.updated",
	"row.dropped",
	"row.restored",
	"row.removed",
	"claim.reported",
	"claim.released",
	"catalog.imported",
];

export type WebhookRow = {
	id: string;
	board_id: string;
	url: string;
	events: string;
	secret: string;
	created: string;
	last_at: string | null;
	last_status: number | null;
};

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const LOCAL_SUFFIX = /\.(local|localhost|internal|home|lan|intranet)$/i;

/** An https URL on a public host. Loopback, private ranges, and IP literals are refused. */
export function validateWebhookUrl(raw: unknown): { ok: true; url: string } | { ok: false; error: string } {
	if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "url required" };
	if (raw.length > MAX_WEBHOOK_URL) return { ok: false, error: "url too long" };
	let u: URL;
	try {
		u = new URL(raw.trim());
	} catch {
		return { ok: false, error: "invalid url" };
	}
	if (u.protocol !== "https:") return { ok: false, error: "a webhook URL must be https" };
	if (u.username || u.password) return { ok: false, error: "invalid url" };
	const host = u.hostname.toLowerCase();
	if (host.startsWith("[") || IPV4.test(host)) return { ok: false, error: "a webhook URL needs a hostname, not an address" };
	if (!host.includes(".") || host === "localhost" || LOCAL_SUFFIX.test(host)) {
		return { ok: false, error: "a webhook URL must be reachable from the internet" };
	}
	u.hash = "";
	return { ok: true, url: u.toString() };
}

export function parseEvents(raw: unknown): { ok: true; events: string[] } | { ok: false; error: string } {
	if (raw === undefined || raw === null) return { ok: true, events: ["*"] };
	if (!Array.isArray(raw)) return { ok: false, error: "events must be an array" };
	if (raw.includes("*")) return { ok: true, events: ["*"] };
	const out: string[] = [];
	for (const ev of raw) {
		if (typeof ev !== "string" || !(WEBHOOK_EVENTS as readonly string[]).includes(ev)) {
			return { ok: false, error: "unknown event " + JSON.stringify(String(ev).slice(0, 30)) };
		}
		if (!out.includes(ev)) out.push(ev);
	}
	return { ok: true, events: out.length ? out : ["*"] };
}

export function eventsOf(hook: Pick<WebhookRow, "events">): string[] {
	try {
		const parsed = JSON.parse(hook.events) as unknown;
		return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === "string") : ["*"];
	} catch {
		return ["*"];
	}
}

export function webhookToApi(h: WebhookRow) {
	return { id: h.id, url: h.url, events: eventsOf(h), created: h.created, last_at: h.last_at, last_status: h.last_status };
}

function hex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newSecret(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return "whsec_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newWebhookId(): string {
	const bytes = new Uint8Array(6);
	crypto.getRandomValues(bytes);
	return "wh_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sign(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return "sha256=" + hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
}

export type Delivery = {
	board: { catalog_id: string; title: string; revision: number };
	actor: unknown;
	at: string;
	events: AuditEvent[];
};

function matching(hook: WebhookRow, events: AuditEvent[]): AuditEvent[] {
	const wanted = eventsOf(hook);
	if (wanted.includes("*")) return events;
	return events.filter((e) => wanted.includes(e.action));
}

export async function deliverOne(db: D1Database, hook: WebhookRow, delivery: Delivery): Promise<number> {
	const events = matching(hook, delivery.events);
	if (!events.length) return -1;
	const id = "dl_" + [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
	const body = JSON.stringify({
		id,
		at: delivery.at,
		board: delivery.board,
		actor: delivery.actor,
		events,
	});
	let status = 0;
	try {
		const res = await fetch(hook.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"user-agent": "darsay.io-webhooks/1 (+https://darsay.io/docs/board/agents/)",
				"x-darsay-delivery": id,
				"x-darsay-events": events.map((e) => e.action).join(","),
				"x-darsay-signature": await sign(hook.secret, body),
			},
			body,
			redirect: "manual",
			signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
		});
		status = res.status;
	} catch {
		status = 0;
	}
	try {
		await db.prepare("UPDATE webhooks SET last_at = ?, last_status = ? WHERE id = ?").bind(delivery.at, status, hook.id).run();
	} catch {
		/* the delivery happened; the bookkeeping can miss a beat */
	}
	return status;
}

export async function deliverAll(db: D1Database, hooks: WebhookRow[], delivery: Delivery): Promise<void> {
	await Promise.all(hooks.map((h) => deliverOne(db, h, delivery)));
}
