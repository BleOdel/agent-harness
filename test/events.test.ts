import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { describeUsage, EventStream } from "../src/agent/events.ts";

/**
 * The fixture is real output, captured from a live run against
 * openai-codex, trimmed for length. A parser tested against a stream
 * somebody invented proves only that it matches the invention.
 */
const FIXTURE = path.join(import.meta.dirname, "fixtures", "pi-events.jsonl");

async function feed(chunks: readonly string[]): Promise<{ text: string; stream: EventStream }> {
  const stream = new EventStream();
  let text = "";
  for (const chunk of chunks) text += stream.push(chunk);
  text += stream.finish();
  return { text, stream };
}

test("the assistant's prose is what reaches the operator", async () => {
  // --mode json takes away Pi's readable output. If this file does not
  // give it back, the trade was not worth making.
  const { text } = await feed([await readFile(FIXTURE, "utf8")]);
  assert.match(text, /Adding the helper\./u);
});

test("usage is summed from turns, never from partial updates", async () => {
  // The same numbers appear on message_start, every message_update,
  // message_end, turn_end and agent_end. Counting more than one of those
  // multiplies a turn's tokens by how often its partial state was
  // reported -- and the resulting figure looks entirely plausible.
  const { stream } = await feed([await readFile(FIXTURE, "utf8")]);
  const usage = stream.current();
  assert.equal(usage.turns, 2);
  assert.equal(usage.input, 5_002);
  assert.equal(usage.output, 125);
  assert.equal(usage.cacheRead, 3_600);
  assert.equal(usage.reasoning, 64);
  assert.equal(usage.totalTokens, 5_127);
  assert.equal(Number(usage.costUsd.toFixed(5)), 0.02616);
  assert.equal(usage.model, "gpt-5.6-sol");
  assert.equal(usage.provider, "openai-codex");
});

test("a stream split mid-line still parses", async () => {
  // Chunks arrive from a pipe at arbitrary boundaries, so a JSON object
  // is routinely delivered in two pieces.
  const whole = await readFile(FIXTURE, "utf8");
  const cut = Math.floor(whole.length / 2);
  const { stream, text } = await feed([whole.slice(0, cut), whole.slice(cut)]);
  assert.equal(stream.current().totalTokens, 5_127);
  assert.match(text, /Adding the helper\./u);
});

test("tool activity is named, not dumped", async () => {
  // A tool call's arguments are frequently the whole file being written.
  // That is the diff, and the diff is what `view` is for.
  const { text } = await feed([await readFile(FIXTURE, "utf8")]);
  assert.match(text, /· write/u);
  assert.equal(text.includes("toolCall"), false);
});

test("output that is not JSON is passed through, not swallowed", async () => {
  // Pi prints warnings and startup notices as plain text. Swallowing them
  // is how a diagnosable failure becomes a silent one.
  const { text, stream } = await feed(["a plain warning line\n", '{"type":"agent_settled"}\n']);
  assert.match(text, /a plain warning line/u);
  assert.deepEqual(stream.unparsed, ["a plain warning line"]);
});

test("an unrecognised event is ignored rather than fatal", async () => {
  // Pi's stream is not this project's contract. A new event type must
  // not stop a build.
  const { text, stream } = await feed(['{"type":"something_new","payload":{"a":1}}\n']);
  assert.equal(text, "");
  assert.equal(stream.current().turns, 0);
});

test("the cached share is measured against the whole prompt", async () => {
  // Observed on a real run: input 20,809, cacheRead 43,008, output 2,086,
  // totalTokens 65,903 -- so totalTokens = input + output + cacheRead, and
  // `input` is the non-cached portion. Dividing cacheRead by input alone
  // reported "207% cached", which is exactly the sort of confident
  // nonsense that gets believed because it sits beside correct numbers.
  const { cachedShare } = await import("../src/agent/events.ts");
  const observed = { ...(new EventStream()).current(), input: 20_809, cacheRead: 43_008, output: 2_086, totalTokens: 65_903, turns: 14 };
  assert.equal(observed.input + observed.output + observed.cacheRead, observed.totalTokens);
  assert.equal(cachedShare(observed), 67);
  assert.equal(cachedShare({ ...observed, cacheRead: 0, input: 63_817 }), 0);
});

test("a run reporting no usage says so rather than showing zero", () => {
  assert.match(describeUsage((new EventStream()).current()), /no usage reported/u);
});

test("the summary line reads as a person would want it", async () => {
  const { stream } = await feed([await readFile(FIXTURE, "utf8")]);
  const line = describeUsage(stream.current());
  assert.match(line, /model: gpt-5\.6-sol/u);
  assert.match(line, /2 turns/u);
  assert.match(line, /5,127 tokens/u);
  assert.match(line, /42% cached/u);
  assert.match(line, /\$0\.0262/u);
});
