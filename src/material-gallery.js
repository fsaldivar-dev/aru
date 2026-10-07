import {mountEditor,listMaterials} from '../plugin/index.js';
const $=s=>document.querySelector(s),materials=listMaterials();
const backgrounds={base:'#F7F7FA',neon:'#191426',chrome:'#182130',glass:'#EFF4FA',clay:'#F7F1EB',fruits:'#EFF5E8'};
const descriptions={neon:'Luz & resplandor',chrome:'Metal & reflejos',glass:'Cristal tintado',clay:'Volumen mate',fruits:'Gel & color'};
let chosen='neon',size=48,baseView=false,busy=false,ready=false;
function updateCollection(){
 const id=baseView?'base':chosen,label=baseView?'Base':materials.find(m=>m.id===id).label;
 const grid=$('.icon-grid');grid.dataset.current=id;grid.style.setProperty('--tile',backgrounds[id]);grid.style.setProperty('--preview',size+'px');
 for(const tile of grid.querySelectorAll('[data-icon]')){const url=`${id}/${tile.dataset.icon}-${size}.png`;tile.href=url;const img=tile.querySelector('img');img.src=url;img.width=size;img.height=size;}
 for(const button of document.querySelectorAll('[data-material]')){const active=button.dataset.material===chosen&&!baseView;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));}
 for(const button of document.querySelectorAll('[data-size]'))button.setAttribute('aria-pressed',String(Number(button.dataset.size)===size));
 $('#show-base').setAttribute('aria-pressed',String(baseView));$('#show-base').textContent=baseView?'Volver al acabado':'Ver base';
 $('#current-material').textContent=baseView?'Base · Trazo original':`${label} · ${descriptions[id]}`;
 $('#download-material').href=`${id}-50.zip`;$('#download-material').textContent=`Descargar ${label} ↓`;$('#download-source').href=`${id}.aru`;$('#material').value=chosen;
}
for(const button of document.querySelectorAll('[data-material]'))button.onclick=()=>{chosen=button.dataset.material;baseView=false;updateCollection();};
for(const button of document.querySelectorAll('[data-size]'))button.onclick=()=>{size=Number(button.dataset.size);updateCollection();};
$('#show-base').onclick=()=>{baseView=!baseView;updateCollection();};$('#material').onchange=()=>{chosen=$('#material').value;baseView=false;updateCollection();};
const status=$('#status');
const agents={detect:async()=>await(await fetch('/api/agents',{headers:{'x-aru-bridge':'1'}})).json(),run:async args=>await(await fetch('/api/agents/run',{method:'POST',headers:{'content-type':'application/json','x-aru-bridge':'1'},body:JSON.stringify(args)})).json()};
try{
 const response=await fetch('base.aru');if(!response.ok)throw new Error('No se pudo abrir la base');
 const text=await response.text();const editor=mountEditor($('#editor'),{text,name:'CatArt · mesa de materiales',studioUrl:'../../index.html',agents,onChange:()=>{if(ready&&!busy){status.classList.remove('error');status.textContent='Lienzo actualizado · puedes deshacer';}}});
 await editor.ready;await editor.select([document.body.dataset.group]);ready=true;status.textContent='50 iconos seleccionados · base original';$('#apply').disabled=false;$('#undo').disabled=false;
 const action=async run=>{if(busy)return;busy=true;$('#apply').disabled=$('#undo').disabled=true;status.classList.remove('error');try{await run();}catch(e){status.textContent=e.message;status.classList.add('error');}finally{busy=false;$('#apply').disabled=$('#undo').disabled=false;}};
 $('#apply').onclick=()=>action(async()=>{const before=await editor.getDocument();const r=await editor.refine([{op:'material',target:'selection',preset:chosen}],{mode:'style',expectedRevision:before.revision});status.textContent=`${materials.find(m=>m.id===chosen).label} aplicado · ${r.changed.length} piezas · puedes deshacer`;});
 $('#undo').onclick=()=>action(async()=>{await editor.undo();status.textContent='Cambio deshecho';});
}catch(e){status.textContent=e.message;status.classList.add('error');}
