import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	HERDR_AGENT,
	HERDR_CUSTOM_STATUS,
	HERDR_SOURCE,
	HerdrReporter,
	herdrReleaseCommand,
	herdrReportCommand,
} from "../src/herdr.js";

/**
 * Tests for the herdr `working`-status reporter.
 *
 * herdr (https://herdr.dev) is a terminal agent multiplexer. While ≥1 subagent
 * runs we report `--state working` so herdr's sidebar/waits/rollups don't
 * mis-classify the blocked-waiting parent pane as idle. The reporter is
 * refcounted: the first running agent reports, the last terminal one releases.
 *
 * The host shell for this very session often has HERDR_ENV=1 set (we run
 * inside herdr), so every test stubs process.env.HERDR_ENV / HERDR_PANE_ID in
 * a beforeEach to stay hermetic — tests opt INTO a herdr pane by passing
 * env/paneId explicitly on the reporter.
 */

const PANE = "w1:p1";

/** Capture every spawn call; return a minimal ChildProcess-like object. */
function makeSpawnCapture() {
	const calls: { cmd: string; args: string[] }[] = [];
	const spawnFn = vi.fn((cmd: string, args: string[]) => {
		calls.push({ cmd, args });
		return { unref: vi.fn(), on: vi.fn() } as any;
	});
	return { spawnFn, calls };
}

/** Value following a --flag in an args list. */
function flag(args: string[], name: string): string {
	return args[args.indexOf(name) + 1];
}

const reports = (calls: { args: string[] }[]) => calls.filter((c) => c.args.includes("report-agent"));
const releases = (calls: { args: string[] }[]) => calls.filter((c) => c.args.includes("release-agent"));

const origEnv = process.env.HERDR_ENV;
const origPane = process.env.HERDR_PANE_ID;

beforeEach(() => {
	// Hermetic: never inherit the host's herdr env. Tests pass env/paneId
	// explicitly to opt into a herdr pane.
	delete process.env.HERDR_ENV;
	delete process.env.HERDR_PANE_ID;
});

afterEach(() => {
	if (origEnv == null) delete process.env.HERDR_ENV;
	else process.env.HERDR_ENV = origEnv;
	if (origPane == null) delete process.env.HERDR_PANE_ID;
	else process.env.HERDR_PANE_ID = origPane;
});

describe("herdr command builders", () => {
	it("herdrReportCommand builds report-agent with --state working", () => {
		const { cmd, args } = herdrReportCommand(PANE, "running subagent: Explore");
		expect(cmd).toBe("herdr");
		expect(args.slice(0, 3)).toEqual(["pane", "report-agent", PANE]);
		expect(flag(args, "--source")).toBe(HERDR_SOURCE);
		expect(flag(args, "--agent")).toBe(HERDR_AGENT);
		expect(flag(args, "--state")).toBe("working");
		expect(flag(args, "--custom-status")).toBe(HERDR_CUSTOM_STATUS);
		expect(flag(args, "--message")).toBe("running subagent: Explore");
	});

	it("source/agent identify the extension", () => {
		expect(HERDR_SOURCE).toBe("user:pi-subagents");
		expect(HERDR_AGENT).toBe("pi");
	});

	it("custom-status fits herdr's 32-char cap", () => {
		expect(HERDR_CUSTOM_STATUS.length).toBeLessThanOrEqual(32);
	});

	it("herdrReleaseCommand builds release-agent", () => {
		const { cmd, args } = herdrReleaseCommand(PANE);
		expect(cmd).toBe("herdr");
		expect(args.slice(0, 3)).toEqual(["pane", "release-agent", PANE]);
		expect(flag(args, "--source")).toBe(HERDR_SOURCE);
		expect(flag(args, "--agent")).toBe(HERDR_AGENT);
	});
});

