# ARU como componente y herramienta para IA

El paquete `@fsaldivar.dev/aru` reúne el editor, el motor de documentos y el comando `aru`. Conserva el flujo de ARU Studio: la IA interpreta una referencia, el trazador genera las regiones y la IA propone ajustes que solo se conservan cuando mejoran la puntuación. Las capas, curvas, agrupación por piezas, glifos, packs y fondos opacos permanecen editables.

## Instalación

Node 22 o superior para la CLI. El componente visual solo requiere un navegador moderno.

```sh
npm install @fsaldivar.dev/aru
npx aru help
npx aru serve --port 8787
```

Para usar `aru` directamente en la terminal, instala con `npm install -g @fsaldivar.dev/aru`. Sharp se carga únicamente desde la entrada `@fsaldivar.dev/aru/node`, para leer referencias y rasterizar sin navegador. La entrada principal no tiene dependencias de Node. La producción por lotes, las pausas y la reanudación se describen en [Producción de iconos](./produccion-iconos.md).

## Editor embebido

Sirve los archivos del paquete mediante HTTP(S), preservando las carpetas `src`, `plugin`, `trace` y `vision` junto a `index.html`. El montaje usa un iframe para aislar los estilos y los identificadores del editor; admite varias instancias. Se necesita espacio para sus tres paneles (recomendado: 1100 × 650 o mayor).

```js
import { mountEditor } from '@fsaldivar.dev/aru';

const editor = mountEditor(document.querySelector('#ilustrador'), {
  studioUrl: '/aru/index.html',
  name: 'Mi ilustración',
  text: documentoAru,
  onChange: ({ text, name, revision }) => guardarEnMiAplicacion(text, name, revision),
  agents: {
    detect: () => miTransporte.detect(),
    run: request => miTransporte.run(request),
    cancel: ({ runId }) => miTransporte.cancel(runId),
  },
  timeout: 120000,
});
await editor.ready;
await editor.ask("Cambia el ojo a azul", { provider: "claude", review: 1 });
const context = await editor.context();
await editor.select(['personaje.ojo']);
const preview = await editor.preview([{ op: 'set', target: 'selection', fill: '#2277DD' }]);
await editor.apply([{ op: 'set', target: 'selection', fill: '#2277DD' }], {
  expectedRevision: context.revision,
});
const pngDataUrl = await editor.png(); // PNG opaco
editor.destroy();
```

El contenedor necesita una altura explícita. `ready` confirma que el documento inicial está cargado. `getDocument`, `load`, `context`, `select`, `apply`, `preview`, `insert`, `trace`, `undo`, `redo`, `ask`, `svg`, `png` y `destroy` son la API pública. `trace` recibe `{ name, mime, data }`, donde `data` es base64 sin prefijo. Los métodos son asíncronos.

El host guarda el documento. En modo embebido ARU no abre su biblioteca ni escribe documentos, preferencias o conversaciones en localStorage. `onChange` incluye la carga inicial y cada cambio aceptado; si necesitas conservar conversaciones, corresponde hacerlo en el host. Los menús para crear/importar documentos quedan deshabilitados: usa `load` desde tu programa. El cambio de documento cancela la consulta de IA anterior. Los mensajes se validan por origen, ventana y canal. El transporte de agentes es responsabilidad del host; nunca expongas el puente de ejecución de CLIs directamente a Internet.

## CLI para una IA

```sh
aru new --out trabajo.aru --width 800 --height 600
aru context trabajo.aru
aru schema
aru render trabajo.aru --out antes.png
aru trace trabajo.aru --image referencia.png --reference ajustes.json --out trazado.aru
aru ask trazado.aru --message "Transforma la referencia en un icono móvil de Sajaru Box" \
  --image referencia.png --provider claude --review 1 --out icono.aru
aru render icono.aru --out icono.png --width 1024
```

Ejemplo de `ajustes.json` (también admite `parts`, `crop`, `abstraction`, `keepBackground`, `dropHoles`):

```json
{
  "label": "Sajaru móvil",
  "crop": { "x": 0, "y": 0, "w": 0.5, "h": 1 },
  "backdrop": {
    "shape": "squircle",
    "style": "glyph",
    "color": "#245747",
    "glyphColor": "#FFFFFF",
    "depth": 0.3
  },
  "w": 256,
  "h": 256
}
```

