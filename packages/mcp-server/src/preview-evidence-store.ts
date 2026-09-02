import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, writeFileSync } from "node:fs";
import { link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import * as z from "zod/v4";
import sharp from "sharp";

const MAX_PNG_BYTES = 64 * 1024 * 1024;
const MAX_PIXELS = 16_777_216;

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const connectionSchema = z
	.object({
		serverInstanceId: z.string().min(1),
		editorInstanceId: z.string().min(1),
		editorSessionId: z.string().min(1),
		connectionGeneration: z.number().int().positive(),
	})
	.strict();
const saveReceiptSchema = z
	.object({
		status: z.enum(["saved", "replayed"]),
		receiptId: z.string().min(1),
		operationId: z.string().min(1),
		projectId: z.string().min(1),
		sceneId: z.string().min(1),
		revision: z.number().int().nonnegative(),
		contentHash: digestSchema,
		persistedAt: z.iso.datetime({ offset: true }),
		completedAt: z.iso.datetime({ offset: true }),
		storageSchemaVersion: z.number().int().positive(),
		writeVersion: z.number().int().positive(),
		reloadVerified: z.literal(true),
		readbackContentHash: digestSchema,
	})
	.strict()
	.refine(
		(value) => value.contentHash === value.readbackContentHash,
		"save receipt readback hash mismatch",
	);
const requestedTimeSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("frame-index"),
			frameIndex: z.number().int().nonnegative(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("media-time"),
			ticks: z.number().int().nonnegative(),
			rounding: z.enum(["exact", "floor", "nearest", "ceil"]),
		})
		.strict(),
]);
const rendererSchema = z
	.object({
		provider: z.literal("opencut-web-renderer"),
		pipeline: z.literal("editor-native-exact-frame"),
		compositor: z.literal("opencut-wasm-webgl"),
		browser: z.string().min(1),
		encoder: z.literal("browser-canvas-png"),
		bridgeProtocolVersion: z.literal(2),
		mcpBuild: z.string().min(1),
		wasmPackageVersion: z.string().min(1),
		renderSpecFingerprint: digestSchema,
		capabilityHash: digestSchema,
		executionIdentity: connectionSchema,
	})
	.strict();
const fontReadinessSchema = z
	.object({
		status: z.literal("ready"),
		families: z.array(z.string()),
		descriptors: z.array(
			z
				.object({
					family: z.string().min(1),
					style: z.string().min(1),
					weight: z.string().min(1),
					stretch: z.string().min(1),
					css: z.string().min(1),
					identitySha256: digestSchema,
					matchedFaceIdentities: z.array(digestSchema).min(1),
					matchedFaces: z
						.array(
							z
								.object({
									provenance: z.enum([
										"font-face-set",
										"system-local-font-face",
									]),
									family: z.string().min(1),
									style: z.string().min(1),
									weight: z.string().min(1),
									stretch: z.string().min(1),
									unicodeRange: z.string(),
									featureSettings: z.string(),
									display: z.string(),
									identitySha256: digestSchema,
								})
								.strict(),
						)
						.min(1),
				})
				.strict(),
		),
		descriptorsSha256: digestSchema,
	})
	.strict();
const editorStateSchema = z
	.object({
		unchanged: z.literal(true),
		playheadTicks: z.number().int(),
		isPlaying: z.boolean(),
		selectionFingerprint: z.string(),
		canUndo: z.boolean(),
		canRedo: z.boolean(),
	})
	.strict();
const sourceVerificationSchema = z
	.object({
		revisionBefore: z.number().int().nonnegative(),
		revisionAfter: z.number().int().nonnegative(),
		contentHashBefore: digestSchema,
		contentHashAfter: digestSchema,
	})
	.strict()
	.refine(
		(value) =>
			value.revisionBefore === value.revisionAfter &&
			value.contentHashBefore === value.contentHashAfter,
		"render source changed during capture",
	);
