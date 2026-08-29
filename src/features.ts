/**
 * The unit of work.
 *
 * Prose cannot be reviewed mechanically and cannot be checked off. An
 * item has an id, acceptance criteria as separate strings, a status, and
 * a MoSCoW priority -- so the Reviewer has something exact to compare the
 * diff against, and so "done" is a claim about named criteria rather than
 * a feeling.
 *
 * The file lives in the project, is written by the operator, and is never
 * modified by the harness. A model that could edit its own acceptance
 * criteria has none.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const FEATURES_FILE = "features.json";

export const PRIORITIES = ["must", "should", "could", "wont"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const STATUSES = ["todo", "doing", "done", "blocked"] as const;
export type Status = (typeof STATUSES)[number];

export interface Feature {
  readonly id: string;
  readonly title: string;
  readonly priority: Priority;
  readonly status: Status;
  readonly criteria: readonly string[];
  /** Ids that must be `done` first. Advisory: reported, never enforced silently. */
  readonly dependsOn: readonly string[];
}

export type FeatureListResult =
  | { readonly ok: true; readonly features: readonly Feature[] }
  | { readonly ok: false; readonly reason: string };

function fault(index: number, message: string): string {
  return `${FEATURES_FILE}: item ${String(index)} ${message}`;
}

export function parseFeatures(text: string): FeatureListResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `${FEATURES_FILE} is not valid JSON: ${(error as Error).message}` };
  }
  const items = Array.isArray(raw) ? raw : (raw as { features?: unknown })?.features;
  if (!Array.isArray(items)) {
    return { ok: false, reason: `${FEATURES_FILE} must be an array of items, or an object with a "features" array.` };
  }

  const features: Feature[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of items.entries()) {
    const item = entry as Record<string, unknown>;
    if (typeof item?.id !== "string" || item.id.trim() === "") {
      return { ok: false, reason: fault(index, "has no id.") };
    }
    if (seen.has(item.id)) {
      // Two items with one id means `work <id>` is ambiguous, and an
      // ambiguous unit of work is not a unit of work.
      return { ok: false, reason: `${FEATURES_FILE}: id ${item.id} appears more than once.` };
    }
    seen.add(item.id);
    if (typeof item.title !== "string" || item.title.trim() === "") {
      return { ok: false, reason: fault(index, `(${item.id}) has no title.`) };
    }
    if (!PRIORITIES.includes(item.priority as Priority)) {
      return { ok: false, reason: fault(index, `(${item.id}) needs a priority: ${PRIORITIES.join(", ")}.`) };
    }
    if (!STATUSES.includes(item.status as Status)) {
      return { ok: false, reason: fault(index, `(${item.id}) needs a status: ${STATUSES.join(", ")}.`) };
    }
    if (!Array.isArray(item.criteria) || item.criteria.length === 0
      || item.criteria.some((c) => typeof c !== "string" || c.trim() === "")) {
      return {
        ok: false,
        reason: fault(index, `(${item.id}) needs at least one non-empty acceptance criterion. `
          + "An item with no criteria cannot be reviewed and cannot be finished."),
      };
    }
    const dependsOn = item.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((d) => typeof d !== "string")) {
      return { ok: false, reason: fault(index, `(${item.id}) has a malformed dependsOn.`) };
    }
    features.push({
      id: item.id,
      title: item.title,
      priority: item.priority as Priority,
      status: item.status as Status,
      criteria: item.criteria as string[],
      dependsOn: dependsOn as string[],
    });
  }

  const ids = new Set(features.map((feature) => feature.id));
  for (const feature of features) {
    for (const dependency of feature.dependsOn) {
      if (!ids.has(dependency)) {
        return { ok: false, reason: `${FEATURES_FILE}: ${feature.id} depends on ${dependency}, which does not exist.` };
      }
    }
  }
  return { ok: true, features };
}

/**
 * Items proposed by a `plan` run, normalised into the shape the feature
 * list uses.
 *
 * A proposal omits `status`: nothing has been done yet, and letting a
 * model declare an item already "done" would hand it the one field the
 * harness reserves for its own verdict. Anything it sets is discarded
 * here rather than trusted.
 *
 * Validation goes through the same parser that reads the real list, so a
 * proposal that would not load is refused before it can be imported
 * rather than after.
 */
