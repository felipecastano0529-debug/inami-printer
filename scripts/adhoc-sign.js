// Firma ad-hoc (`codesign --sign -`) de la .app antes de empaquetar el .dmg.
//
// Por qué existe: en Apple Silicon macOS EXIGE que todo binario arm64 tenga
// alguna firma. Un .app sin firmar no muestra el diálogo de "desarrollador no
// verificado" — directamente no arranca ("la app está dañada, muévela a la
// papelera"). La firma ad-hoc no cuesta nada (no requiere el cert de $99/año)
// y es suficiente para que la app abra; el usuario sigue viendo el aviso de
// Gatekeeper la primera vez, eso sí se resuelve con "Abrir de todos modos".
//
// electron-builder no firma solo porque `mac.identity` es null (no tenemos
// certificado). Este hook corre por cada arquitectura empaquetada.
const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  // Los xattr (quarantine, Finder info) hacen fallar a codesign con
  // "resource fork, Finder information, or similar detritus not allowed".
  execFileSync("xattr", ["-cr", appPath], { stdio: "inherit" });

  // --deep firma de adentro hacia afuera: helpers y frameworks primero.
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });

  // Si la firma no quedó bien, mejor romper el build que publicar un .dmg
  // que no abre en ningún Mac.
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "inherit",
  });

  console.log(`  • firma ad-hoc aplicada  ${appPath}`);
};