`x` e `y`, si se indican, son el centro del resultado en coordenadas de lienzo, como en la GUI. `w`/`h` delimitan el tamaño máximo; el contenido se ajusta conservando proporciones. El lienzo crece si hace falta y la distribución evita solapamientos.

Para editar, primero consulta el contexto y mira el render; después previsualiza un lote:

```sh
aru context icono.aru --select Sajaru_movil.motivo
aru preview icono.aru --ops cambios.json --out propuesta.svg
aru apply icono.aru --ops cambios.json --out editado.aru --expected-hash HASH_DEL_CONTEXT
aru apply icono.aru --ops cambios.json --dry-run
```

Los targets son rutas de capas, `selection`, o selectores `part:`, `role:`, `type:`, `semantic:`, `name:`. `smooth`, `simplify`, `weld` y `connect` son las herramientas de trazos ya disponibles en el Studio. La selección se pasa mediante `--select ruta1,ruta2`. `aru insert` incorpora ARU editable; `--into grupo` agrega un detalle escrito en coordenadas de lienzo, dentro de un grupo con escala uniforme y rotación. Los fondos nuevos son capas editables y cada PNG exportado se compone sobre un fondo opaco.

La salida estándar es JSON; el progreso va a stderr y los errores terminan con código 1. `--ops -` recibe JSON por stdin. Los comandos de edición requieren `--out`, `--write` o `--dry-run`; `new` y las salidas nuevas no sobrescriben archivos existentes sin `--force`. Los lotes se validan completos antes de guardar. `expected-hash` detecta un contexto desactualizado; además se comprueba que el archivo no cambió durante una consulta de IA. La escritura usa un archivo temporal y renombrado. `preview` y `dry-run` conservan el original.

`aru agents` muestra los proveedores instalados. `ask` usa la autenticación de sus CLIs y la misma guía/esquemas de la GUI; soporta hasta tres referencias, revisión 0/1/2, agrupación por piezas, limpieza de glifos y revisión/prueba ciega de packs. Las referencias se limitan a 1024 px, igual que en el chat visual. Cada llamada es independiente; para conversación persistente usa `askIllustrator(..., { history })` en la API Node y guarda el historial en tu host.

## Motor sin interfaz

```js
import { createIllustrator } from '@fsaldivar.dev/aru';
import { traceInto, askIllustrator, renderPng } from '@fsaldivar.dev/aru/node';
const doc = createIllustrator({ text: documentoAru });
await traceInto(doc, '/ruta/base.png', { label: 'Ilustración' });
await askIllustrator(doc, { message: 'Cambia el ojo a azul', provider: 'claude' });
const png = await renderPng(doc.getDocument().text);
doc.undo();
```

El motor, el trazador y las revisiones son compartidos. El navegador mide texto mediante SVG; la CLI usa límites conservadores y un rasterizador diferente. Puede haber pequeñas diferencias de tipografía, antialiasing y colocación: evalúa siempre el PNG/SVG final. El paquete mantiene los límites del trazador actual, como las regiones del mismo color que atraviesan varias partes. El iframe conserva el editor completo; la extracción de paneles individuales es una ampliación futura.

## Casos de uso

- Generar variantes de iconos móviles y de escritorio desde el mismo logotipo.
- Incorporar un editor de ilustraciones en un IDE, conservando sus archivos y persistencia.
- Procesar varias referencias por CLI y revisar resultados antes de incorporarlos al catálogo.
- Ajustar una capa seleccionada desde el asistente del programa anfitrión.
- Crear packs consistentes y revisar legibilidad a 24 px con la prueba ciega.
- Preparar una propuesta sin tocar el documento mediante `preview` o `dry-run`.
- Producir ARU editable, SVG y PNG opaco a partir de una misma base.

## Discovery autónomo del proyecto

