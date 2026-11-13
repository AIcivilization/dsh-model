// checkin/ext/checkin-secrets.js — dsh-model 版（设计 §14.28）
//
// dsh-checkin-all 里这里存手动填的签到凭据（灵犀 wps_sid、DuMate Cookie、AStudio 登录……）。
// dsh-model 这一版先只做「读本机 App 已有的登录」，零配置：手动凭据一律当没有，各 provider 自动退回读本机 App。

/** 某个服务手动填的凭据：dsh-model 不存 */
export async function getManual(_service, _env = process.env) {
  return null
}

/** 某个服务手动配的多个账号：dsh-model 不存 */
export async function listAccounts(_service, _env = process.env) {
  return []
}
