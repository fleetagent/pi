#!/usr/bin/env node

/**
 * Syncs all workspace package versions and local dependency ranges.
 *
 * By default this verifies lockstep versioning and syncs inter-package
 * dependency ranges. Pass --set x.y.z to set the root package and every
 * versioned workspace package to an explicit version first.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const args = process.argv.slice(2);
let explicitVersion;
let bumpType;

for (let index = 0; index < args.length; index++) {
	const arg = args[index];
	if (arg === "--set") {
		explicitVersion = args[++index];
		if (!explicitVersion || !SEMVER_RE.test(explicitVersion)) {
			console.error("Expected --set <x.y.z>");
			process.exit(1);
		}
		continue;
	}

	if (arg === "--bump") {
		bumpType = args[++index];
		if (!new Set(["major", "minor", "patch"]).has(bumpType)) {
			console.error("Expected --bump <major|minor|patch>");
			process.exit(1);
		}
		continue;
	}

	console.error(`Unknown argument: ${arg}`);
	process.exit(1);
}

if (explicitVersion && bumpType) {
	console.error("Use only one of --set or --bump.");
	process.exit(1);
}

function bumpVersion(version, type) {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
	if (!match) {
		console.error(`Can not bump non-semver version: ${version}`);
		process.exit(1);
	}

	let major = Number(match[1]);
	let minor = Number(match[2]);
	let patch = Number(match[3]);
	if (type === "major") {
		major++;
		minor = 0;
		patch = 0;
	} else if (type === "minor") {
		minor++;
		patch = 0;
	} else {
		patch++;
	}
	return `${major}.${minor}.${patch}`;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, data) {
	writeFileSync(path, `${JSON.stringify(data, null, "\t")}\n`);
}

function expandWorkspacePattern(pattern) {
	if (!pattern.includes("*")) {
		return existsSync(join(pattern, "package.json")) ? [pattern] : [];
	}

	const starIndex = pattern.indexOf("*");
	const beforeStar = pattern.slice(0, starIndex);
	const afterStar = pattern.slice(starIndex + 1);
	const baseDir = beforeStar.endsWith("/") ? beforeStar.slice(0, -1) : beforeStar;

	if (!existsSync(baseDir)) {
		return [];
	}

	return readdirSync(baseDir)
		.map((entry) => join(baseDir, entry, afterStar))
		.filter((path) => existsSync(path) && statSync(path).isDirectory())
		.filter((path) => existsSync(join(path, "package.json")));
}

function getWorkspacePackagePaths(rootPackage) {
	const workspaces = Array.isArray(rootPackage.workspaces)
		? rootPackage.workspaces
		: rootPackage.workspaces?.packages;

	if (!Array.isArray(workspaces)) {
		return [];
	}

	return [...new Set(workspaces.flatMap(expandWorkspacePattern))]
		.map((dir) => join(process.cwd(), dir, "package.json"))
		.sort();
}

function updateDependencyBlock(block, versionMap, packageName) {
	if (!block) {
		return 0;
	}

	let updates = 0;
	for (const depName of Object.keys(block)) {
		const depVersion = versionMap.get(depName);
		if (!depVersion) {
			continue;
		}

		const newRange = `^${depVersion}`;
		if (block[depName] !== newRange) {
			console.log(`  ${packageName}: ${depName} ${block[depName]} → ${newRange}`);
			block[depName] = newRange;
			updates++;
		}
	}

	return updates;
}

const rootPath = join(process.cwd(), "package.json");
const rootPackage = readJson(rootPath);
const packagePaths = [rootPath, ...getWorkspacePackagePaths(rootPackage)];
const packages = packagePaths.map((path) => ({ path, data: readJson(path) }));

const versionedPackages = packages.filter((pkg) => pkg.data.version !== undefined);

if (bumpType) {
	const currentVersions = new Set(versionedPackages.map((pkg) => pkg.data.version));
	if (currentVersions.size > 1) {
		console.error("Can not bump because packages are not currently lockstep.");
		process.exit(1);
	}
	explicitVersion = bumpVersion(versionedPackages[0].data.version, bumpType);
}

if (explicitVersion) {
	console.log(`Setting all versioned packages to ${explicitVersion}`);
	for (const pkg of versionedPackages) {
		if (pkg.data.version !== explicitVersion) {
			console.log(`  ${pkg.data.name}: ${pkg.data.version} → ${explicitVersion}`);
			pkg.data.version = explicitVersion;
		}
	}
}

const versionMap = new Map();
for (const pkg of versionedPackages) {
	versionMap.set(pkg.data.name, pkg.data.version);
}

console.log("Current versions:");
for (const pkg of versionedPackages.toSorted((a, b) => a.data.name.localeCompare(b.data.name))) {
	console.log(`  ${pkg.data.name}: ${pkg.data.version}`);
}

const versions = new Set(versionMap.values());
if (versions.size > 1) {
	console.error("\nERROR: Not all packages have the same version.");
	console.error("Expected lockstep versioning. Run one of:");
	console.error("  npm run version:patch");
	console.error("  npm run version:minor");
	console.error("  npm run version:major");
	console.error("  node scripts/sync-versions.js --set <x.y.z>");
	console.error("  node scripts/sync-versions.js --bump <major|minor|patch>");
	process.exit(1);
}

console.log("\nAll packages at same version (lockstep)");

let totalUpdates = 0;
for (const pkg of packages) {
	let updates = 0;
	updates += updateDependencyBlock(pkg.data.dependencies, versionMap, pkg.data.name);
	updates += updateDependencyBlock(pkg.data.devDependencies, versionMap, pkg.data.name);
	updates += updateDependencyBlock(pkg.data.optionalDependencies, versionMap, pkg.data.name);
	updates += updateDependencyBlock(pkg.data.peerDependencies, versionMap, pkg.data.name);
	totalUpdates += updates;

	if (explicitVersion || updates > 0) {
		writeJson(pkg.path, pkg.data);
	}
}

if (totalUpdates === 0) {
	console.log("\nAll inter-package dependencies already in sync.");
} else {
	console.log(`\nUpdated ${totalUpdates} dependency version(s).`);
}