Desde ARU 0.2.0, `discover` investiga el producto y crea una identidad nueva sin recibir imágenes del usuario. En 0.3.0 también busca, recupera y observa referencias visuales antes de decidir el concepto final. La herramienta lee el README de un directorio local o el README de una revisión concreta de GitHub; si un repositorio remoto no tiene README, recoge hasta cuatro archivos pequeños de configuración/entrada como evidencia y declara la inferencia. GitHub utiliza la autenticación existente de `gh`.

```sh
aru discover --repo https://github.com/owner/project \
  --style "Material 3 Expressive" --out nuevo-icono.aru
aru render nuevo-icono.aru --out nuevo-icono.png --width 512

# Investigar y revisar las tres direcciones sin dibujar todavía:
aru discover --repo /ruta/al/proyecto --style "Frutiger Aero" --plan
```

Discovery habilita exclusivamente `WebSearch` y `WebFetch` en el puente de Claude; sin shell, escritura ni conectores MCP. En esta versión requiere Claude instalado y autenticado, además de `gh` para GitHub. La generación sigue usando el puente habitual sin herramientas web. No existe aún un botón de discovery en el editor; un host embebido puede llamarlo desde su backend Node y cargar el documento devuelto.

```js
import { discoverIllustration } from '@fsaldivar.dev/aru/node';
const result = await discoverIllustration({
  repo: 'https://github.com/owner/project',
  style: 'Minimalista monocromático',
  progress: (phase, status) => console.log(phase, status),
});
await editor.load(result.text, result.name);
// El host persiste result.text y result.report.
```

La IA del discovery decide sus propias consultas, encuentra referencias conceptuales/de estilo y propone tres direcciones. El informe JSON incluye evidencia del proyecto, consultas reales, resultados web, fuentes, concepto elegido y breve de dibujo. Se exige una búsqueda completada y que cada URL citada aparezca en los resultados o en una lectura completada; si falla la investigación, no se genera un icono con referencias inventadas. Esto comprueba procedencia, no la veracidad de todas las afirmaciones de cada página.

Por defecto, el agente elige consultas de imágenes cortas y genéricas. ARU busca candidatos en Openverse y Wikimedia Commons y recoge imágenes editoriales de las páginas que encontró su propia investigación. Recupera vistas previas PNG/JPEG/WebP/GIF/AVIF, muestra una lámina numerada a la IA y exige seleccionar 2–3 referencias con observaciones sobre sus píxeles y su utilidad. El concepto se puede reconsiderar después de verlas. El dibujo recibe esas imágenes como inspiración y el revisor recibe el moodboard; también se conservan durante una reparación de sintaxis. No son una calca del logo vigente. `--text-only` permite el flujo anterior de referencias de texto. La IA dibuja una interpretación editable en ARU con canvas fijo de 512 × 512 y fondo opaco. No traza el logo previo y no produce materiales 3D reales ni un archivo nativo de Icon Composer. Discovery revisa el render final y las muestras a 48/24 px contra el concepto y el estilo. Por defecto permite un redibujo y vuelve a evaluar el resultado; `--review 0` omite esa fase y `--review 2` permite dos redibujos. El informe conserva el dibujo inicial y los motivos de cada decisión. Es una evaluación del modelo, no una garantía de calidad visual.

La lectura del repositorio se envía al proveedor de IA elegido, igual que el contexto de `ask`; el sistema indica buscar únicamente conceptos genéricos y mantener nombres/datos privados fuera de las consultas. Los documentos se tratan como evidencia y no autorizan ejecutar instrucciones contenidas en ellos.

### Referencias visuales y propuestas rechazadas

`aru discover --repo URL --style "Frutiger Aero" --previous borrador.aru --feedback "La propuesta anterior no me gustó" --out nuevo.aru` vuelve a investigar y muestra el borrador rechazado al agente visual para evitar repetirlo. `--previous` también admite PNG/JPEG. El CLI guarda las imágenes seleccionadas y `moodboard.png` en `nuevo.references/`; stdout contiene rutas, URLs, autor/licencia disponible, hashes y observaciones, sin base64. La API Node conserva los píxeles PNG en `report.discovery.visual.images[].data` (base64) para que el host los guarde.

