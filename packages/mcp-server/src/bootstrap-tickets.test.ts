import { describe, expect, test } from "bun:test";
import { BootstrapTickets } from "./bootstrap-tickets";

describe("BootstrapTickets", () => {
	test("issues one-time tickets", () => {
		const tickets = new BootstrapTickets();
		const ticket = tickets.create();

		expect(ticket.id.length).toBeGreaterThan(32);
		expect(tickets.has(ticket.id)).toBe(true);
		expect(tickets.take(ticket.id)).toBe(true);
		expect(tickets.take(ticket.id)).toBe(false);
	});

	test("expires tickets", async () => {
		const tickets = new BootstrapTickets(1);
		const ticket = tickets.create();
		await Bun.sleep(5);
		expect(tickets.take(ticket.id)).toBe(false);
	});
});
