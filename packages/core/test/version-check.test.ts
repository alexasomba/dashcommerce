import { describe, expect, test } from "bun:test";
import {
	SUPPORTED_EMDASH_PEER,
	checkEmDashVersion,
	isEmDashVersionSupported,
} from "../src/version-check";

describe("EmDash version compatibility", () => {
	test("peer string matches the dual range we advertise", () => {
		expect(SUPPORTED_EMDASH_PEER).toBe(">=0.37.0 <0.38.0 || >=1.1.0 <2.0.0");
	});

	test.each(["0.37.0", "0.37.9", "1.1.0", "1.1.9", "1.9.0"])("accepts supported %s", (version) => {
		expect(isEmDashVersionSupported(version)).toBe(true);
		expect(() => checkEmDashVersion(version)).not.toThrow();
	});

	test.each(["0.36.9", "0.38.0", "0.42.0", "1.0.0", "1.0.1", "2.0.0"])(
		"rejects unsupported %s",
		(version) => {
			expect(isEmDashVersionSupported(version)).toBe(false);
			expect(() => checkEmDashVersion(version)).toThrow(/incompatibility/);
		},
	);

	test("below-floor error still points at 0.1.5 as the 0.28-era pin", () => {
		expect(() => checkEmDashVersion("0.28.1")).toThrow(/@dashcommerce\/core@\^0\.1\.5/);
	});

	test("gap / too-new error lists both supported windows", () => {
		expect(() => checkEmDashVersion("0.38.0")).toThrow(SUPPORTED_EMDASH_PEER);
		expect(() => checkEmDashVersion("1.0.0")).toThrow(/not 1\.0\.0/);
	});
});
