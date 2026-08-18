import './material.css'
import { registerTheme } from './registry'
import { MATERIAL_ICONS, MATERIAL_VIEWBOX } from './material-icons'

registerTheme({
  id: 'material',
  label: 'Material',
  rowHeight: 36,
  icons: MATERIAL_ICONS,
  iconViewBox: MATERIAL_VIEWBOX,
})
