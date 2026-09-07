# La Marea Abandonada · Quini 6

Aplicación web para consultar resultados y compartir jugadas, tickets, gastos y
rendiciones entre Ale, Zamba y Maxi. La rendición principal se puede consultar
sin iniciar sesión; solo el editor autenticado puede modificarla.

Funciona como sitio estático, conserva una copia local inmediata para el editor
y sincroniza el estado principal mediante Supabase. No necesita un servidor
propio.

## Puesta en marcha local

La aplicación carga `data.json` mediante `fetch`, por lo que debe abrirse
desde un servidor HTTP y no como archivo:

```bash
python3 -m http.server 8000
```

Después abrí <http://localhost:8000>.

Sin configurar Supabase, la página funciona completa en **modo local**:
marcas, gastos e imágenes quedan en el navegador y pueden exportarse a un
respaldo JSON.

## Uso

1. Elegí el mes y el sorteo.
2. Marcá el sorteo como `Jugado`, `No jugado` o `Pendiente`.
3. Ajustá el gasto grupal real y, si corresponde, adjuntá el ticket.
4. Revisá el resumen mensual y cuánto debe transferir cada integrante.
5. Marcá los pagos de Ale y Zamba y adjuntá sus comprobantes.
6. El editor ingresa por email para sincronizar; los demás abren la misma URL
   sin registrarse y ven la rendición en modo lectura.
7. Exportá respaldos periódicos aunque uses sincronización online.

El campo **Gasto total** es el gasto de todo el grupo para ese sorteo. El valor
predeterminado se calcula con los períodos de precio de `data.json`; solo los
sorteos marcados como jugados entran en la rendición.

## Qué se comparte

- estado de cada concurso: jugado, no jugado o pendiente;
- gasto real de cada concurso;
- referencias a tickets publicados en Storage;
- pago mensual de Ale y Zamba;
- referencias a comprobantes publicados en Storage;
- fechas de modificación para combinar cambios de distintos dispositivos.

Los resultados, números elegidos y precios siguen en `data.json`: son datos
comunes de la aplicación, no se duplican en cada cuenta.

## Arquitectura de persistencia

- **Supabase Auth:** acceso sin contraseña por magic link.
- **Postgres:** una fila de `public.user_states` por `auth.users.id`, con el
  estado en JSONB y un número de revisión.
- **Row Level Security:** cualquier visitante puede leer únicamente la fila marcada
  como pública; solo el usuario dueño puede crear o actualizar su propia fila.
- **Supabase Storage:** bucket público `user-attachments`; no permite listar,
  subir ni borrar archivos sin ser el usuario dueño.
- **Caché local:** una clave distinta de `localStorage` por usuario. Cada
  interacción se guarda primero allí, incluso sin conexión.
- **Sincronización:** guardado diferido con control optimista de revisión. Ante
  un cambio concurrente, se combinan sorteos y pagos por su fecha de edición.

Las imágenes se comprimen en el navegador antes de guardarse. La base solo
recibe referencias. Los tickets y comprobantes son públicos por decisión del
grupo, mientras que subirlos o borrarlos requiere la sesión del editor. Un
respaldo exportado desde una sesión incorpora las imágenes para seguir siendo
portable.

El estado anterior `marea-quini-state-v2` se lee automáticamente. Si la
primera cuenta no tiene aún estado online, esa copia local se migra al iniciar
sesión sin borrar el original.

## Configurar Supabase

La vista pública y el guardado online requieren completar estos pasos.

### 1. Crear el proyecto

1. Creá una cuenta en <https://supabase.com>.
2. Elegí **New project**.
3. Asignale un nombre, una contraseña segura para la base y una región cercana.
4. Esperá a que el proyecto termine de inicializar.

### 2. Crear tabla, bucket y permisos

1. En el panel del proyecto abrí **SQL Editor**.
2. Elegí **New query**.
3. Copiá todo el contenido de `supabase/schema.sql`.
4. Pegalo y presioná **Run**.
5. Confirmá en **Table Editor** que existe `user_states`.
6. Confirmá en **Storage** que existe `user-attachments` y figura como
   público.

El SQL es versionado, repetible y crea las políticas RLS. No desactives RLS:
la lectura es pública, pero las escrituras continúan protegidas.

### 3. Habilitar los enlaces de acceso

1. Abrí **Authentication → Sign In / Providers → Email**.
2. Dejá habilitado Email y el acceso por magic link.
3. Abrí **Authentication → URL Configuration**.
4. En **Site URL** colocá la URL pública final de Quini6.
5. En **Redirect URLs** agregá esa misma URL y, para desarrollo,
   `http://localhost:8000/`.

