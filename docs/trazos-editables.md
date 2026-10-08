# Editar una ilustración a partir de una base

Primera entrega, 2026-10-07. La referencia convertida en capas es la base de trabajo. La IA elige la parte y la herramienta; el motor calcula las curvas y las coordenadas. Esta entrega permite limpiar contornos y unir extremos existentes. El modo **Redibujar formas** permite reinterpretar el contenido de los grupos seleccionados; los controles semánticos específicos de poses y expresiones siguen pendientes.

## Uso en Studio

1. En **Proyectos → Plantillas**, abre **sajaru base editable** o **editar trazos**. La plantilla crea un documento independiente.
2. Selecciona un path o un grupo. En **Propiedades → Afinar trazos**, usa **Simplificar…** o **Suavizar…**. La vista previa compara ambos resultados sin modificar el documento.
3. Para controlar intensidad y tolerancia, abre **Código → Lote / IA**, pega operaciones y pulsa **Vista previa**. Si hay errores, la aplicación desde esta vista queda deshabilitada.
4. El **Asistente → Refinar → Limpiar trazos** ejecuta las mismas herramientas sobre la selección, con deshacer. **Redibujar formas** reemplaza sus trazos internos para mejorar siluetas ambiguas, conservando identidad y posición. **Color y acabado** conserva la geometría; **Crear** añade dibujos nuevos y **Consultar** mantiene el lienzo en solo lectura.
5. Los cambios se guardan como ARU y se pueden deshacer en un paso. Cancelar la comparación no modifica el documento ni el historial.

El chat muestra los resultados medidos dentro del desplegable de operaciones. Una simplificación válida puede retirar **cero puntos**; eso no significa que haya limpiado la forma. Los resultados pasan también al contexto del siguiente pedido a la IA.

## Fondo de las nuevas ilustraciones

Cada ilustración nueva creada en ARU por el asistente o trazada desde una referencia en el chat recibe una capa **Fondo opaco**. Usa el color del documento, o blanco cuando el lienzo es transparente. La capa pertenece al grupo: se mueve y escala con la ilustración, se guarda en ARU y se puede recolorear desde Propiedades. Los huecos del dibujo permanecen como subtrazos; muestran el color del fondo. Los detalles añadidos dentro de un grupo existente mediante `aruInto` conservan su fondo actual.

La opacidad de una forma sigue siendo editable: el fondo sólido compone su color sin aplanar ni perder las capas. El PNG de **Archivo → Exportar PNG sin transparencia** compone el documento completo sobre un fondo sólido y deja todos sus píxeles con alfa 255, incluidos huecos, esquinas redondeadas y bordes suavizados. Si el documento tiene fondo transparente, esta exportación usa blanco. Las ilustraciones guardadas antes de esta actualización no reciben capas nuevas automáticamente; también se pueden exportar con esta opción.

## Cuatro herramientas

| Operación | Resultado | Protección y alcance |
| --- | --- | --- |
| `simplify` | Retira puntos redundantes de tramos rectos | Conserva curvas existentes, esquinas detectadas, extremos y subtrazos separados |
| `smooth` | Alinea manijas en uniones suaves y convierte líneas en curvas | Mantiene anclas y extremos; conserva uniones angulosas; limita el movimiento de las manijas |
| `weld` | Hace coincidir dos extremos en su punto medio | Conserva ambos paths, nombres y estilos; desplaza la manija adyacente con el extremo |
| `connect` | Forma un path continuo y elimina la segunda capa | Retiene el nombre y propiedades del primero; requiere capas contiguas del mismo grupo, `fill none` y estilos, rotación y escala iguales |

`weld` trabaja entre grupos con distinta posición, rotación y escala. **La soldadura es una edición de posición, no un vínculo persistente**: al mover después una capa, los extremos pueden separarse.

## Parámetros

- `target`: una ruta exacta, `selection` o un selector habitual. Para suavizar/simplificar, un grupo recorre sus paths descendientes sin repetirlos.
- `tolerance`: unidades del lienzo; predeterminado `1`, rango `0.001..100`. Compensa transformaciones acumuladas. En `smooth` limita el desplazamiento de cada manija; en `simplify` controla la desviación de los vértices originales respecto al tramo simplificado. El guardado utiliza la precisión habitual de ARU.
- `strength`: solo suavizado; `0..1`, predeterminado `0.6`.
- `cornerAngle`: giro mínimo conservado como esquina; predeterminado `60°`, rango `5..175`. Un umbral menor protege más esquinas.
- `other`: segunda ruta exacta para las uniones.
- `endpoint` y `otherEndpoint`: `auto`, `start` o `end`. Predeterminado `auto`: el motor elige el par más cercano, sin cálculos de la IA.
- `maxDistance`: separación máxima antes de unir; predeterminado `8` unidades del lienzo, rango `0.001..1000`. Un par demasiado alejado se rechaza.

