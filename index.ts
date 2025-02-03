#!/usr/bin/env bun

import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { select } from "@inquirer/prompts";
import { $ } from "bun";

type SyncConfig = {
	name: string;
	description: string;
	pattern?: RegExp;
	sources: Array<{
		path: string;
		dest: string;
	}>;
	rsyncFlags: readonly string[];
};

const PATHS = {
	movies: "/Users/sk/Movies",
	footage: "/Users/sk/Movies/Footage",
	audio: "/Users/sk/Movies/Audio",
	photography: "/Users/sk/Dropbox/photography",
} as const;

const RSYNC_FLAGS = {
	copyNew: ["-av", "--progress"] as const,
	mirror: ["-av", "--delete", "--progress"] as const,
} as const;

const backupSources: SyncConfig["sources"] = [
	{
		path: `${PATHS.movies}/`,
		dest: "Video",
	},
	{
		path: `${PATHS.photography}/2024/`,
		dest: "Photography/2024",
	},
	{
		path: `${PATHS.photography}/2025/`,
		dest: "Photography/2025",
	},
	{
		path: `${PATHS.photography}/Capture One/`,
		dest: "Photography/Capture One",
	},
];

const SYNC_CONFIGS: SyncConfig[] = [
	{
		name: "Hot Backup",
		description: "Mirror backup of all media files",
		pattern: /^HOT_/,
		sources: backupSources,
		rsyncFlags: RSYNC_FLAGS.mirror,
	},
	{
		name: "Archive Backup",
		description: "Append-only backup of all media files",
		pattern: /^ARCHIVE_/,
		sources: backupSources,
		rsyncFlags: RSYNC_FLAGS.copyNew,
	},
	{
		name: "Sony FX3",
		description: "Import footage",
		sources: [
			{
				path: "/Volumes/Untitled/M4ROOT/CLIP/",
				dest: PATHS.footage,
			},
		],
		rsyncFlags: [
			...RSYNC_FLAGS.copyNew,
			"--include=*/",
			"--include=*.MP4",
			"--include=*.XML",
			"--exclude=*",
		],
	},
	{
		name: "DJI Osmo Pocket 3",
		description: "Import footage",
		sources: [
			{
				path: "/Volumes/Untitled/DCIM/DJI_001/",
				dest: PATHS.footage,
			},
		],
		rsyncFlags: [
			...RSYNC_FLAGS.copyNew,
			"--include=*/",
			"--include=*.MP4",
			"--include=*.WAV",
			"--exclude=*",
		],
	},
	// TODO: Add mic paths to copy audio
];

type SyncOperation = {
	name: string;
	config: SyncConfig;
	source: string;
};

async function findAvailableOperations(): Promise<SyncOperation[]> {
	const operations: SyncOperation[] = [];
	const volumes = await readdir("/Volumes");

	for (const config of SYNC_CONFIGS) {
		if (config.pattern) {
			const matches = volumes.filter((v) => config.pattern?.test(v));
			for (const drive of matches) {
				const drivePath = join("/Volumes", drive);
				const spaceAvailable = await getDriveAvailableSpace(drivePath);
				const formattedSpace = await formatSize(spaceAvailable);
				operations.push({
					name: `${drive} (${formattedSpace} free)`,
					config,
					source: drivePath,
				});
			}
			continue;
		}

		for (const source of config.sources) {
			try {
				await access(source.path);
				operations.push({
					name: config.name,
					config,
					source: source.path,
				});
				break;
			} catch {}
		}
	}

	return operations;
}

async function performSync(operation: SyncOperation) {
	for (const { path, dest } of operation.config.sources) {
		try {
			console.log(`\nSyncing ${path} to ${dest}`);

			const destPath = operation.config.pattern
				? `${operation.source}/${dest}`
				: dest;

			const command = [
				"rsync",
				...operation.config.rsyncFlags,
				path,
				`${destPath}/`,
			];

			const proc = Bun.spawn(command, {
				stdout: "pipe",
				stderr: "pipe",
			});

			const decoder = new TextDecoder();
			const reader = proc.stdout.getReader();

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				process.stdout.write(decoder.decode(value));
			}

			const exitCode = await proc.exited;
			if (exitCode !== 0) {
				throw new Error(`rsync failed with exit code ${exitCode}`);
			}
		} catch (error) {
			console.error(`Error syncing ${path}:`, error);
		}
	}
}

async function getDriveAvailableSpace(path: string): Promise<number> {
	const output = await $`df -k ${path} | tail -1 | awk '{print $4}'`.quiet();
	return Number.parseInt(output.stdout.toString().trim(), 10) * 1024;
}

async function formatSize(bytes: number): Promise<string> {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let size = bytes;
	let unitIndex = 0;

	while (size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024;
		unitIndex++;
	}

	return `${size.toFixed(2)} ${units[unitIndex]}`;
}

async function main() {
	try {
		console.log("Media Sync");

		const operations = await findAvailableOperations();
		if (operations.length === 0) {
			console.error("No available sync operations found");
			process.exit(1);
		}

		const selectedOperation = await select({
			message: "Select drive to sync",
			choices: operations.map((op) => ({
				name: `${op.name}`,
				value: op,
			})),
			theme: {
				helpMode: "never",
			},
		});

		console.log(`\nStarting ${selectedOperation.name}`);
		await performSync(selectedOperation);
		console.log("\nSync completed");
	} catch (error) {
		handleError(error);
	}
}

function handleGracefulExit() {
	console.log("\nSync cancelled. Exiting...");
	process.exit(0);
}

function handleError(error: unknown) {
	if (error instanceof Error && error.name === "ExitPromptError") {
		handleGracefulExit();
	} else {
		console.error("Error:", error);
		process.exit(1);
	}
}

// Handle Ctrl+C
process.on("SIGINT", handleGracefulExit);

// Handle unhandled errors
process.on("unhandledRejection", handleError);
process.on("uncaughtException", handleError);

main().catch(handleError);
