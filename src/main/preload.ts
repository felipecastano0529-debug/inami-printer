// Preload: expone funciones seguras del main al renderer
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  listPrinters: () => ipcRenderer.invoke("printer:list"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (s: any) => ipcRenderer.invoke("settings:set", s),
  getSession: () => ipcRenderer.invoke("session:get"),
  setSession: (s: any) => ipcRenderer.invoke("session:set", s),
  getSupabaseConfig: () => ipcRenderer.invoke("config:supabase"),
  testPrint: () => ipcRenderer.invoke("printer:test"),
  testNotification: () => ipcRenderer.invoke("notification:test"),
});
