import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
const python = `import os, pty, select, sys, time, signal
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
transcript = b''
position = 0
def expect(text):
    global transcript, position
    deadline = time.monotonic() + 90
    token = text.encode()
    while token not in transcript[position:]:
        if time.monotonic() > deadline: raise RuntimeError('Timed out waiting for ' + text)
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            chunk = os.read(fd, 65536)
            if not chunk: raise RuntimeError('Terminal ended waiting for ' + text)
            transcript += chunk
    position = transcript.index(token, position) + len(token)
def answer(prompt, text):
    expect(prompt)
    os.write(fd, (text + '\\n').encode())
def finish(expected):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try: transcript_chunk = os.read(fd, 65536)
            except OSError: transcript_chunk = b''
            if transcript_chunk: sys.stdout.buffer.write(transcript_chunk)
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            if os.waitstatus_to_exitcode(status) != expected: raise RuntimeError('Unexpected terminal exit ' + str(status))
            return
    raise RuntimeError('Terminal did not exit')
try:
`;
const ending = `
finally:
    sys.stdout.buffer.write(transcript)
    try: os.kill(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    os.close(fd)
`;
export async function ptyRun(root:string,env:NodeJS.ProcessEnv,body:string,args:string[]) {
 const script=path.join(root,"terminal.py");await writeFile(script,python+body+ending);
 return promisify(execFile)("python3",[script,process.execPath,path.resolve(import.meta.dirname,"../src/cli.ts"),...args],{env,timeout:180000,maxBuffer:2*1024*1024});
}
