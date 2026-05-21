const fs = require('fs')
const path = require('path')

const toolsDir = path.join(__dirname, '..', 'dist', 'tools')
const files = fs.readdirSync(toolsDir).filter(f => f.endsWith('.js'))

for (const file of files) {
  const filePath = path.join(toolsDir, file)
  let content = fs.readFileSync(filePath, 'utf8')
  const original = content
  content = content.replace(/from "@opencode-ai\/plugin"/g, 'from "../types/plugin-shim.js"')
  if (content !== original) {
    fs.writeFileSync(filePath, content)
    console.log(`[postbuild] Patched ${file}`)
  }
}

// Copy prompt .txt files to dist/prompts
const promptsSrc = path.join(__dirname, '..', 'src', 'prompts')
const promptsDst = path.join(__dirname, '..', 'dist', 'prompts')
if (fs.existsSync(promptsSrc)) {
  const txtFiles = fs.readdirSync(promptsSrc).filter(f => f.endsWith('.txt'))
  for (const file of txtFiles) {
    fs.copyFileSync(path.join(promptsSrc, file), path.join(promptsDst, file))
    console.log(`[postbuild] Copied prompt ${file}`)
  }
}

console.log('[postbuild] Done')