const previewReceiptObjectSchema = z
	.object({
		schemaVersion: z.literal(2),
		receiptId: z.string().min(1).max(512),
		operationId: z.string().min(1).max(256),
		inputFingerprint: digestSchema,
		createdAt: z.iso.datetime({ offset: true }),
		projectId: z.string().min(1),
		sceneId: z.string().min(1),
		revision: z.number().int().nonnegative(),
		contentHash: digestSchema,
		writeVersion: z.number().int().positive(),
		saveReceiptId: z.string().min(1),
		saveReceiptOperationId: z.string().min(1).max(256),
		connectionIdentity: connectionSchema,
		requestedTime: requestedTimeSchema,
		requestedTicks: z.number().int().nonnegative(),
		resolvedTicks: z.number().int().nonnegative(),
		frameIndex: z.number().int().nonnegative(),
		fps: z
			.object({
				numerator: z.number().int().positive(),
				denominator: z.number().int().positive(),
			})
			.strict(),
		ticksPerFrame: z.number().int().positive(),
		rounding: z.enum(["exact", "floor", "nearest", "ceil"]),
		artifact: z
			.object({
				artifactId: digestSchema,
				path: z.string().min(1),
				mimeType: z.literal("image/png"),
				bytes: z.number().int().positive(),
				sha256: digestSchema,
				width: z.number().int().positive(),
				height: z.number().int().positive(),
				pixelRgbaSha256: digestSchema,
				colorSpace: z.literal("srgb"),
				alphaMode: z.literal("straight"),
			})
			.strict(),
		saveReceipt: saveReceiptSchema,
		renderer: rendererSchema,
		fontReadiness: fontReadinessSchema,
		editorState: editorStateSchema,
		sourceVerification: sourceVerificationSchema,
		operationLedgerId: z.string().min(1),
	})
	.strict();

const previewReceiptSchema = previewReceiptObjectSchema.superRefine(
	validatePreviewReceiptBindings,
);

function validatePreviewReceiptBindings(
	value: z.infer<typeof previewReceiptObjectSchema>,
	context: z.RefinementCtx<z.infer<typeof previewReceiptObjectSchema>>,
): void {
	if (
		value.saveReceipt.receiptId !== value.saveReceiptId ||
		value.saveReceipt.operationId !== value.saveReceiptOperationId ||
		value.saveReceipt.projectId !== value.projectId ||
		value.saveReceipt.contentHash !== value.contentHash ||
		value.saveReceipt.readbackContentHash !== value.contentHash ||
		value.saveReceipt.writeVersion !== value.writeVersion
	) {
		context.addIssue({
			code: "custom",
			path: ["saveReceipt"],
			message: "save receipt does not match preview source binding",
			input: value,
		});
	}
	if (
		value.sourceVerification.revisionBefore !== value.revision ||
		value.sourceVerification.revisionAfter !== value.revision ||
		value.sourceVerification.contentHashBefore !== value.contentHash ||
		value.sourceVerification.contentHashAfter !== value.contentHash
	) {
		context.addIssue({
			code: "custom",
			path: ["sourceVerification"],
			message: "source verification does not match preview source binding",
			input: value,
		});
	}
	if (
		!connectionIdentitiesEqual(
			value.renderer.executionIdentity,
			value.connectionIdentity,
		)
	) {
		context.addIssue({
			code: "custom",
			path: ["renderer", "executionIdentity"],
			message: "renderer execution identity does not match bridge affinity",
			input: value,
		});
	}
	if (
		value.artifact.artifactId !== value.artifact.sha256 ||
		value.resolvedTicks !== value.frameIndex * value.ticksPerFrame ||
		(value.requestedTime.kind === "frame-index" &&
			(value.requestedTime.frameIndex !== value.frameIndex ||
				value.requestedTicks !== value.resolvedTicks ||
				value.rounding !== "exact")) ||
		(value.requestedTime.kind === "media-time" &&
			(value.requestedTime.ticks !== value.requestedTicks ||
				value.requestedTime.rounding !== value.rounding))
	) {
		context.addIssue({
			code: "custom",
			message:
				"artifact or requested-time evidence is cross-field inconsistent",
			input: value,
		});
	}
	const expectedFamilies = [
		...new Set(value.fontReadiness.descriptors.map(({ family }) => family)),
	].sort();
	const descriptorBindingsValid = value.fontReadiness.descriptors.every(
		({
			identitySha256,
			matchedFaceIdentities,
			matchedFaces,
			...descriptor
		}) => {
			const matchedFacesValid = matchedFaces.every(
				({ identitySha256: faceIdentity, ...face }) =>
					faceIdentity === sha256Json(face) &&
					fontFamiliesEqual(face.family, descriptor.family) &&
					normalizeFontStyle(face.style) ===
						normalizeFontStyle(descriptor.style) &&
					normalizeFontWeight(face.weight) ===
						normalizeFontWeight(descriptor.weight) &&
					normalizeFontStretch(face.stretch) ===
						normalizeFontStretch(descriptor.stretch),
			);
			const expectedFaceIdentities = matchedFaces
				.map(({ identitySha256: faceIdentity }) => faceIdentity)
				.sort();
			return (
				identitySha256 === sha256Json(descriptor) &&
				matchedFacesValid &&
				JSON.stringify(matchedFaceIdentities) ===
					JSON.stringify(expectedFaceIdentities)
			);
		},
	);
	if (
		JSON.stringify(value.fontReadiness.families) !==
			JSON.stringify(expectedFamilies) ||
		!descriptorBindingsValid ||
		value.fontReadiness.descriptorsSha256 !==
			sha256Json(value.fontReadiness.descriptors)
	) {
		context.addIssue({
			code: "custom",
			path: ["fontReadiness"],
			message: "font readiness descriptor identities are inconsistent",
			input: value,
		});
	}
}

