"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { EditorCore } from "@/core";
import { useEditor } from "@/editor/use-editor";
import { useKeybindingsListener } from "@/actions/use-keybindings";
import { useKeybindingsStore } from "@/actions/keybindings-store";
import { useTimelineStore } from "@/timeline/timeline-store";
import { useEditorActions } from "@/actions/use-editor-actions";
import { loadFontAtlas } from "@/fonts/google-fonts";
import {
	initializeGpuRenderer,
	isGpuAvailable,
} from "@/services/renderer/gpu-renderer";
import { AutomationBridgeClient, EditorAutomation } from "@/automation";

interface EditorProviderProps {
	projectId: string;
	children: React.ReactNode;
}

const AUTOMATION_BOOTSTRAP_PROJECT_ID = "__opencut_automation_bootstrap__";
let automationBridgeConfigPromise: Promise<AutomationBridgeConfig | null> | null =
	null;

interface AutomationBridgeConfig {
	port: string;
	token: string;
}

export function EditorProvider({ projectId, children }: EditorProviderProps) {
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const router = useRouter();
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const { setLoadingProject } = useKeybindingsStore();

	useEffect(() => {
		setLoadingProject(isLoading);
	}, [isLoading, setLoadingProject]);

	useEffect(() => {
		let cancelled = false;
		const editor = EditorCore.getInstance();

		const loadProject = async () => {
			try {
				setIsLoading(true);
				if (projectId === AUTOMATION_BOOTSTRAP_PROJECT_ID) {
					await editor.project.loadAllProjects();
					if (cancelled) return;
					const latestProjectId = editor.project.getSavedProjects()[0]?.id;
					const bootstrapProjectId =
						latestProjectId ??
						(await editor.project.createNewProject({
							name: "Automation Project",
						}));
					if (cancelled) return;
					router.replace(
						`/editor/${bootstrapProjectId}${window.location.search}`,
					);
					return;
				}
				await initializeGpuRenderer();
				editor.renderer.setDegraded(!isGpuAvailable());
				await editor.project.loadProject({ id: projectId });

				if (cancelled) return;

				setIsLoading(false);
				loadFontAtlas();
			} catch (err) {
				if (cancelled) return;

				const isNotFound =
					err instanceof Error &&
					(err.message.includes("not found") ||
						err.message.includes("does not exist"));

				if (isNotFound) {
					try {
						const newProjectId = await editor.project.createNewProject({
							name: "Untitled Project",
						});
						router.replace(`/editor/${newProjectId}${window.location.search}`);
					} catch (_createErr) {
						setError("Failed to create project");
						setIsLoading(false);
					}
				} else {
					const wasmPanic = (window as Window & { __wasmPanic?: string })
						.__wasmPanic;
					if (wasmPanic) {
						delete (window as Window & { __wasmPanic?: string }).__wasmPanic;
						setError(wasmPanic);
					} else {
						setError(
							err instanceof Error ? err.message : "Failed to load project",
						);
					}
					setIsLoading(false);
				}
			}
		};

		loadProject();

		return () => {
			cancelled = true;
		};
	}, [projectId, router]);

	if (error) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<p className="text-destructive text-sm">{error}</p>
				</div>
			</div>
		);
	}

	if (isLoading) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<Loader2 className="text-muted-foreground size-8 animate-spin" />
					<p className="text-muted-foreground text-sm">Loading project...</p>
				</div>
			</div>
		);
	}

	if (!activeProject) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<Loader2 className="text-muted-foreground size-8 animate-spin" />
					<p className="text-muted-foreground text-sm">Exiting project...</p>
				</div>
			</div>
		);
	}

	return (
		<>
			<EditorRuntimeBindings />
			{children}
		</>
	);
}

function EditorRuntimeBindings() {
	const editor = useEditor();
	const rippleEditingEnabled = useTimelineStore(
		(state) => state.rippleEditingEnabled,
	);

	useEffect(() => {
		editor.command.isRippleEnabled = rippleEditingEnabled;
	}, [editor, rippleEditingEnabled]);

	useEffect(() => {
		const handleBeforeUnload = (event: BeforeUnloadEvent) => {
			if (!editor.save.getIsDirty()) return;
			event.preventDefault();
			(event as unknown as { returnValue: string }).returnValue = "";
		};

		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => window.removeEventListener("beforeunload", handleBeforeUnload);
	}, [editor]);

	useEffect(() => {
		let stopped = false;
		let bridge: AutomationBridgeClient | null = null;
		void readAutomationBridgeConfig()
			.then((config) => {
				if (!config || stopped) return;
				bridge = new AutomationBridgeClient(new EditorAutomation(editor), {
					url: `ws://127.0.0.1:${config.port}/editor`,
					token: config.token,
					onActiveProjectChange: (projectId) => {
						window.history.replaceState(
							window.history.state,
							"",
							`/editor/${projectId}`,
						);
					},
				});
				bridge.start();
			})
			.catch((error) => {
				console.error(
					"Failed to bootstrap the OpenCut automation bridge",
					error,
				);
			});
		return () => {
			stopped = true;
			bridge?.stop();
		};
	}, [editor]);

	useEditorActions();
	useKeybindingsListener();
	return null;
}

function readAutomationBridgeConfig(): Promise<AutomationBridgeConfig | null> {
	automationBridgeConfigPromise ??= loadAutomationBridgeConfig();
	return automationBridgeConfigPromise;
}

async function loadAutomationBridgeConfig(): Promise<AutomationBridgeConfig | null> {
	const url = new URL(window.location.href);
	const bootstrap = url.searchParams.get("automationBootstrap");
	const queryPort = url.searchParams.get("automationBridgePort");
	if (bootstrap) {
		const port = queryPort ?? "32191";
		if (!/^\d+$/.test(port)) throw new Error("Invalid automation bridge port");
		url.searchParams.delete("automationBootstrap");
		url.searchParams.delete("automationBridgePort");
		window.history.replaceState(
			window.history.state,
			"",
			`${url.pathname}${url.search}${url.hash}`,
		);
		const response = await fetch(
			`http://127.0.0.1:${port}/bootstrap/${encodeURIComponent(bootstrap)}`,
			{ cache: "no-store" },
		);
		if (!response.ok) {
			throw new Error(
				`Automation bootstrap failed with HTTP ${response.status}`,
			);
		}
		const config: unknown = await response.json();
		if (!isAutomationBridgeConfig(config)) {
			throw new Error("Automation bootstrap returned an invalid configuration");
		}
		return { port: String(config.port), token: config.token };
	}

	const token = process.env.NEXT_PUBLIC_OPENCUT_BRIDGE_TOKEN;
	if (!token) return null;
	return {
		port: process.env.NEXT_PUBLIC_OPENCUT_BRIDGE_PORT ?? "32191",
		token,
	};
}

function isAutomationBridgeConfig(
	value: unknown,
): value is { port: number; token: string } {
	return (
		value !== null &&
		typeof value === "object" &&
		"port" in value &&
		typeof value.port === "number" &&
		"token" in value &&
		typeof value.token === "string" &&
		value.token.length >= 32
	);
}
