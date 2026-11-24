import { Flex, Switch } from 'antd'

/** 「顯示停用的範本／流程（n）」 above a 組成要素 list (#31, #85); the page keeps the choice in the URL. */
export function InactiveSwitch({ checked, onChange, label }: { checked: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <Flex align="center" gap={8}>
      <Switch size="small" checked={checked} onChange={onChange} data-testid="show-inactive" id="show-inactive" />
      <label htmlFor="show-inactive">{label}</label>
    </Flex>
  )
}
