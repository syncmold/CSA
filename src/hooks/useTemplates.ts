import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createControlPoint,
  createSection,
  createTemplate,
  deleteControlPoint,
  deleteSection,
  deleteTemplate,
  fetchTemplates,
  fetchTemplateTree,
  updateSection,
  reorderControlPoints,
  reorderSections,
  setControlPointReverse,
  updateControlPoint,
  updateTemplateHeader,
  type SectionInput,
  type TemplateHeaderInput,
  type TemplateStatus,
  type TemplateTree,
} from '../api/templates'
import { applyOrder } from '../domain/templates'
import { useWrite } from './useWrite'

const LIST = ['templates']

export function useTemplates() {
  return useQuery({ queryKey: LIST, queryFn: fetchTemplates })
}

export function useTemplateTree(id: string | undefined) {
  return useQuery({
    queryKey: ['templates', id],
    queryFn: () => fetchTemplateTree(id!),
    enabled: !!id,
  })
}

export function useCreateTemplate() {
  return useWrite(createTemplate, [LIST])
}

/**
 * The 範本管理 edits of one template. The header also shows in the list, so it refreshes both;
 * the structure only shows on the template page. Reorders show the new order at once and the
 * refetch afterwards replaces it with the database's (or puts it back when the write was refused).
 */
export function useTemplateEditing(templateId: string) {
  const queryClient = useQueryClient()
  const tree = ['templates', templateId]
  const showOrder = (update: (tree: TemplateTree) => TemplateTree) =>
    queryClient.setQueryData<TemplateTree | null>(tree, (current) => (current ? update(current) : current))

  return {
    updateHeader: useWrite((input: TemplateHeaderInput & { status: TemplateStatus }) => updateTemplateHeader(templateId, input), [LIST]),
    /**
     * Only a template that was never used; `confirmCode` is its 編號. The caller leaves the page afterwards,
     * so a success refreshes the list alone (refetching the deleted template would only come back empty);
     * a refusal refreshes this template, whose 已被使用 flag may have changed meanwhile.
     */
    deleteTemplate: useWrite(
      (confirmCode: string) =>
        deleteTemplate(templateId, confirmCode).then(
          () => void queryClient.invalidateQueries({ queryKey: LIST, exact: true }),
          (error: unknown) => {
            void queryClient.invalidateQueries({ queryKey: tree })
            throw error
          },
        ),
      [],
    ),
    createSection: useWrite((input: SectionInput) => createSection(templateId, input), [tree]),
    updateSection: useWrite(updateSection, [tree]),
    deleteSection: useWrite(deleteSection, [tree]),
    reorderSections: useWrite((ids: string[]) => {
      showOrder((t) => ({ ...t, template_section: applyOrder(t.template_section, ids) }))
      return reorderSections(templateId, ids)
    }, [tree]),
    createControlPoint: useWrite(createControlPoint, [tree]),
    updateControlPoint: useWrite(updateControlPoint, [tree]),
    setControlPointReverse: useWrite(setControlPointReverse, [tree]),
    deleteControlPoint: useWrite(deleteControlPoint, [tree]),
    reorderControlPoints: useWrite((sectionId: string, ids: string[]) => {
      showOrder((t) => ({
        ...t,
        template_section: t.template_section.map((s) => (s.id === sectionId ? { ...s, control_point: applyOrder(s.control_point, ids) } : s)),
      }))
      return reorderControlPoints(sectionId, ids)
    }, [tree]),
  }
}
