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

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FEATURES_FILE, parseFeatures, PRIORITIES, type Priority } from "../features.ts";
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
      'Use: npm run add -- <id> --title "..." --criterion "..."',
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

export async function add(project: string, argv: readonly string[]): Promise<void> {
  const parsed = parseAddArguments(argv);
  const file = path.join(project, FEATURES_FILE);

  const existing = await readFile(file, "utf8").catch(() => "[]");
  const list = parseFeatures(existing);
  if (!list.ok) throw new OperatorError(list.reason, `Fix ${FEATURES_FILE} before adding to it.`);
  if (list.features.some((feature) => feature.id === parsed.id)) {
    throw new OperatorError(`${parsed.id} is already in the feature list.`, "Pick another id.");
  }

  const next = [...list.features, { ...parsed, status: "todo" as const }];
  // Validated through the same parser that reads it, so an item can never
  // be written that the harness would then refuse to load.
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const check = parseFeatures(text);
  if (!check.ok) throw new OperatorError(`The resulting list would be invalid: ${check.reason}`);

  await writeFile(file, text, "utf8");
  say(`added ${parsed.id} (${parsed.priority}), ${String(parsed.criteria.length)} criteria`);
  say(`work on it with: npm run work -- ${parsed.id}`);
}
