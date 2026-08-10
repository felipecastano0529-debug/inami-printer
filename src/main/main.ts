// Inami Printer — Electron main process.
// Vive en el system tray. Suscribe a Supabase Realtime de orders del tenant
// y, cuando llega un pedido nuevo (INSERT), abre una ventana invisible con
// el HTML del ticket y la imprime silently al printer seleccionado.

import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification } from "electron";
import path from "node:path";
import Store from "electron-store";

const isDev = process.env.NODE_ENV === "development";

interface Settings {
  printerName?: string;
  paperWidthMm?: number; // 58 o 80
  copies?: number;
  silentMode?: boolean;
  soundEnabled?: boolean;
  notificationEnabled?: boolean;
}

interface SessionState {
  accessToken?: string;
  refreshToken?: string;
  tenantId?: string;
  tenantName?: string;
  userEmail?: string;
}

interface OfflineState {
  lastSeenAt: string | null; // ISO timestamp del último pedido visto/impreso
  printedIds: string[];      // IDs de pedidos ya impresos (cap 1000)
}

// Set en memoria de IDs en proceso de impresión — evita race condition
// entre el listener de INSERT y catchUpMissedOrders al reconectar.
const inFlight = new Set<string>();

const store = new Store<{
  settings: Settings;
  session: SessionState | null;
  offline: OfflineState;
}>({
  defaults: {
    settings: {
      paperWidthMm: 80, copies: 1, silentMode: true,
      soundEnabled: true, notificationEnabled: true,
    },
    session: null,
    offline: { lastSeenAt: null, printedIds: [] },
  },
});

// Track de pedidos ya impresos (en memoria + persistido) para evitar duplicados
function markPrinted(orderId: string) {
  const off = store.get("offline");
  if (off.printedIds.includes(orderId)) return;
  const next = [...off.printedIds, orderId].slice(-1000); // cap 1000
  store.set("offline", { ...off, printedIds: next, lastSeenAt: new Date().toISOString() });
}
function alreadyPrinted(orderId: string): boolean {
  return store.get("offline").printedIds.includes(orderId);
}

let tray: Tray | null = null;
let configWindow: BrowserWindow | null = null;
let printWindow: BrowserWindow | null = null;
let supabaseChannel: any = null;
let supabaseClient: any = null;          // cliente compartido (autoRefresh activo)
let refreshTimer: NodeJS.Timeout | null = null;
let pollingTimer: NodeJS.Timeout | null = null;
let realtimeStatus: "DISCONNECTED" | "SUBSCRIBING" | "SUBSCRIBED" | "ERROR" = "DISCONNECTED";
let lastSeenAt: Date | null = null;

// Config de runtime (proyecto Supabase de Inami).
//
// La anon key es pública por diseño (viaja a cada navegador), así que vivir
// en el binario no la expone. Lo que sí dolía era tenerla hardcodeada sin
// salida: migrar de proyecto Supabase obligaba a recompilar y redistribuir el
// instalador a cada local. Ahora las env mandan y el valor de aquí es solo el
// defecto.
const SUPABASE_URL = process.env.SUPABASE_URL || "https://vdnznbuxjkesjmonyyvh.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZkbnpuYnV4amtlc2ptb255eXZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzMTgyNDYsImV4cCI6MjEwMTg5NDI0Nn0.F549tfkuo8xmLFqws5BkJAtvyMDxI4bOdZwiIKFcjhA";

// ──────────────────────────────────────────────────────
// Tray icon (vive en barra del sistema)
// ──────────────────────────────────────────────────────
function buildTrayMenu() {
  const session = store.get("session");
  const settings = store.get("settings");
  const isLoggedIn = !!session?.accessToken;
  const statusEmoji = realtimeStatus === "SUBSCRIBED" ? "🟢"
    : realtimeStatus === "SUBSCRIBING" ? "🟡"
    : realtimeStatus === "ERROR" ? "🔴" : "⚪";
  const statusLabel = realtimeStatus === "SUBSCRIBED" ? "Conectado en vivo"
    : realtimeStatus === "SUBSCRIBING" ? "Conectando…"
    : realtimeStatus === "ERROR" ? "Error de conexión — usando polling"
    : "Sin conexión";

  return Menu.buildFromTemplate([
    {
      label: isLoggedIn
        ? `📡 ${session?.tenantName || "Conectado"} · ${session?.userEmail || ""}`
        : "❌ Sin sesión",
      enabled: false,
    },
    {
      label: `${statusEmoji} ${statusLabel}`,
      enabled: false,
    },
    {
      label: settings.printerName ? `🖨️ ${settings.printerName}` : "⚠️ Sin impresora",
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Abrir configuración…",
      click: () => openConfigWindow(),
    },
    {
      label: "Imprimir ticket de prueba",
      enabled: !!settings.printerName,
      click: () => printTestTicket(),
    },
    {
      label: "Forzar revisión de pedidos",
      enabled: isLoggedIn,
      click: async () => {
        const sb = await getSupabase();
        if (sb) await catchUpMissedOrders(sb);
      },
    },
    { type: "separator" },
    {
      label: "Salir",
      click: () => app.quit(),
    },
  ]);
}

