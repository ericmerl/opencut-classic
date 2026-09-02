import { randomBytes } from "node:crypto";

interface BootstrapTicket {
	expiresAt: number;
}

export class BootstrapTickets {
	private tickets = new Map<string, BootstrapTicket>();

	constructor(private ttlMs = 60_000) {}

	create(): { id: string; expiresAt: string } {
		this.removeExpired();
		const id = randomBytes(32).toString("base64url");
		const expiresAt = Date.now() + this.ttlMs;
		this.tickets.set(id, { expiresAt });
		return { id, expiresAt: new Date(expiresAt).toISOString() };
	}

	has(id: string): boolean {
		this.removeExpired();
		return this.tickets.has(id);
	}

	take(id: string): boolean {
		this.removeExpired();
		if (!this.tickets.has(id)) return false;
		this.tickets.delete(id);
		return true;
	}

	private removeExpired(): void {
		const now = Date.now();
		for (const [id, ticket] of this.tickets) {
			if (ticket.expiresAt <= now) this.tickets.delete(id);
		}
	}
}
