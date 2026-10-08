# ARU Studio

Ilustraciones editables a partir de referencias, un editor embebible y una CLI para que una IA pueda trabajar con el mismo motor que la interfaz gráfica.

ARU representa una ilustración como un documento de texto `.aru`: capas, piezas semánticas, trazos, curvas, colores y materiales. Puedes interpretar una imagen de base, ajustar sus piezas y transformarla en otros estilos. El motor se encarga de la geometría y del render; la IA recibe el contexto del documento y propone operaciones estructuradas.

## Instalación

Requiere **Node.js 22 o superior** para la CLI y la API de Node.

```sh
npm install -g @fsaldivar.dev/aru
aru serve --port 8787
```

Abre http://localhost:8787 para usar ARU Studio. Los documentos del editor se guardan localmente. Para integrarlo en otra aplicación:

```sh
npm install @fsaldivar.dev/aru
```

## Crear y transformar

```sh
aru new --out base.aru --width 800 --height 600
aru trace base.aru --image referencia.png --out ilustracion.aru
aru context ilustracion.aru
aru ask ilustracion.aru --message "Transforma esta base en un icono de escritorio" \
  --image referencia.png --provider claude --out icono.aru
aru render icono.aru --out icono.png --width 1024
```

Las consultas de IA utilizan CLIs instaladas y autenticadas por separado. `aru agents` muestra los proveedores disponibles; `aru help` y `aru schema` describen los comandos y el contrato para agentes. Consultar, editar mediante operaciones, trazar, renderizar y exportar no requiere un proveedor de IA.

## Producción por lotes

El comando `produce` divide una solicitud grande en lotes, valida los resultados, rechaza duplicados de nombres, geometría y silueta, y conserva un checkpoint. No considera terminado un trabajo mientras falten iconos aceptados.

```sh
aru produce base.aru --message "Crea 320 iconos distintos para un reproductor de música vintage" \
  --provider claude --job trabajo.json --out pack.aru

# Reanudar un trabajo pausado con su documento y checkpoint.
aru produce base.aru --job trabajo.json --out pack.aru --resume

# Un ZIP con cada icono separado, varios tamaños y documentos editables.
aru export-icons pack.aru --out iconos.zip --sizes 24,48,96 --formats png,svg,aru
```

`Ctrl+C` pausa la producción conservando los lotes aceptados. Si el proveedor deja de avanzar, el trabajo queda incompleto y puede reanudarse. La comprobación de duplicados reduce repeticiones; la pertinencia de cada símbolo y su acabado todavía necesitan revisión visual.

## Descubrimiento y estilos

`discover` investiga el propósito del proyecto y busca sus propias referencias visuales antes de construir el icono.

```sh
aru styles
aru discover --repo https://github.com/owner/project --style "Material 3" --out icono.aru
aru materials
aru material icono.aru --select simbolo --style chrome --out cromado.aru
```

El catálogo incluye Material 3, Apple minimalista, Y2K, Frutiger Aero y Funky Seasons, entre otros perfiles. Los materiales editables incluyen neón, cromo, cristal, clay y fruits. El descubrimiento remoto requiere Claude CLI y GitHub CLI; las referencias guardan procedencia y licencia declarada.

## Recursos con identidad

Registra propósito, marca, tags y reglas de identidad desde Propiedades. El catálogo Recursos permite encontrarlos y reutilizarlos; la IA recibe esas fichas con el contexto del documento. Reutilizar copia la geometría editable y conserva la procedencia, sin volver a dibujar el logo o símbolo.

```sh
aru resources ilustracion.aru --brand Musaru --tag vinilo
```

Las copias son independientes y el catálogo pertenece al documento actual. Consulta las operaciones `set` con `resource` y `reuse` en la [API](docs/plugin.md).

## Editor embebido y API

La entrada principal funciona en el navegador; `@fsaldivar.dev/aru/node` añade archivos, rasterización y ejecución de agentes.

```js
import { createIllustrator, mountEditor } from '@fsaldivar.dev/aru';

const illustrator = createIllustrator();
console.log(illustrator.context());

const editor = mountEditor(document.querySelector('#editor'), {
  studioUrl: '/aru/index.html',
  text: illustrator.getDocument().text,
  onChange: state => guardarDocumento(state),
  onProduction: checkpoint => guardarCheckpoint(checkpoint),
});
await editor.ready;
```

El contenedor necesita altura explícita. Sirve `index.html` y las carpetas `src`, `plugin`, `trace`, `vision` y `examples` del paquete conservando su estructura. El host controla la persistencia y proporciona el transporte de IA si quiere habilitar el asistente. El editor se monta en un iframe para aislar su interfaz.

- [Cambios de la versión 0.7.0](CHANGELOG.md)
- [Integración, API y CLI](docs/plugin.md)
- [Producción, pausas, reanudación y exportación](docs/produccion-iconos.md)
- [Perfiles de estilo](docs/estilos.md)
- [Edición de trazos](docs/trazos-editables.md)

## Alcance

ARU busca interpretaciones editables de una referencia. El trazado y la agrupación semántica pueden necesitar refinamiento, especialmente en imágenes complejas o detalles muy pequeños. Los materiales son efectos 2D, no un renderizador 3D. Las exportaciones PNG usan un fondo opaco; los huecos deliberados de la figura se conservan visualmente.

## Desarrollo

```sh
npm ci
npm test
npm run serve
npm run pack:local
npm run smoke:plugin
```

Las pruebas que dependen de imágenes de terceros en `references/` se omiten si esas referencias locales no están disponibles; las pruebas sintéticas y de integración sí se ejecutan en un clon limpio. Esas imágenes y los resultados de investigación local no se distribuyen.

Para preparar la aplicación Tauri:

```sh
node tools/build-desktop.mjs
cd desktop
npx @tauri-apps/cli@2 build
```

La compilación nativa requiere las dependencias de desarrollo de Tauri y Rust. El paquete npm distribuye el motor, el editor web y la CLI; el repositorio incluye también el código del contenedor de escritorio.

## Licencia

MIT. Consulta [LICENSE](LICENSE).