function refreshTrayMenu() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  // Icono fallback: en producción usaríamos un .png específico
  const iconPath = path.join(__dirname, "..", "..", "build", "iconTemplate.png");
  let icon: Electron.NativeImage;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error("empty");
  } catch {
    // Fallback: icono blanco simple en runtime
    icon = nativeImage.createEmpty();
  }
  if (process.platform === "darwin") icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Inami Printer");
  tray.setContextMenu(buildTrayMenu());
}

// ──────────────────────────────────────────────────────
// Ventana de configuración (login + selector printer)
// ──────────────────────────────────────────────────────
function openConfigWindow() {
  if (configWindow) {
    if (configWindow.isMinimized()) configWindow.restore();
    configWindow.show();
    configWindow.focus();
    return;
  }
  configWindow = new BrowserWindow({
    width: 480,
    height: 640,
    title: "Inami Printer",
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (isDev) {
    configWindow.loadURL("http://localhost:5174/");
  } else {
    // dist/main.js → dist/renderer/index.html
    configWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  }
  configWindow.on("closed", () => {
    configWindow = null;
  });
}

// ──────────────────────────────────────────────────────
// Cliente Supabase compartido (con auto-refresh) + Realtime
// ──────────────────────────────────────────────────────
async function getSupabase() {
  if (supabaseClient) return supabaseClient;
  const session = store.get("session");
  if (!session?.accessToken) return null;

  const { createClient } = await import("@supabase/supabase-js");
  supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    realtime: { params: { eventsPerSecond: 10 } },
    auth: {
      persistSession: false,
      autoRefreshToken: false, // lo manejamos a mano para persistir en electron-store
    },
  });

  await supabaseClient.auth.setSession({
    access_token: session.accessToken,
    refresh_token: session.refreshToken || "",
  });

  // Realtime también necesita el JWT explícitamente para canales con RLS
  try { await supabaseClient.realtime.setAuth(session.accessToken); } catch {}

  startRefreshLoop();
  return supabaseClient;
}

// Refresca el access_token cada 50 minutos (los tokens viven 1h por default).
function startRefreshLoop() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(async () => {
    try {
      if (!supabaseClient) return;
      const session = store.get("session");
      if (!session?.refreshToken) return;
      const { data, error } = await supabaseClient.auth.refreshSession({
        refresh_token: session.refreshToken,
      });
      if (error || !data.session) {
        console.error("Token refresh failed:", error?.message);
        return;
      }
      store.set("session", {
        ...session,
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
      });
      try { await supabaseClient.realtime.setAuth(data.session.access_token); } catch {}
      console.log("Token refreshed OK");
    } catch (e) {
      console.error("Refresh loop error:", e);
    }
  }, 50 * 60 * 1000);
}

async function startRealtime() {
  const session = store.get("session");
  if (!session?.accessToken || !session.tenantId) return;
  if (supabaseChannel) {
    try { supabaseChannel.unsubscribe(); } catch {}
    supabaseChannel = null;
  }

  const sb = await getSupabase();
  if (!sb) return;
  realtimeStatus = "SUBSCRIBING";
  refreshTrayMenu();

  const channelName = `printer-${session.tenantId}-${Math.random().toString(36).slice(2, 8)}`;
  supabaseChannel = sb
    .channel(channelName)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "orders",
        filter: `tenant_id=eq.${session.tenantId}`,
      },
      async (payload: any) => {
        const order = payload.new;
        if (!order) return;
        if (alreadyPrinted(order.id) || inFlight.has(order.id)) return;
        if (order.status === "cancelled") return;
        inFlight.add(order.id);
        try {
          await onNewOrder(sb, order);
        } catch (e) {
          console.error("Print failed:", e);
        } finally {
          inFlight.delete(order.id);
        }
      },
    )
    // Escuchar la cola de impresión: cuando el cajero toca "Imprimir" en
    // la web, llega un job aquí y lo procesamos sin diálogo.
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "print_jobs",
        filter: `tenant_id=eq.${session.tenantId}`,
      },
      async (payload: any) => {
        const job = payload.new;
        if (!job || job.status !== "pending") return;
        await processPrintJob(sb, job);
      },
    )
    .subscribe(async (status: string) => {
      console.log(`Realtime status: ${status}`);
      // Mapear el status a algo amigable que se vea en el tray menu
      if (status === "SUBSCRIBED") realtimeStatus = "SUBSCRIBED";
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") realtimeStatus = "ERROR";
      else realtimeStatus = "SUBSCRIBING";
      refreshTrayMenu();
      // Al (re)conectar, hacer catch-up de pedidos perdidos durante un corte
      if (status === "SUBSCRIBED") {
        await catchUpMissedOrders(sb);
      }
    });

  // Polling de respaldo: cada 25s revisa si hay pedidos nuevos. Garantiza que
  // aunque el realtime falle (timeouts, RLS, NAT), el plugin igual imprime.
  // Es defensa profunda — pedidos no se pierden bajo ninguna circunstancia.
  if (pollingTimer) clearInterval(pollingTimer);
  pollingTimer = setInterval(async () => {
    try {
      const fresh = await getSupabase();
      if (fresh) await catchUpMissedOrders(fresh);
    } catch (e) {
      console.error("Polling error:", e);
    }
  }, 25 * 1000);
}

