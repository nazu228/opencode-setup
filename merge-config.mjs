import fs from "node:fs"
import path from "node:path"

const configDir = process.argv[2] || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".config", "opencode")
const opencodePath = path.join(configDir, "opencode.json")

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")
  return JSON.parse(text)
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8")
}

const template = {
  $schema: "https://opencode.ai/config.json",
  model: "openrouter/deepseek/deepseek-v4.1-flash-1017",
  plugins: [],
}

const config = readJson(opencodePath, template)
if (!Array.isArray(config.plugins)) config.plugins = []

const has = (name) =>
  config.plugins.some((entry) => {
    if (typeof entry === "string") return entry.includes(name)
    return entry && typeof entry === "object" && String(entry.package || "").includes(name)
  })

if (!has("cc-safety-net")) config.plugins.push("cc-safety-net@2.7.12")

const plannotator = {
  package: "@plannotator/opencode@0.28.62",
  options: {
    workflow: "plan-agent",
    planningAgents: ["team-lid"],
  },
}
config.plugins = config.plugins.filter((entry) => {
  if (typeof entry === "string") return !entry.includes("@plannotator/opencode")
  return !(entry && typeof entry === "object" && String(entry.package || "").includes("@plannotator/opencode"))
})
config.plugins.push(plannotator)

writeJson(opencodePath, config)

console.log(`merged: ${opencodePath}`)
