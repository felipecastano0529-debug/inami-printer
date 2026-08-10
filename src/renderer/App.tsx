// UI de configuración del Inami Printer.
// Pantallas: Login → Selector de tenant → Selector de impresora → Estado.

import React, { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";

declare global {
  interface Window {
    api: {
      listPrinters: () => Promise<any[]>;
      getSettings: () => Promise<any>;
      setSettings: (s: any) => Promise<any>;
      getSession: () => Promise<any>;
      setSession: (s: any) => Promise<any>;
      getSupabaseConfig: () => Promise<{ url: string; anonKey: string }>;
      testPrint: () => Promise<boolean>;
      testNotification: () => Promise<boolean>;
    };
  }
}

interface Tenant { id: string; name: string; }

export default function App() {
  const [config, setConfig] = useState<{ url: string; anonKey: string } | null>(null);
  const [session, setSession] = useState<any>(null);
  const [settings, setSettings] = useState<any>(null);
  const [printers, setPrinters] = useState<any[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const cfg = await window.api.getSupabaseConfig();
      const ses = await window.api.getSession();
      const set = await window.api.getSettings();
      const prs = await window.api.listPrinters();
      setConfig(cfg);
      setSession(ses);
      setSettings(set);
      setPrinters(prs);

      if (ses?.accessToken && cfg) {
        await loadTenants(cfg, ses.accessToken, ses.refreshToken);
      }
      setLoading(false);
    })();
  }, []);

  async function loadTenants(cfg: { url: string; anonKey: string }, accessToken: string, refreshToken: string) {
    const sb = createClient(cfg.url, cfg.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    await sb.auth.setSession({ access_token: accessToken, refresh_token: refreshToken || "" });
    const { data: roles } = await sb.from("user_roles").select("tenant_id, role, tenant:tenants(id, name)").not("tenant_id", "is", null);
    const list: Tenant[] = [];
    const seen = new Set();
    for (const r of (roles as any[]) ?? []) {
      const t = (r as any).tenant;
      if (t && !seen.has(t.id)) {
        list.push({ id: t.id, name: t.name });
        seen.add(t.id);
      }
    }
    setTenants(list);
  }

  async function handleLogin(email: string, password: string) {
    if (!config) return;
    setError(null);
    try {
      const sb = createClient(config.url, config.anonKey, { auth: { persistSession: false } });
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      const newSession = {
        accessToken: data.session?.access_token,
        refreshToken: data.session?.refresh_token,
        userEmail: data.user?.email,
      };
      const ses = await window.api.setSession(newSession);
      setSession(ses);
      await loadTenants(config, newSession.accessToken!, newSession.refreshToken!);
    } catch (e: any) {
      setError(e?.message ?? "Error de login");
    }
  }

  async function handlePickTenant(t: Tenant) {
    const newSession = { ...session, tenantId: t.id, tenantName: t.name };
    const ses = await window.api.setSession(newSession);
    setSession(ses);
  }

  async function handleLogout() {
    await window.api.setSession(null);
    setSession(null);
    setTenants([]);
  }

  async function updateSettings(patch: any) {
    const next = await window.api.setSettings(patch);
    setSettings(next);
  }

  if (loading) return <div style={{ padding: 32, textAlign: "center" }}>Cargando…</div>;

  // ─── Login ───
  if (!session?.accessToken) {
    return <Login onLogin={handleLogin} error={error} />;
  }

  // ─── Selector de tenant si tiene varios y no eligió todavía ───
  if (!session.tenantId && tenants.length > 0) {
    return (
      <div style={{ padding: 8 }}>
        <Header userEmail={session.userEmail} onLogout={handleLogout} />
        <h2 style={{ marginTop: 24, marginBottom: 12 }}>Elige el restaurante</h2>
        <p style={panelMuted}>Vamos a imprimir los pedidos de este restaurante en esta impresora.</p>
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          {tenants.map((t) => (
            <button key={t.id} onClick={() => handlePickTenant(t)} style={btnPrimary}>
              {t.name}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ─── Configuración impresora + estado ───
  return (
    <div style={{ padding: 8 }}>
      <Header userEmail={session.userEmail} onLogout={handleLogout} />

      <Card>
        <Row>
          <Label>Restaurante</Label>
          <strong>{session.tenantName ?? "—"}</strong>
        </Row>
        <Row>
          <Label>Estado</Label>
          <span style={{ color: settings?.printerName ? "var(--success)" : "var(--warning)" }}>
            {settings?.printerName ? "● Activo · imprimirá pedidos en vivo" : "● Selecciona una impresora"}
          </span>
        </Row>
      </Card>

      <Card>
        <h3 style={{ margin: 0, marginBottom: 12 }}>Impresora</h3>
        <select
          value={settings?.printerName || ""}
          onChange={(e) => updateSettings({ printerName: e.target.value })}
          style={selectStyle}
        >
          <option value="">— Elegir impresora —</option>
          {printers.map((p) => (
            <option key={p.name} value={p.name}>
              {p.displayName || p.name}
            </option>
          ))}
        </select>

        <Row style={{ marginTop: 12 }}>
          <Label>Ancho de papel</Label>
          <select
            value={settings?.paperWidthMm ?? 80}
            onChange={(e) => updateSettings({ paperWidthMm: Number(e.target.value) })}
            style={{ ...selectStyle, width: 100 }}
          >
            <option value={58}>58 mm</option>
            <option value={80}>80 mm</option>
          </select>
        </Row>

        <Row style={{ marginTop: 12 }}>
          <Label>Copias</Label>
          <input
            type="number"
            min={1}
            max={5}
            value={settings?.copies ?? 1}
            onChange={(e) => updateSettings({ copies: Number(e.target.value) })}
            style={{ ...selectStyle, width: 70 }}
          />
        </Row>

        <Row style={{ marginTop: 12 }}>
          <Label>Imprimir sin diálogo</Label>
          <input
            type="checkbox"
            checked={settings?.silentMode ?? true}
            onChange={(e) => updateSettings({ silentMode: e.target.checked })}
          />
        </Row>

        <Row style={{ marginTop: 12 }}>
          <Label>Sonido al recibir pedido</Label>
          <input
            type="checkbox"
            checked={settings?.soundEnabled ?? true}
            onChange={(e) => updateSettings({ soundEnabled: e.target.checked })}
          />
        </Row>

        <Row style={{ marginTop: 12 }}>
          <Label>Notificación del sistema</Label>
          <input
            type="checkbox"
            checked={settings?.notificationEnabled ?? true}
            onChange={(e) => updateSettings({ notificationEnabled: e.target.checked })}
          />
        </Row>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 16 }}>
          <button
            disabled={!settings?.printerName}
            onClick={() => window.api.testPrint()}
            style={btnGlass}
          >
            🧾 Probar impresión
          </button>
          <button
            onClick={() => window.api.testNotification()}
            style={btnGlass}
          >
            🔔 Probar sonido
          </button>
        </div>
      </Card>

      <p style={{ ...panelMuted, marginTop: 24, textAlign: "center", fontSize: 12 }}>
        Puedes cerrar esta ventana — el plugin sigue corriendo en la barra del sistema.
      </p>
    </div>
  );
}

// ─── UI helpers ───
function Login({ onLogin, error }: { onLogin: (email: string, password: string) => void; error: string | null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <div style={{ padding: 32, textAlign: "center" }}>
      <div style={{ fontSize: 32 }}>🖨️</div>
      <h1 style={{ margin: "12px 0" }}>Inami Printer</h1>
      <p style={panelMuted}>Inicia sesión con tu cuenta de admin del restaurante</p>
      <form
        onSubmit={(e) => { e.preventDefault(); onLogin(email, password); }}
        style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 24 }}
      >
        <input
          type="email"
          placeholder="email@tudominio.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoFocus
          style={inputStyle}
        />
        <input
          type="password"
          placeholder="Contraseña"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          style={inputStyle}
        />
        {error && <div style={{ color: "var(--danger)", fontSize: 13 }}>{error}</div>}
        <button type="submit" style={btnPrimary}>Entrar</button>
      </form>
    </div>
  );
}

function Header({ userEmail, onLogout }: { userEmail: string; onLogout: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingBottom: 12, borderBottom: "1px solid var(--border)" }}>
      <div style={{ fontSize: 13 }}>
        <div style={panelMuted}>Sesión</div>
        <div>{userEmail}</div>
      </div>
      <button onClick={onLogout} style={btnGlass}>Cerrar sesión</button>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12, padding: 16, marginTop: 16 }}>
      {children}
    </div>
  );
}

function Row({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0", ...style }}>
      {children}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <span style={panelMuted}>{children}</span>;
}

const panelMuted: React.CSSProperties = { color: "var(--muted)", fontSize: 13 };
const inputStyle: React.CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "10px 12px",
  color: "var(--text)",
  fontSize: 14,
};
const selectStyle: React.CSSProperties = {
  ...inputStyle,
  width: "100%",
};
const btnPrimary: React.CSSProperties = {
  background: "var(--primary)",
  color: "#fff",
  border: "none",
  padding: "10px 16px",
  borderRadius: 8,
  cursor: "pointer",
  fontWeight: 700,
  fontSize: 14,
};
const btnGlass: React.CSSProperties = {
  background: "transparent",
  color: "var(--text)",
  border: "1px solid var(--border)",
  padding: "8px 12px",
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 13,
};
