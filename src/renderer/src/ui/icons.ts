// SPADE's icon set: every icon the renderer shows, by what it means. Components use these names and never
// import Phosphor directly, so the set is chosen and swapped here. Icons are 1em and use currentColor:
// the slot's font-size and color size and tint them (see the Icons section of the style guide).
import {
  ArrowClockwiseIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowSquareOutIcon,
  ArrowUpIcon,
  CaretDownIcon,
  CaretRightIcon,
  CpuIcon,
  DotsThreeIcon,
  GearIcon,
  GlobeIcon,
  ImageIcon,
  InfoIcon,
  KeyboardIcon,
  MagnifyingGlassIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  MapTrifoldIcon,
  MinusSquareIcon,
  NoteIcon,
  PlusIcon,
  QuestionIcon,
  RobotIcon,
  ShareNetworkIcon,
  WarningIcon,
  XIcon,
  type Icon
} from '@phosphor-icons/react'

export type { Icon }

export const icons = {
  // Entity types and actors
  agent: RobotIcon,
  note: NoteIcon,
  image: ImageIcon,
  webpage: GlobeIcon,
  system: CpuIcon,
  unknownType: QuestionIcon,

  // Navigation
  back: ArrowLeftIcon,
  forward: ArrowRightIcon,
  parent: ArrowUpIcon,
  child: ArrowDownIcon,
  referenceOut: ArrowRightIcon,
  referenceIn: ArrowLeftIcon,
  pathSeparator: CaretRightIcon,
  search: MagnifyingGlassIcon,

  // Disclosure: a node, a conversation section
  expanded: CaretDownIcon,
  collapsed: CaretRightIcon,
  collapseBranch: MinusSquareIcon,

  // Actions
  add: PlusIcon,
  more: DotsThreeIcon,
  close: XIcon,
  remove: XIcon,
  stop: XIcon,
  reload: ArrowClockwiseIcon,
  openExternal: ArrowSquareOutIcon,
  zoomIn: MagnifyingGlassPlusIcon,
  zoomOut: MagnifyingGlassMinusIcon,
  related: ShareNetworkIcon,
  minimap: MapTrifoldIcon,
  shortcuts: KeyboardIcon,
  settings: GearIcon,

  // Notices
  info: InfoIcon,
  problem: WarningIcon
} as const satisfies Record<string, Icon>
