import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import {
  Trash, Cpu, CurrencyDollar, Question, HardDrives, Sparkle, Gauge, ListChecks, Lightning, HandPalm,
  PencilSimple, ArrowsInSimple, ChartPie, TerminalWindow,
} from '@phosphor-icons/react'
import type { SlashCommand } from '../../shared/slash-commands'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'

export type { SlashCommand }

const ICONS: Record<string, React.ReactNode> = {
  '/clear': <Trash size={13} />,
  '/cost': <CurrencyDollar size={13} />,
  '/model': <Cpu size={13} />,
  '/effort': <Gauge size={13} />,
  '/plan': <ListChecks size={13} />,
  '/auto': <Lightning size={13} />,
  '/manual': <HandPalm size={13} />,
  '/rename': <PencilSimple size={13} />,
  '/mcp': <HardDrives size={13} />,
  '/skills': <Sparkle size={13} />,
  '/help': <Question size={13} />,
  '/compact': <ArrowsInSimple size={13} />,
  '/context': <ChartPie size={13} />,
}

function iconFor(cmd: SlashCommand): React.ReactNode {
  return ICONS[cmd.command] ?? (cmd.icon === 'skill' ? <span className="text-[11px]">✦</span> : <TerminalWindow size={13} />)
}

interface Props {
  commands: SlashCommand[]
  selectedIndex: number
  onSelect: (cmd: SlashCommand) => void
  anchorRect: DOMRect | null
}

export function SlashCommandMenu({ commands: filtered, selectedIndex, onSelect, anchorRect }: Props) {
  const listRef = useRef<HTMLDivElement>(null)
  const popoverLayer = usePopoverLayer()
  const colors = useColors()

  useEffect(() => {
    if (!listRef.current) return
    const item = listRef.current.children[selectedIndex] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (filtered.length === 0 || !anchorRect || !popoverLayer) return null

  return createPortal(
    <motion.div
      data-clui-ui
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.12 }}
      style={{
        position: 'fixed',
        bottom: window.innerHeight - anchorRect.top + 4,
        left: anchorRect.left + 12,
        right: window.innerWidth - anchorRect.right + 12,
        pointerEvents: 'auto',
      }}
    >
      <div
        ref={listRef}
        className="overflow-y-auto rounded-xl py-1"
        style={{
          maxHeight: 220,
          background: colors.popoverBg,
          backdropFilter: 'blur(20px)',
          border: `1px solid ${colors.popoverBorder}`,
          boxShadow: colors.popoverShadow,
        }}
      >
        {filtered.map((cmd, i) => {
          const isSelected = i === selectedIndex
          return (
            <button
              key={cmd.command}
              onClick={() => onSelect(cmd)}
              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors"
              style={{
                background: isSelected ? colors.accentLight : 'transparent',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = colors.accentLight
              }}
              onMouseLeave={(e) => {
                if (!isSelected) {
                  (e.currentTarget as HTMLElement).style.background = 'transparent'
                }
              }}
            >
              <span
                className="flex items-center justify-center w-6 h-6 rounded-md flex-shrink-0"
                style={{
                  background: isSelected ? colors.accentSoft : colors.surfaceHover,
                  color: isSelected ? colors.accent : colors.textTertiary,
                }}
              >
                {iconFor(cmd)}
              </span>
              <div className="min-w-0 flex-1 truncate">
                <span
                  className="text-[12px] font-mono font-medium"
                  style={{ color: isSelected ? colors.accent : colors.textPrimary }}
                >
                  {cmd.command}
                </span>
                <span
                  className="text-[11px] ml-2"
                  style={{ color: colors.textTertiary }}
                >
                  {cmd.description}
                </span>
              </div>
            </button>
          )
        })}
      </div>
    </motion.div>,
    popoverLayer,
  )
}