Se admiten paths con `move`, `line`, `curve`, `quad` y `close`. Los arcos y comandos `smooth` del lenguaje todavía se rechazan. Las uniones requieren dos paths abiertos con un solo subtrazo. Los bloqueos heredados se respetan. Cada operación valida todos sus paths antes de modificarlos; un hijo inválido no deja una edición parcial.

Los lotes conservan su comportamiento previo: cada operación produce un resultado independiente. **Aplicar lote** directamente puede ejecutar las operaciones válidas aunque otra falle. La vista previa exige corregir todos los errores antes de aplicar.

## Limpiar una mejilla

En la plantilla **editar trazos**:

```json
[
  { "op": "simplify", "target": "practica.mejilla", "tolerance": 3 },
  { "op": "smooth", "target": "practica.mejilla", "tolerance": 3, "strength": 1 }
]
```

Simplifica **antes** de suavizar: por ahora, simplificar no reduce segmentos Bézier. Esta práctica retira seis puntos y convierte el contorno facetado en una curva más limpia.

## Continuar un contorno

```json
[
  {
    "op": "connect",
    "target": "practica.costura.izquierda",
    "other": "practica.costura.derecha",
    "maxDistance": 8
  }
]
```

Para conservar las dos capas, sustituye `connect` por `weld`. El motor elige los extremos y transforma sus posiciones al espacio de cada path. Para una unión concreta, especifica `endpoint` y `otherEndpoint`.

## Pedidos sencillos para la IA

- «Suaviza ligeramente el lobo de Sajaru. Conserva las puntas de las orejas y el pelaje, el texto y la paleta.»
- «Junta las dos mitades del contorno naranja del hocico en un solo trazo. Conserva su color y grosor.»
- «Haz coincidir estos dos extremos, conservando las dos capas y sus colores.»
- «Quita puntos redundantes de la mejilla y después suavízala un poco.»
- «Limpia este contorno compuesto conservando el hueco interior.»

## Límites pendientes

Los nombres de las partes y la geometría editada se guardan, pero el serializador sigue expandiendo blueprints y construcciones procedurales. No conserva todavía un modelo canónico con controles semánticos y dependencias regenerables.

Conservar cierres y subtrazos mantiene la estructura de los huecos; no garantiza todas las relaciones geométricas tras una edición intensa. Faltan detección de cruces, bordes compartidos entre tinta y rellenos y uniones persistentes. Editar rellenos vecinos independientemente puede crear separaciones: comienza con tolerancias pequeñas y revisa la comparación.

Esta entrega no incluye pincel de influencia local, perfiles de grosor, unión booleana de regiones ni deformación de expresiones y proporciones. El siguiente paso es conservar el modelo editable de cada parte y conectar sus límites compartidos; sobre eso se podrán construir cambios de estilo estructurales.

## Corrección del revisor de iconos

Una ilustración con tres o más grupos hijos ya no se considera automáticamente un paquete de iconos de 24 px. Los paquetes nuevos declaran `semantic ui.iconpack`; se conserva el nombre raíz `pack` por compatibilidad. Esto evita la revisión de iconos sobre personajes y paisajes.

## Verificación

**59 pruebas automatizadas aprobadas.** Incluyen límites de desplazamiento en grupos transformados, esquinas y huecos, curvas existentes, bloqueos, validación sin mutación parcial, combinaciones de extremos, elección automática del par cercano, estilos incompatibles, serialización y preview independiente.

En Studio se verificaron comparación/cancelación/aplicación sobre Sajaru, deshacer/rehacer, cinco operaciones reales de Claude, persistencia al recargar y geometría del texto y separador conservada. La práctica incluye un contorno facetado, dos extremos separados, esquinas y un hueco.

Claude también ejecutó `connect` con el pedido sencillo de unir las dos mitades del hocico: quedó una sola capa, con el color `#C8643A` y grosor `4` conservados. La app Tauri se recompiló y se probó directamente: vista previa, aplicación, deshacer y rehacer. El archivo guardado en disco coincide con el resultado del mismo lote ejecutado por el motor.
