import { createBrowserRouter, Navigate, Outlet } from 'react-router'
import { useAuth } from './auth/AuthContext'
import { AccessPage } from './pages/AccessPage'
import { AssessingUnitsPage } from './pages/AssessingUnitsPage'
import { AssessmentPage } from './pages/AssessmentPage'
import { AssignmentPage } from './pages/AssignmentPage'
import { HomePage } from './pages/HomePage'
import { LaunchPage } from './pages/LaunchPage'
import { LoginPage } from './pages/LoginPage'
import { RecordsPage } from './pages/RecordsPage'
import { RouteEditorPage } from './pages/RouteEditorPage'
import { RouteListPage } from './pages/RouteListPage'
import { TemplateDetailPage } from './pages/TemplateDetailPage'
import { TemplateListPage } from './pages/TemplateListPage'
import { TrackingPage } from './pages/TrackingPage'

/** Front-end gate only; the real permission check is RLS in the database (ADR-0001). */
function RequireSession() {
  const { session } = useAuth()
  return session ? <Outlet /> : <Navigate to="/login" replace />
}

/** The path the site is served from (VITE_BASE, e.g. /csa/ on GitHub Pages); routes stay relative to it. */
const basename = import.meta.env.BASE_URL.replace(/\/$/, '') || '/'

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireSession />,
    children: [
      { path: '/', element: <HomePage /> },
      // 簽核人頁面，不在 /admin/ 下 (Q80)。不在流程裡的人打網址進來，RLS 回空，頁面顯示找不到。
      { path: '/assessments/:id', element: <AssessmentPage /> },
      // 自評表紀錄 (#164)：每個人都有，看得到哪些照自評表的讀取規則（view assessment_record），不另寫規則。
      { path: '/records', element: <RecordsPage /> },
      // 範本管理 is not hidden behind a front-end role check on purpose: a non-admin who
      // types the URL gets an empty list from RLS, which is the behaviour #3 asks to verify.
      { path: '/admin/templates', element: <TemplateListPage /> },
      // 點名稱進來只能查看；/edit 才有編輯功能 (#66)。
      { path: '/admin/templates/:id', element: <TemplateDetailPage /> },
      { path: '/admin/templates/:id/edit', element: <TemplateDetailPage editing /> },
      { path: '/admin/assessing-units', element: <AssessingUnitsPage /> },
      // 流程編輯器 (#11)：同範本管理，不在前端擋角色，非稽核管理者看到 RLS 回的空清單。
      { path: '/admin/flows', element: <RouteListPage /> },
      { path: '/admin/flows/:id', element: <RouteEditorPage /> },
      { path: '/admin/flows/:id/edit', element: <RouteEditorPage editing /> },
      // 年度發起 (#12)：同上，不在前端擋角色；組合清單由資料庫決定，非稽核管理者拿到空清單。
      { path: '/admin/launch', element: <LaunchPage /> },
      // 分派填寫人 (#101)：同上，不在前端擋角色；自評表由資料庫決定，分派函式只接受本廠負責人與稽核管理者。
      { path: '/admin/assignment', element: <AssignmentPage /> },
      // 追蹤總覽 (#14)：同上，不在前端擋角色；view tracking_assessment 回給稽核管理者與檢視者（#58，檢視廠區），其他人看到空頁。
      { path: '/admin/tracking', element: <TrackingPage /> },
      // 權限管理 (#58)：同上，不在前端擋角色；名單與異動紀錄只有稽核管理者讀得到，維護函式也只給稽核管理者。
      { path: '/admin/access', element: <AccessPage /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
], { basename })
