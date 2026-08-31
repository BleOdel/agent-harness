/**
 * Pi's JSON event stream, turned into something the operator can read and
 * the record can keep.
 *
 * `--print` gives prose and nothing else: no model, no token counts, no
 * cost, no turn boundaries. `--mode json` gives all of it, and takes away
 * the readable commentary -- so this file has to give that back. If the
 * terminal ends up worse than it was, the trade was not worth making.
 *
 * Usage is summed from `turn_end` only. The same numbers appear on
 * `message_start`, every `message_update`, `message_end` and `agent_end`;
 * counting any of those as well would multiply a turn's tokens by the
 * number of times its partial state was reported.
 */

export interface AgentUsage {
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly turns: number;
}

export const emptyUsage = (): AgentUsage => ({
  provider: undefined,
  model: undefined,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 0,
  costUsd: 0,
  turns: 0,
});

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

interface Message {
  provider?: unknown;
  model?: unknown;
  usage?: Record<string, unknown> & { cost?: Record<string, unknown> };
  content?: unknown;
}

/**
 * Accumulates a run's usage and hands back the text worth printing.
 *
 * Deliberately forgiving: an event shape this does not recognise is
 * ignored rather than fatal. Pi's stream is not this project's contract,
 * and a new event type must not stop a build.
 */
export class EventStream {
  private buffer = "";
  private usage: AgentUsage = emptyUsage();
  /** Lines that were not JSON at all, kept so a failure can be explained. */
  readonly unparsed: string[] = [];
  /**
   * Called as each turn completes.
   *
   * Without it a watcher hears nothing between the start of a run and its
   * end -- which for a model turn is a minute or more, long enough for a
   * heartbeat to give the run up for dead. It was, on the first live test.
   */
  onTurn: ((usage: AgentUsage) => void) | undefined;

  /** Feeds a chunk, returning text to show the operator. */
  push(chunk: string): string {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    let out = "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      out += this.line(line);
    }
    return out;
  }

  /** Anything left unterminated when the process ended. */
  finish(): string {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest === "" ? "" : this.line(rest);
  }

  current(): AgentUsage {
    return this.usage;
  }

  private line(line: string): string {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Not JSON. Pi prints warnings and startup notices as plain text,
      // and swallowing them is how a diagnosable failure becomes silence.
      this.unparsed.push(line);
      return `${line}\n`;
    }
    switch (event.type) {
      case "message_update":
        return this.delta(event);
      case "turn_end":
        this.count(event.message as Message | undefined);
        this.onTurn?.(this.usage);
        return "";
      default:
        return "";
    }
  }

  private delta(event: Record<string, unknown>): string {
    const inner = event.assistantMessageEvent as Record<string, unknown> | undefined;
    if (inner?.type === "text_delta" && typeof inner.delta === "string") return inner.delta;
    // Tool activity, named rather than shown. The arguments are often the
    // whole file being written, which is the diff, and the diff is what
    // `view` is for.
    if (typeof inner?.type === "string" && inner.type.startsWith("tool")) {
      const name = str((inner.toolCall as Record<string, unknown> | undefined)?.name)
        ?? str(inner.name);
      return inner.type.endsWith("_start") && name !== undefined ? `\n  · ${name}\n` : "";
    }
    return "";
  }

  private count(message: Message | undefined): void {
    const usage = message?.usage;
    if (usage === undefined) return;
    this.usage = {
      provider: str(message?.provider) ?? this.usage.provider,
      model: str(message?.model) ?? this.usage.model,
      input: this.usage.input + num(usage.input),
      output: this.usage.output + num(usage.output),
      cacheRead: this.usage.cacheRead + num(usage.cacheRead),
      cacheWrite: this.usage.cacheWrite + num(usage.cacheWrite),
      reasoning: this.usage.reasoning + num(usage.reasoning),
      totalTokens: this.usage.totalTokens + num(usage.totalTokens),
      costUsd: this.usage.costUsd + num(usage.cost?.total),
      turns: this.usage.turns + 1,
    };
  }
}

/**
 * The share of the prompt that came from cache.
 *
 * `input` is the *non-cached* portion: measured against a real run,
 * totalTokens = input + output + cacheRead. Dividing cacheRead by input
 * alone reported "207% cached", which is the kind of confident nonsense
 * that gets believed because it sits beside numbers that are right.
 */
export function cachedShare(usage: AgentUsage): number {
  const prompt = usage.input + usage.cacheRead;
  return prompt === 0 ? 0 : Math.round((usage.cacheRead / prompt) * 100);
}

/** One line for the operator, after a run. */
export function describeUsage(usage: AgentUsage): string {
  if (usage.turns === 0) return "model: no usage reported";
  const cached = cachedShare(usage);
  return [
    `model: ${usage.model ?? "unknown"}`,
    `${String(usage.turns)} turns`,
    `${usage.totalTokens.toLocaleString("en-GB")} tokens`,
    ...(cached > 0 ? [`${String(cached)}% cached`] : []),
    `$${usage.costUsd.toFixed(4)}`,
  ].join(" · ");
}
