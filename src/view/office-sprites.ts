/** Original integer-grid artwork. These display personas do not create harness agents. */
type Character = {variant:number;kind:'builder'|'reviewer';role:string;task?:string;active?:boolean;location?:string};
export type Workstyle = 'developer'|'writer'|'designer'|'tester'|'reviewer';

export function workstyle(a: Pick<Character,'kind'|'role'|'task'>): Workstyle {
  if(a.kind==='reviewer') return 'reviewer';
  const classify=(text:string):Workstyle|undefined=>{
    const words=text.toLowerCase().replaceAll(/[-_]/g,' ');
    if(/\b(docs?|documentation|writer|writing|copywriter|content|technical writing)\b/.test(words)) return 'writer';
    if(/\b(design|designer|ux|ui|illustration)\b/.test(words)) return 'designer';
    if(/\b(qa|test|tests|tester|testing|quality)\b/.test(words)) return 'tester';
    if(/\b(backend|frontend|engineer|developer|coding)\b/.test(words)) return 'developer';
    return undefined;
  };
  return classify(a.role)??classify(a.task??'')??'developer';
}

const FIRST=['Maya','Leo','Noor','Theo','Ada','Erin','Kai','Felix','Iris','Jude','Zara','Arlo','Lina','Ravi','Oscar','Nina','Hugo','Esme','Finn','Cleo','Amir','June','Rosa','Eli','Sana','Otis','Nora','Luca','Milo','Tess','Idris','Ava'];
const LAST=['Chen','Okafor','Patel','Rivera','Kim','Bennett','Silva','Reed','Park','Ali','Costa','Brooks','Singh','Ito','Mensah','Clarke'];
export function personaName(index:number):string {
  const cycle=Math.floor(index/(FIRST.length*LAST.length));
  return `${FIRST[index%FIRST.length]} ${LAST[(index*7+Math.floor(index/FIRST.length))%LAST.length]}${cycle?` ${cycle+1}`:''}`;
}

const OUT='#262c3d', INK='#363c51', CREAM='#f6e8ca';
const SKIN=['#cb946e','#edbd91','#8f5c46','#ddab7d','#aa7254','#f1c7a5'];
const HAIR=['#332f40','#bb8249','#4d3435','#d1b276','#554c61','#865d43','#9c5360','#e1d5bf'];
const HAIR_LIGHT=['#57495c','#e3ad65','#795354','#f0d194','#7b7189','#b2885c','#c9797f','#fff0d6'];
// Every ordinal has a distinct hue; hair shape, skin, trim and accessories vary independently.
const accent=(n:number)=>`hsl(${(n*137.508%360).toFixed(3)} 42% 53%)`;
const r=(x:number,y:number,w:number,h:number,fill:string)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;

