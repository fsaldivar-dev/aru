import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export function modelsFromCache(cache) {
  const seen=new Set();
  return (Array.isArray(cache?.models)?cache.models:[]).filter(m=>m && m.visibility==='list' && typeof m.slug==='string' && /^[A-Za-z0-9._:/-]{1,64}$/.test(m.slug) && !seen.has(m.slug) && seen.add(m.slug)).map(m=>({id:m.slug,label:typeof m.display_name==='string'?m.display_name:m.slug}));
}
export function localModelCatalog(provider, home=process.env.CODEX_HOME || path.join(os.homedir(),'.codex')) {
  if(provider!=='codex') return {};
  try {const cache=JSON.parse(fs.readFileSync(path.join(home,'models_cache.json'),'utf8')),models=modelsFromCache(cache);return models.length?{models,modelSource:'local-cache'}:{};} catch {return {};}
}
