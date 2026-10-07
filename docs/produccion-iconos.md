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

Estas comprobaciones no garantizan que dos conceptos parecidos sean distintos semánticamente, ni sustituyen una revisión humana del reconocimiento y la coherencia del estilo. La producción valida cantidades y dibujos; las revisiones ciegas del flujo de un solo pack siguen siendo una etapa de calidad independiente.

Si el documento cambia durante una llamada, se descarta esa entrega. Si se modifica o deshace el pack después de guardarlo, la reanudación se bloquea hasta restaurar el documento del checkpoint. Ninguna pausa equivale a «completo».
