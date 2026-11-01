// 主播放栏和歌词页控制栏共用 VolumePopover。
// 已安装版触发按钮的 aria-label 是“音量”，较新的源码版本则使用“静音/取消静音”，这里同时兼容。
// 用捕获阶段监听滚轮，既覆盖两种页面，也避免宿主弹出层自己的滚轮逻辑再次调整音量。
const VOLUME_BUTTON_SELECTOR = [
  'button[aria-label="音量"]',
  'button[aria-label^="音量 · "]',
  'button[aria-label="静音"]',
  'button[aria-label="取消静音"]',
].join(', ')
const VOLUME_BAR_SELECTOR =
  '.player-bar-container, .lyric-bar, .playerbar-action-popover-proxy'
const POPOVER_TRIGGER_SELECTOR = '.echo-popover-trigger'
// VolumePopover 的弹层经 reka-ui Portal 挂到 body，内容根节点带有 vol-popover 类。
const VOLUME_POPOVER_CONTENT_SELECTOR = '.echo-popover-content.vol-popover'
const WHEEL_NOTCH = 100
const DISCRETE_WHEEL_THRESHOLD = 60
const DEFAULT_STEP = 5
const MIN_STEP = 1
const MAX_STEP = 20
// 悬停弹出与移开隐藏的延迟，与宿主 hover 弹层的手感保持一致，
// 也容忍鼠标从按钮滑向弹层时经过的 8px 空隙。
const HOVER_OPEN_DELAY = 100
const HOVER_HIDE_DELAY = 100

const isMacPlatform = () => {
  const platform = navigator.userAgentData?.platform || navigator.platform || ''
  return platform.toLowerCase().includes('mac')
}

// 统一不同 deltaMode 的滚轮单位，让鼠标滚轮和触控板都能按相近的节奏调节。
const normalizeWheelDelta = (event) => {
  const raw = Number(event.deltaY)
  if (!Number.isFinite(raw) || raw === 0) return 0
  if (event.deltaMode === 1) return raw * 40
  if (event.deltaMode === 2) return raw * 100
  return raw
}

const clampStep = (value) => {
  const step = Number(value)
  if (!Number.isFinite(step)) return DEFAULT_STEP
  return Math.min(MAX_STEP, Math.max(MIN_STEP, Math.round(step)))
}

// 鼠标滚轮通常是 100/120 的离散事件，直接按“格”计算；触控板的小增量则累积后触发。
const consumeWheelNotches = (delta, accumulated) => {
  const magnitude = Math.abs(delta)
  if (magnitude >= DISCRETE_WHEEL_THRESHOLD) {
    return {
      notches: Math.sign(delta) * Math.max(1, Math.round(magnitude / WHEEL_NOTCH)),
      accumulated: 0,
    }
  }

  const next = accumulated + delta
  const rawNotches = next / WHEEL_NOTCH
  const notches = rawNotches < 0 ? Math.ceil(rawNotches) : Math.floor(rawNotches)
  return {
    notches,
    accumulated: notches === 0 ? next : next - notches * WHEEL_NOTCH,
  }
}

const resolveVolumeButton = (target) => {
  if (!(target instanceof Element)) return null
  const direct = target.closest(VOLUME_BUTTON_SELECTOR)
  if (direct) return direct.closest(VOLUME_BAR_SELECTOR) ? direct : null

  // 某些主题/插件会给触发按钮套一层包装，命中外层时再向下找实际按钮。
  const trigger = target.closest('.echo-popover-trigger')
  if (!trigger || !trigger.closest(VOLUME_BAR_SELECTOR)) return null
  return trigger.querySelector(VOLUME_BUTTON_SELECTOR)
}