describe("HerdrReporter", () => {
	it("reports working on first acquire, releases on the matching release", () => {
		const { spawnFn, calls } = makeSpawnCapture();
		const r = new HerdrReporter({ env: "1", paneId: PANE, spawnFn });
		r.acquire("Explore codebase");

		expect(reports(calls)).toHaveLength(1);
		expect(releases(calls)).toHaveLength(0);
		expect(flag(reports(calls)[0].args, "--state")).toBe("working");
		expect(flag(reports(calls)[0].args, "--message")).toBe("running subagent: Explore codebase");

		r.release();
		expect(releases(calls)).toHaveLength(1);
	});

	it("refcounts: 2 acquires need 2 releases; report re-fires per acquire", () => {
		const { spawnFn, calls } = makeSpawnCapture();
		const r = new HerdrReporter({ env: "1", paneId: PANE, spawnFn });

		r.acquire("A");
		r.acquire("B");

		// One report per acquire (the latest message reflects B + the count).
		expect(reports(calls)).toHaveLength(2);
		expect(releases(calls)).toHaveLength(0);
		expect(flag(reports(calls)[1].args, "--message")).toBe("running 2 subagents (latest: B)");

		// First release: still one running → no release-agent yet.
		r.release();
		expect(releases(calls)).toHaveLength(0);

		// Second release: none running → release-agent fires once.
		r.release();
		expect(releases(calls)).toHaveLength(1);
	});

	it("is a no-op outside a herdr pane (env absent)", () => {
		const { spawnFn, calls } = makeSpawnCapture();
		const r = new HerdrReporter({ paneId: PANE, spawnFn }); // env defaults to ""
		r.acquire("x");
		r.release();
		expect(calls).toHaveLength(0);
	});

	it("is a no-op when paneId is absent even if env=1", () => {
		const { spawnFn, calls } = makeSpawnCapture();
		const r = new HerdrReporter({ env: "1", spawnFn });
		r.acquire("x");
		r.release();
		expect(calls).toHaveLength(0);
	});

	it("is a no-op when the setting is disabled", () => {
		const { spawnFn, calls } = makeSpawnCapture();
		const r = new HerdrReporter({ env: "1", paneId: PANE, spawnFn, isEnabled: () => false });
		r.acquire("x");
		r.release();
		expect(calls).toHaveLength(0);
	});

	it("release before any acquire is a no-op (never negative)", () => {
		const { spawnFn, calls } = makeSpawnCapture();
		const r = new HerdrReporter({ env: "1", paneId: PANE, spawnFn });
		r.release();
		r.release();
		expect(releases(calls)).toHaveLength(0);
	});

	it("extra releases beyond acquires are no-ops", () => {
		const { spawnFn, calls } = makeSpawnCapture();
		const r = new HerdrReporter({ env: "1", paneId: PANE, spawnFn });
		r.acquire("x");
		r.release();
		r.release(); // extra
		r.release(); // extra
		expect(releases(calls)).toHaveLength(1);
	});

	it("a throwing spawn is caught and logged, never throws", () => {
		const spawnFn = vi.fn(() => {
			throw new Error("ENOENT");
		});
		const logs: string[] = [];
		const r = new HerdrReporter({ env: "1", paneId: PANE, spawnFn, log: (m) => logs.push(m) });
		expect(() => r.acquire("x")).not.toThrow();
		expect(logs.some((l) => l.includes("report-agent failed"))).toBe(true);
	});

	it("a spawn 'error' event is logged, never thrown", () => {
		const handlers: Record<string, (e: Error) => void> = {};
		const spawnFn = vi.fn(() => ({
			unref: vi.fn(),
			on: vi.fn((ev: string, cb: (e: Error) => void) => {
				handlers[ev] = cb;
			}),
		}));
		const logs: string[] = [];
		const r = new HerdrReporter({ env: "1", paneId: PANE, spawnFn, log: (m) => logs.push(m) });
		r.acquire("x");
		handlers.error?.(new Error("boom"));
		expect(logs.some((l) => l.includes("report-agent failed: boom"))).toBe(true);
	});

	it("dispose releases if armed", () => {
		const { spawnFn, calls } = makeSpawnCapture();
		const r = new HerdrReporter({ env: "1", paneId: PANE, spawnFn });
		r.acquire("x");
		r.dispose();
		expect(releases(calls)).toHaveLength(1);
	});

	it("dispose is a no-op when not armed", () => {
		const { spawnFn, calls } = makeSpawnCapture();
		const r = new HerdrReporter({ env: "1", paneId: PANE, spawnFn });
		r.dispose();
		expect(calls).toHaveLength(0);
	});

	it("acquire without a detail uses the custom-status text as the message", () => {
		const { spawnFn, calls } = makeSpawnCapture();
		const r = new HerdrReporter({ env: "1", paneId: PANE, spawnFn });
		r.acquire();
		expect(flag(reports(calls)[0].args, "--message")).toBe(HERDR_CUSTOM_STATUS);
	});

	it("does not inherit the host's HERDR env by default (hermetic)", () => {
		// Even if a host had HERDR_ENV set at process start (we delete it in
		// beforeEach), a reporter with no explicit paneId never spawns.
		const { spawnFn, calls } = makeSpawnCapture();
		const r = new HerdrReporter({ spawnFn });
		r.acquire("x");
		expect(calls).toHaveLength(0);
	});

	it("acquire after the setting is toggled back on still reports", () => {
		// Count tracks reality regardless of isEnabled, so toggling back on
		// mid-stream re-arms reporting on the next acquire.
		let enabled = false;
		const { spawnFn, calls } = makeSpawnCapture();
		const r = new HerdrReporter({ env: "1", paneId: PANE, spawnFn, isEnabled: () => enabled });
		r.acquire("skipped"); // disabled → no report
		expect(reports(calls)).toHaveLength(0);
		enabled = true;
		r.acquire("now"); // re-enabled → reports (count=2)
		expect(reports(calls)).toHaveLength(1);
		expect(flag(reports(calls)[0].args, "--message")).toBe("running 2 subagents (latest: now)");
	});
});