La recuperación utiliza HTTPS público, valida y fija las direcciones DNS, revisa cada redirección y limita tamaño, tiempo y formatos. No utiliza sesiones ni cookies de navegador. Si no se pueden recuperar dos imágenes, la IA considera que menos de dos son útiles o la selección cita una imagen inexistente, el discovery falla antes de dibujar. Fuente y licencia proceden del catálogo o de la página, no son una verificación legal de reutilización: las referencias sirven para extraer principios visuales y generar formas nuevas.

Los catálogos consultados son [Openverse API](https://api.openverse.org/v1/) y [Wikimedia Commons / Imageinfo](https://www.mediawiki.org/wiki/API:Imageinfo). No cubren todos los estilos y pueden devolver fotografías o resultados poco pertinentes; el informe registra candidatos, consultas, selección y fallos de recuperación.

## Perfiles de estilo y propósito

`aru styles` devuelve diez perfiles de apariencia. Consulta [el catálogo](estilos.md). `discover --style` admite tanto sus identificadores como nombres libres. Los perfiles aportan materiales, paletas y restricciones, sin proporcionar imágenes ni imponer el concepto. El discovery sigue buscando y observando sus propias referencias.

Desde 0.3.1, el revisor evalúa `purposeMatch` independientemente de `conceptMatch`, `styleMatch` y `smallLegibility`; solo acepta cuando los cuatro son verdaderos. Una representación consistente con el concepto puede fallar si comunica otra categoría de producto. Las correcciones humanas en `--feedback` tienen prioridad sobre inferencias del nombre o de funciones secundarias. Es una evaluación de IA: puede equivocarse y su aceptación no sustituye la revisión humana.

```sh
aru styles
aru discover --repo /ruta/proyecto --style dark-aero --out oscuro.aru
aru discover --repo /ruta/proyecto --style funky-seasons --out color.aru
aru discover --repo /ruta/proyecto --style "Y2K cromado" \
  --previous anterior.aru \
  --feedback "La función principal es automatización móvil; el disco comunica música" \
  --out nuevo.aru
```

Los informes anteriores a 0.3.1 no contienen `purposeMatch`. Añadir un perfil no significa que todos sus posibles resultados estén verificados visualmente.

## Refinar una base protegida (0.4)

Selecciona piezas existentes. En el Asistente IA, `Conservar base → Cambiar estilo` permite solo pintura, grosor, opacidad, sombra y relieve. `Afinar curvas` permite `smooth` y `simplify` acotados. Ambos rechazan dibujos nuevos, borrados, renombres, movimientos, cambios fuera de selección y cambios que afecten descendientes bloqueados. Cada respuesta se valida antes de editar y conserva un paso de deshacer. El modo libre sigue disponible para crear otras ilustraciones.

```sh
aru refine base.aru --select Icono.Gato --mode style --message "Trazo violeta con resplandor suave" --out neon.aru
aru refine base.aru --select Icono.Gato --mode contour --message "Afina las curvas conservando las esquinas" --out curvas.aru
```

Node: `refineIllustration(session, {message, mode, provider, transport})`. API compartida: `session.previewRefinement(operations, {mode})` y `session.refine(operations, {mode, expectedRevision})`. Editor embebido: `editor.refine(operations, options)` y `editor.ask(message, {refine:'style'})` sobre una selección explícita.

Este modo conserva geometría y estructura; no garantiza por sí solo parecido perceptual. No agrega nueva geometría, poses o expresiones. Desde 0.5 puede crear degradados mediante las recetas de material descritas abajo. Las curvas admitidas son las de las herramientas existentes. Las coordenadas se serializan sin redondearlas en el refinamiento protegido. ARU con nombres que requieren normalización al expandir generadores puede ser rechazado por el guardián de identidad; utiliza una base con nombres estables.

Discovery conserva el borrador revisado con mayor puntuación de criterios cumplidos: propósito (8), concepto (4), estilo (2), legibilidad (1). Un empate conserva la versión anterior. `quality.selectedRound` identifica el resultado devuelto; cada revisión incluye `score` y `kept`. Es una comparación de criterios del modelo, no una medición objetiva de calidad artística.

## Exportar un lote de iconos (0.4)

`Archivo → Exportar iconos por lote…`: elige el grupo que contiene un subgrupo por icono, marca todos o algunos, indica tamaños PNG y formatos, y descarga un ZIP. La vista previa muestra cada icono aislado. El fondo es opaco y configurable. No se modifica el documento fuente.

```sh
aru export-icons pack.aru --group iconos_app --out iconos.zip --sizes 24,48,96 --formats png,svg,aru
aru export-icons pack.aru --group iconos_app --select iconos_app.inicio,iconos_app.buscar --cell fit --out seleccion.zip
```

El ZIP contiene `png/24/nombre.png`, `png/48/nombre.png`, etc., `svg/nombre.svg`, `aru/nombre.aru` y `manifest.json` con la correspondencia de nombres, paths y archivos. Los nombres repetidos reciben sufijos. Se conserva la pintura heredada y los gradientes utilizados; se retira la posición/escala de presentación de los ancestros del lote. La celda de 24 unidades mantiene la retícula de iconos UI. `--cell fit` centra cada icono con una celda común suficientemente grande para sus límites conservadores. Los recortes externos al icono se rechazan: deben estar dentro de él.

API Node: `exportIconArchive(text, options)` devuelve `{data:Uint8Array, manifest, fileCount}`. Editor embebido: `editor.exportIcons(options)` devuelve el mismo contrato. API navegador: `buildIconArchive(text, options, renderPng)`; `prepareIconExports` y `listIconBatches` permiten construir una interfaz anfitriona propia. Máximo 250 iconos, ocho tamaños de 16–2048 px y 64 millones de píxeles por lote PNG. Los PNG de distintos tamaños son renders de la misma geometría; aún no hay variantes ópticas específicas para tamaños pequeños.

## Materiales sobre una base existente (0.5)

`Asistente IA → Material → Aplicar a selección` usa la misma operación protegida que el CLI y el editor embebido. Elige el lote completo o piezas concretas. No requiere ejecutar un modelo; también puedes pedir el material en el chat con `Conservar base → Cambiar estilo`.

```sh
aru materials
aru material base.aru --select iconos_app --style chrome --out cromado.aru
aru material base.aru --select iconos_app --style neon --color '#38B9FF' --strength 0.7 --out neon.aru
aru refine base.aru --select iconos_app --mode style --message "Transforma esta familia en Fruits" --out fruits.aru
```

```js
import { createIllustrator, listMaterials } from '@fsaldivar.dev/aru';
const session = createIllustrator({text, selection:['iconos_app']});
session.refine([{op:'material', target:'selection', preset:'chrome', color:'#7691B8', strength:1}]);
// La misma operación admite editor.refine(...) en el editor embebido.
```

Recetas: `neon` (emisión), `chrome` (bandas de reflexión), `glass` (cristal tintado), `clay` (relieve mate), `fruits` (gel y brillo radial en superficies rellenas). `color` opcional debe ser #RRGGBB; `strength` mayor que cero y hasta uno. La operación conserva canales sin pintura, huecos, geometría, transforms, opacidad, grosor efectivo de trazos y grupos semánticos. Crea degradados sin modificar definiciones de la base; la exportación aislada incluye únicamente los utilizados. Los efectos reemplazan los efectos propios de las piezas seleccionadas; efectos heredados del grupo se siguen componiendo.

Cada pieza pintada recibe el material elegido. Para conservar contraste entre fondo y símbolo, selecciona solo la superficie o aplica materiales diferentes a las piezas. Una selección uniforme no analiza automáticamente el contraste ni asigna funciones de fondo/símbolo. Los materiales son una aproximación vectorial 2D: sin refracción de un fondo, luces físicas ni volumen 3D real. En trazos de 2 unidades los reflejos pierden detalle a 24 px; las variantes ópticas quedan pendientes. Al cambiar de material se conservan degradados anteriores globales para proteger sus posibles usuarios; una herramienta futura puede limpiar los que ya no se usan.

Prueba reproducible: `node tools/material-family-bench.mjs --ai`. Ejecuta cinco pedidos breves con el CLI de IA sobre una copia de CatArt, conserva informes y exporta 50 iconos por material a 24/48/96 px. `--replay` reproduce las operaciones guardadas sin otra llamada a IA. Galería y ZIPs: `out/material-family-2026-10-07/`.
