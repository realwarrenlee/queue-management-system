import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const files = readdirSync('dist', { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name !== 'sw.js')
  .map(entry => '/' + join(entry.parentPath, entry.name).replaceAll('\\', '/').replace(/^dist\//, ''))
  .sort()
assert(files.includes('/index.html') && files.some(file => /\/assets\/.*\.js$/.test(file)) && files.some(file => /\/assets\/.*\.css$/.test(file)), 'Build must include HTML, JS and CSS for offline loading')
assert(!files.some(file => file.startsWith('/api/')), 'Never precache API data')
const hash = createHash('sha256')
for (const file of files) hash.update(readFileSync('dist' + file))
const build = hash.digest('hex').slice(0, 12)
const worker = readFileSync('public/sw.js', 'utf8').replace('__BUILD__', `beans-shell-${build}`).replace('__PRECACHE__', JSON.stringify(files))
writeFileSync('dist/sw.js', worker)
console.log(`Offline shell: ${files.length} files, build ${build}`)