function connectionIdentitiesEqual(
	left: z.infer<typeof connectionSchema>,
	right: z.infer<typeof connectionSchema>,
): boolean {
	return (
		left.serverInstanceId === right.serverInstanceId &&
		left.editorInstanceId === right.editorInstanceId &&
		left.editorSessionId === right.editorSessionId &&
		left.connectionGeneration === right.connectionGeneration
	);
}

function sha256Json(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function fontFamiliesEqual(left: string, right: string): boolean {
	return normalizeFontFamily(left) === normalizeFontFamily(right);
}

function normalizeFontFamily(value: string): string {
	return value
		.trim()
		.replace(/^['"]|['"]$/g, "")
		.toLocaleLowerCase();
}

function normalizeFontStyle(value: string): string {
	return value.trim().toLocaleLowerCase() || "normal";
}

function normalizeFontWeight(value: string): string {
	const normalized = value.trim().toLocaleLowerCase();
	if (normalized === "normal") return "400";
	if (normalized === "bold") return "700";
	return normalized;
}

function normalizeFontStretch(value: string): string {
	const normalized = value.trim().toLocaleLowerCase();
	const named: Record<string, string> = {
		"ultra-condensed": "50%",
		"extra-condensed": "62.5%",
		condensed: "75%",
		"semi-condensed": "87.5%",
		normal: "100%",
		"semi-expanded": "112.5%",
		expanded: "125%",
		"extra-expanded": "150%",
		"ultra-expanded": "200%",
	};
	return named[normalized] ?? normalized;
}

export type PreviewFrameReceipt = z.infer<typeof previewReceiptSchema>;

type UploadRow = {
	operation_id: string;
	sha256: string;
	path: string;
	bytes: number;
	width: number;
	height: number;
	pixel_rgba_sha256: string;
};

export class PreviewEvidenceIntegrityError extends Error {
	readonly code = "PREVIEW_ARTIFACT_INTEGRITY_FAILED";
	constructor(message: string) {
		super(message);
		this.name = "PreviewEvidenceIntegrityError";
	}
}

export class PreviewEvidenceStore {
	readonly directory: string;
	readonly databasePath: string;
	private database: Database | null = null;
	private readinessPromise: Promise<void> | null = null;
	private tickets = new Map<
		string,
		{ operationId: string; width: number; height: number; expiresAt: number }
	>();

	constructor(
		directory: string,
		private port: number,
	) {
		this.directory = resolve(directory);
		this.databasePath = join(this.directory, "preview-evidence.sqlite");
	}

	async readiness(): Promise<void> {
		if (this.database) return;
		if (!this.readinessPromise) {
			this.readinessPromise = this.initialize().catch((error) => {
				this.readinessPromise = null;
				throw error;
			});
		}
		await this.readinessPromise;
	}

	private async initialize(): Promise<void> {
		await mkdir(join(this.directory, "artifacts"), { recursive: true });
		const database = new Database(this.databasePath, {
			create: true,
			strict: true,
		});
		try {
			database.exec("PRAGMA busy_timeout=5000");
			await enableWal(database);
			database.exec("PRAGMA synchronous=FULL");
			database.exec("PRAGMA foreign_keys=ON");
			await withImmediate(database, () => {
				const version = Number(
					(
						database.query("PRAGMA user_version").get() as {
							user_version: number;
						}
					).user_version,
				);
				if (version !== 0 && version !== 2)
					throw new Error(
						`unsupported preview evidence schema version: ${version}`,
					);
				database.exec(`
			CREATE TABLE IF NOT EXISTS preview_uploads (
				operation_id TEXT PRIMARY KEY,
				sha256 TEXT NOT NULL,
				path TEXT NOT NULL,
				bytes INTEGER NOT NULL,
				width INTEGER NOT NULL,
				height INTEGER NOT NULL,
				pixel_rgba_sha256 TEXT NOT NULL,
				created_at TEXT NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS preview_receipts (
				receipt_id TEXT PRIMARY KEY,
				operation_id TEXT NOT NULL UNIQUE,
				project_id TEXT NOT NULL,
				scene_id TEXT NOT NULL,
				created_at TEXT NOT NULL,
				receipt_json TEXT NOT NULL,
				receipt_checksum TEXT NOT NULL,
				FOREIGN KEY(operation_id) REFERENCES preview_uploads(operation_id)
			) STRICT;
			CREATE INDEX IF NOT EXISTS preview_receipts_source ON preview_receipts(project_id, scene_id, created_at DESC, receipt_id DESC);
		`);
				database.exec("PRAGMA user_version=2");
				pauseForCrashTest("after-schema-ddl");
			});
		} catch (error) {
			database.close();
			throw error;
		}
		await syncDirectory(this.directory);
		const journal = database.query("PRAGMA journal_mode").get() as {
			journal_mode: string;
		};
		const synchronous = database.query("PRAGMA synchronous").get() as {
			synchronous: number;
		};
		const foreignKeys = database.query("PRAGMA foreign_keys").get() as {
			foreign_keys: number;
		};
		const integrity = database.query("PRAGMA quick_check").get() as {
			quick_check: string;
		};
		if (
			journal.journal_mode.toLowerCase() !== "wal" ||
			synchronous.synchronous !== 2 ||
			foreignKeys.foreign_keys !== 1 ||
			integrity.quick_check !== "ok"
		) {
			database.close();
			throw new Error(
				"preview evidence SQLite durability or integrity preflight failed",
			);
		}
		this.database = database;
	}

	createTicket(
		operationId: string,
		width: number,
		height: number,
	): { url: string } {
		this.removeExpiredTickets();
		const id = randomBytes(32).toString("hex");
		this.tickets.set(id, {
			operationId,
			width,
			height,
			expiresAt: Date.now() + 30 * 60_000,
		});
		return { url: `http://127.0.0.1:${this.port}/preview/${id}` };
	}

	hasTicket(id: string): boolean {
		this.removeExpiredTickets();
		return this.tickets.has(id);
	}

	async receive(
		id: string,
		request: Request,
	): Promise<{ bytesWritten: number; sha256: string }> {
		await this.readiness();
		this.removeExpiredTickets();
		const ticket = this.tickets.get(id);
		if (!ticket) throw new Error("expired or invalid preview ticket");
		this.tickets.delete(id);
		if (request.headers.get("content-type")?.split(";", 1)[0] !== "image/png") {
			throw new Error("preview artifact must use image/png");
		}
		const declaredBytes = Number(request.headers.get("content-length"));
		if (Number.isFinite(declaredBytes) && declaredBytes > MAX_PNG_BYTES)
			throw new Error("preview PNG exceeds the 67108864-byte upload limit");
		const bytes = Buffer.from(await request.arrayBuffer());
		if (bytes.byteLength === 0 || bytes.byteLength > MAX_PNG_BYTES)
			throw new Error("preview PNG body is empty or exceeds the upload limit");
		const decoded = await decodePng(bytes);
		if (decoded.width !== ticket.width || decoded.height !== ticket.height) {
			throw new Error("PNG dimensions do not match the preview ticket");
		}
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const artifactPath = join(this.directory, "artifacts", `${sha256}.png`);
		await publishAtomic(artifactPath, bytes);
		pauseForCrashTest("after-artifact-publication");
		await withImmediate(this.requireDatabase(), () =>
			this.requireDatabase()
				.query(
					`INSERT INTO preview_uploads(operation_id, sha256, path, bytes, width, height, pixel_rgba_sha256, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(operation_id) DO UPDATE SET
				sha256=excluded.sha256, path=excluded.path, bytes=excluded.bytes,
				width=excluded.width, height=excluded.height, pixel_rgba_sha256=excluded.pixel_rgba_sha256
				WHERE preview_uploads.sha256=excluded.sha256`,
				)
				.run(
					ticket.operationId,
					sha256,
					artifactPath,
					bytes.byteLength,
					decoded.width,
					decoded.height,
					decoded.pixelRgbaSha256,
					new Date().toISOString(),
				),
		);
		const upload = this.upload(ticket.operationId);
		if (!upload || upload.sha256 !== sha256)
			throw new Error("operation already owns a different preview artifact");
		return { bytesWritten: bytes.byteLength, sha256 };
	}

	async write(receipt: PreviewFrameReceipt): Promise<PreviewFrameReceipt> {
		await this.readiness();
		const parsed = previewReceiptSchema.parse(receipt);
		const upload = this.upload(parsed.operationId);
		if (
			!upload ||
			upload.sha256 !== parsed.artifact.sha256 ||
			upload.path !== parsed.artifact.path ||
			upload.bytes !== parsed.artifact.bytes
		) {
			throw new PreviewEvidenceIntegrityError(
				"receipt does not match the atomically published PNG",
			);
		}
		const receiptJson = JSON.stringify(parsed);
		const receiptChecksum = createHash("sha256")
			.update(receiptJson)
			.digest("hex");
		let prior: PreviewFrameReceipt | null = null;
		const database = this.requireDatabase();
		await withImmediate(database, () => {
			const row = database
				.query(
					"SELECT receipt_json, receipt_checksum FROM preview_receipts WHERE operation_id=?",
				)
				.get(parsed.operationId) as {
				receipt_json: string;
				receipt_checksum: string;
			} | null;
			if (row) {
				prior = parseCheckedReceipt(row);
				if (prior.inputFingerprint !== parsed.inputFingerprint) {
					throw new Error(
						"operationId was already used for a different preview receipt",
					);
				}
				return;
			}
			database
				.query(
					"INSERT INTO preview_receipts(receipt_id, operation_id, project_id, scene_id, created_at, receipt_json, receipt_checksum) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					parsed.receiptId,
					parsed.operationId,
					parsed.projectId,
					parsed.sceneId,
					parsed.createdAt,
					receiptJson,
					receiptChecksum,
				);
		});
		await syncDirectory(this.directory);
		if (prior) return this.verifyReceipt(prior);
		return this.get(parsed.receiptId).then((value) => value!);
	}

	async uploadIdentity(operationId: string): Promise<UploadRow | null> {
		await this.readiness();
		return this.upload(operationId);
	}

	async get(receiptId: string): Promise<PreviewFrameReceipt | null> {
		await this.readiness();
		const row = this.requireDatabase()
			.query(
				"SELECT receipt_json, receipt_checksum FROM preview_receipts WHERE receipt_id=?",
			)
			.get(receiptId) as {
			receipt_json: string;
			receipt_checksum: string;
		} | null;
		return row ? this.verifyReceipt(parseCheckedReceipt(row)) : null;
	}

	async getByOperation(
		operationId: string,
	): Promise<PreviewFrameReceipt | null> {
		await this.readiness();
		const row = this.requireDatabase()
			.query(
				"SELECT receipt_json, receipt_checksum FROM preview_receipts WHERE operation_id=?",
			)
			.get(operationId) as {
			receipt_json: string;
			receipt_checksum: string;
		} | null;
		return row ? this.verifyReceipt(parseCheckedReceipt(row)) : null;
	}

	async list(input: {
		projectId?: string;
		sceneId?: string;
		limit: number;
		cursor?: string;
	}) {
		await this.readiness();
		if (input.cursor && input.cursor.length > 512)
			throw new Error("preview receipt cursor exceeds the 512-character limit");
		const database = this.requireDatabase();
		const conditions: string[] = [];
		const values: Array<string | number> = [];
		if (input.projectId) {
			conditions.push("project_id=?");
			values.push(input.projectId);
		}
		if (input.sceneId) {
			conditions.push("scene_id=?");
			values.push(input.sceneId);
		}
		if (input.cursor) {
			const cursor = database
				.query(
					"SELECT project_id, scene_id, created_at, receipt_id FROM preview_receipts WHERE receipt_id=?",
				)
				.get(input.cursor) as {
				project_id: string;
				scene_id: string;
				created_at: string;
				receipt_id: string;
			} | null;
			if (
				!cursor ||
				(input.projectId && cursor.project_id !== input.projectId) ||
				(input.sceneId && cursor.scene_id !== input.sceneId)
			) {
				throw new Error("unknown preview receipt cursor");
			}
			conditions.push(
				"(created_at < ? OR (created_at = ? AND receipt_id < ?))",
			);
			values.push(cursor.created_at, cursor.created_at, cursor.receipt_id);
		}
		const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
		const rows = database
			.query(
				`SELECT receipt_json, receipt_checksum FROM preview_receipts ${where} ORDER BY created_at DESC, receipt_id DESC LIMIT ?`,
			)
			.all(...values, input.limit + 1) as Array<{
			receipt_json: string;
			receipt_checksum: string;
		}>;
		const parsed = rows.map(parseCheckedReceipt);
		const selected = parsed.slice(0, input.limit);
		const receipts = [];
		for (const receipt of selected)
			receipts.push(await this.verifyReceipt(receipt));
		return {
			receipts,
			nextCursor:
				parsed.length > input.limit
					? (selected.at(-1)?.receiptId ?? null)
					: null,
		};
	}

	close(): void {
		this.database?.close();
		this.database = null;
		this.readinessPromise = null;
	}

	private async verifyReceipt(
		receipt: PreviewFrameReceipt,
	): Promise<PreviewFrameReceipt> {
		const info = await stat(receipt.artifact.path).catch(() => null);
		if (!info?.isFile() || info.size !== receipt.artifact.bytes)
			throw new PreviewEvidenceIntegrityError(
				"preview artifact is missing or its byte count changed",
			);
		const sha256 = await hashFile(receipt.artifact.path);
		if (
			sha256 !== receipt.artifact.sha256 ||
			resolve(receipt.artifact.path) !==
				resolve(join(this.directory, "artifacts", `${sha256}.png`))
		) {
			throw new PreviewEvidenceIntegrityError(
				"preview artifact SHA-256 verification failed",
			);
		}
		const decoded = await decodePng(await readFile(receipt.artifact.path));
		if (
			decoded.width !== receipt.artifact.width ||
			decoded.height !== receipt.artifact.height ||
			decoded.pixelRgbaSha256 !== receipt.artifact.pixelRgbaSha256
		)
			throw new PreviewEvidenceIntegrityError(
				"preview artifact dimensions changed",
			);
		return receipt;
	}

	private upload(operationId: string): UploadRow | null {
		return this.requireDatabase()
			.query(
				"SELECT operation_id, sha256, path, bytes, width, height, pixel_rgba_sha256 FROM preview_uploads WHERE operation_id=?",
			)
			.get(operationId) as UploadRow | null;
	}

	private requireDatabase(): Database {
		if (!this.database) throw new Error("preview evidence store is not ready");
		return this.database;
	}

	private removeExpiredTickets(): void {
		const now = Date.now();
		for (const [id, ticket] of this.tickets)
			if (ticket.expiresAt <= now) this.tickets.delete(id);
	}
}

async function publishAtomic(path: string, bytes: Buffer): Promise<void> {
	const temp = join(
		dirname(path),
		`.${basename(path)}.${randomBytes(12).toString("hex")}.tmp`,
	);
	const handle = await open(temp, "wx");
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await link(temp, path).catch(async (error) => {
			const existing = await readFile(path).catch(() => null);
			if (!existing?.equals(bytes)) throw error;
		});
		await syncDirectory(dirname(path));
	} finally {
		await unlink(temp).catch(() => undefined);
		await syncDirectory(dirname(path));
	}
	const published = await readFile(path);
	if (!published.equals(bytes))
		throw new PreviewEvidenceIntegrityError(
			"atomic PNG publication verification failed",
		);
}

function parseCheckedReceipt(row: {
	receipt_json: string;
	receipt_checksum: string;
}): PreviewFrameReceipt {
	const checksum = createHash("sha256").update(row.receipt_json).digest("hex");
	if (checksum !== row.receipt_checksum)
		throw new PreviewEvidenceIntegrityError(
			"preview receipt checksum verification failed",
		);
	return previewReceiptSchema.parse(JSON.parse(row.receipt_json));
}

async function withImmediate<T>(database: Database, work: () => T): Promise<T> {
	const deadline = Date.now() + 10_000;
	while (true) {
		try {
			database.exec("BEGIN IMMEDIATE");
			break;
		} catch (error) {
			if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
			await Bun.sleep(10);
		}
	}
	try {
		const result = work();
		database.exec("COMMIT");
		return result;
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

async function enableWal(database: Database): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (true) {
		try {
			const mode = database.query("PRAGMA journal_mode=WAL").get() as {
				journal_mode: string;
			};
			if (mode.journal_mode.toLocaleLowerCase() !== "wal") {
				throw new Error("preview evidence store could not enable WAL mode");
			}
			return;
		} catch (error) {
			if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
			await Bun.sleep(10);
		}
	}
}

function isSqliteBusy(error: unknown): boolean {
	return (
		(error as { code?: unknown } | null)?.code === "SQLITE_BUSY" ||
		(error as { errno?: unknown } | null)?.errno === 5
	);
}

function pauseForCrashTest(
	point: "after-schema-ddl" | "after-artifact-publication",
): void {
	if (process.env.OPENCUT_PREVIEW_TEST_PAUSE !== point) return;
	const marker = process.env.OPENCUT_PREVIEW_TEST_MARKER;
	if (!marker) throw new Error("preview crash-test marker path is required");
	writeFileSync(marker, point);
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, "r").catch(() => null);
	if (!handle) return;
	try {
		await handle.sync().catch(() => undefined);
	} finally {
		await handle.close();
	}
}

async function decodePng(
	bytes: Buffer,
): Promise<{ width: number; height: number; pixelRgbaSha256: string }> {
	try {
		const image = sharp(bytes, {
			failOn: "error",
			limitInputPixels: MAX_PIXELS,
		});
		const metadata = await image.metadata();
		if (metadata.format !== "png" || !metadata.width || !metadata.height)
			throw new Error("decoded artifact is not PNG");
		const { data, info } = await image
			.toColourspace("srgb")
			.ensureAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true });
		if (
			info.channels !== 4 ||
			info.width !== metadata.width ||
			info.height !== metadata.height
		)
			throw new Error("decoded PNG is not canonical RGBA8");
		return {
			width: info.width,
			height: info.height,
			pixelRgbaSha256: createHash("sha256").update(data).digest("hex"),
		};
	} catch (error) {
		throw new PreviewEvidenceIntegrityError(
			`PNG decode or CRC validation failed: ${error instanceof Error ? error.message : "unknown decoder failure"}`,
		);
	}
}

function hashFile(path: string): Promise<string> {
	return new Promise((resolveHash, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolveHash(hash.digest("hex")));
	});
}
