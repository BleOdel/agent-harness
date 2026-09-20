/** Harness-owned process lifecycle. Imported only by acceptance probes in offline containers. */
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StringDecoder} from 'node:string_decoder';

const stopped = child => child.exitCode !== null || child.signalCode !== null;
const duration = value => {
  if (!Number.isInteger(value) || value < 1 || value > 60000) throw Error('Timeout must be 1–60000 ms.');
  return value;
};
function waitForExit(child, timeoutMs) {
  if (stopped(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    let timer;
    const finish = value => {clearTimeout(timer);child.removeListener('exit', exit);resolve(value);};
    const exit = () => finish(true);
    child.once('exit', exit);
    timer = setTimeout(() => finish(stopped(child)), timeoutMs);
    if (stopped(child)) finish(true);
  });
}
function signal(child, name, group) {
  try {
    if (group && child.pid) process.kill(-child.pid, name);
    else if (!stopped(child)) child.kill(name);
  } catch (error) {if (error.code !== 'ESRCH') throw error;}
}
export async function stopProcess(child, {timeoutMs = 1000, group = false} = {}) {
  duration(timeoutMs);
  try {
    // Signal the group even if its leader exited: descendants can still hold pipe handles.
    signal(child, 'SIGTERM', group);
    if (!await waitForExit(child, timeoutMs)) {
      signal(child, 'SIGKILL', group);
      if (!await waitForExit(child, timeoutMs)) throw Error('Server exit was not observed after SIGKILL.');
    }
  } finally {
    try {if (group) signal(child, 'SIGKILL', true);}
    finally {child.stdout?.destroy();child.stderr?.destroy();child.unref();}
  }
}

/** One isolated data directory spans restarts; all cleanup runs even after failed assertions. */
export async function withServer(options, observe) {
  const {command, ready, databaseEnv, cwd = '/work', env = {}, startTimeoutMs = 10000,
    stopTimeoutMs = 1000, maxOutputBytes = 1048576} = options;
  duration(startTimeoutMs);duration(stopTimeoutMs);
  if (!Array.isArray(command) || !command.length || command.some(x => typeof x !== 'string')) throw Error('Server command must be an argument array.');
  if (!(ready instanceof RegExp) || ready.global || ready.sticky) throw Error('Readiness needs a non-global RegExp with the URL in capture group 1.');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(databaseEnv)) throw Error('Specify the contracted database environment variable.');
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 16777216) throw Error('Output limit must be 1–16777216 bytes.');
  const directory = await mkdtemp(join(tmpdir(), 'harness-server-'));
  const database = join(directory, 'application.sqlite');
  let child, url, failure, outputBytes = 0, stdout = '', stderr = '', closed = false;
  const group = process.platform === 'linux';
  const stop = async () => {
    if (!child) return;
    const current = child;
    child = undefined;
    await stopProcess(current, {timeoutMs:stopTimeoutMs, group});
  };
  const start = async () => {
    if (closed || child) throw Error('Cannot start an active or closed fixture.');
    url = undefined;
    await new Promise((resolve, reject) => {
      const current = spawn(command[0], command.slice(1), {cwd, env:{...process.env,...env,[databaseEnv]:database}, detached:group, stdio:['ignore','pipe','pipe']});
      child = current;
      let pending = '', settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;clearTimeout(timer);
        if (error) reject(error);else resolve();
      };
      const fail = error => {failure ??= error;finish(error);};
      const timer = setTimeout(() => fail(Error('Server readiness timed out.')), startTimeoutMs);
      current.on('error', error => {
        // A failed spawn has no process to terminate or wait for.
        if (!current.pid) child = undefined;
        fail(error);
      });
      current.once('exit', (code, sig) => {if (!settled) fail(Error(`Server exited before readiness (code=${code}, signal=${sig}).`));});
      for (const [stream, name] of [[current.stdout,'stdout'],[current.stderr,'stderr']]) {
        const decoder = new StringDecoder('utf8');
        stream.on('data', chunk => {
          outputBytes += chunk.length;
          if (outputBytes > maxOutputBytes) {fail(Error('Server output limit exceeded.'));signal(current,'SIGKILL',group);return;}
          const text = decoder.write(chunk);
          if (name === 'stderr') {stderr += text;return;}
          stdout += text;
          if (settled) return;
          pending += text;
          const lines = pending.split('\n');pending = lines.pop();
          for (const line of lines) {
            const match = ready.exec(line.replace(/\r$/, ''));
            if (match) {
              if (!match[1]) {fail(Error('Readiness capture group 1 must contain the URL.'));return;}
              url = match[1];finish();break;
            }
          }
        });
      }
    });
  };
  const app = {directory, database, get pid(){return child?.pid;}, get child(){return child;},
    get url(){return url;}, get stdout(){return stdout;}, get stderr(){return stderr;},
    stop, async restart(){await stop();await start();}};
  let result, error;
  try {await start();result = await observe(app);if (failure) throw failure;}
  catch (caught) {error = caught;}
  finally {
    closed = true;
    try {await stop();} catch (caught) {error = error ? new AggregateError([error,caught], 'Observation and server cleanup failed.') : caught;}
    finally {try {await rm(directory,{recursive:true,force:true});} catch(caught) {error = error ? new AggregateError([error,caught], 'Observation and data cleanup failed.') : caught;}}
  }
  if (!error && failure) error = failure;
  if (error) throw error;
  return result;
}
