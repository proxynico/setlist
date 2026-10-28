import { describe, expect, test } from "bun:test";
import { besideImage, detectImageProtocol, imageEscape } from "../src/lib/terminal-image";

describe("detectImageProtocol", () => {
  test("uses the Kitty protocol in Ghostty and Kitty", () => {
    expect(detectImageProtocol({ env: { TERM_PROGRAM: "ghostty" }, isTTY: true })).toBe("kitty");
    expect(detectImageProtocol({ env: { TERM: "xterm-kitty" }, isTTY: true })).toBe("kitty");
  });

  test("uses the iTerm2 protocol in iTerm2 and WezTerm", () => {
    expect(detectImageProtocol({ env: { TERM_PROGRAM: "iTerm.app" }, isTTY: true })).toBe("iterm");
    expect(detectImageProtocol({ env: { TERM_PROGRAM: "WezTerm" }, isTTY: true })).toBe("iterm");
  });

  test("shows no image when piped, inside tmux, or in an unknown terminal", () => {
    expect(detectImageProtocol({ env: { TERM_PROGRAM: "ghostty" }, isTTY: false })).toBeUndefined();
    expect(detectImageProtocol({ env: { TERM_PROGRAM: "ghostty", TMUX: "/tmp/tmux" }, isTTY: true })).toBeUndefined();
    expect(detectImageProtocol({ env: { TERM_PROGRAM: "Apple_Terminal" }, isTTY: true })).toBeUndefined();
  });
});

describe("imageEscape", () => {
  const box = { columns: 12, rows: 6 };

  test("splits Kitty payloads into 4096-byte chunks and keeps the terminal quiet", () => {
    const sequence = imageEscape("kitty", new Uint8Array(7000), box);
    expect(sequence.startsWith("\x1b7")).toBe(true);
    expect(sequence.endsWith("\x1b8")).toBe(true);
    const chunks = sequence
      .slice(2, -2)
      .split("\x1b\\")
      .filter(Boolean)
      .map((chunk) => chunk.replace("\x1b_G", "").split(";"));
    expect(chunks.map(([control]) => control)).toEqual(["a=T,f=100,q=2,C=1,c=12,r=6,m=1", "m=1", "m=0"]);
    expect(chunks.map(([, data]) => data).join("")).toBe(Buffer.from(new Uint8Array(7000)).toString("base64"));
  });

  test("sizes iTerm2 images to the cell box", () => {
    const sequence = imageEscape("iterm", new Uint8Array([1, 2, 3]), box);
    expect(sequence).toBe("\x1b7\x1b]1337;File=inline=1;size=3;width=12;height=6;preserveAspectRatio=1:AQID\x07\x1b8");
  });
});

describe("besideImage", () => {
  test("reserves the image rows and centres the text to its right", () => {
    const out = besideImage({ image: "<img>", box: { columns: 4, rows: 4 }, lines: ["a", "b"] });
    expect(out).toBe("\n\n\n\n\x1b[4A\r<img>\n\x1b[6Ca\n\x1b[6Cb\n\n");
  });
});
