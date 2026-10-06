/**
 * Test that DASHCOMMERCE_VERSION matches package.json version.
 * The constant is imported from package.json at build/source time so
 * Changesets bumps cannot drift; this test is the CI backstop.
 */

import { describe, expect, test } from "bun:test";
import pkg from "../package.json";
import { DASHCOMMERCE_VERSION } from "../src/index";

describe("Version constant hygiene", () => {
	test("DASHCOMMERCE_VERSION matches package.json version", () => {
		expect(DASHCOMMERCE_VERSION).toBe(pkg.version);
	});
});
