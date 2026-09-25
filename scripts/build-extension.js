const fs = require("node:fs/promises");
const path = require("node:path");
const { zipSync } = require("fflate");

const projectRoot = path.resolve(__dirname, "..");
const sharedFiles = ["app.js", "data.js", "chart.js", "table.js", "export.js", "notifications.js", "styles.css", "LICENSE"];
const extensionFiles = ["manifest.json", "client.js", "popup.html", "popup.js", "options.html", "options.js", "extension.css", "icons/16.png", "icons/32.png", "icons/48.png", "icons/128.png"];

async function buildExtension(outputRoot = path.join(projectRoot, "dist")) {
  const outputDirectory = path.join(path.resolve(outputRoot), "extension");
  const archivePath = path.join(path.resolve(outputRoot), "gpt-token-look-extension.zip");
  const files = new Map(await Promise.all([
    ...sharedFiles.map(async (name) => [name, await fs.readFile(path.join(projectRoot, name))]),
    ...extensionFiles.map(async (name) => [name, await fs.readFile(path.join(projectRoot, "extension", name))])
  ]));
  const dashboard = await fs.readFile(path.join(projectRoot, "index.html"), "utf8");
  const entry = '  <script src="./app.js"></script>';
  if (dashboard.split(entry).length !== 2) throw new Error("The dashboard must contain exactly one app.js entry script.");
  files.set("dashboard.html", Buffer.from(dashboard.replace(entry, '  <script src="./client.js"></script>\n' + entry)));

  const zipFiles = {};
  for (const [name, content] of [...files].sort(([first], [second]) => first.localeCompare(second))) {
    const destination = path.join(outputDirectory, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content);
    zipFiles[name] = [content, { mtime: new Date(2020, 0, 1) }];
  }
  await fs.writeFile(archivePath, zipSync(zipFiles, { level: 9 }));
  return { directory: outputDirectory, archive: archivePath, files: files.size };
}

if (require.main === module) {
  buildExtension().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { buildExtension };