// Cuando reconectamos tras un corte de red, traemos los pedidos creados
// después del último que vimos y NO estén ya impresos. Así nada se pierde.
// También procesa los print_jobs pendientes (reimpresión desde web).
async function catchUpMissedOrders(sb: any) {
  const session = store.get("session");
  const off = store.get("offline");
  if (!session?.tenantId) return;

  // 1. Pedidos nuevos perdidos
  const since = off.lastSeenAt ?? new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data, error } = await sb
    .from("orders")
    .select("id, created_at, status")
    .eq("tenant_id", session.tenantId)
    .gt("created_at", since)
    .neq("status", "cancelled")
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) {
    console.error("Catch-up query failed:", error.message);
  } else {
    const pending = (data ?? []).filter((o: any) => !alreadyPrinted(o.id) && !inFlight.has(o.id));
    if (pending.length > 0) {
      console.log(`Catch-up: ${pending.length} pedido(s) pendiente(s)`);
      for (const o of pending) {
        inFlight.add(o.id);
        try {
          await onNewOrder(sb, o);
        } catch (e) {
          console.error(`Catch-up print failed for ${o.id}:`, e);
        } finally {
          inFlight.delete(o.id);
        }
      }
    }
  }

  // 2. Print jobs pendientes (reimpresión solicitada desde la web)
  const { data: jobs, error: jobsErr } = await sb
    .from("print_jobs")
    .select("*")
    .eq("tenant_id", session.tenantId)
    .eq("status", "pending")
    .order("requested_at", { ascending: true })
    .limit(20);
  if (jobsErr) {
    console.error("Catch-up jobs query failed:", jobsErr.message);
    return;
  }
  for (const job of jobs ?? []) {
    await processPrintJob(sb, job);
  }
}

// Procesa un trabajo de impresión solicitado desde la web. Imprime el
// pedido SIN diálogo y marca el job como printed/failed.
async function processPrintJob(sb: any, job: any) {
  if (inFlight.has(`job-${job.id}`)) return;
  inFlight.add(`job-${job.id}`);
  try {
    console.log(`Procesando print job ${job.id} → order ${job.order_id}`);
    const ok = await printOrder(job.order_id);
    await sb
      .from("print_jobs")
      .update({
        status: ok ? "printed" : "failed",
        printed_at: ok ? new Date().toISOString() : null,
        notes: ok ? "ok plugin" : "spooler rejected",
      })
      .eq("id", job.id);
  } catch (e: any) {
    console.error(`Print job ${job.id} failed:`, e);
    try {
      await sb
        .from("print_jobs")
        .update({ status: "failed", notes: String(e?.message || e).slice(0, 200) })
        .eq("id", job.id);
    } catch {}
  } finally {
    inFlight.delete(`job-${job.id}`);
  }
}

// Acción al recibir un pedido nuevo: notificación + sonido + impresión
async function onNewOrder(sb: any, orderHeader: { id: string }) {
  const settings = store.get("settings");

  // Trae info mínima para la notificación
  const { data: meta } = await sb
    .from("orders")
    .select("order_number, tenant_order_number, customer_name, total")
    .eq("id", orderHeader.id)
    .maybeSingle();

  if (settings.notificationEnabled !== false && meta) {
    showNewOrderNotification(meta);
  }
  if (settings.soundEnabled !== false) {
    playBeep();
  }
  const ok = await printOrder(orderHeader.id);
  // Solo marcar como impreso si el spooler aceptó el job. Si falló, dejamos
  // el id sin marcar para que el próximo catch-up lo reintente.
  if (ok) markPrinted(orderHeader.id);
}

