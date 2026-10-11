/** Command signal handling delegates all build orchestration to the workflow service. */
import { runOrdinaryBuild } from '../workflow/work.ts';
export async function work(argv: readonly string[]): Promise<void> {
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error('Implementation cancelled by operator signal.'));
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    try {
        return await runOrdinaryBuild(argv, controller.signal);
    }
    finally {
        process.off('SIGINT', cancel);
        process.off('SIGTERM', cancel);
    }
}
