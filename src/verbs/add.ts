/**
 *   add <id> --title "..." --criterion "..." [--criterion "..."] [--priority must]
 *
 * Adds one item to the project's feature list.
 *
 * Deliberately refuses an item with no acceptance criteria, at the point
 * of writing rather than later. An item without criteria cannot be
 * reviewed and cannot be finished, so it is not a unit of work -- and the
 * moment the operator is thinking about the item is the cheapest moment
 * to make them say what "done" means.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type Feature,
  FEATURES_FILE,
  parseFeatures,
  parseProposedItems,
  PRIORITIES,
  type Priority,
} from "../features.ts";
import { harnessDirectory } from "../record/record.ts";
import { OperatorError, say } from "./io.ts";

interface Parsed {
  readonly id: string;
  readonly title: string;
  readonly priority: Priority;
  readonly criteria: readonly string[];
  readonly dependsOn: readonly string[];
}

export function parseAddArguments(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  let title: string | undefined;
  let priority: string = "must";
  const criteria: string[] = [];
  const dependsOn: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    const next = argv[index + 1];
    if (value === "--title") {
      title = next;
      index += 1;
    } else if (value === "--priority") {
      priority = next ?? "";
      index += 1;
    } else if (value === "--criterion") {
      if (next !== undefined) criteria.push(next);
      index += 1;
    } else if (value === "--depends-on") {
      if (next !== undefined) dependsOn.push(next);
      index += 1;
    } else if (value.startsWith("--")) {
      throw new OperatorError(`Unknown option ${value}.`, "Options: --title --criterion --priority --depends-on");
    } else {
      positional.push(value);
    }
  }

  const id = positional[0];
  if (id === undefined || positional.length !== 1) {
    throw new OperatorError(
      "An item needs exactly one id.",
      'Use: harness add <id> --title "..." --criterion "..."',
    );
  }
  if (title === undefined || title.trim() === "") {
    throw new OperatorError(`${id} needs a title.`, 'Add --title "what this item delivers".');
  }
  if (criteria.length === 0) {
    throw new OperatorError(
      `${id} needs at least one acceptance criterion.`,
      "An item with no criteria cannot be reviewed and cannot be finished, so the\n"
      + "Reviewer would have nothing to check the work against.\n"
      + 'Add --criterion "what must be true when this is done" (repeatable).',
    );
  }
  if (!PRIORITIES.includes(priority as Priority)) {
    throw new OperatorError(
      `${JSON.stringify(priority)} is not a MoSCoW priority.`,
      `Use one of: ${PRIORITIES.join(", ")}.`,
    );
  }
  return { id, title, priority: priority as Priority, criteria, dependsOn };
}

/**
 * Items a `plan` run proposed, read from a file the operator names.
 *
 * The model never writes the feature list. It proposes; the operator runs
 * the command that accepts. Same shape as `work` -- propose inside the
 * sandbox, then a gate before anything lands -- except that here the gate
 * is a person reading the list, which is why every item is printed before
 * any of it is written.
 */
/**
 * Resolves `latest` to the newest proposal a `plan` run left behind.
 *
 * Plans are stored under a timestamped directory, and making the operator
 * paste that path is the kind of friction that gets a good idea abandoned.
 */
async function resolveProposal(project: string, given: string): Promise<string> {
  if (given !== "latest") return path.resolve(given);
  const plans = path.join(harnessDirectory(project), "plans");
  const stamps = await readdir(plans).catch(() => [] as string[]);
  const newest = stamps.sort().at(-1);
  if (newest === undefined) {
    throw new OperatorError(
      "No plan has been run for this project yet.",
      "Run `harness plan` first, or pass the path to an items file.",
    );
  }
  return path.join(plans, newest, "items.json");
}

async function itemsFromFile(source: string): Promise<Feature[]> {
  const text = await readFile(source, "utf8").catch(() => undefined);
  if (text === undefined) {
    throw new OperatorError(
      `No file at ${source}.`,
      "A plan run writes items.json beside its PLAN.md, under <project>-harness/plans/.",
    );
  }
  const proposed = parseProposedItems(text);
  if (!proposed.ok) throw new OperatorError(proposed.reason, `Fix ${source}, or add the items by hand.`);
  if (proposed.features.length === 0) {
    throw new OperatorError(`${source} proposes no items.`, "");
  }
  return [...proposed.features];
}

export async function add(project: string, argv: readonly string[]): Promise<void> {
  const fromIndex = argv.indexOf("--from");
  const incoming = fromIndex >= 0
    ? await itemsFromFile(await resolveProposal(project, argv[fromIndex + 1] ?? "latest"))
    : [{ ...parseAddArguments(argv), status: "todo" as const }];

  const file = path.join(project, FEATURES_FILE);
  const existing = await readFile(file, "utf8").catch(() => "[]");
  const list = parseFeatures(existing);
  if (!list.ok) throw new OperatorError(list.reason, `Fix ${FEATURES_FILE} before adding to it.`);

  const taken = new Set(list.features.map((feature) => feature.id));
  const clashes = incoming.filter((item) => taken.has(item.id)).map((item) => item.id);
  if (clashes.length > 0) {
    throw new OperatorError(
      `Already in the feature list: ${clashes.join(", ")}.`,
      fromIndex >= 0
        ? "Nothing was imported. Remove those items from the proposal, or rename them."
        : "Pick another id.",
    );
  }

  const next = [...list.features, ...incoming];
  // Validated through the same parser that reads it, so an item can never
  // be written that the harness would then refuse to load.
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const check = parseFeatures(text);
  if (!check.ok) throw new OperatorError(`The resulting list would be invalid: ${check.reason}`);

  await writeFile(file, text, "utf8");
  for (const item of incoming) {
    say(`added ${item.id} (${item.priority}), ${String(item.criteria.length)} criteria`);
    for (const criterion of item.criteria) say(`    ${criterion}`);
  }
  say("");
  say(incoming.length === 1
    ? `work on it with: harness work ${incoming[0]?.id ?? ""}`
    : `${String(incoming.length)} items added. Start the first Must with: harness work`);
}
