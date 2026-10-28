import { describe, expect, test } from "bun:test";
import { getOutputMode, outputErrorDetails, outputTracks, setColorEnabled, setVerboseEnabled } from "../src/lib/output";
import { ExternalServiceError } from "../src/lib/errors";

function captureErrors(run: () => void): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (value?: unknown) => {
    lines.push(String(value));
  };
  try {
    run();
  } finally {
    console.error = original;
  }
  return lines;
}

describe("getOutputMode", () => {
  test("defaults to human output", () => {
    expect(getOutputMode({})).toBe("human");
  });

  test("selects json output", () => {
    expect(getOutputMode({ json: true })).toBe("json");
  });

  test("selects plain output", () => {
    expect(getOutputMode({ plain: true })).toBe("plain");
  });

  test("rejects conflicting output modes", () => {
    expect(() => getOutputMode({ json: true, plain: true })).toThrow("cannot be used together");
  });
});

describe("plain output", () => {
  test("escapes tabs and newlines in track fields", () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      lines.push(String(value));
    };

    try {
      outputTracks(
        [
          {
            id: "native:persistent:ABC123",
            source: "native",
            persistentId: "ABC123",
            name: "one\ttwo",
            artist: "line\nbreak",
            album: "carriage\rreturn",
            duration: 61,
          },
        ],
        "plain",
      );
    } finally {
      console.log = originalLog;
    }

    expect(lines).toEqual([
      "track\tnative:persistent:ABC123\tone\\ttwo\tline\\nbreak\tcarriage\\rreturn\t1:01\tnative",
    ]);
  });
});

describe("error output", () => {
  test("hides the underlying cause by default", () => {
    setColorEnabled(false);
    setVerboseEnabled(false);
    try {
      const err = new ExternalServiceError("API unreachable", "Check your network.", new Error("ECONNREFUSED"));
      const lines = captureErrors(() => outputErrorDetails(err));
      expect(lines).toEqual(["error: API unreachable", "Check your network."]);
    } finally {
      setColorEnabled(true);
    }
  });

  test("surfaces the cause when verbose is enabled", () => {
    setColorEnabled(false);
    setVerboseEnabled(true);
    try {
      const err = new ExternalServiceError("API unreachable", "Check your network.", new Error("ECONNREFUSED"));
      const lines = captureErrors(() => outputErrorDetails(err));
      expect(lines[0]).toBe("error: API unreachable");
      expect(lines[1]).toBe("Check your network.");
      expect(lines.some((line) => line.includes("ECONNREFUSED"))).toBe(true);
    } finally {
      setVerboseEnabled(false);
      setColorEnabled(true);
    }
  });
});