La URL debe coincidir con la que muestra el navegador, incluida la subcarpeta
si el sitio se publica bajo una.

### 4. Conectar el frontend

1. Abrí **Project Settings → API**.
2. Copiá **Project URL**.
3. Copiá la **Publishable key** (`sb_publishable_...`). En proyectos antiguos
   puede aparecer como clave pública `anon`.
4. Abrí `app-config.js` y completá:

```javascript
window.QUINI_CONFIG = Object.freeze({
  supabaseUrl: "https://TU-PROYECTO.supabase.co",
  supabasePublishableKey: "sb_publishable_TU_CLAVE_PUBLICA",
});
```

La publishable key es configuración pública pensada para el navegador; la
seguridad de los datos depende de las políticas RLS incluidas en el esquema.
**Nunca** uses aquí `sb_secret_...`, `service_role`, la contraseña de la
base ni un JWT privado. El frontend bloquea claves secretas reconocibles para
reducir errores de configuración.

### 5. Verificar

1. Serví la página localmente.
2. Sin iniciar sesión, comprobá que la tarjeta diga `Solo lectura`.
3. Confirmá que las marcas y fotos públicas sean visibles pero no editables.
4. Ingresá con el email del editor, modificá un sorteo y esperá `Guardado online`.
5. Cerrá la sesión y verificá que el cambio aparezca en la vista pública.
6. Abrí la página desde otro dispositivo sin ingresar y comprobá el mismo cambio.

No hace falta copiar ningún secreto, crear una API propia ni ejecutar un
backend adicional.

## Estructura

- `index.html`: HTML semántico y estructura de la interfaz.
- `marea.css`: diseño responsive, estados visuales y accesibilidad.
- `marea-app.js`: interacción, render, caché local y coordinación de sync.
- `state-utils.js`: validación, migración y combinación de estados.
- `online-store.js`: única capa que conoce la API de Supabase.
- `app-config.js`: configuración pública del cliente de Supabase.
- `supabase/schema.sql`: tabla, bucket y políticas RLS reproducibles.
- `data.json`: configuración y resultados validados.
- `scripts/actualizar_resultados.py`: validador y actualizador de resultados.
- `.github/workflows/actualizar-datos.yml`: pruebas y actualización programada.
- `tests/`: pruebas Python y JavaScript sin dependencias de proyecto.

`Quini.html`, `app.js`, `style.css` y `datos.json` son artefactos de
versiones anteriores. Se conservan para no borrar historial ni posibles usos
externos, pero la aplicación principal no los carga.

## Resultados automáticos

El actualizador consulta la fuente enlazada en cada sorteo, valida el archivo
completo y escribe `data.json` de forma atómica. También contempla sorteos
reprogramados hasta seis días después de la fecha habitual. Si no hay
resultados nuevos, no modifica el timestamp ni crea cambios innecesarios.

```bash
# Validar datos sin red ni escritura
python3 scripts/actualizar_resultados.py --check

# Pruebas Python
python3 -m unittest discover -s tests -v

# Pruebas JavaScript (Node.js 20 o posterior)
node --test tests/*.test.js

# Buscar y agregar resultados publicados
python3 scripts/actualizar_resultados.py
```

GitHub Actions ejecuta las pruebas Python y JavaScript antes del actualizador.
Luego solo crea un commit cuando cambia `data.json`.

## Seguridad y límites

- El modo local depende del almacenamiento disponible en el navegador.
- La sesión del editor se conserva localmente para evitar iniciar sesión en cada
  visita. Los lectores no necesitan una cuenta.
- Los adjuntos admiten JPEG, PNG o WebP de hasta 12 MB; se convierten a JPEG
  comprimido. El bucket rechaza archivos finales mayores a 5 MB.
- Cada sección admite hasta 12 imágenes y cada estado online se limita a 1 MB,
  suficiente porque la base solo guarda referencias.
- Los respaldos admiten hasta 50 MB y se validan antes de reemplazar el estado.
- La Content Security Policy restringe scripts, conexiones e imágenes a los
  orígenes necesarios.
- El proyecto carga una versión fijada del cliente oficial de Supabase desde
  jsDelivr; la página sigue en modo local si ese recurso no está disponible.

La rendición, los tickets y los comprobantes de la vista compartida son públicos.
Los respaldos también pueden contener esa información y datos históricos.
