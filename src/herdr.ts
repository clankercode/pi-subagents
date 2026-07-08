/**
 * herdr.ts — Report `working` status to [herdr](https://herdr.dev) while
 * subagents are running.
 *
 * herdr is a terminal agent multiplexer that shows each pane's semantic state
 * (`working` / `blocked` / `done` / `idle`) in a sidebar. By default it
 * screen-scrapes the pane buffer to guess the state. While subagents run, the
 * parent pane is often blocked-waiting or idle-looking, so herdr
 * mis-classifies it as `idle` even though the overall task is in progress.
 *
 * This mirrors pi-questionnaire's `herdrReportBlocked` pattern but reports
 * `--state working` (delegated work is in progress — not waiting on a human,
 * which is what `blocked` means in herdr) for the duration that ≥1 subagent is
 * running, then releases the status authority when the last one finishes. The
 * reporter is refcounted so concurrent and background agents pair
 * acquire/release correctly: the first running agent reports `working`, the
 * last terminal one releases.
 *
 * All spawns are fire-and-forget, detached, stdio ignored, and wrapped in
 * try/catch — status reporting must NEVER break the tool. No-op outside a
 * herdr-managed pane (HERDR_ENV=1 + HERDR_PANE_ID) and when the
 * `herdrReportWorking` setting is off.
 */
import { type ChildProcess, spawn } from "node:child_process";

/** Source identity. The `user:` prefix marks a non-authority hook; the
 * `--agent pi` guard restricts the report to while pi is the active pane
 * agent (and auto-drops it if pi exits first). */
export const HERDR_SOURCE = "user:pi-subagents";
/** Agent label — this extension only runs inside pi. */
export const HERDR_AGENT = "pi";
/** Short visual label next to the working dot (herdr caps custom-status at 32 chars). */
export const HERDR_CUSTOM_STATUS = "running subagents";

export interface HerdrCommand {
	cmd: string;
	args: string[];
}

/** Build the `herdr pane report-agent` command that marks the pane `working`. */
export function herdrReportCommand(paneId: string, message: string): HerdrCommand {
	return {
		cmd: "herdr",
		args: [
			"pane", "report-agent", paneId,
			"--source", HERDR_SOURCE,
			"--agent", HERDR_AGENT,
			"--state", "working",
			"--custom-status", HERDR_CUSTOM_STATUS,
			"--message", message,
		],
	};
}

/** Build the `herdr pane release-agent` command that restores the pane's
 * prior status authority when the last subagent finishes. */
export function herdrReleaseCommand(paneId: string): HerdrCommand {
	return {
		cmd: "herdr",
		args: [
			"pane", "release-agent", paneId,
			"--source", HERDR_SOURCE,
			"--agent", HERDR_AGENT,
		],
	};
}

export interface HerdrReporterOptions {
	/** `"1"` inside a herdr-managed pane. Default: `process.env.HERDR_ENV`. */
	env?: string;
	/** The herdr pane id. Default: `process.env.HERDR_PANE_ID`. */
	paneId?: string;
	/** Reads the live `herdrReportWorking` setting. Default: `() => true`. */
	isEnabled?: () => boolean;
	/** Spawn override for tests. Default: `node:child_process` `spawn`. */
	spawnFn?: typeof spawn;
	/** Sink for fire-and-forget failures. Default: no-op (never noisy). */
	log?: (msg: string) => void;
}

/**
 * Refcounted herdr status reporter. Call `acquire()` when a subagent starts
 * running and `release()` when it reaches a terminal state. The reporter
 * emits exactly one `report-agent --state working` for the 0→1 transition and
 * one `release-agent` for the →0 transition, regardless of how many agents
 * run concurrently.
 */
export class HerdrReporter {
	private readonly env: string;
	private readonly paneId: string | undefined;
	private readonly isEnabled: () => boolean;
	private readonly spawnFn: typeof spawn;
	private readonly log: (msg: string) => void;
	/** Number of currently-running subagents (reality — tracked even when
	 * reporting is disabled, so acquire/release always pair). */
	private count = 0;
	/** Whether we currently hold the pane's status authority (i.e. we have
	 * emitted a report-agent that a release-agent must balance). */
	private armed = false;

	constructor(opts: HerdrReporterOptions = {}) {
		this.env = opts.env ?? process.env.HERDR_ENV ?? "";
		this.paneId = opts.paneId ?? process.env.HERDR_PANE_ID;
		this.isEnabled = opts.isEnabled ?? (() => true);
		this.spawnFn = opts.spawnFn ?? spawn;
		this.log = opts.log ?? (() => {});
	}

	/** Valid herdr pane id present (non-empty string). */
	private pane(): string | null {
		return typeof this.paneId === "string" && this.paneId.length > 0 ? this.paneId : null;
	}

	/**
	 * A subagent started running. Refcount; on 0→1 (and on each subsequent
	 * start) emit `report-agent --state working` so the visible message tracks
	 * the latest agent. `detail` (e.g. the agent description) is folded into
	 * the message and capped for readability.
	 */
	acquire(detail?: string): void {
		this.count++;
		const pane = this.pane();
		if (!this.isEnabled() || this.env !== "1" || pane === null) return;
		this.armed = true;
		const label = detail && detail.trim() !== "" ? detail.trim().slice(0, 80) : "";
		const message =
			label === ""
				? this.count > 1 ? `running ${this.count} subagents` : HERDR_CUSTOM_STATUS
				: this.count > 1
					? `running ${this.count} subagents (latest: ${label})`
					: `running subagent: ${label}`;
		this.run(herdrReportCommand(pane, message), "report-agent");
	}

	/**
	 * A subagent reached a terminal state (completed/errored/aborted/stopped).
	 * Refcount; on →0 release the pane's status authority. Never goes
	 * negative; releases with no prior acquire are a no-op. Releases always
	 * fire when armed (even if the setting was toggled off mid-run) so we
	 * never leak a `working` hold — the `--agent pi` guard also drops it on
	 * process exit as a backstop.
	 */
	release(): void {
		this.count = Math.max(0, this.count - 1);
		if (this.count !== 0 || !this.armed) return;
		this.armed = false;
		const pane = this.pane();
		if (pane) this.run(herdrReleaseCommand(pane), "release-agent");
	}

	/** Force-release on teardown (e.g. `session_shutdown`). Safe if not armed. */
	dispose(): void {
		this.count = 0;
		if (!this.armed) return;
		this.armed = false;
		const pane = this.pane();
		if (pane) this.run(herdrReleaseCommand(pane), "release-agent");
	}

	/** Fire-and-forget spawn; never throws. Detached + unref'd so the child
	 * can finish after a fast tool return without keeping the event loop alive. */
	private run({ cmd, args }: HerdrCommand, label: string): void {
		try {
			const child: ChildProcess = this.spawnFn(cmd, args, { detached: true, stdio: "ignore" });
			child.unref?.();
			child.on?.("error", (err: Error) => this.log(`herdr ${label} failed: ${err.message}`));
		} catch (err) {
			this.log(`herdr ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