export function parseProposedItems(text: string): FeatureListResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `the proposal is not valid JSON: ${(error as Error).message}` };
  }
  const items = Array.isArray(raw) ? raw : (raw as { items?: unknown; features?: unknown })?.items
    ?? (raw as { features?: unknown })?.features;
  if (!Array.isArray(items)) {
    return { ok: false, reason: 'the proposal must be an array of items, or an object with an "items" array.' };
  }
  const normalised = items.map((entry) => {
    const item = entry as Record<string, unknown>;
    return { ...item, status: "todo" };
  });
  return parseFeatures(JSON.stringify(normalised));
}

export async function readFeatures(project: string): Promise<FeatureListResult | undefined> {
  let text;
  try {
    text = await readFile(path.join(project, FEATURES_FILE), "utf8");
  } catch {
    // No feature list is not an error. A free-form goal still works; the
    // Reviewer just has less to check against, and says so.
    return undefined;
  }
  return parseFeatures(text);
}

/**
 * Records that an item is done, after the harness proved it.
 *
 * The harness writes `status` and nothing else -- never a title, never a
 * priority, and never a criterion. The rule that matters is that nothing
 * being judged can edit what it is judged against, and status is not
 * that: it is the harness recording its own verdict, reached through the
 * gates and the Reviewer.
 *
 * Without this, `work` takes the same next Must forever. Found by the
 * plan's own M5 verification -- build an application following nothing
 * but `look` -- on the second run.
 */
export async function markStatus(project: string, id: string, status: Status): Promise<boolean> {
  const file = path.join(project, FEATURES_FILE);
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) return false;
  const list = parseFeatures(text);
  if (!list.ok) return false;
  if (!list.features.some((feature) => feature.id === id)) return false;
  const next = list.features.map((feature) =>
    feature.id === id ? { ...feature, status } : feature);
  const rendered = `${JSON.stringify(next, null, 2)}\n`;
  // Through the same parser that reads it: the harness must never write a
  // list it would then refuse to load.
  if (!parseFeatures(rendered).ok) return false;
  await writeFile(file, rendered, "utf8");
  return true;
}

export const markDone = async (project: string, id: string): Promise<boolean> =>
  markStatus(project, id, "done");

/** Unmet dependencies, so the operator is told rather than silently blocked. */
export function unmetDependencies(feature: Feature, all: readonly Feature[]): string[] {
  const byId = new Map(all.map((entry) => [entry.id, entry]));
  return feature.dependsOn.filter((id) => byId.get(id)?.status !== "done");
}

/**
 * Which item `work` takes next, and which it stepped over.
 *
 * An item whose last run changed nothing is stepped over rather than
 * offered again. Left in the queue, `work` hands the model an item it has
 * already satisfied, and a model asked to do something finds something
 * cosmetic to do. Watched happen on a real project: a number wrapped in
 * <strong>, which the Reviewer then escalated.
 *
 * A function rather than a few lines inside the command, so the rule can
 * be tested rather than a copy of it.
 */
export function chooseNext(
  features: readonly Feature[],
  lastOutcomeOf: (id: string) => string | undefined,
): { next: Feature | undefined; steppedOver: Feature[] } {
  const queue = nextItems(features);
  const steppedOver = queue.filter((feature) => lastOutcomeOf(feature.id) === "no-changes");
  return {
    next: queue.find((feature) => lastOutcomeOf(feature.id) !== "no-changes"),
    steppedOver,
  };
}

/** MoSCoW order, then declaration order. What to do next, when unsure. */
export function nextItems(features: readonly Feature[]): Feature[] {
  const rank = (feature: Feature): number => PRIORITIES.indexOf(feature.priority);
  return features
    .filter((feature) => feature.status === "todo" || feature.status === "doing")
    .filter((feature) => feature.priority !== "wont")
    .sort((a, b) => rank(a) - rank(b));
}
