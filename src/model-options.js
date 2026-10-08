import { PROVIDERS } from './agents.js';
export const validModel = value => typeof value==='string' && (value==='' || /^[A-Za-z0-9._:/-]{1,64}$/.test(value));
export function modelOptions(provider, agent, selected='') {
  const raw=Array.isArray(agent?.models)&&agent.models.length?agent.models:PROVIDERS.find(p=>p.id===provider)?.models || [];
  const seen=new Set(['']);
  const models=[{id:'',label:'Predeterminado del CLI'}];
  for(const item of raw) {const id=typeof item==='string'?item:item?.id;if(!id || !/^[A-Za-z0-9._:/-]{1,64}$/.test(id)||seen.has(id)) continue;seen.add(id);models.push({id,label:typeof item?.label==='string'?item.label:id});}
  if(selected && !seen.has(selected)) models.push({id:selected,label:selected+' · personalizado'});
  return models;
}
