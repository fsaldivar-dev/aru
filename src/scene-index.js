// Tree indices live outside the serializable scene and do not retain discarded documents.
const indices = new WeakMap();
export function invalidateSceneIndex(scene) { indices.delete(scene); }
export function sceneIndex(scene) {
  let index = indices.get(scene);
  if (!index) {
    index = { parents: new Map() };
    const walk = parent => { for (const child of parent.children || []) { index.parents.set(child, parent); walk(child); } };
    walk(scene.root); indices.set(scene, index);
  }
  return index;
}
export const indexedParent = (scene, node) => sceneIndex(scene).parents.get(node) || null;
