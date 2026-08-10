// El renderer del Electron app no usa Tailwind (solo CSS inline).
// Sin este archivo, Vite busca el postcss.config del repo raíz que pide
// tailwindcss y rompe el build de CI porque electron-app no tiene esa dep.
module.exports = { plugins: {} };
