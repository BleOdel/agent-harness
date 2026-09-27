export function stoppedVMs(raw:unknown):boolean {
 if(!Array.isArray(raw)||raw.length!==1)return false;
 const vm=raw[0];return vm&&typeof vm==='object'&&vm.Name==='job'&&vm.State==='stopped';
}
export function outputMount(raw:unknown,imagePath:string,mountPath:string):'absent'|'owned'{
 const images=(raw as {images?:unknown[]})?.images;if(!Array.isArray(images))throw Error('Invalid disk image inventory.');
 const image=images.find((value:any)=>value?.['image-path']===imagePath) as any;if(!image)return 'absent';
 const mounts=image['system-entities'];if(!Array.isArray(mounts)||!mounts.some(m=>m['mount-point']===mountPath)||mounts.some(m=>m['mount-point']&&m['mount-point']!==mountPath))throw Error('Native output image is mounted at an unexpected location.');return 'owned';
}
