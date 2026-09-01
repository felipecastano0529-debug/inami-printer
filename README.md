# Inami Printer

App de escritorio que imprime las comandas de **Inami Ice Cream Shop** sin que
nadie tenga que darle a imprimir.

Vive en la barra del sistema, escucha los pedidos en tiempo real y manda el
ticket a la impresora térmica en silencio.

```
Cliente pide  ──▶  Supabase Realtime  ──▶  Inami Printer  ──▶  impresora
```

## Por qué es un repo aparte

Salió de la plataforma (`inami-platform`), donde vivía dentro de `electron-app/`.
Se separó porque su ciclo de vida no tiene nada que ver con el de la web: la web
se despliega varias veces al día y se actualiza sola en el navegador; esto es un
binario que alguien instala a mano en el computador del local y que solo cambia
cuando hay algo que arreglar en la impresión. Mezclarlos obligaba a versionar y
publicar los dos juntos.

## Instalar (el local)

Descarga el instalador de [Releases](../../releases) y elige según el equipo:

| Archivo | Para |
|---|---|
| `Inami-Printer-x.y.z-arm64.dmg` | Mac con chip Apple (M1, M2, M3, M4) |
| `Inami-Printer-x.y.z-x64.dmg` | Mac con chip Intel |
| `Inami-Printer-x.y.z.exe` | Windows |

En el menú Apple → *Acerca de este Mac* ves cuál tienes.

La primera vez macOS avisa de que viene de un desarrollador no identificado:
clic derecho sobre la app → **Abrir** → **Abrir**. La app no está firmada porque
no se distribuye por la App Store.

## Desarrollo

```bash
npm install
npm run dev      # Vite + Electron en caliente
npm run dist:mac # genera los .dmg en release/
npm run dist:win # genera el .exe
```

## Configuración

Apunta al proyecto Supabase de Inami. Los valores por defecto están en
`src/main/main.ts` y se pueden sobrescribir por entorno:

```bash
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
```

La `anon key` es pública por diseño —viaja a cada navegador que abre la tienda—,
así que vivir dentro del binario no la expone. Lo que sí importa es que sea la
del proyecto correcto: si algún día se migra de proyecto Supabase, se cambia por
entorno y no hay que recompilar y redistribuir el instalador a cada local.

## Cómo imprime

1. Se suscribe por realtime al tenant. Un **pedido nuevo** (o el momento en que
   se le confirma el pago) solo dispara la campana y la notificación —
   **no imprime**: la comanda sale cuando el pedido está listo para empacar.
2. Imprime cuando aparece una fila en **`print_jobs`**. La encola la base al
   pasar el pedido a `ready` (disparador `trg_enqueue_comanda_al_empacar` —
   respeta `print_settings.auto_print` y no imprime pedidos sin pago aprobado),
   o la crea el botón 🖨️ del panel para una reimpresión a demanda.
3. Arma el HTML del ticket con la cabecera de la sede (logo, razón social y NIT
   salen de `branches`; si están vacíos usa los del tenant).
4. Lo manda a la impresora seleccionada con `silent: true`, sin diálogo, y marca
   el trabajo como `printed` o `failed` en `print_jobs`.

## Si no imprime

| Síntoma | Qué mirar |
|---|---|
| No aparece en la barra del sistema | macOS → Privacidad y seguridad → Accesibilidad, dale permiso |
| Aparece pero no sale nada | Que la impresora esté encendida y seleccionada dentro de la app |
| Sale cortado o con márgenes raros | El ancho de papel en la configuración (58 o 80 mm) |
| No llegan pedidos | Que el proyecto Supabase configurado sea el correcto |

## Licencia

Privado. Uso interno de Inami Ice Cream Shop.
