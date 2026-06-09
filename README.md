# La Marea Abandonada - Quini 6

Sitio estático para controlar resultados, jugadas, tickets y rendiciones entre
Ale, Zamba y Maxi.

## Uso

1. Abrí `index.html` mediante un servidor web.
2. Desde abril de 2026, marcá cada sorteo como `Jugado`, `No jugado` o
   `Pendiente`.
3. Ajustá el gasto real y adjuntá el ticket.
4. El resumen mensual calcula el total y la parte de cada integrante.
5. Ale y Zamba pueden marcar sus pagos y adjuntar comprobantes.
6. Usá `Exportar respaldo` para mover el estado a otro navegador.

Las marcas y las imágenes se guardan en `localStorage`; no se sincronizan
automáticamente entre dispositivos. Para sincronización multiusuario hace falta
conectar un backend, por ejemplo Supabase.

## Resultados automáticos

`scripts/actualizar_resultados.py` agrega los concursos nuevos a `data.json`.
GitHub Actions lo ejecuta los lunes y jueves a las 09:30 de Argentina, después
de los sorteos de domingo y miércoles. También puede ejecutarse manualmente:

```bash
python scripts/actualizar_resultados.py
```
