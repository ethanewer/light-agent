import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	getExportTemplateDir,
	getInteractiveAssetsDir,
	getPackageDir,
	getPackageJsonPath,
	getReadmePath,
	getThemesDir,
	resolveNodeRuntimeDirName,
	resolvePackageDirFrom,
} from "../src/config.js";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("config asset paths", () => {
	it("resolves package-root metadata paths from source", () => {
		expect(getPackageDir()).toBe(packageDir);
		expect(getPackageJsonPath()).toBe(join(packageDir, "package.json"));
		expect(getReadmePath()).toBe(join(packageDir, "README.md"));
	});

	it("resolves source asset paths from source runtime", () => {
		expect(getThemesDir()).toBe(join(packageDir, "src", "modes", "interactive", "theme"));
		expect(getExportTemplateDir()).toBe(join(packageDir, "src", "core", "export-html"));
		expect(getInteractiveAssetsDir()).toBe(join(packageDir, "src", "modes", "interactive", "assets"));
	});

	it("prefers the package root over nested dist/src package.json files", () => {
		expect(resolvePackageDirFrom(join(packageDir, "dist"))).toBe(packageDir);
		expect(resolvePackageDirFrom(join(packageDir, "src"))).toBe(packageDir);
	});

	it("detects the node runtime asset directory from the current module directory", () => {
		expect(resolveNodeRuntimeDirName(join(packageDir, "dist"))).toBe("dist");
		expect(resolveNodeRuntimeDirName(join(packageDir, "src"))).toBe("src");
	});
});
