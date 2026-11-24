// 草稿途徑的連線：以 csa_drafter 角色連到 CSA 資料庫（ADR-0006、Q90）。
// 主機、埠號與資料庫沿用 CSA_DB_URL（每個 worktree 各自的 csa_dev_<N>），帳號固定是 csa_drafter，
// 密碼是 CSA_DRAFTER_PASSWORD（db:init 依它建立或同步這個登入角色）。兩者都必填：沒有預設密碼，
// 免得部署時漏設，資料庫裡就多一個用公開密碼登入的角色。

export function drafterConnectionString(env: Record<string, string | undefined>): string {
  const missing = ['CSA_DB_URL', 'CSA_DRAFTER_PASSWORD'].filter((name) => !env[name])
  if (missing.length) {
    throw new Error(`缺少 ${missing.join('、')}：請照 .env.example 補進 .env（見 docs/對話寫入草稿操作說明.md）`)
  }
  const url = new URL(env.CSA_DB_URL!)
  url.username = 'csa_drafter'
  url.password = env.CSA_DRAFTER_PASSWORD!
  return url.toString()
}