function showNewOrderNotification(meta: any) {
  if (!Notification.isSupported()) return;
  const dailyN = meta.tenant_order_number
    ? `P-${String(meta.tenant_order_number).padStart(3, "0")}`
    : `#${meta.order_number}`;
  const n = new Notification({
    title: `🛎️ Nuevo pedido ${dailyN}`,
    body: `${meta.customer_name ?? ""} · $${Math.round(Number(meta.total)).toLocaleString("es-CO")}`,
    silent: false,
    // urgency solo aplica en Linux; en macOS/Windows se ignora.
    urgency: "critical",
  });
  n.show();
}

// Reproduce un beep usando una BrowserWindow oculta con audio HTML5.
// IMPORTANTE: NO usamos `offscreen: true` — AudioContext no inicializa en
// ventanas offscreen. Solo `show: false` basta para que sea invisible.
// El flag --autoplay-policy=no-user-gesture-required se setea en app.whenReady.
let beepWin: BrowserWindow | null = null;
function playBeep() {
  try {
    if (beepWin) { try { beepWin.close(); } catch {} beepWin = null; }
    beepWin = new BrowserWindow({
      show: false,
      width: 1, height: 1,
      webPreferences: { offscreen: false, contextIsolation: true, nodeIntegration: false },
    });
    const html = `<!doctype html><html><body><script>
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = "square"; o.frequency.value = 880;
        g.gain.value = 0.18;
        o.start();
        setTimeout(() => { o.stop(); ctx.close(); }, 280);
      } catch (e) { /* noop */ }
    </script></body></html>`;
    beepWin.loadURL(`data:text/html,${encodeURIComponent(html)}`);
    setTimeout(() => { if (beepWin) { try { beepWin.close(); } catch {} beepWin = null; } }, 1200);
  } catch (e) {
    console.error("Beep failed:", e);
  }
}

async function stopRealtime() {
  if (supabaseChannel) {
    try { supabaseChannel.unsubscribe(); } catch {}
    supabaseChannel = null;
  }
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  supabaseClient = null;
}