export default async function (ctx) {
  const { defineComponent, h, reactive, computed } = ctx.vue

  const settings = reactive({
    step: DEFAULT_STEP,
    invertDirection: false,
  })

  try {
    const saved = await ctx.storage.get('settings')
    if (saved && typeof saved === 'object') {
      settings.step = clampStep(saved.step)
      settings.invertDirection = Boolean(saved.invertDirection)
    }
  } catch (error) {
    console.warn('[volume-wheel] 读取设置失败', error)
  }

  let accumulatedDelta = 0

  const saveSettings = async () => {
    try {
      await ctx.storage.set('settings', {
        step: settings.step,
        invertDirection: settings.invertDirection,
      })
    } catch (error) {
      console.warn('[volume-wheel] 保存设置失败', error)
    }
  }

  const handleWheel = (event) => {
    if (!resolveVolumeButton(event.target)) return

    // 拦截宿主的滚轮处理，防止一次滚动触发两份音量调整。
    event.preventDefault()
    event.stopPropagation()

    const delta = normalizeWheelDelta(event)
    if (delta === 0) return

    const result = consumeWheelNotches(delta, accumulatedDelta)
    accumulatedDelta = result.accumulated
    if (result.notches === 0) return

    // 与宿主音量弹出层保持一致：Windows 滚轮向上增大，macOS 自然滚动向上增大。
    const platformDirection = isMacPlatform() ? 1 : -1
    const direction = settings.invertDirection ? -platformDirection : platformDirection
    ctx.player.store.adjustVolume(result.notches * settings.step * direction)
  }

  window.addEventListener('wheel', handleWheel, { capture: true, passive: false })
  ctx.dispose(() => window.removeEventListener('wheel', handleWheel, { capture: true }))

  // ===== 悬停弹出音量条 =====
  // 宿主弹层由 trigger="click" 驱动，插件改不了其 props，只能用合成点击模拟开合：
  // 开合状态从触发器包装元素（.echo-popover-trigger）的 aria-expanded 读取，
  // 真实点击则在捕获阶段被劫持为静音切换（见下方 handleClickCapture）。
  let openTimer = null
  let closeTimer = null
  let pendingOpenButton = null

  const dispatchSyntheticClick = (button) => {
    button.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
    )
  }

  const clearHoverTimers = () => {
    if (openTimer !== null) {
      clearTimeout(openTimer)
      openTimer = null
      pendingOpenButton = null
    }
    if (closeTimer !== null) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
  }

  ctx.dispose(clearHoverTimers)

  const isVolumePopoverOpen = (button) => {
    const expanded = button?.closest(POPOVER_TRIGGER_SELECTOR)?.getAttribute('aria-expanded')
    if (expanded !== null && expanded !== undefined) return expanded === 'true'
    // 老版本未在触发器上写 aria-expanded 时，退回看弹层自身状态。
    return Boolean(document.querySelector(`${VOLUME_POPOVER_CONTENT_SELECTOR}[data-state="open"]`))
  }

  const findOpenVolumeButton = () => {
    for (const button of document.querySelectorAll(VOLUME_BUTTON_SELECTOR)) {
      if (button.closest(POPOVER_TRIGGER_SELECTOR)?.getAttribute('aria-expanded') === 'true') {
        return button
      }
    }
    return null
  }

  const isInsidePopoverContent = (target) =>
    target instanceof Element && Boolean(target.closest(VOLUME_POPOVER_CONTENT_SELECTOR))

  const isInsideHoverZone = (target) =>
    Boolean(resolveVolumeButton(target)) || isInsidePopoverContent(target)

  const cancelCloseTimer = () => {
    if (closeTimer === null) return
    clearTimeout(closeTimer)
    closeTimer = null
  }

  const cancelOpenTimer = () => {
    if (openTimer === null) return
    clearTimeout(openTimer)
    openTimer = null
    pendingOpenButton = null
  }

  const handleMouseOver = (event) => {
    if (!isInsideHoverZone(event.target)) return
    // 回到按钮或弹层即取消隐藏；穿过按钮与弹层之间的空隙也不会闪关。
    cancelCloseTimer()

    const button = resolveVolumeButton(event.target)
    if (!button || isVolumePopoverOpen(button)) return
    // 同一按钮上已有计时不重置，避免在按钮内部子元素间移动导致永远打不开。
    if (pendingOpenButton === button && openTimer !== null) return
    cancelOpenTimer()

    pendingOpenButton = button
    openTimer = setTimeout(() => {
      openTimer = null
      const target = pendingOpenButton
      pendingOpenButton = null
      if (target?.isConnected && !isVolumePopoverOpen(target)) {
        dispatchSyntheticClick(target)
      }
    }, HOVER_OPEN_DELAY)
  }

  const handleMouseOut = (event) => {
    if (!isInsideHoverZone(event.target)) return
    // relatedTarget 仍落在按钮或弹层内（含两者之间的空隙过渡）时不隐藏。
    if (isInsideHoverZone(event.relatedTarget)) return

    cancelOpenTimer()
    if (closeTimer !== null) return
    closeTimer = setTimeout(() => {
      closeTimer = null
      const openButton = findOpenVolumeButton()
      if (openButton) dispatchSyntheticClick(openButton)
    }, HOVER_HIDE_DELAY)
  }

  window.addEventListener('mouseover', handleMouseOver, { capture: true })
  window.addEventListener('mouseout', handleMouseOut, { capture: true })
  ctx.dispose(() => {
    window.removeEventListener('mouseover', handleMouseOver, { capture: true })
    window.removeEventListener('mouseout', handleMouseOut, { capture: true })
  })

  // ===== 点击触发按钮改为切换静音 =====
  // 只拦截用户真实点击（isTrusted），放行上方用于开合弹层的合成点击；
  // 捕获阶段先于宿主触发器的 click 处理器，阻止其继续把弹层开关。
  const handleClickCapture = (event) => {
    if (!event.isTrusted) return
    if (!resolveVolumeButton(event.target)) return

    event.preventDefault()
    event.stopPropagation()
    clearHoverTimers()
    void ctx.player.store.toggleMute()
  }

  window.addEventListener('click', handleClickCapture, { capture: true })
  ctx.dispose(() => window.removeEventListener('click', handleClickCapture, { capture: true }))

  const SettingsPanel = defineComponent({
    setup() {
      const stepLabel = computed(() => `${settings.step}%`)

      const handleStepInput = (event) => {
        settings.step = clampStep(event.target.value)
      }

      const handleStepChange = () => {
        void saveSettings()
      }

      const handleDirectionChange = (event) => {
        settings.invertDirection = Boolean(event.target.checked)
        void saveSettings()
      }

      return () =>
        h('div', { style: 'display: grid; gap: 16px;' }, [
          h('div', { style: 'display: grid; gap: 8px;' }, [
            h(
              'div',
              {
                style:
                  'display: flex; align-items: center; justify-content: space-between; gap: 16px;',
              },
              [
                h('span', '每格滚轮调节步进'),
                h(
                  'span',
                  {
                    style:
                      'font-variant-numeric: tabular-nums; color: var(--color-text-secondary);',
                  },
                  stepLabel.value,
                ),
              ],
            ),
            h('input', {
              type: 'range',
              min: MIN_STEP,
              max: MAX_STEP,
              step: 1,
              value: settings.step,
              'aria-label': '每格滚轮调节步进',
              onInput: handleStepInput,
              onChange: handleStepChange,
              style: 'width: 100%;',
            }),
          ]),
          h(
            'label',
            {
              style:
                'display: flex; align-items: center; justify-content: space-between; gap: 16px; cursor: pointer;',
            },
            [
              h('span', [
                h('span', { style: 'display: block;' }, '反转滚轮方向'),
                h(
                  'span',
                  {
                    style:
                      'display: block; margin-top: 4px; font-size: 12px; color: var(--color-text-secondary);',
                  },
                  '如果滚轮方向与预期相反，可以开启此项。',
                ),
              ]),
              h('input', {
                type: 'checkbox',
                checked: settings.invertDirection,
                'aria-label': '反转滚轮方向',
                onChange: handleDirectionChange,
              }),
            ],
          ),
          h(
            'p',
            {
              style:
                'margin: 0; font-size: 12px; line-height: 1.6; color: var(--color-text-secondary);',
            },
            '鼠标悬停在主播放栏或歌词页底部的音量按钮上即可弹出音量条，移开后自动隐藏；点击按钮切换静音，在按钮上滚动滚轮直接调节音量。',
          ),
        ])
    },
  })

  ctx.ui.settings.define({
    id: 'default',
    title: '滚轮音量调节',
    description: '悬停弹出音量条、点击切换静音，滚轮步进与方向在此调整。',
    component: SettingsPanel,
  })
}
