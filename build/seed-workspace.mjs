import { constants, copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export function seedWorkspace(source, destination) {
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const input = join(source, entry.name)
    const output = join(destination, entry.name)
    if (entry.isDirectory()) {
      seedWorkspace(input, output)
    } else if (entry.isFile()) {
      try {
        copyFileSync(input, output, constants.COPYFILE_EXCL)
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
    }
  }
}
