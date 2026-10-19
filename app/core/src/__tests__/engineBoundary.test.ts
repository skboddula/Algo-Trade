import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// app/core/src/__tests__ → repo root
const repoRoot = path.resolve(__dirname, '../../../..')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

describe('Strategy engine package boundary', () => {
  it('routes both apps through packages/strategy-engine', () => {
    const coreEngine = fs.readFileSync(
      path.join(repoRoot, 'app/core/src/services/strategyEngine.ts'),
      'utf8',
    )
    const clientEngine = fs.readFileSync(
      path.join(repoRoot, 'app/client/src/lib/strategyEngine.ts'),
      'utf8',
    )
    expect(coreEngine).toContain('packages/strategy-engine/src')
    expect(clientEngine).toContain('packages/strategy-engine/src')
    // Re-export only — no local scoring implementations.
    expect(coreEngine).toMatch(/^export \*/m)
    expect(clientEngine).toMatch(/^export \*/m)
  })

  it('forbids app-to-app source imports (core ⇄ client)', () => {
    for (const file of walk(path.join(repoRoot, 'app/core/src'))) {
      const src = fs.readFileSync(file, 'utf8')
      expect(src, file).not.toMatch(/from\s+['"][^'"]*\/client\/src/)
    }
    for (const file of walk(path.join(repoRoot, 'app/client/src'))) {
      const src = fs.readFileSync(file, 'utf8')
      expect(src, file).not.toMatch(/from\s+['"][^'"]*app\/core\/src/)
    }
  })
})
