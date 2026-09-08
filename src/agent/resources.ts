import { CONTAINER_SKILLS } from "../containment/sandbox.ts";

/** Explicit skill paths remain enabled by Pi even with discovery off. */
export function resourceArguments(skills: boolean): string[] {
  return [
    "--no-skills",
    "--no-extensions",
    ...(skills ? ["--skill", CONTAINER_SKILLS] : []),
  ];
}
