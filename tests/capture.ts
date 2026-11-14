export function capture(stream: "log" | "error", run: () => void): string[] {
  const lines: string[] = [];
  const original = console[stream];
  console[stream] = (value?: unknown) => {
    lines.push(String(value));
  };
  try {
    run();
  } finally {
    console[stream] = original;
  }
  return lines;
}
