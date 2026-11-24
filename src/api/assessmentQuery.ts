// The PostgREST selects for one 自評表 page, kept apart from assessments.ts (which creates the browser
// client on import) so tests/db can run the exact same queries against PostgREST.

export const ASSESSMENT_TREE =
  'id,template_code,template_name,template_layout,status,current_step_position,my_current_steps,can_approve,' +
  'plant(factory_code,name),annual_cycle(year,due_date),' +
  'assessment_section(id,position,level,code,name,' +
  'assessment_control_point(id,position,code,text,' +
  'assessment_control_point_unit(position,assessing_unit_name,assessment_answer(design,execution,satisfaction,improvement)))),' +
  'assessment_step(id,position,name,step_group,signer_emp_id,editable_unit_name,branch_unit_name,state),' +
  'assessment_conclusion(assessing_unit_name,conclusion,exceptions)'

/** 簽核歷程 (#6): every 簽核紀錄 of a 自評表, voided ones included; the page orders them by signed_at, serial_no. */
export const SIGNOFF_COLUMNS =
  'serial_no,step_id,step_position,step_name,action,signer_emp_id,signer_name,comment,return_to_position,signature_method,signed_at,voided_at'

/**
 * 匯出 PDF (#7): the company the 版頭 prints, with its logo (a path the web app serves, e.g. logos/fulfil.png).
 * Aliased, so it can be added to ASSESSMENT_TREE, which already embeds plant.
 */
export const ASSESSMENT_COMPANY = 'pdf_company:plant(company(name,logo_path))'