// ──────────────────────────────────────────────────────
// Imprimir un ticket
// ──────────────────────────────────────────────────────
async function printOrder(orderId: string): Promise<boolean> {
  const settings = store.get("settings");
  if (!settings.printerName) return false;

  const sb = await getSupabase();
  if (!sb) return false;

  const { data: order, error } = await sb
    .from("orders")
    .select("*, items:order_items(product_name, variant_name, quantity, unit_price, subtotal, toppings, notes)")
    .eq("id", orderId)
    .maybeSingle();
  if (error || !order) {
    console.error("Order fetch failed:", error);
    return false;
  }

  // Cargar tenant + branch (para invoice_* config) en paralelo. La sede
  // gana sobre el tenant para logo y datos legales — refleja el mismo
  // comportamiento del módulo POS de invoicing en /admin.
  const [{ data: tenant }, { data: branch }] = await Promise.all([
    sb.from("tenants").select("name, whatsapp, logo_url").eq("id", order.tenant_id).maybeSingle(),
    order.branch_id
      ? sb.from("branches")
          .select("legal_name, tax_id, logo_url, invoice_print_compact, invoice_print_logo, invoice_header_message, invoice_footer_message, invoice_qr_text")
          .eq("id", order.branch_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  // Logo: prefiero el de la sede sobre el del tenant. Lo cacheamos como
  // data:URL para que funcione 100% offline en silent mode (sin parpadeo
  // ni hotlink failure que arruine el ticket).
  const preferredLogoUrl = branch?.logo_url || tenant?.logo_url || null;
  const logoDataUrl = preferredLogoUrl ? await fetchLogoAsDataUrl(preferredLogoUrl) : null;

  // QR opcional si la sede lo configuró
  const qrDataUrl = branch?.invoice_qr_text ? await generateQRDataUrl(branch.invoice_qr_text) : null;

  const html = renderTicketHtml({
    tenantName: tenant?.name ?? "Inami",
    tenantPhone: tenant?.whatsapp ?? "",
    tenantLogo: logoDataUrl,
    branch,
    qrDataUrl,
    order,
    paperWidthMm: settings.paperWidthMm ?? 80,
    copies: settings.copies ?? 1,
  });

  // copies=1 acá porque renderTicketHtml ya genera N páginas con page-break.
  return await renderAndPrint(html, settings.printerName!, 1, settings.silentMode ?? true);
}

// Descarga el logo y lo convierte a data:URL. Cachea en memoria por URL para
// no re-descargar cada ticket. Si falla, retorna null y el ticket sale sin logo.
const logoCache = new Map<string, string>();
async function fetchLogoAsDataUrl(url: string): Promise<string | null> {
  if (logoCache.has(url)) return logoCache.get(url) ?? null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = res.headers.get("content-type") || "image/png";
    const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
    logoCache.set(url, dataUrl);
    return dataUrl;
  } catch (e) {
    console.error("Logo fetch failed:", url, e);
    return null;
  }
}

async function printTestTicket(): Promise<boolean> {
  const settings = store.get("settings");
  const session = store.get("session");
  if (!settings.printerName) return false;

  // Si hay sesión y tenant elegido, intenta traer el logo real para que la
  // prueba muestre cómo va a quedar el ticket de verdad.
  let tenantName = "Inami — Test";
  let tenantLogo: string | null = null;
  if (session?.accessToken && session.tenantId) {
    try {
      const sb = await getSupabase();
      if (sb) {
        const { data: t } = await sb
          .from("tenants").select("name, logo_url").eq("id", session.tenantId).maybeSingle();
        if (t?.name) tenantName = `${t.name} — Test`;
        if (t?.logo_url) tenantLogo = await fetchLogoAsDataUrl(t.logo_url);
      }
    } catch {}
  }

  const html = renderTicketHtml({
    tenantName,
    tenantPhone: "",
    tenantLogo,
    branch: null,
    qrDataUrl: null,
    order: {
      order_number: 9999,
      tenant_order_number: 999,
      customer_name: "Cliente de prueba",
      customer_phone: "+57 300 000 0000",
      address: "Cra 0 # 0-0",
      address_details: "Apto Test",
      subtotal: 30000,
      delivery_fee: 5000,
      total: 35000,
      payment_method: "cash",
      payment_status: "approved",
      notes: "Prueba de impresión",
      items: [
        { product_name: "Hamburguesa de prueba", variant_name: "Sencilla", quantity: 1, unit_price: 25000, subtotal: 25000, toppings: [], notes: null },
        { product_name: "Gaseosa", variant_name: null, quantity: 1, unit_price: 5000, subtotal: 5000, toppings: [], notes: null },
      ],
      created_at: new Date().toISOString(),
    },
    paperWidthMm: settings.paperWidthMm ?? 80,
    copies: settings.copies ?? 1,
  });
  // copies=1 acá porque renderTicketHtml ya genera N páginas con page-break.
  return await renderAndPrint(html, settings.printerName, 1, settings.silentMode ?? true);
}

// Render el HTML en una ventana invisible y dispara la impresión silent.
// IMPORTANTE: nada de `offscreen: true` — webContents.print() requiere el
// pipeline de rendering normal de Chromium para producir PDF al spooler.
// Devuelve true si TODAS las copias se enviaron sin error al spooler.
async function renderAndPrint(html: string, printerName: string, copies: number, silent: boolean): Promise<boolean> {
  if (printWindow) {
    try { printWindow.close(); } catch {}
    printWindow = null;
  }
  printWindow = new BrowserWindow({
    show: false,
    width: 800,
    height: 1200,
    webPreferences: { offscreen: false, contextIsolation: true, nodeIntegration: false },
  });
  await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  // Espera a que TODAS las imágenes (logo) hayan terminado de cargar antes
  // de imprimir, sino el ticket sale sin logo en silent mode.
  try {
    await printWindow.webContents.executeJavaScript(`
      Promise.all(Array.from(document.images).map(img =>
        img.complete ? Promise.resolve() :
          new Promise(r => { img.onload = img.onerror = () => r(null); })
      )).then(() => true)
    `);
  } catch {}
  // Margen extra para layout de @page después de que el browser midió las imgs
  await new Promise((r) => setTimeout(r, 200));

  let allOk = true;
  for (let i = 0; i < copies; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      printWindow!.webContents.print(
        {
          silent,
          deviceName: printerName,
          printBackground: true,
          margins: { marginType: "none" },
        },
        (success, errorType) => {
          if (!success) console.error(`Print error: ${errorType}`);
          resolve(success);
        },
      );
    });
    if (!ok) allOk = false;
  }
  setTimeout(() => {
    if (printWindow) {
      try { printWindow.close(); } catch {}
      printWindow = null;
    }
  }, 1500);
  return allOk;
}

