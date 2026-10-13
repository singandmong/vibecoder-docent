import test from "node:test";
import assert from "node:assert/strict";
import { ompCommand } from "../app/omp-bin.mjs";

test("a JS entry point runs under the current Node, any other path runs as itself", () => {
	for (const entry of ["/opt/omp/cli.js", "C:\\omp\\cli.mjs", "./omp.cjs", "/opt/omp/CLI.JS"]) {
		assert.deepEqual(ompCommand(entry, ["--version"]), { command: process.execPath, args: [entry, "--version"] });
	}
	for (const bin of ["omp", "/usr/local/bin/omp", "C:\\Program Files\\omp\\omp.exe", "/opt/omp.json", "/opt/omp.jsx"]) {
		assert.deepEqual(ompCommand(bin, ["models", "--json"]), { command: bin, args: ["models", "--json"] });
	}
	assert.deepEqual(ompCommand("omp"), { command: "omp", args: [] });
});
