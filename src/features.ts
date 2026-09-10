/**
 * The unit of work.
 *
 * Prose cannot be reviewed mechanically and cannot be checked off. An
 * item has an id, acceptance criteria as separate strings, a status, and
 * a MoSCoW priority -- so the Reviewer has something exact to compare the
 * diff against, and so "done" is a claim about named criteria rather than
 * a feeling.
 *
 * The operator owns requirements; the host records completion and
 * invalidation. The model never receives this file in its sandbox.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const FEATURES_FILE = "features.json";

export const PRIORITIES = ["must", "should", "could", "wont"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const STATUSES = ["todo", "doing", "done", "blocked", "needs-revalidation"] as const;
export type Status = (typeof STATUSES)[number];

export interface Feature {
  readonly id: string;
  readonly title: string;
  readonly priority: Priority;
  readonly status: Status;
  readonly criteria: readonly string[];
  /** Ids that must be `done` before this item may start. */
  readonly dependsOn: readonly string[];
  /** Operator-authorized changes to dependencies or shared contracts. */
  readonly kind?: "implementation" | "shared-inputs";
  readonly assignedRole?: string;
  readonly changeScope?: readonly string[];
  readonly contracts?: readonly string[];
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
    if (item.kind !== undefined && item.kind !== "implementation" && item.kind !== "shared-inputs") return { ok: false, reason: fault(index, "has an unsupported assignment kind.") };
    if (item.assignedRole !== undefined && (typeof item.assignedRole !== "string" || !item.assignedRole.trim())) return { ok: false, reason: fault(index, "has an invalid assignedRole.") };
    for (const field of ["changeScope", "contracts"]) {
      if (item[field] !== undefined && (!Array.isArray(item[field]) || (item[field] as unknown[]).some(v => typeof v !== "string" || !v.trim()))) return { ok: false, reason: fault(index, `has an invalid ${field}.`) };
    }
    features.push({
      id: item.id,
      title: item.title,
      priority: item.priority as Priority,
      status: item.status as Status,
      criteria: item.criteria as string[],
      dependsOn: dependsOn as string[],
      ...(item.assignedRole === undefined ? {} : { assignedRole: item.assignedRole as string }),
      ...(item.changeScope === undefined ? {} : { changeScope: item.changeScope as string[] }),
      ...(item.contracts === undefined ? {} : { contracts: item.contracts as string[] }),
      ...(item.kind === undefined ? {} : { kind: item.kind as "implementation" | "shared-inputs" }),
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
  const byId = new Map(features.map(feature => [feature.id, feature]));
  const finished = new Set<string>();
  const visiting: string[] = [];
  const visit = (id: string): string[] | undefined => {
    const index = visiting.indexOf(id);
    if (index >= 0) return [...visiting.slice(index), id];
    if (finished.has(id)) return undefined;
    visiting.push(id);
    for (const dependency of byId.get(id)!.dependsOn) {
      const cycle = visit(dependency);
      if (cycle !== undefined) return cycle;
    }
    visiting.pop();
    finished.add(id);
    return undefined;
  };
  for (const feature of features) {
    const cycle = visit(feature.id);
    if (cycle !== undefined) return { ok: false, reason: `${FEATURES_FILE}: dependency cycle: ${cycle.join(" -> ")}.` };
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
export async function markStatus(project: string, id: string, status: Status, invalidateDependents = false): Promise<boolean> {
  const file = path.join(project, FEATURES_FILE);
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) return false;
  const list = parseFeatures(text);
  if (!list.ok) return false;
  const previous = list.features.find((feature) => feature.id === id);
  if (previous === undefined) return false;
  const affected = new Set<string>([id]);
  if (invalidateDependents || (previous.status === "done" && status !== "done")) {
    // Follow through unfinished intermediates too: a completed grandchild
    // may still rely on the changed ancestor's previous behavior.
    for (let changed = true; changed;) {
      changed = false;
      for (const feature of list.features) {
        if (!affected.has(feature.id) && feature.dependsOn.some(dependency => affected.has(dependency))) {
          affected.add(feature.id);
          changed = true;
        }
      }
    }
  }
  const next = list.features.map((feature) =>
    feature.id === id ? { ...feature, status }
      : affected.has(feature.id) && (feature.status === "done" || feature.status === "doing")
        ? { ...feature, status: "needs-revalidation" as const }
        : feature);
  const rendered = `${JSON.stringify(next, null, 2)}\n`;
  // Through the same parser that reads it: the harness must never write a
  // list it would then refuse to load.
  if (!parseFeatures(rendered).ok) return false;
  await writeFile(file, rendered, "utf8");
  return true;
}

export const markDone = async (project: string, id: string, changed = true): Promise<boolean> =>
  markStatus(project, id, "done", changed);

/** Prerequisites whose acceptance the current feature list does not establish. */
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
): { next: Feature | undefined; steppedOver: Feature[]; waiting: Feature[] } {
  const queue = nextItems(features);
  const skip = (feature: Feature): boolean =>
    feature.status !== "needs-revalidation" && lastOutcomeOf(feature.id) === "no-changes";
  const steppedOver = queue.filter(skip);
  return {
    next: queue.find((feature) => !skip(feature)),
    steppedOver,
    waiting: pendingItems(features).filter(feature => unmetDependencies(feature, features).length > 0),
  };
}

function pendingItems(features: readonly Feature[]): Feature[] {
  const rank = (feature: Feature): number => PRIORITIES.indexOf(feature.priority);
  return features
    .filter((feature) => feature.status === "todo" || feature.status === "doing" || feature.status === "needs-revalidation")
    .filter((feature) => feature.priority !== "wont")
    .sort((a, b) => rank(a) - rank(b));
}

/** Eligible work in MoSCoW order, then declaration order. */
export function nextItems(features: readonly Feature[]): Feature[] {
  return pendingItems(features).filter(feature => unmetDependencies(feature, features).length === 0);
}

/** A shared environment changed; without finer dependency ownership all accepted items are affected. */
export async function invalidateSharedInputs(project: string, except: string): Promise<void> {
  const list = await readFeatures(project);
  if (!list?.ok) throw new Error("Cannot invalidate tasks: feature list is missing or invalid.");
  const next = list.features.map(f => f.id !== except && (f.status === "done" || f.status === "doing") ? { ...f, status: "needs-revalidation" } : f);
  await writeFile(path.join(project, FEATURES_FILE), JSON.stringify(next, null, 2) + "\n");
}
