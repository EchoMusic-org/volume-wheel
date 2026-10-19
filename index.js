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
const WHEEL_NOTCH = 100
const DISCRETE_WHEEL_THRESHOLD = 60
const DEFAULT_STEP = 5
const MIN_STEP = 1
const MAX_STEP = 20

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
            '将鼠标移到主播放栏或歌词页底部的音量按钮上滚动滚轮即可调节音量。',
          ),
        ])
    },
  })

  ctx.ui.settings.define({
    id: 'default',
    title: '滚轮音量调节',
    description: '调节滚轮步进与方向，修改后立即生效。',
    component: SettingsPanel,
  })
}
