import { PendingDecision } from '../workflow/protocol.ts';
import { createInterface } from "node:readline/promises";
import { OperatorError, say } from "../verbs/io.ts";
export interface Dialogue {
    ask(question: string): Promise<string>;
    write(text: string): void;
    choose?(title: string, choices: readonly string[]): Promise<number>;
    confirm?(question: string): Promise<boolean>;
}
export function noninteractiveDialogue(): Dialogue {
    return { write: say, ask: async (question) => { throw new PendingDecision(question, [{ id: "provide-input", label: "Provide the missing information through harness guide", command: "harness guide" }, { id: "save", label: "Keep saved progress and stop" }]); }, choose: async (title, choices) => { throw new PendingDecision(title, choices.map((label, index) => ({ id: String(index + 1), label }))); }, confirm: async (question) => { throw new PendingDecision(question, [{ id: "review", label: "Review and decide interactively", command: "harness guide" }, { id: "save", label: "Keep saved progress without approval" }]); } };
}
export function terminalDialogue(): Dialogue {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
        throw new OperatorError("The guide needs a terminal.", "Use harness doctor --json and the explicit commands in scripts.");
    return {
        write: say,
        async ask(question) {
            // Release stdin before starting the planner's own terminal conversation.
            const reader = createInterface({ input: process.stdin, output: process.stdout });
            try {
                return await reader.question(`${question} `);
            }
            catch {
                throw new OperatorError("Guide closed. Saved work is available next time.");
            }
            finally {
                reader.close();
            }
        },
    };
}
export const confirmed = async (io: Dialogue, question: string): Promise<boolean> => io.confirm ? io.confirm(question) : /^y(?:es)?$/iu.test((await io.ask(`${question} [y/N]`)).trim());
export async function choose(io: Dialogue, title: string, choices: readonly string[]): Promise<number> {
    if (io.choose)
        return io.choose(title, choices);
    for (;;) {
        io.write(title);
        choices.forEach((choice, i) => io.write(`  ${i + 1}. ${choice}`));
        const answer = (await io.ask("Choose a number (0 to leave):")).trim();
        if (answer === "0" || !answer)
            return -1;
        const number = Number(answer);
        if (Number.isInteger(number) && number >= 1 && number <= choices.length)
            return number - 1;
        io.write("Enter one of the numbers shown.");
    }
}
