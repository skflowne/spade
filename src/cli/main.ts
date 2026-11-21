import skill from '../../resources/skills/spade-canvas/SKILL.md?raw'
import { runCli } from './runCli'

// Entry of the bundled `spade` CLI (out/main/cli.js). Launcher shims run it with the SPADE executable in
// Node mode; it also runs under plain Node.
process.exitCode = await runCli(process.argv.slice(2), process.env, {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  cwd: process.cwd(),
  skill
})
