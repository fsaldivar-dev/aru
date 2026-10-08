import test from 'node:test';
import assert from 'node:assert/strict';
import {compile} from '../src/engine.js';
import {parentOf,group,ungroup,moveInto,duplicate,remove,addShape,insertFragment} from '../src/edit.js';
import {layerWindow,LAYER_ROW_HEIGHT} from '../src/layer-window.js';
import {createIllustrator,documentContext,sceneContext} from '../plugin/core.js';

test('parent lookup traverses once, rather than once for each of 10,000 nodes',()=>{
 let reads=0;
 const children=Array.from({length:10000},()=>({get children(){reads++;return [];}}));
 const scene={root:{get children(){reads++;return children;}}};
 for(const child of children) assert.equal(parentOf(scene,child),scene.root);
 assert.equal(reads,10001);
 assert.equal(parentOf(scene,scene.root),null);
});

test('parent index follows grouping, ungrouping, duplication, moving, addition and deletion',()=>{
 let scene=compile('group a { circle one {} circle two {} } group b {}').scene;
 const a=scene.byPath.get('a'),b=scene.byPath.get('b'),one=scene.byPath.get('a.one'),two=scene.byPath.get('a.two');
 assert.equal(parentOf(scene,one),a);
 const g=group(scene,[one.id,two.id]);assert.equal(parentOf(scene,one),g);assert.equal(parentOf(scene,g),a);
 // A newly authored node receives an id on recompile, as in the editor.
 scene=compile(toAru(scene)).scene;
 const node=scene.byPath.get('a.Grupo');const kids=node.children.slice();
 ungroup(scene,node.id);assert.equal(parentOf(scene,node),null);assert.equal(parentOf(scene,kids[0]),scene.byPath.get('a'));
 const c=duplicate(scene,[kids[0].id])[0];assert.equal(parentOf(scene,c),scene.byPath.get('a'));
 moveInto(scene,[kids[0].id],scene.byPath.get('b').id);assert.equal(parentOf(scene,kids[0]),scene.byPath.get('b'));
 const added=addShape(scene,'circle');assert.equal(parentOf(scene,added),scene.root);
 remove(scene,[kids[0].id]);assert.equal(parentOf(scene,kids[0]),null);
 const imported=insertFragment(scene,compile('group imported { circle z {} }').scene);assert.equal(parentOf(scene,imported),scene.root);assert.equal(parentOf(scene,imported.children[0]),imported);
});
import {toAru} from '../src/serialize.js';

test('virtual rows preserve complete scroll range with bounded DOM at the start, middle and end',()=>{
 for(const scroll of [0,155000,310000,999999]) {
  const w=layerWindow(10000,scroll,500);
  assert.ok(w.end-w.start<=33);
  assert.equal(w.before+(w.end-w.start)*LAYER_ROW_HEIGHT+w.after,310000);
  assert.ok(w.start>=0&&w.end<=10000&&w.end>=w.start);
 }
 assert.deepEqual(layerWindow(0,1000,500),{start:0,end:0,before:0,after:0});
});

test('cached plugin context and selection stay current after edit, undo, redo and rejected input',()=>{
 const text='group a { circle one { radius 2 } } group b { rect two {} }';
 const app=createIllustrator({text});app.select(['a.one','b.two']);
 app.apply([{op:'translate',target:'selection',dx:10,dy:2}]);
 assert.deepEqual(app.context().selection,['a.one','b.two']);assert.equal(app.context().layers.find(n=>n.path==='a.one').bounds[0],8);
 assert.equal(app.undo(),true);assert.equal(app.context().layers.find(n=>n.path==='a.one').bounds[0],-2);
 assert.equal(app.redo(),true);assert.equal(app.context().layers.find(n=>n.path==='a.one').bounds[0],8);
 assert.throws(()=>app.load('garbage {'));assert.equal(app.context().layers.find(n=>n.path==='a.one').bounds[0],8);
 app.apply([{op:'delete',target:'a.one'}]);assert.deepEqual(app.context().selection,['b.two']);assert.throws(()=>app.select(['a.one']));
 assert.deepEqual(sceneContext(compile(text).scene),documentContext(text));
});
