import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext, type Ctx } from '../../src/context.js'

export async function tempCtx(extraEnv: Record<string, string> = {}): Promise<{ ctx: Ctx; root: string; profileDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-model-test-'))
  const dshHome = join(root, 'dsh')
  const profileDir = join(dshHome, 'profiles', 'desktop')
  await mkdir(profileDir, { recursive: true })
  const ctx = await createContext({
    ...process.env,
    DSH_MODEL_MODE: 'local',
    DSH_MODEL_HOME: join(root, 'home'),
    DSH_HOME: dshHome,
    DSH_MODEL_DSH_VERSION: '0.2.0-rc.2',
    DSH_MODEL_SERVICE: 'none',
    ...extraEnv,
  })
  return { ctx, root, profileDir }
}
