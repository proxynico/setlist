/**
 * Inline images for terminals that can show them: the Kitty graphics protocol
 * (Ghostty, Kitty) and the iTerm2 inline image protocol (iTerm2, WezTerm).
 * Anything else gets text only.
 */

export type ImageProtocol = "kitty" | "iterm";

export interface CellBox {
  columns: number;
  rows: number;
}

export function detectImageProtocol({
  env = process.env,
  isTTY = Boolean(process.stdout.isTTY),
}: {
  env?: Record<string, string | undefined>;
  isTTY?: boolean;
} = {}): ImageProtocol | undefined {
  if (!isTTY || env.TERM === "dumb") return undefined;
  // tmux and screen swallow image escapes unless passthrough is configured.
  if (env.TMUX || env.STY) return undefined;
  if (env.TERM_PROGRAM === "ghostty" || env.TERM === "xterm-kitty" || env.KITTY_WINDOW_ID) return "kitty";
  if (env.TERM_PROGRAM === "iTerm.app" || env.TERM_PROGRAM === "WezTerm") return "iterm";
  return undefined;
}

const KITTY_CHUNK = 4096;

/** Escape sequence that draws a PNG scaled into `box`, leaving the cursor where it was. */
export function imageEscape(protocol: ImageProtocol, png: Uint8Array, box: CellBox): string {
  const data = Buffer.from(png).toString("base64");
  if (protocol === "iterm") {
    const args = `inline=1;size=${png.length};width=${box.columns};height=${box.rows};preserveAspectRatio=1`;
    return `\x1b7\x1b]1337;File=${args}:${data}\x07\x1b8`;
  }
  // q=2 keeps the terminal from answering on stdin; C=1 keeps the cursor still.
  const chunks: string[] = [];
  for (let i = 0; i < data.length; i += KITTY_CHUNK) {
    const more = i + KITTY_CHUNK < data.length ? 1 : 0;
    const control = i === 0 ? `a=T,f=100,q=2,C=1,c=${box.columns},r=${box.rows},m=${more}` : `m=${more}`;
    chunks.push(`\x1b_G${control};${data.slice(i, i + KITTY_CHUNK)}\x1b\\`);
  }
  return `\x1b7${chunks.join("")}\x1b8`;
}

/** Draw an image with `lines` printed to its right, vertically centred. */
export function besideImage({ image, box, lines }: { image: string; box: CellBox; lines: string[] }): string {
  const height = Math.max(box.rows, lines.length);
  const top = Math.floor((height - lines.length) / 2);
  const indent = `\x1b[${box.columns + 2}C`;
  // Reserve the rows first so the image never scrolls out from under the text.
  let out = `${"\n".repeat(height)}\x1b[${height}A\r${image}`;
  for (let i = 0; i < height; i++) {
    const line = lines[i - top];
    out += `${line ? indent + line : ""}\n`;
  }
  return out;
}
