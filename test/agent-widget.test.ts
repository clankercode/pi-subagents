import { describe, expect, it } from "vitest";
import { createActivityTracker } from "../src/index.js";
import { describeActivityWithAge, formatMs, formatSessionTokens } from "../src/ui/agent-widget.js";

describe("formatSessionTokens", () => {
  const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };

  it("applies threshold colors (<70 dim, 70–85 warning, ≥85 error)", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("1.2k token");
    expect(formatSessionTokens(1234, 50, theme)).toBe("1.2k token (<dim>50%</dim>)");
    expect(formatSessionTokens(1234, 70, theme)).toBe("1.2k token (<warning>70%</warning>)");
    expect(formatSessionTokens(1234, 84, theme)).toBe("1.2k token (<warning>84%</warning>)");
    expect(formatSessionTokens(1234, 85, theme)).toBe("1.2k token (<error>85%</error>)");
    expect(formatSessionTokens(1234, 99, theme)).toBe("1.2k token (<error>99%</error>)");
  });

  it("annotates compaction count alongside percent", () => {
    // compactions only (e.g. immediately post-compaction, percent null)
    expect(formatSessionTokens(1234, null, theme, 1)).toBe("1.2k token (<dim>⇊1</dim>)");
    expect(formatSessionTokens(1234, null, theme, 3)).toBe("1.2k token (<dim>⇊3</dim>)");
    // percent + compactions, joined with ` · `
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe("1.2k token (<dim>45%</dim> · <dim>⇊2</dim>)");
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe("1.2k token (<error>88%</error> · <dim>⇊4</dim>)");
    // compactions=0 omitted
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe("1.2k token (<dim>45%</dim>)");
  });
});

describe("formatMs (humanized duration)", () => {
  it("keeps one decimal under a minute", () => {
    expect(formatMs(0)).toBe("0.0s");
    expect(formatMs(12_300)).toBe("12.3s");
    expect(formatMs(59_999)).toBe("60.0s");
  });

  it("uses m+s from one minute up to one hour", () => {
    expect(formatMs(60_000)).toBe("1m");
    expect(formatMs(72_000)).toBe("1m 12s");
    expect(formatMs(723_100)).toBe("12m 3s");
    expect(formatMs(3_599_999)).toBe("59m 59s");
  });

  it("uses h+m at one hour and above", () => {
    expect(formatMs(3_600_000)).toBe("1h");
    expect(formatMs(3_900_000)).toBe("1h 5m");
    expect(formatMs(7_470_000)).toBe("2h 4m");
  });
});

describe("describeActivityWithAge", () => {
  it("shows how long the current activity description has been current", () => {
    const active = new Map([["read-1", "read"]]);
    expect(describeActivityWithAge(active, "", 1_000, 3_400)).toBe("reading… · 2.4s");
  });

  it("omits the age until an activity timestamp exists", () => {
    expect(describeActivityWithAge(new Map(), "drafting answer")).toBe("drafting answer");
  });
});

describe("createActivityTracker", () => {
  it("initializes initial thinking with an activity age timestamp", () => {
    const { state } = createActivityTracker();

    expect(state.activityDescription).toBe("thinking…");
    expect(typeof state.activityDescriptionUpdatedAt).toBe("number");
    expect(describeActivityWithAge(
      state.activeTools,
      state.responseText,
      state.activityDescriptionUpdatedAt,
      state.activityDescriptionUpdatedAt! + 2_400,
    )).toBe("thinking… · 2.4s");
  });
});
