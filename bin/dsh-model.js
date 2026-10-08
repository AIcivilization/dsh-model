#!/usr/bin/env node
import('../dist/cli.js').then((m) => m.main(process.argv.slice(2))).then(
  (code) => process.exit(code ?? 0),
  (error) => {
    console.error(error?.stack ?? String(error))
    process.exit(1)
  },
)
