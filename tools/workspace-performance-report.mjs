import fs from 'node:fs/promises';
const dir=new URL('../out/workspace-performance-2026-10-07/',import.meta.url);
const read=name=>fs.readFile(new URL(name,dir),'utf8').then(JSON.parse);
const [before,after,cpuBefore,cpuAfter]=await Promise.all(['browser-baseline.json','browser-after.json','cpu-baseline.json','cpu-after.json'].map(read));
let extra={},materialBefore={};try{extra=await read('browser-materials.json');materialBefore=await read('browser-materials-baseline.json');}catch{}
const mean=(rows,count,operation)=>{const a=rows.filter(r=>r.count===count&&r.operation===operation);return a.reduce((v,r)=>v+r.ms,0)/a.length;};
const operations={load:'Abrir documento','select-one':'Seleccionar un icono','select-100':'Seleccionar 100 iconos',context:'Contexto completo de la IA',move:'Aplicar traslado por API',undo:'Deshacer','pan-20':'Desplazar: 20 pasos'};
const comparisons=[100,300,1000].flatMap(count=>Object.keys(operations).map(op=>({count,operation:operations[op],beforeMs:mean(before.rows,count,op),afterMs:mean(after.rows,count,op)})));
const round=n=>n.toFixed(1);
const selectComparison=comparisons.find(r=>r.count===1000&&r.operation===operations['select-one']);
const maximumTask=operation=>after.rows.find(r=>r.count===1000&&r.operation===operation)?.maxLongTaskMs;const lines=comparisons.map(r=>`| ${r.count} | ${r.operation} | ${round(r.beforeMs)} | ${round(r.afterMs)} | ${(r.beforeMs/r.afterMs).toFixed(1)}× |`).join('\n');
const parents=r=>r.rows.find(r=>r.count===1000).samples.map(r=>r.parentsMs).sort((a,b)=>a-b)[1];
const md=`# Rendimiento del workspace ARU · 2026-10-07

Se reprodujo la lentitud y se corrigieron cuellos de botella de la interfaz y del plugin. No hay Python en la ruta medida: el problema encontrado es trabajo síncrono del hilo principal de JavaScript, exceso de DOM y recorridos repetidos. La revisión del puente Rust muestra que las llamadas largas a los CLI usan spawn_blocking y lectores independientes para los pipes. No se hizo una auditoría exhaustiva de concurrencia ni se midió el WebView nativo. No se encontró evidencia de un deadlock en el caso reproducido; eso no certifica todos los caminos de bloqueo.

## Método

- Editor real montado mediante mountEditor en un iframe aislado, sin modificar proyectos ni llamar a modelos.
- Geometría de los 20 instrumentos ampliada a 100, 300 y 1.000 grupos. El caso mayor contiene 9.950 capas editables, más la raíz, en 848.052 bytes de ARU. Son repeticiones intencionadas para carga, no nuevos diseños únicos.
- Navegador: ${before.userAgent}. Viewport ${before.viewport.join(' × ')}.
- Tiempos desde la llamada pública hasta dos requestAnimationFrame posteriores. Incluyen comunicación del iframe y espera de pintura; el suelo de ~33 ms no equivale a 33 ms de CPU.
- Tres selecciones de un icono por tamaño (tabla: promedio). Las otras operaciones tienen una muestra por tamaño. No son percentiles ni un SLA.
- Desplazamiento: 20 eventos wheel sintéticos, uno por frame, a través del manejador real. También se probó arrastre físico con CUA y deshacer/rehacer.
- Observador de long tasks y conteo de DOM. Heap orientativo de performance.memory, sin forzar GC; no mide toda la memoria nativa/GPU.

## Antes y después

| Iconos | Operación | Antes (ms) | Después (ms) | Mejora |
|---|---|---:|---:|---:|
${lines}

## Correcciones aplicadas

1. Capas virtualizadas: conserva el árbol completo para filtros y selección por rango, pero monta solo las filas visibles y un margen. En 1.000 iconos, 4.450 filas bajaron a 26; DOM total al abrir: 88.396 → 10.733 elementos.
2. Seleccionar mediante el plugin usa la escena validada y actualiza selección, propiedades y el contexto de selección del chat. Conserva el SVG; evita recompilar, reconstruir el lienzo y revalidar todo el inventario por un clic.
3. Índice de padres con WeakMap por escena. Se invalida en operaciones estructurales, inserción, unión de trazos y actualizaciones de blueprint. Consultar los padres de 9.950 nodos en Node: mediana ${round(parents(cpuBefore))} → ${round(parents(cpuAfter))} ms. Una prueba cuenta recorridos para asegurar escalado lineal sin depender del reloj.
4. Índice de elementos SVG y límites en coordenadas del documento: pan/zoom reutilizan medidas; arrastre mide la parte afectada. Se omiten títulos de frames fuera del viewport o demasiado pequeños para ser legibles.
5. El plugin conserva la compilación validada para selección/contexto y filtra la selección tras un cambio con una sola compilación, en vez de una por elemento seleccionado.
6. Al confirmar una edición, los paths de selección se calculan en un solo recorrido, incluyendo nodos nuevos. Se quitó el segundo render del panel de capas.
7. Pan con superficie compuesta mediante translate3d y will-change:transform; evita rasterizar de nuevo los filtros en cada paso. El zoom sigue cambiando las dimensiones reales del SVG para mantener resolución. No se quitan filtros ni se alteran exportaciones. Las dimensiones del SVG solo se escriben si cambian.
8. Frontend de escritorio preparado con tools/build-desktop.mjs. El binario instalado no se reconstruyó ni se reinició; los tiempos de arriba pertenecen a Chromium.

## Validación

- Suite completa: 194 pruebas aprobadas; regresión final de edición/plugin/índices: 17 aprobadas.
- Diez verificaciones en el editor: identidad del SVG al seleccionar, fila distante accesible, selección inválida rechazada sin perder selección anterior, scroll al extremo, límite de filas DOM, 9.950 capas en contexto, límites correctos tras mover, deshacer exacto y rehacer.
- Arrastre real del instrumento 513: translate(864 1440) → translate(943.21 1494.46); deshacer y rehacer restauraron ambos estados.
- Ocho ciclos 1.000 → doce selecciones → 100 iconos. DOM final siempre 1.778 elementos; heap observado ${Math.min(...after.soak.map(r=>r.heapMB)).toFixed(1)}–${Math.max(...after.soak.map(r=>r.heapMB)).toFixed(1)} MB, termina en ${after.soak.at(-1).heapMB.toFixed(1)} MB. No se observó crecimiento sostenido en esta muestra; no demuestra ausencia de fugas.

## Materiales

La medición inicial con Fruits encontró un cuello de pintura/composición: pan de 20 pasos tardó 9.918 ms con 100 iconos y 26.919 ms con 300, aun sin long tasks de JavaScript. Esto es independiente del coste del panel de capas.

${extra.rows?.filter(r=>r.operation.startsWith('fruits-')).map(r=>`- ${r.count} iconos, ${r.operation}: ${round(r.ms)} ms; tarea larga máxima ${round(r.maxLongTaskMs)} ms; ${r.domNodes} elementos DOM.`).join('\n')||'Prueba adicional pendiente.'}

## Límites que siguen abiertos

- Con 1.000 iconos, abrir y confirmar cambios aún reconstruye el SVG completo. Tareas largas observadas: abrir ${maximumTask('load')} ms, traslado por API ${maximumTask('move')} ms, deshacer ${maximumTask('undo')} ms. La interacción de selección y desplazamiento dejó de producir tareas largas en esta muestra.
- Fruits con 300 iconos aún tardó 1.665 ms en su primera carga/pintura tras promover la superficie. El coste inicial de rasterizar efectos sigue abierto aunque pan reutilice esa superficie. Para escenas mayores o con efectos complejos, falta trasladar compilación/validación pesada a un Worker y actualizar únicamente la parte modificada del render. La exportación masiva también requiere medición separada.
- El historial guarda hasta 200 documentos completos y las miniaturas no tienen un presupuesto de bytes. Los ciclos de esta prueba reinician historial al cargar; falta una sesión larga con cientos de ediciones y muchos documentos para evaluar esos límites. No se alteró la profundidad de deshacer en este cambio.
- Falta repetir en WKWebView/Tauri, con packs anidados, producción activa e imágenes grandes. La mejora del chat evita verificar inventario en cada selección; ese escenario no fue medido con un modelo en ejecución.

## Reproducir

\`node --expose-gc tools/workspace-performance.mjs cpu-after\` prepara los fixtures y el benchmark de CPU. Iniciar \`node tools/serve.mjs 8788\` si no está abierto. Visitar /tools/workspace-performance.html y usar los botones de medición, verificación y ciclos. No requiere servicios de IA.

Evidencias: browser-materials-baseline.json, browser-baseline.json, browser-after.json, browser-materials.json, cpu-baseline.json, cpu-after.json, manual-drag.json, tests.log y regression-final.log en este directorio.
`;
await fs.writeFile(new URL('REPORT.md',dir),md);
const e=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
await fs.writeFile(new URL('index.html',dir),`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ARU · Rendimiento verificado</title><style>body{margin:0;background:#18201e;color:#e9eee8;font:16px system-ui}main{max-width:1040px;margin:auto;padding:38px 22px}h1{font-size:34px}p{max-width:780px;line-height:1.6;color:#bdc9c1}a{color:#efbd7b}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:12px 8px;border-bottom:1px solid #38493e}td:last-child{color:#a4dcb4}figure{margin:28px 0}img{max-width:100%;border-radius:10px;border:1px solid #42564a}small{color:#afc3b4}</style><main><small>ARU STUDIO · 7 OCT 2026 · PRUEBA LOCAL</small><h1>Mil iconos, sin reconstruir el lienzo por cada clic.</h1><p>La selección bajó de ${Math.round(selectComparison.beforeMs)} a ${Math.round(selectComparison.afterMs)} ms en promedio. El panel de capas monta 26 filas de las 4.450 del árbol visible. Conserva las 9.950 capas editables.</p><table><thead><tr><th>Con 1.000 iconos</th><th>Antes</th><th>Después</th><th>Mejora</th></tr></thead><tbody>${comparisons.filter(r=>r.count===1000).map(r=>`<tr><td>${e(r.operation)}</td><td>${round(r.beforeMs)} ms</td><td>${round(r.afterMs)} ms</td><td>${(r.beforeMs/r.afterMs).toFixed(1)}×</td></tr>`).join('')}</tbody></table><p>Con Fruits, desplazar 300 iconos bajó de 26,9 segundos a 0,37 segundos reutilizando la superficie gráfica. La primera carga con esos efectos aún tardó 1,7 segundos.</p><p>194 pruebas aprobadas y 10 verificaciones funcionales en el editor. Ocho ciclos de carga mantuvieron estable el número de elementos DOM.</p><p>Abrir y confirmar una edición grande todavía produce pausas de 0,2–0,32 s en el hilo principal. Son mediciones de Chromium; queda pendiente repetir en la app nativa.</p><p><a href="REPORT.md">Leer el informe completo</a> · <a href="/tools/workspace-performance.html">Abrir banco de pruebas</a></p><figure><img src="workspace-preview.png" alt="Workspace de prueba con mil instrumentos y un instrumento seleccionado"><figcaption>Documento aislado de carga; tus proyectos no se modificaron.</figcaption></figure></main></html>`);
console.log('Informe y comparativa guardados.');
