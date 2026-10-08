# QA de producción · 0.7.0

## Cobertura del release

- Producción por lotes con respuestas parciales, pausa/reanudación, cambios concurrentes, revalidación y exportación real de 300 piezas a ZIP. Los cambios de apariencia conservan el inventario; cambios geométricos requieren revalidación.
- Brief compartido entre Studio, editor embebido, CLI y Node: propósito, historial, proyecto, modelo, 23 perfiles visuales, cinco materiales y paleta.
- Crear, Refinar y Consultar con límites distintos. Se captura la selección al enviar y las operaciones se validan antes de aplicarse. Consultar rechaza mutaciones.
- Identidad de recursos: metadatos persistidos, búsqueda por tags/marca/tipo, inventario completo para IA, copia editable con gradientes independientes, procedencia y conservación de identidad al refinar.
- Consumidor limpio instalado únicamente desde el tarball: CLI, API de navegador/Node, exportación, materiales, producción e identidad/reutilización.
- Versiones de npm y Tauri alineadas en 0.7.0; compilación nativa optimizada.

## Comprobaciones del candidato

- Suite local: 204 pruebas aprobadas, cero fallos.
- Árbol de fuentes limpio: 194 aprobadas, cero fallos y 10 omitidas por ausencia de imágenes de terceros.
- Tarball instalado en consumidor aislado: 16 comprobaciones de CLI/API aprobadas, incluida identidad y reutilización de recursos.

## Evidencia visual y de integración local

- IA real: pack de 25 iconos de automatización móvil, Fruits azul/dorado, revisión por lote y ZIP de 126 archivos; inspección a 24/48 px.
- Editor embebido con transporte simulado: detener a 16/33, recuperar checkpoint, completar, repintar, eliminar una pieza, revalidar y crear solo la faltante.
- Layout a 1280×800, 960×600, 760×500 y 480×600: compositor dentro del panel, sin desbordamiento horizontal del chat en las condiciones probadas. Cancelación durante una llamada pendiente, paneles independientes y cambio de proyecto/modelo verificados.
- Recursos: registro manual, guardar/recargar, catálogo, búsqueda y reutilización exacta comprobados en navegador y catálogo inspeccionado en escritorio. La prueba de orquestación de IA usa transporte controlado.

Las capturas y resultados de trabajo están en `out/production-quality-2026-10-07/`, `out/assistant-flow-2026-10-07/`, `out/workspace-controls-2026-10-07/`, `out/workspace-performance-2026-10-07/` y `out/resource-identity-2026-10-08/`. Son evidencia local excluida del repositorio y del paquete.

## Rendimiento medido

Fixture de 1000 iconos / 9950 capas: carga de 1322 a 367 ms, selección de 705 a 33 ms y contexto de 1058 a 33 ms. En la prueba de 300 iconos con Fruits, el paneo pasó de 26.9 s a 0.37 s. Son mediciones locales de la misma carga, no garantías para cualquier dispositivo.

El primer render de Fruits todavía ronda 1.7 s en esa prueba. Editar documentos grandes puede reconstruir el SVG completo y producir pausas. Los scripts y la fixture sintética de rendimiento permiten repetir la evaluación.

## Límites

La prueba de 320 piezas verifica protocolo e inventario con dibujos sintéticos; no demuestra reconocimiento ni originalidad semántica de 320 iconos generados por IA. Las pruebas locales que requieren imágenes de terceros se omiten en un clon limpio y esas imágenes no se distribuyen.

Material 3 y Apple son direcciones visuales, no certificaciones. Los materiales son efectos 2D y PNG mantiene su resolución propia. El catálogo de recursos pertenece al documento actual; las copias son independientes, sin vinculación automática ni biblioteca entre documentos.
