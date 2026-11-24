// 登入卡的系統版本（Q123 (4)）：package.json 的版本加建置時的 commit 短碼，由 vite.config.ts 在建置時帶入。
// demo 部署是在主 checkout 的 main 上 `vite build` 再把成品推到 Vercel（scripts/deploy/deploy.mjs），Vercel 不重建，
// 所以短碼通常來自本機的 git；若日後改由 Vercel 從 GitHub 建置，就用它給的 VERCEL_GIT_COMMIT_SHA。

/** 和 Vercel 介面上顯示的短碼一樣長。 */
const SHORT = 7

/** 建置的 commit 短碼：先看 VERCEL_GIT_COMMIT_SHA，再問 git；兩者都拿不到（例如不在 git 裡）就是空字串。 */
export function buildCommit(env: Record<string, string | undefined>, gitHead: () => string): string {
  const vercel = env.VERCEL_GIT_COMMIT_SHA?.trim()
  if (vercel) return vercel.slice(0, SHORT)
  try {
    return gitHead().trim().slice(0, SHORT)
  } catch {
    return ''
  }
}
