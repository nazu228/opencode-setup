import fs from "node:fs"
import path from "node:path"

const configDir = process.argv[2] || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".config", "opencode")
const cliPath = path.join(configDir, "cli.json")

const fallback = {
  $schema: "https://opencode.ai/v2/cli.json",
}

let config = fallback
if (fs.existsSync(cliPath)) {
  const text = fs.readFileSync(cliPath, "utf8").replace(/^\uFEFF/, "")
  config = JSON.parse(text)
}

config.$schema = config.$schema || fallback.$schema
config.theme = {
  ...(config.theme && typeof config.theme === "object" ? config.theme : {}),
  name: "mitsuha",
  mode: "dark",
}
if (config.animations === undefined) config.animations = true
if (!Array.isArray(config.plugins)) config.plugins = []

fs.writeFileSync(cliPath, JSON.stringify(config, null, 2) + "\n", "utf8")
console.log(`merged: ${cliPath}`)