export function avatarSvg(a:Character):string {
  const n=a.variant, style=workstyle(a), typing=a.active&&a.location==='desk';
  const skin=SKIN[n%SKIN.length]!, hair=HAIR[n%HAIR.length]!, shine=HAIR_LIGHT[n%HAIR_LIGHT.length]!;
  const coat=accent(n), trim=['#b5ddcc','#efd290','#d7c2ee','#a7d0e5'][n%4]!;
  const shape=[0,1,3,2,4,0,5,1][n%8]!; // bob, crop, curls, ponytail, bun, swept fringe
  const long=shape===0||shape===2;
  let art=typing?'':r(8,37,17,2,'#1f26364d');
  // Boots and trouser break keep the silhouette readable at small sizes.
  if(!typing) art+=r(9,30,14,7,OUT)+r(10,30,5,6,INK)+r(18,30,4,6,INK)+r(9,36,6,2,OUT)+r(18,36,6,2,OUT);
  // The seated pose uses the room's existing desk and chair footprint.
  art+=r(8,22,17,11,OUT)+r(9,22,15,9,coat)+r(11,20,10,4,OUT)+r(12,20,8,3,skin);
  if(typing) art+=r(11,23,11,2,trim)+r(12,25,9,5,coat)+r(15,26,3,2,trim);
  else art+=r(12,23,8,3,CREAM)+r(15,25,3,6,trim)+r(19,27,3,1,CREAM);
  if(typing){
    // Reach north onto the desk keyboard. Paint arms before the head so they
    // pass beside/behind it, never across the character's back or chair.
    const hands=(left:number,right:number)=>
      r(3,7,5,20,OUT)+r(4,9,4,17,coat)+r(5,6,4,7,OUT)+r(6,7,3,6,coat)+r(7,left,5,3,skin)+
      r(25,7,5,20,OUT)+r(25,9,4,17,coat)+r(24,6,4,7,OUT)+r(24,7,3,6,coat)+r(21,right,5,3,skin);
    art+=`<g class="pose pose-a">${hands(3,4)}</g><g class="pose pose-b">${hands(4,3)}</g>`;
    // Lean toward the monitor, with the crown just below the keyboard.
    art+='<g transform="translate(0 3)">';
  }
  // Hair silhouette; varied length and profile are visible even in the back pose.
  if(long) art+=r(6,8,20,16,OUT)+r(7,9,18,14,hair);
  if(shape===4) art+=r(11,1,10,6,OUT)+r(12,2,8,4,hair)+r(13,2,4,1,shine);
  if(shape===2) art+=r(23,11,6,13,OUT)+r(24,12,4,10,hair)+r(24,14,4,2,trim);
  art+=r(9,5,14,2,OUT)+r(7,7,18,3,OUT)+r(6,10,20,7,OUT)+r(8,17,16,4,OUT)+r(11,21,10,1,OUT);
  art+=r(8,8,16,9,typing?hair:skin)+r(9,16,14,3,typing?hair:skin)+r(12,19,8,2,typing?hair:skin);
  // Ears stay visible beside the cap of hair.
  art+=r(6,13,2,4,skin)+r(24,13,2,4,skin);
  art+=r(9,6,14,3,hair)+r(7,8,18,4,hair)+r(7,11,3,5,hair)+r(23,11,2,5,hair);
  if(shape===0) art+=r(7,10,3,11,hair)+r(23,10,2,11,hair)+r(9,7,11,2,shine);
  if(shape===1) art+=r(10,4,5,3,OUT)+r(11,5,5,3,hair)+r(12,7,9,2,shine)+r(10,10,4,2,hair);
  if(shape===2) art+=r(9,7,8,2,shine)+r(9,10,9,2,hair);
  if(shape===3) art+=r(6,7,4,5,OUT)+r(23,7,4,5,OUT)+r(8,6,4,5,hair)+r(21,6,4,5,hair)+r(10,7,3,2,shine)+r(17,6,4,2,shine)+r(22,9,3,2,shine);
  if(shape===4) art+=r(10,8,11,2,shine)+r(9,10,5,2,hair);
  if(shape===5) art+=r(10,5,13,2,hair)+r(10,7,12,2,shine)+r(10,10,9,2,hair)+r(10,12,5,1,hair);
  if(typing) art+=r(10,12,13,5,hair)+r(11,17,11,2,hair)+r(11,10,3,6,shine);
  else {
    art+=r(11,13,2,2,OUT)+r(20,13,2,2,OUT)+r(12,13,1,1,CREAM)+r(20,13,1,1,CREAM)+r(16,16,2,1,'#a36a55')+r(14,18,5,1,'#945c50');
    if(n%5===3) art+=r(12,18,1,2,hair)+r(13,19,7,1,hair)+r(20,17,1,2,hair);
  }
  // Roles use recognizable tools as well as clothing, independent of gender/palette.
  if(style==='developer') art+=r(6,10,2,8,OUT)+r(24,10,2,8,OUT)+r(6,12,3,5,trim)+r(23,12,3,5,trim)+r(24,17,3,2,OUT)+r(21,18,4,1,OUT);
  if(style==='writer') art+=r(23,6,1,8,'#efc767')+r(23,5,1,2,'#e9a197')+r(23,14,1,1,OUT);
  if(style==='designer') art+=r(7,9,18,2,trim);
  if(style==='reviewer'&&!typing) art+=r(10,12,5,4,OUT)+r(18,12,5,4,OUT)+r(11,13,3,2,'#c0d8d6')+r(19,13,3,2,'#c0d8d6')+r(15,13,3,1,OUT);
  if(typing) art+='</g>';
  if(style==='writer') art+=r(11,27,1,4,CREAM);
  if(style==='designer') art+=r(11,27,2,2,'#f4b677')+r(13,29,2,2,'#a3daca')+r(19,27,2,2,'#e9b5c4');
  if(style==='tester') art+=r(10,24,3,7,trim)+r(20,24,3,7,trim)+r(20,26,2,3,CREAM)+r(21,26,1,1,'#428e83');
  if(style==='reviewer') {
    art+=r(10,23,3,6,CREAM)+r(20,23,3,6,CREAM)+r(16,26,1,4,OUT);
  }
  if(typing){
    // From this rear view only the low chair back overlaps the lower torso.
    // Match the blue room furniture; the seat and wheels remain in the backdrop.
    art+=r(9,31,15,5,OUT)+r(10,31,13,4,'#28558a')+r(11,32,11,1,'#4779b1');
  } else {
    art+=r(5,24,4,7,OUT)+r(6,24,3,5,coat)+r(6,29,3,3,skin)+r(24,24,4,7,OUT)+r(24,24,3,5,coat)+r(24,29,3,3,skin);
    if(style==='reviewer'||style==='writer'||style==='tester') art+=r(22,25,7,9,OUT)+r(23,26,5,7,style==='tester'?'#a4d9c2':CREAM)+r(24,28,3,1,'#6b8090')+r(24,30,3,1,'#6b8090');
    if(style==='designer') art+=r(24,25,1,8,CREAM)+r(24,25,1,2,'#e7a061');
  }
  return `<svg class="office-sprite" viewBox="0 0 32 40" data-workstyle="${style}" data-pose="${typing?'typing':a.location==='review'?'review':'idle'}" aria-hidden="true" shape-rendering="crispEdges">${art}</svg>`;
}

