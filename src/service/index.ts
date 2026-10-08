// service/index.ts — 引擎的系统服务：按运行模式挑 launchd / systemd --user / systemd 系统级

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Ctx } from '../context.js'
import type { ServiceKind } from '../state.js'
import { currentBinary } from '../engine/install.js'
import { launchd } from './launchd.js'
import { systemd } from './systemd.js'

export const SERVICE_LABEL = 'com.dsh-model.engine'
export const UNIT_NAME = 'dsh-model-engine.service'

export interface ServiceStatus {
  installed: boolean
  running: boolean
  pid?: number
  detail?: string
}

export interface ServiceSpec {
  label: string
  file: string
  program: string[]
  workingDirectory: string
  stdoutPath: string
  user?: string
  home: string
}

export interface ServiceManager {
  kind: ServiceKind
  spec: ServiceSpec
  install(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  restart(): Promise<void>
  status(): Promise<ServiceStatus>
  uninstall(): Promise<void>
  /** 不写文件，只给出将要写的内容（repair / 测试用） */
  render(): string
}

export function serviceKind(ctx: Ctx): ServiceKind {
  if (ctx.mode === 'vps') return 'systemd-system'
  return ctx.platform === 'darwin' ? 'launchd' : 'systemd-user'
}

export function serviceFor(ctx: Ctx): ServiceManager {
  const kind = serviceKind(ctx)
  const common = {
    program: [currentBinary(ctx), '-config', ctx.paths.engineYaml],
    workingDirectory: ctx.paths.home,
    stdoutPath: join(ctx.paths.home, 'engine.stdout.log'),
    home: ctx.paths.home,
  }
  if (kind === 'launchd') {
    return launchd({ ...common, label: SERVICE_LABEL, file: join(homedir(), 'Library/LaunchAgents', `${SERVICE_LABEL}.plist`) })
  }
  if (kind === 'systemd-user') {
    return systemd('systemd-user', { ...common, label: UNIT_NAME, file: join(homedir(), '.config/systemd/user', UNIT_NAME) })
  }
  return systemd('systemd-system', { ...common, label: UNIT_NAME, file: join('/etc/systemd/system', UNIT_NAME), user: ctx.runAs })
}
