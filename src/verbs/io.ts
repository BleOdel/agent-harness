/**
 * The one place the operator surface writes to a terminal.
 *
 * Shared so every verb sounds the same, and so a failure always says the
 * same two things in the same order: what went wrong, then what to do
 * about it. v1's usability complaints were mostly errors that stated a
 * condition and left the operator to work out the remedy.
 */

export function say(line = ""): void {
  process.stdout.write(`${line}\n`);
}

export class OperatorError extends Error {
  readonly remedy: string;

  constructor(message: string, remedy = "") {
    super(message);
    this.name = "OperatorError";
    this.remedy = remedy;
  }
}

/** Right-pads for columns without pulling in a formatter. */
export const pad = (text: string, width: number): string =>
  text.length >= width ? text : text + " ".repeat(width - text.length);

/** One line, never wrapped mid-word, for a column that must not sprawl. */
export function clip(text: string, width: number): string {
  const flat = text.replaceAll(/\s+/gu, " ").trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}