// HTML del ticket — formato POS v0.5.0
//
// Port directo del nuevo diseño POS del proyecto principal
// (src/lib/printTicket.ts → renderCopy). Usa Poppins (con fallback monospace),
// header multilínea de la sede, divider ASCII, totales con border, footer
// custom y QR opcional. Soporta múltiples copias con page-break entre ellas
// para que la térmica corte automáticamente.
//
// Datos que toma:
// - branch.invoice_* (logo, legal_name, header, footer, QR) — gana sobre tenant
// - tenant (fallback de logo y nombre)
// - order + order_items
//
// Si actualizan el formato en src/lib/printTicket.ts del proyecto principal,
// sincronizar acá para mantener identidad visual entre /admin preview y la
// impresión real.
function renderTicketHtml(args: {
  tenantName: string;
  tenantPhone: string;
  tenantLogo: string | null;
  branch: any | null;
  qrDataUrl: string | null;
  order: any;
  paperWidthMm: number;
  copies: number;
}): string {
  const { tenantName, tenantPhone, tenantLogo, branch, qrDataUrl, order, paperWidthMm, copies } = args;
  const widthMm = paperWidthMm === 58 ? 58 : 80;
  const compact = branch?.invoice_print_compact === true || widthMm === 58;
  const baseFont = compact ? 9 : 11;
  const innerWidthMm = Math.max(40, widthMm - 4);

  const safeCopies = Math.max(1, Math.min(5, copies || 1));
  const labels = safeCopies === 1
    ? ["** TICKET **"]
    : safeCopies === 2
      ? ["** COPIA COCINA **", "** COPIA CLIENTE **"]
      : Array.from({ length: safeCopies }, (_, i) => `** COPIA ${i + 1}/${safeCopies} **`);

  const copiesHtml = labels.map((lbl, i) => {
    const isLast = i === labels.length - 1;
    const copy = renderCopyPOS({
      tenantName, tenantPhone, tenantLogo, branch, qrDataUrl, order,
      copyLabel: lbl, baseFont,
    });
    return isLast
      ? copy
      : copy + '<div class="cut">— — — — — corte — — — — —</div><div class="page-break"></div>';
  }).join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Ticket ${order.order_number}</title>
<style>
  @page { size: ${widthMm}mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000;
    font-family: 'Poppins', system-ui, 'Courier New', monospace;
    font-size: ${baseFont}px; line-height: 1.4; }
  .invoice-print { width: ${innerWidthMm}mm; padding: 2mm; }
  .invoice-print table { width: 100%; border-collapse: collapse; }
  .invoice-print td, .invoice-print th { padding: 0; vertical-align: top; }
  .invoice-print .ip-right { text-align: right; }
  .invoice-print .ip-center { text-align: center; }
  .invoice-print .ip-left { text-align: left; }
  .invoice-print .ip-muted { color: #666; }

  .invoice-print .ip-divider {
    text-align: center; letter-spacing: 1px; color: #000; margin: 3px 0;
    font-family: 'Courier New', monospace; white-space: nowrap; overflow: hidden;
  }
  .invoice-print .ip-logo-wrap { text-align: center; margin-bottom: 4px; }
  .invoice-print .ip-logo {
    max-height: ${compact ? 50 : 70}px; max-width: 90%; object-fit: contain;
    filter: grayscale(1) contrast(1.3);
  }
  .invoice-print .ip-header { text-align: center; line-height: 1.3; }
  .invoice-print .ip-header-primary { font-weight: 700; font-size: ${baseFont + 2}px; }
  .invoice-print .ip-header-line { font-size: ${baseFont - 1}px; }
  .invoice-print .ip-legal { text-align: center; font-size: ${baseFont - 2}px; color: #444; margin-top: 2px; }
  .invoice-print .ip-copy-label { text-align: center; font-size: ${baseFont - 2}px; color: #555; margin-top: 2px; letter-spacing: 1px; }
  .invoice-print .ip-meta td, .invoice-print .ip-payment td { padding: 1px 0; }
  .invoice-print .ip-addr { padding-top: 2px !important; line-height: 1.3; }
  .invoice-print .ip-notes { font-size: ${baseFont - 1}px; padding: 2px 0; }
  .invoice-print .ip-items th {
    font-weight: 700; padding-bottom: 3px; border-bottom: 1px dotted #888;
  }
  .invoice-print .ip-items .ip-item-row td { padding: 2px 0; }
  .invoice-print .ip-item-mods { font-size: ${baseFont - 2}px; color: #444; padding-left: 4px; }
  .invoice-print .ip-variant { color: #555; font-size: ${baseFont - 1}px; }
  .invoice-print .ip-totals td { padding: 1px 0; }
  .invoice-print .ip-total-row td { padding-top: 4px; border-top: 1px solid #000; font-size: ${baseFont + 1}px; }
  .invoice-print .ip-footer { text-align: center; margin-top: 4px; line-height: 1.4; font-size: ${baseFont - 1}px; }
  .invoice-print .ip-qr-wrap { text-align: center; margin-top: 6px; }
  .invoice-print .ip-qr-img { display: inline-block; width: ${compact ? 90 : 110}px; height: ${compact ? 90 : 110}px; }
  .invoice-print .ip-qr-caption { font-size: ${baseFont - 2}px; color: #555; word-break: break-all; margin-top: 2px; }

  .cut { border-top: 1px dashed #000; margin: 8px 0; text-align: center; font-size: ${baseFont - 2}px; color: #555; }
  .page-break { break-after: page; page-break-after: always; height: 0; }
</style></head>
<body>
${copiesHtml}
</body></html>`;
}

function renderCopyPOS(args: {
  tenantName: string;
  tenantPhone: string;
  tenantLogo: string | null;
  branch: any | null;
  qrDataUrl: string | null;
  order: any;
  copyLabel: string;
  baseFont: number;
}): string {
  const { tenantName, tenantPhone, tenantLogo, branch, qrDataUrl, order, copyLabel } = args;
  const fmt = (n: number) => "$" + Math.round(Number(n)).toLocaleString("es-CO");
  const dailyN = order.tenant_order_number
    ? `P-${String(order.tenant_order_number).padStart(3, "0")}`
    : `#${order.order_number}`;

  const showLogo = branch?.invoice_print_logo !== false;
  const logoHtml = showLogo && tenantLogo
    ? `<div class="ip-logo-wrap"><img class="ip-logo" src="${tenantLogo}" alt="" /></div>`
    : "";

  // Header: si la sede tiene invoice_header_message lo usamos (multilínea).
  // Sino fallback al tenantName + tenantPhone.
  let headerLines: string[];
  if (branch?.invoice_header_message) {
    headerLines = branch.invoice_header_message.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
  } else {
    headerLines = [tenantName];
    if (tenantPhone) headerLines.push(tenantPhone);
  }
  const headerHtml = headerLines.map((line, i) =>
    `<div class="${i === 0 ? "ip-header-primary" : "ip-header-line"}">${escapeHtml(line)}</div>`,
  ).join("");

  const legalHtml = branch?.legal_name
    ? `<div class="ip-legal">${escapeHtml(branch.legal_name)}${branch.tax_id ? " · NIT " + escapeHtml(branch.tax_id) : ""}</div>`
    : "";

  const itemsHtml = (order.items || []).map((it: any) => {
    const tops = Array.isArray(it.toppings) && it.toppings.length
      ? `<div class="ip-item-mods">+ ${it.toppings.map((t: any) => escapeHtml(t.name || "")).join(", ")}</div>`
      : "";
    const noteHtml = it.notes ? `<div class="ip-item-mods">⚠ ${escapeHtml(it.notes)}</div>` : "";
    const variant = it.variant_name ? ` <span class="ip-variant">(${escapeHtml(it.variant_name)})</span>` : "";
    return `<tr class="ip-item-row">
      <td class="ip-left ip-item-name">
        <div>${escapeHtml(it.product_name)}${variant}</div>
        ${tops}${noteHtml}
      </td>
      <td class="ip-center">${it.quantity}</td>
      <td class="ip-right">${fmt(it.subtotal)}</td>
    </tr>`;
  }).join("");

  const footerHtml = branch?.invoice_footer_message
    ? branch.invoice_footer_message.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean)
        .map((line: string) => `<div>${escapeHtml(line)}</div>`).join("")
    : `<div>¡Gracias por tu compra!</div>`;

  const qrHtml = qrDataUrl && branch?.invoice_qr_text
    ? `<div class="ip-qr-wrap">
         <img src="${qrDataUrl}" class="ip-qr-img" alt="" />
         <div class="ip-qr-caption">${escapeHtml(branch.invoice_qr_text)}</div>
       </div>`
    : "";

  const dateStr = new Date(order.created_at).toLocaleString("es-CO", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });

  return `
    <div class="invoice-print">
      ${logoHtml}
      <div class="ip-header">${headerHtml}</div>
      ${legalHtml}
      <div class="ip-copy-label">${escapeHtml(copyLabel)}</div>
      <div class="ip-divider">${"-".repeat(40)}</div>

      <table class="ip-meta">
        <tbody>
          <tr><td>Pedido No.</td><td class="ip-right"><strong>${escapeHtml(dailyN)}</strong></td></tr>
          <tr><td>Fecha:</td><td class="ip-right">${escapeHtml(dateStr)}</td></tr>
          <tr><td>Cliente:</td><td class="ip-right">${escapeHtml(order.customer_name || "------")}</td></tr>
          <tr><td>Teléfono:</td><td class="ip-right">${escapeHtml(order.customer_phone || "------")}</td></tr>
          <tr><td colspan="2" class="ip-addr">${escapeHtml(order.address || "")}${order.address_details ? "<br><span class='ip-muted'>" + escapeHtml(order.address_details) + "</span>" : ""}</td></tr>
        </tbody>
      </table>

      ${order.notes ? `<div class="ip-divider">${"-".repeat(40)}</div><div class="ip-notes"><strong>Notas:</strong> ${escapeHtml(order.notes)}</div>` : ""}

      <div class="ip-divider">${"-".repeat(40)}</div>

      <table class="ip-items">
        <thead>
          <tr>
            <th class="ip-left">Producto</th>
            <th class="ip-center">Cant.</th>
            <th class="ip-right">Precio</th>
          </tr>
        </thead>
        <tbody>${itemsHtml}</tbody>
      </table>

      <div class="ip-divider">${"-".repeat(40)}</div>

      <table class="ip-totals">
        <tbody>
          <tr><td>Subtotal</td><td class="ip-right">${fmt(order.subtotal)}</td></tr>
          ${order.delivery_fee > 0 ? `<tr><td>Domicilio</td><td class="ip-right">${fmt(order.delivery_fee)}</td></tr>` : ""}
          ${order.courier_tip > 0 ? `<tr><td>Propina domi</td><td class="ip-right">${fmt(order.courier_tip)}</td></tr>` : ""}
          <tr class="ip-total-row"><td><strong>TOTAL</strong></td><td class="ip-right"><strong>${fmt(order.total)}</strong></td></tr>
        </tbody>
      </table>

      <div class="ip-divider">${"-".repeat(40)}</div>

      <table class="ip-payment">
        <tbody>
          <tr><td>Método de pago:</td><td class="ip-right">${escapeHtml(paymentLabel(order.payment_method))}</td></tr>
          <tr><td>Estado:</td><td class="ip-right">${escapeHtml(order.payment_status || "pending")}</td></tr>
        </tbody>
      </table>

      <div class="ip-divider">${"-".repeat(40)}</div>

      <div class="ip-footer">${footerHtml}</div>
      ${qrHtml}
    </div>
  `;
}

// QR data URL generado lazy con la lib qrcode (~30KB). Si la lib no está
// instalada o falla, retorna null y el ticket sale sin QR — graceful.
async function generateQRDataUrl(text: string): Promise<string | null> {
  if (!text) return null;
  try {
    // @ts-ignore — qrcode no tiene types incluidos por default
    const QR = await import("qrcode");
    return await QR.default.toDataURL(text, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 220,
      color: { dark: "#000000", light: "#ffffff" },
    });
  } catch (e) {
    console.error("QR generation failed:", e);
    return null;
  }
}

function paymentLabel(m: string): string {
  switch (m) {
    case "cash": return "Efectivo contra entrega";
    case "card_on_delivery": return "Datáfono al recibir";
    case "wompi": return "Pago en línea (Wompi)";
    case "bold": return "Pago en línea (Bold)";
    default: return m;
  }
}

function escapeHtml(s: any): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ──────────────────────────────────────────────────────
// IPC: el renderer (UI de config) habla con el main
// ──────────────────────────────────────────────────────
ipcMain.handle("printer:list", async () => {
  // Lista impresoras disponibles del SO via webContents.getPrintersAsync.
  // El webContents necesita estar inicializado, por eso about:blank.
  const tmp = new BrowserWindow({ show: false, webPreferences: { offscreen: false } });
  try {
    await tmp.loadURL("about:blank");
    const printers = await tmp.webContents.getPrintersAsync();
    return printers;
  } catch (e) {
    console.error("getPrintersAsync failed:", e);
    return [];
  } finally {
    try { tmp.close(); } catch {}
  }
});

ipcMain.handle("settings:get", () => store.get("settings"));
ipcMain.handle("settings:set", (_e, settings: Settings) => {
  store.set("settings", { ...store.get("settings"), ...settings });
  refreshTrayMenu();
  return store.get("settings");
});

ipcMain.handle("session:get", () => store.get("session"));
ipcMain.handle("session:set", async (_e, session: SessionState | null) => {
  store.set("session", session);
  refreshTrayMenu();
  if (session?.accessToken && session.tenantId) {
    await startRealtime();
  } else {
    await stopRealtime();
  }
  return session;
});

ipcMain.handle("config:supabase", () => ({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY }));

ipcMain.handle("printer:test", async () => {
  return await printTestTicket();
});

ipcMain.handle("notification:test", async () => {
  showNewOrderNotification({
    order_number: 9999,
    tenant_order_number: 999,
    customer_name: "Cliente de prueba",
    total: 35000,
  });
  playBeep();
  return true;
});

// ──────────────────────────────────────────────────────
// App lifecycle
// ──────────────────────────────────────────────────────
// Habilita reproducir el beep sin gesto de usuario (HTML5 audio).
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

app.whenReady().then(async () => {
  createTray();
  // Si ya hay sesión, arrancamos Realtime sin abrir ventana
  const session = store.get("session");
  if (session?.accessToken && session.tenantId) {
    await startRealtime();
  } else {
    openConfigWindow();
  }
});

// No hacer app.quit() al cerrar ventanas — el plugin vive en el tray.
// En macOS este es el comportamiento por defecto; en Win/Linux NO subscribirse
// a window-all-closed evita el quit automático.
if (process.platform !== "darwin") {
  app.on("window-all-closed", () => {
    // intencional: no llamamos app.quit()
  });
}

app.on("before-quit", async () => {
  await stopRealtime();
});
