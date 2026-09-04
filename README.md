# La Marea Abandonada - Quini 6

Sitio estático para controlar resultados, jugadas, tickets y rendiciones entre
Ale, Zamba y Maxi. No requiere un backend ni dependencias de JavaScript.

## Puesta en marcha

La aplicación carga `data.json` mediante `fetch`, por lo que debe abrirse desde
un servidor HTTP local y no directamente como archivo:

```bash
python3 -m http.server 8000
```

Después abrí <http://localhost:8000>.

## Uso

1. Elegí el mes y el sorteo.
2. Marcá cada sorteo como `Jugado`, `No jugado` o `Pendiente`.
3. Ajustá el gasto real y, si hace falta, adjuntá el ticket.
4. Revisá el resumen mensual y la parte de cada integrante.
5. Ale y Zamba pueden marcar sus pagos y adjuntar comprobantes.
6. Usá `Exportar respaldo` para conservar o mover el estado a otro navegador.

El campo `Gasto total` corresponde al gasto grupal del sorteo, no al valor de
una boleta. La configuración actual calcula $9.000 por sorteo hasta mayo de
2026 y $12.000 desde junio de 2026.

## Estructura

Los archivos activos son:

- `index.html`: estructura y estilos de la interfaz.
- `marea-app.js`: comportamiento, cálculos, validación y respaldos.
- `data.json`: configuración y resultados que consume la aplicación.
- `scripts/actualizar_resultados.py`: validador y actualizador de resultados.
- `.github/workflows/actualizar-datos.yml`: pruebas y actualización programada.
- `tests/`: pruebas locales sin dependencias externas.

`Quini.html`, `app.js`, `style.css` y `datos.json` son artefactos de
versiones anteriores. Se conservan para no borrar historial ni posibles usos
externos, pero la aplicación actual no los carga.

## Resultados automáticos

El actualizador consulta la fuente pública enlazada en cada sorteo, valida el
archivo completo y escribe `data.json` de forma atómica. También contempla
sorteos reprogramados hasta seis días después de la fecha habitual. Al no haber
resultados nuevos, no modifica el timestamp ni genera cambios innecesarios.

Comandos útiles:

```bash
# Validar los datos sin usar la red ni modificar archivos
python3 scripts/actualizar_resultados.py --check

# Ejecutar todas las pruebas
python3 -m unittest discover -s tests -v

# Buscar y agregar resultados nuevos
python3 scripts/actualizar_resultados.py

# Volver a descargar concursos existentes desde un número
python3 scripts/actualizar_resultados.py --refresh-from 3400
```

GitHub Actions ejecuta primero las pruebas y luego el actualizador los lunes y
jueves a las 09:30 de Argentina, después de los sorteos habituales de domingo y
miércoles. Sólo crea un commit cuando cambia `data.json`.

## Respaldo, privacidad y límites

Las marcas y las imágenes se guardan en `localStorage`; no se sincronizan entre
dispositivos. La importación valida el formato y pide confirmación antes de
reemplazar el estado local. Si el navegador se queda sin espacio, la interfaz
rechaza el cambio y avisa para evitar una falsa sensación de guardado.

Los respaldos pueden contener tickets o comprobantes codificados dentro del
JSON. No conviene publicarlos ni versionarlos; los respaldos nuevos quedan
ignorados por Git. El respaldo histórico ya versionado se mantiene intacto.

Para sincronización multiusuario hace falta un backend y una definición explícita
de permisos, autenticación y tratamiento de comprobantes; eso queda fuera del
alcance del sitio estático actual.
