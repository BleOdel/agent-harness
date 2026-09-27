import type {NativeCheck} from './schema.ts';
export function nativeArguments(name:string,root:string):string[]{
 if(!/^[a-zA-Z0-9-]+$/u.test(name)||!root.startsWith('/')||/[,:\n\r]/u.test(root))throw Error('Invalid native VM mount or name.');
 return ['run','--no-graphics','--no-clipboard','--no-audio','--no-usb-accessories','--net-softnet','--dir',`harness-input:${root}/input:ro`,'--dir',`harness-output:${root}/output`,name];
}
export function guestLaunch(check:NativeCheck,nonce:string):string{
 if(!/^[a-zA-Z0-9]{32}$/u.test(nonce))throw Error('Invalid native job nonce.');
 return `#!/bin/zsh -f
set -eu
input='/Volumes/My Shared Files/harness-input'
output='/Volumes/My Shared Files/harness-output'
work='/private/tmp/harness-work'
/bin/mkdir -p "$work" /private/tmp/harness-home
/usr/bin/ditto "$input/source" "$work"
cd "$work"
set +e
/usr/bin/env -i HOME=/private/tmp/harness-home TMPDIR=/private/tmp PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin /bin/zsh -f ${check.entry} > "$output/stdout.txt" 2> "$output/stderr.txt"
code=$?
set -e
${check.artifacts.map(p=>`if [[ -f '${p}' && ! -L '${p}' ]]; then /bin/mkdir -p "$output/artifacts/${p.includes('/')?p.slice(0,p.lastIndexOf('/')):'.'}"; /bin/cp '${p}' "$output/artifacts/${p}"; fi`).join('\n')}
/usr/bin/printf '%s\\n' "$code" > "$output/exit.txt"
/usr/bin/printf '%s\\n' '${nonce}' > "$output/complete.txt"
`;
}