export function officeCompanions():string {
  const catBody=r(6,20,28,2,'#26344055')+r(10,12,20,9,OUT)+r(8,14,24,5,OUT)+r(11,12,17,8,'#dbab70')+r(9,15,21,4,'#edc18a')+r(18,12,7,2,'#b8794f')+r(22,15,3,3,'#b8794f')+r(12,19,14,2,'#f4d5a1')+r(5,10,12,10,OUT)+r(6,7,4,7,OUT)+r(13,8,4,6,OUT)+r(7,9,2,4,'#d8a176')+r(14,10,2,3,'#d8a176')+r(6,12,10,6,'#e6b37c')+r(7,15,3,1,OUT)+r(12,15,3,1,OUT)+r(10,17,2,1,'#a46c5e')+r(5,19,10,2,'#f4d5a1');
  const tailA=r(29,17,6,4,OUT)+r(33,13,4,6,OUT)+r(32,11,4,4,OUT)+r(29,18,6,2,'#b8794f')+r(34,14,2,5,'#dbab70')+r(33,12,2,3,'#edc18a');
  const tailB=r(29,17,5,4,OUT)+r(32,10,4,9,OUT)+r(30,8,4,4,OUT)+r(29,18,4,2,'#b8794f')+r(33,11,2,8,'#dbab70')+r(31,9,2,3,'#edc18a');
  const hover=r(10,30,20,2,'#26344044')+r(18,1,3,5,OUT)+r(18,1,3,2,'#f0ca78')+r(10,6,20,2,OUT)+r(7,8,26,4,OUT)+r(5,12,30,9,OUT)+r(8,21,24,4,OUT)+r(12,25,16,2,OUT)+r(10,8,20,3,'#eef0d9')+r(7,12,26,8,'#aecdc8')+r(9,20,22,3,'#648d91')+r(11,11,18,10,OUT)+r(12,12,16,8,'#234d60')+r(14,14,3,3,'#8defcf')+r(23,14,3,3,'#8defcf')+r(18,18,4,1,'#8defcf')+r(4,14,3,4,'#f0ca78')+r(33,14,3,4,'#f0ca78')+r(15,25,3,3,'#7ecbbb')+r(23,25,3,3,'#7ecbbb');
  return `<div class="office-companions" aria-label="Decorative office companions"><span class="office-companion office-cat" role="img" aria-label="Pip, the office cat, relaxing on the windowsill"><svg viewBox="0 0 40 24" aria-hidden="true" shape-rendering="crispEdges">${catBody}<g class="cat-tail cat-tail-a">${tailA}</g><g class="cat-tail cat-tail-b">${tailB}</g></svg><span class="companion-label">Pip · office cat</span></span><button type="button" class="office-companion office-hover" aria-label="Orbit, AI companion: show guidance" aria-controls="orbit-guidance"><svg viewBox="0 0 40 34" aria-hidden="true" shape-rendering="crispEdges">${hover}</svg><span class="companion-label">Orbit · Ask for guidance</span></button></div>`;
}

export const COMPANION_STYLE=`
.office-companion{position:absolute;pointer-events:auto;z-index:2;image-rendering:pixelated}.office-companion svg{display:block;width:100%}.office-cat{left:18%;top:7%;width:7.5%}.office-hover{left:57%;top:47%;width:6%;animation:office-float 3s steps(6) infinite}.companion-label{position:absolute;left:50%;top:100%;transform:translateX(-50%);white-space:nowrap;font:10px/1.5 ui-monospace,monospace;color:#fff0d2;background:#22333dec;padding:1px 5px;border-radius:3px;opacity:0;pointer-events:none}.office-companion:hover .companion-label{opacity:1}.cat-tail-b{visibility:hidden}.cat-tail-a{animation:cat-tail-a 3.2s steps(1) infinite}.cat-tail-b{animation:cat-tail-b 3.2s steps(1) infinite}
@keyframes cat-tail-a{0%,65%,85%,100%{visibility:visible}70%,80%{visibility:hidden}}@keyframes cat-tail-b{0%,65%,85%,100%{visibility:hidden}70%,80%{visibility:visible}}@keyframes office-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
.office-paused .office-companion,.office-disconnected .office-companion,.office-still .office-companion,.office-paused .cat-tail,.office-disconnected .cat-tail,.office-still .cat-tail{animation:none!important}.office-paused .cat-tail-a,.office-disconnected .cat-tail-a,.office-still .cat-tail-a{visibility:visible}.office-paused .cat-tail-b,.office-disconnected .cat-tail-b,.office-still .cat-tail-b{visibility:hidden}
@media(prefers-reduced-motion:reduce){.office-companion,.cat-tail{animation:none!important}.cat-tail-a{visibility:visible}.cat-tail-b{visibility:hidden}}
`;
