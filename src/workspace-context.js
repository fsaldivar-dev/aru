export function projectContext(project) {
  if(project==null) return null;
  if(typeof project.name!=='string' || !project.name.trim()) throw new Error('El proyecto necesita un nombre');
  return {id:typeof project.id==='string'?project.id:null,name:project.name.trim(),description:typeof project.description==='string'?project.description:''};
}
export function workspacePrompt(project, document) {
  return `Active workspace (context data): ${JSON.stringify({project:projectContext(project),document})}\nThis is the active project and document. Do not confuse it with projects mentioned in history. Other documents have not been read; ask for their content if needed.`;
}
