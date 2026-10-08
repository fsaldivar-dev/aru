# Producción de iconos por lotes

Desde 0.6.0, los pedidos explícitos de más de 24 iconos se ejecutan por lotes de hasta 16. El objetivo original permanece fijo: entregar 24 de 320 no completa una solicitud de 320.

## Studio

Escribe «Crea un pack de 320 iconos para un reproductor de música vintage». Activa **aplicar** y usa **Edición libre**. El panel muestra aceptados, objetivo y pendientes. **Detener** conserva las entregas guardadas; **Reanudar pendientes** continúa sin volver a crear los aceptados. El trabajo se guarda por documento y puede recuperarse después de abrir nuevamente Studio.

Cada icono es un grupo editable dentro de un único `ui.iconpack`, compatible con la exportación ZIP. La herramienta calcula nombres internos, posición y crecimiento del lienzo. Cada lote es un paso de deshacer. Los pedidos grandes de refinamiento protegido siguen el flujo de refinamiento, no crean un pack nuevo.

## CLI

```sh
aru produce base.aru --message "Crea 320 iconos de música vintage" --job trabajo.json --out pack.aru
aru produce base.aru --job trabajo.json --out pack.aru --resume
aru export-icons pack.aru --out iconos.zip --sizes 24,48,96 --formats png,svg,aru
```

`--batch-size 1..24` cambia el tamaño de las entregas. `Ctrl+C` detiene el agente y conserva el checkpoint. El JSON de checkpoint incluye el documento y el inventario; permite recuperar un proceso interrumpido incluso entre escrituras. `--resume` conserva el objetivo y comprueba que la base y la salida no hayan sido editadas. Una entrega parcial devuelve `ok:false`, `partial:true` y código de salida 1. Los PNG exportados son opacos.

`aru ask` también continúa automáticamente los pedidos grandes; usa `produce` para tener checkpoints duraderos y reanudar desde CLI. Se admiten hasta 1000 iconos por trabajo. Tres respuestas seguidas sin iconos válidos dejan el trabajo en pausa con el motivo visible.

## API e integración

```js
import { createIconJob, produceIcons } from '@fsaldivar.dev/aru/node';
const job = createIconJob('Crea 320 iconos vintage');
const result = await produceIcons(session, {
  job,
  signal: controller.signal,
  checkpoint: async (job, text) => saveCheckpoint({ job, text }),
  progress: job => console.log(job.accepted.length, job.target),
});
```

En el editor embebido, `editor.ask()` comparte el mismo flujo. `onProduction({job, document})` entrega checkpoints al host, que controla su persistencia. `getProduction()`, `stopProduction()` y `resumeProduction(job)` permiten controlar o recuperar un trabajo. Carga primero el documento del checkpoint y luego reanuda su `job`. El progreso renueva el tiempo de espera de las solicitudes largas.

## Validación y límites

Solo cuentan dibujos compilables, visibles, con nombre y propósito y que caben en una celda local de 24 px. Se rechazan nombres repetidos, geometría idéntica aunque cambien el nombre/color y siluetas rasterizadas idénticas a 32 px. La IA recibe el inventario acumulado y tres dibujos aceptados para mantener el estilo. Los rechazos se incluyen en la siguiente solicitud.

Estas comprobaciones no garantizan que dos conceptos parecidos sean distintos semánticamente, ni sustituyen una revisión humana del reconocimiento y la coherencia del estilo. Con revisión activada y un estilo, material o propósito definido, cada lote se muestra a la IA a 72 y 24 px antes de guardarlo. Debe aprobar estilo, propósito y legibilidad; tras tres rechazos se pausa con la razón. `--review 0` omite esta evaluación. Sigue siendo una evaluación de IA, no una garantía estética.

Si el documento cambia durante una llamada, se descarta esa entrega. Cambiar pintura, nombres, posición de los iconos o capas ajenas conserva el inventario. Eliminar piezas, añadir grupos o cambiar su geometría exige **Revalidar inventario**: conserva los dibujos actuales, registra los válidos y continúa únicamente los huecos pendientes. Si se repiten piezas o exceden el objetivo, la revalidación se rechaza con el motivo. Ninguna pausa equivale a «completo».


## Brief e inventario (0.7.0)

Studio, la CLI y el editor embebido comparten 22 perfiles en **Estilo** y cinco recetas de acabado en **Material**. Material 3 y Apple son direcciones de apariencia; Fruits es un acabado calculado por el motor. Puedes combinarlos. Los campos Color y Acento aplican respectivamente el trazo y el relleno; no convierten un hueco en relleno. Si una forma tiene un solo canal activo, ese canal mantiene su función. El brief guarda propósito, perfil, receta, paleta e historial y se reutiliza en cada lote y al reanudar.

```sh
aru produce base.aru --message "Crea 300 iconos nuevos de automatización móvil" \
  --style "Material 3" --material fruits --color '#2463EB' --accent '#FFD426' \
  --purpose "Automatizar acciones del móvil" --job job.json --out pack.aru
aru inventory pack.aru --job job.json
aru palette pack.aru --select production_ID --color '#3355FF' --accent '#FFD426' --material fruits --out azul.aru
aru produce base.aru --job job.json --out pack.aru --resume
```

Por defecto, un pedido de 300 significa **300 adicionales**; los packs previos se inventarían para evitar repetir sus nombres y siluetas. `--count-mode total` descuenta los previos, al igual que «300 iconos en total». El panel muestra previos, nuevos y total, calculados por el motor.

Aplicar paleta o material al pack completo desde Studio o el editor embebido actualiza también su brief; las piezas pendientes siguen ese acabado. En CLI y Node, después de repintar el documento, pasa la nueva paleta al reanudar: `produce ... --resume --material fruits --color '#2463EB'`, o `produceIcons(session,{job,material:'fruits',color:'#2463EB'})`. El objetivo original se conserva.

El chat usa una superficie de desplazamiento para ajustes, inventario y conversación. El compositor tiene su propia fila y muestra «Detener» durante una solicitud. Ocultar el panel izquierdo en una ventana estrecha conserva la columna del chat y el lienzo.

Para aceptar cambios geométricos propios: `aru inventory pack.aru --job job.json --revalidate`, o `produce ... --resume --revalidate`. El documento no se reconstruye desde una versión antigua. El host embebido puede llamar `revalidateProduction(job)` y guardar el checkpoint devuelto. En Node: `productionStatus(job,text)` consulta; `revalidateIconJob(job,text,{rasterize})` reconcilia explícitamente.

La exportación ZIP admite hasta 1000 piezas y conserva la protección de 64 millones de píxeles por exportación. Un lote de 300 o 320 ya no choca con el antiguo límite de 250. El render de PNG y el zoom del lienzo calculan filtros a la resolución visible, evitando ampliar un bitmap pequeño.
