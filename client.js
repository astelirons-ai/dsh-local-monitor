/* dsh-local-monitor — browser half.
 *
 * A draggable floating window registered into `shell.overlay` (the frame-wide
 * floating layer). Two columns of three cards: GPU on the left (GPU-Z sensors),
 * CPU on the right (temperature / clock / system memory in use).
 *
 * Plain React from the module table; no Harness Client package is imported and
 * every colour comes from a theme token so both themes read correctly.
 *
 * Labels are bilingual: French when the app locale or the browser speaks
 * French, English otherwise.
 */
window.__ModuleLoader__.load({
  id: 'dsh-local-monitor',
  factory(require) {
    var React = require('react')
    var h = React.createElement

    var ROUTE = '/dsh-local-monitor/sensors.json'
    var POLL_MS = 1500
    // Window width: 372 px was the original frame, 260 px was -30 %, 221 px is
    // another -15 % on top of that.
    var WIDTH = 221
    // Vertical density: 0.61 (previous step) x 0.74 -> height -15 % more.
    // Kept separate from FSCALE on purpose: the type stays at 6.7/14.7 px, only
    // the vertical furniture (paddings, gaps, line boxes, card height) shrinks.
    var VSCALE = 0.45
    // Type scale: 0.8 (previous step) x 0.85, so glyphs keep fitting the frame.
    var FSCALE = 0.7
    var Y_HEAD_PAD = Math.round(8 * VSCALE)
    var Y_BODY_PAD = Math.round(10 * VSCALE)
    var X_BODY_PAD = 6
    var Y_ROW_GAP = Math.round(8 * VSCALE)
    var X_ROW_GAP = 5
    var Y_CARD_PAD_TOP = Math.round(8 * VSCALE)
    var Y_CARD_PAD_BOTTOM = Math.round(9 * VSCALE)
    var X_CARD_PAD = 7
    var Y_CARD_MIN = Math.round(74 * VSCALE)
    var Y_BAR_MARGIN = Math.round(6 * VSCALE)
    var Y_NOTE_MARGIN = Math.round(4 * VSCALE)
    function FS(px) {
      return Math.round(px * FSCALE * 10) / 10
    }
    var STORAGE_POSITION = 'dsh-local-monitor.position.v1'
    var STORAGE_COLLAPSED = 'dsh-local-monitor.collapsed.v1'

    var STRINGS = {
      fr: {
        sensors: 'Capteurs',
        live: 'en direct',
        offline: 'hors ligne',
        connecting: 'connexion…',
        gpuTemp: 'Température GPU',
        gpuClock: 'Fréquence GPU',
        gpuVram: 'Mémoire dédiée',
        cpuTemp: 'Température CPU',
        cpuClock: 'Fréquence CPU',
        cpuMem: 'Mémoire système',
        hotSpot: 'point chaud',
        memoryClock: 'mémoire',
        vramUsed: 'Mo utilisés',
        viaGpuZ: 'via GPU-Z',
        motherboardZone: 'zone carte mère',
        sensorUnavailable: 'capteur indisponible',
        load: 'charge',
        gpuMissingTitle: 'GPU-Z introuvable',
        gpuMissingBody: 'lancez GPU-Z pour lire ses capteurs',
        cpuUnavailable: 'CPU indisponible',
        collapse: 'Replier',
        expand: 'Déplier',
        dragHint: 'Glisser pour déplacer',
        regionLabel: 'Tableau de bord des capteurs',
        gib: 'Go',
        mib: 'Mo',
        locale: 'fr-FR',
      },
      en: {
        sensors: 'Sensors',
        live: 'live',
        offline: 'offline',
        connecting: 'connecting…',
        gpuTemp: 'GPU temperature',
        gpuClock: 'GPU clock',
        gpuVram: 'Dedicated VRAM',
        cpuTemp: 'CPU temperature',
        cpuClock: 'CPU clock',
        cpuMem: 'System memory',
        hotSpot: 'hot spot',
        memoryClock: 'memory',
        vramUsed: 'MB used',
        viaGpuZ: 'via GPU-Z',
        motherboardZone: 'motherboard zone',
        sensorUnavailable: 'sensor unavailable',
        load: 'load',
        gpuMissingTitle: 'GPU-Z not found',
        gpuMissingBody: 'start GPU-Z to read its sensors',
        cpuUnavailable: 'CPU unavailable',
        collapse: 'Collapse',
        expand: 'Expand',
        dragHint: 'Drag to move',
        regionLabel: 'Sensor dashboard',
        gib: 'GB',
        mib: 'MB',
        locale: 'en-US',
      },
    }

    var LANGUAGE = 'en'
    var STORAGE_LANG = 'dsh-local-monitor.lang'

    /**
     * English by default, French only when the DSH app locale says so.
     * An explicit choice in localStorage wins over both, e.g.
     *   localStorage.setItem('dsh-local-monitor.lang', 'fr')
     * then reload the page.
     */
    function resolveLanguage(ctx) {
      try {
        var chosen = window.localStorage.getItem(STORAGE_LANG)
        if (chosen === 'fr' || chosen === 'en') return chosen
      } catch (e) {}
      var appLocale = ''
      try {
        if (ctx && typeof ctx.get === 'function') {
          var locale = ctx.get('locale')
          if (locale && typeof locale.getLocale === 'function') {
            var snapshot = locale.getLocale()
            if (snapshot) appLocale = String(snapshot.id || snapshot.locale || snapshot.language || '')
          }
        }
      } catch (e) {}
      return String(appLocale || '').toLowerCase().indexOf('fr') === 0 ? 'fr' : 'en'
    }

    var NUMBER_FORMATS = {}
    function numberFormats(language) {
      var tag = STRINGS[language] ? STRINGS[language].locale : 'en-US'
      if (!NUMBER_FORMATS[tag]) {
        NUMBER_FORMATS[tag] = {
          one: new Intl.NumberFormat(tag, { maximumFractionDigits: 1 }),
          zero: new Intl.NumberFormat(tag, { maximumFractionDigits: 0 }),
          two: new Intl.NumberFormat(tag, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        }
      }
      return NUMBER_FORMATS[tag]
    }

    var CSS = [
      '.dsd-window{position:fixed;z-index:60;width:' + WIDTH + 'px;box-sizing:border-box;border-radius:14px;' +
        'background:var(--dsw-alias-bg-overlay,rgba(20,21,25,.96));color:var(--dsw-alias-label-primary,#e8e8ea);' +
        'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));' +
        'box-shadow:0 18px 48px rgba(0,0,0,.34),0 2px 8px rgba(0,0,0,.22);' +
        'font:' + FS(13) + 'px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;' +
        'pointer-events:auto;overflow:hidden;user-select:none;-webkit-user-select:none}',
      '.dsd-head{display:flex;align-items:center;gap:6px;padding:' + Y_HEAD_PAD + 'px 8px;cursor:grab;' +
        'line-height:1.1;' +
        'background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.04));' +
        'border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1))}',
      '.dsd-head:active{cursor:grabbing}',
      '.dsd-title{font-size:' + FS(12) + 'px;line-height:1.1;font-weight:600;letter-spacing:.04em;text-transform:uppercase;' +
        'color:var(--dsw-alias-label-secondary,#a7a8ad)}',
      '.dsd-status{margin-left:auto;display:flex;align-items:center;gap:5px;font-size:' + FS(11) + 'px;line-height:1.1;' +
        'color:var(--dsw-alias-label-secondary,#a7a8ad)}',
      '.dsd-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#8b8d94)}',
      '.dsd-dot.live{background:var(--dsw-alias-state-success-primary,#3ecf8e);box-shadow:0 0 0 2px rgba(62,207,142,.16)}',
      '.dsd-dot.warn{background:var(--dsw-alias-state-warn-primary,#e2a03f)}',
      '.dsd-icon{width:18px;height:18px;display:flex;align-items:center;justify-content:center;border-radius:5px;' +
        'border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#a7a8ad);' +
        'cursor:pointer;font-size:' + FS(13) + 'px;line-height:1;padding:0}',
      '.dsd-icon:hover{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.08));' +
        'color:var(--dsw-alias-label-primary,#e8e8ea)}',
      '.dsd-body{padding:' + Y_BODY_PAD + 'px ' + X_BODY_PAD + 'px}',
      '.dsd-grid{display:grid;grid-template-columns:1fr 1fr;column-gap:' + X_ROW_GAP + 'px;row-gap:' + Y_ROW_GAP + 'px;align-items:start}',
      '.dsd-col{display:flex;flex-direction:column;gap:' + Y_ROW_GAP + 'px;min-width:0}',
      '.dsd-col-head{display:flex;align-items:baseline;gap:4px;padding:0 1px 1px}',
      '.dsd-col-name{font-size:' + FS(10) + 'px;line-height:1.1;font-weight:700;letter-spacing:.08em;text-transform:uppercase;' +
        'color:var(--dsw-alias-label-secondary,#a7a8ad)}',
      '.dsd-col-model{font-size:' + FS(9.5) + 'px;line-height:1.1;color:var(--dsw-alias-label-secondary,#a7a8ad);opacity:.75;' +
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}',
      '.dsd-card{background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.045));' +
        'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));border-radius:8px;' +
        'padding:' + Y_CARD_PAD_TOP + 'px ' + X_CARD_PAD + 'px ' + Y_CARD_PAD_BOTTOM + 'px;min-height:' + Y_CARD_MIN + 'px;' +
        'display:flex;flex-direction:column;gap:0;box-sizing:border-box}',
      '.dsd-card-label{font-size:' + FS(9.5) + 'px;line-height:1.05;letter-spacing:.04em;text-transform:uppercase;' +
        'color:var(--dsw-alias-label-secondary,#a7a8ad);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsd-card-value{margin-top:auto;font-size:' + FS(21) + 'px;font-weight:650;line-height:1;' +
        'font-variant-numeric:tabular-nums;letter-spacing:-.01em;white-space:nowrap}',
      '.dsd-unit{margin-left:3px;font-size:' + FS(11.5) + 'px;font-weight:500;' +
        'color:var(--dsw-alias-label-secondary,#a7a8ad)}',
      '.dsd-bar{margin-top:' + Y_BAR_MARGIN + 'px;height:3px;border-radius:2px;overflow:hidden;' +
        'background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.1))}',
      '.dsd-bar-fill{height:100%;border-radius:2px;transition:width .35s ease,background-color .35s ease}',
      '.dsd-note{margin-top:' + Y_NOTE_MARGIN + 'px;font-size:' + FS(9.5) + 'px;line-height:1.05;' +
        'color:var(--dsw-alias-label-secondary,#a7a8ad);opacity:.8;' +
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsd-collapsed .dsd-body{display:none}',
      '.dsd-missing{font-size:' + FS(10.5) + 'px;color:var(--dsw-alias-label-secondary,#a7a8ad);' +
        'border:1px dashed var(--dsw-alias-border-l1,rgba(255,255,255,.14));border-radius:8px;' +
        'padding:8px 6px;text-align:center;line-height:1.4}',
    ].join('\n')

    function readPosition() {
      try {
        var raw = window.localStorage.getItem(STORAGE_POSITION)
        if (!raw) return null
        var parsed = JSON.parse(raw)
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') return parsed
      } catch (e) {}
      return null
    }

    function defaultPosition() {
      var x = Math.max(12, window.innerWidth - WIDTH - 24)
      return { x: x, y: 88 }
    }

    function clampPosition(point) {
      var maxX = Math.max(8, window.innerWidth - WIDTH - 8)
      var maxY = Math.max(8, window.innerHeight - 80)
      return {
        x: Math.min(Math.max(8, Math.round(point.x)), maxX),
        y: Math.min(Math.max(8, Math.round(point.y)), maxY),
      }
    }

    function stateColor(temp) {
      if (temp === null || temp === undefined) return null
      if (temp >= 85) return 'var(--dsw-alias-state-error-primary,#e5484d)'
      if (temp >= 70) return 'var(--dsw-alias-state-warn-primary,#e2a03f)'
      return 'var(--dsw-alias-state-success-primary,#3ecf8e)'
    }

    function fillColor(ratio) {
      if (ratio === null || ratio === undefined) return 'var(--dsw-alias-brand-primary,#4c7dff)'
      if (ratio >= 0.9) return 'var(--dsw-alias-state-error-primary,#e5484d)'
      if (ratio >= 0.75) return 'var(--dsw-alias-state-warn-primary,#e2a03f)'
      return 'var(--dsw-alias-brand-primary,#4c7dff)'
    }

    function formatTemp(value, nf) {
      if (value === null || value === undefined) return '—'
      return nf.one.format(value)
    }

    function formatClock(mhz, nf) {
      if (mhz === null || mhz === undefined || !isFinite(mhz)) return '—'
      if (mhz >= 1000) return nf.two.format(mhz / 1000) + ' GHz'
      return nf.zero.format(mhz) + ' MHz'
    }

    function formatBytes(bytes, nf, gibLabel) {
      if (bytes === null || bytes === undefined || !isFinite(bytes)) return null
      return nf.one.format(bytes / (1024 * 1024 * 1024)) + ' ' + gibLabel
    }

    function Card(props) {
      return h(
        'div',
        { className: 'dsd-card' },
        h('div', { className: 'dsd-card-label', title: props.title }, props.title),
        h(
          'div',
          { className: 'dsd-card-value', style: props.color ? { color: props.color } : undefined },
          props.value,
          props.unit ? h('span', { className: 'dsd-unit' }, props.unit) : null,
        ),
        props.ratio !== null && props.ratio !== undefined
          ? h(
              'div',
              { className: 'dsd-bar' },
              h('div', {
                className: 'dsd-bar-fill',
                style: {
                  width: Math.max(0, Math.min(1, props.ratio)) * 100 + '%',
                  backgroundColor: fillColor(props.ratio),
                },
              }),
            )
          : null,
        props.note ? h('div', { className: 'dsd-note', title: props.note }, props.note) : null,
      )
    }

    function Dashboard() {
      var L = STRINGS[LANGUAGE] || STRINGS.en
      var nf = numberFormats(LANGUAGE)

      var dataState = React.useState(null)
      var data = dataState[0]
      var setData = dataState[1]
      var errorState = React.useState(null)
      var error = errorState[0]
      var setError = errorState[1]
      var posState = React.useState(function () {
        var stored = readPosition()
        return stored ? clampPosition(stored) : defaultPosition()
      })
      var pos = posState[0]
      var setPos = posState[1]
      var collapsedState = React.useState(function () {
        try {
          return window.localStorage.getItem(STORAGE_COLLAPSED) === '1'
        } catch (e) {
          return false
        }
      })
      var collapsed = collapsedState[0]
      var setCollapsed = collapsedState[1]

      React.useEffect(function () {
        var alive = true
        var timer = null
        function tick() {
          fetch(ROUTE, { cache: 'no-store', credentials: 'same-origin' })
            .then(function (res) {
              if (!res.ok) throw new Error('HTTP ' + res.status)
              return res.json()
            })
            .then(function (json) {
              if (!alive) return
              setData(json)
              setError(null)
            })
            .catch(function (err) {
              if (!alive) return
              setError(String((err && err.message) || err))
            })
            .then(function () {
              if (alive) timer = setTimeout(tick, POLL_MS)
            })
        }
        tick()
        return function () {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [])

      React.useEffect(
        function () {
          try {
            window.localStorage.setItem(STORAGE_POSITION, JSON.stringify(pos))
          } catch (e) {}
        },
        [pos],
      )

      React.useEffect(
        function () {
          try {
            window.localStorage.setItem(STORAGE_COLLAPSED, collapsed ? '1' : '0')
          } catch (e) {}
        },
        [collapsed],
      )

      React.useEffect(
        function () {
          function onResize() {
            setPos(function (current) {
              return clampPosition(current)
            })
          }
          window.addEventListener('resize', onResize)
          return function () {
            window.removeEventListener('resize', onResize)
          }
        },
        [],
      )

      function startDrag(event) {
        if (event.pointerType === 'mouse' && event.button !== 0) return
        var target = event.currentTarget
        var startX = event.clientX
        var startY = event.clientY
        var originX = pos.x
        var originY = pos.y
        try {
          target.setPointerCapture(event.pointerId)
        } catch (e) {}
        function onMove(moveEvent) {
          setPos(clampPosition({ x: originX + (moveEvent.clientX - startX), y: originY + (moveEvent.clientY - startY) }))
        }
        function onUp() {
          target.removeEventListener('pointermove', onMove)
          target.removeEventListener('pointerup', onUp)
          target.removeEventListener('pointercancel', onUp)
          try {
            target.releasePointerCapture(event.pointerId)
          } catch (e) {}
        }
        target.addEventListener('pointermove', onMove)
        target.addEventListener('pointerup', onUp)
        target.addEventListener('pointercancel', onUp)
        event.preventDefault()
      }

      var gpu = data && data.gpu && data.gpu.ok ? data.gpu : null
      var cpu = data && data.cpu && data.cpu.ok ? data.cpu : null
      var mem = data && data.mem && data.mem.ok ? data.mem : null
      var live = Boolean(data && data.ok)
      var helperError = (data && data.helper && data.helper.lastError) || (data && data.sampleError) || error

      var statusText = live ? L.live : data ? L.offline : error ? L.offline : L.connecting
      var dotClass = 'dsd-dot' + (live ? ' live' : data || error ? ' warn' : '')

      var vramRatio = null
      var vramNote = null
      if (gpu && gpu.vramUsedMB !== null && gpu.vramUsedMB !== undefined) {
        if (gpu.vramTotalMB) {
          vramRatio = gpu.vramUsedMB / gpu.vramTotalMB
          vramNote =
            nf.one.format(gpu.vramUsedMB / 1024) + ' / ' + nf.one.format(gpu.vramTotalMB / 1024) + ' ' + L.gib
        } else {
          vramNote = nf.one.format(gpu.vramUsedMB) + ' ' + L.vramUsed
        }
      }

      var ramRatio = null
      var ramNote = null
      if (mem) {
        ramRatio = mem.pct !== null && mem.pct !== undefined ? mem.pct / 100 : null
        ramNote = (formatBytes(mem.usedBytes, nf, L.gib) || '—') + ' / ' + (formatBytes(mem.totalBytes, nf, L.gib) || '—')
      }

      var gpuCards = gpu
        ? [
            h(Card, {
              key: 'gpu-temp',
              title: L.gpuTemp,
              value: formatTemp(gpu.temp, nf),
              unit: gpu.temp === null || gpu.temp === undefined ? null : '°C',
              color: stateColor(gpu.temp),
              note:
                gpu.hotSpot !== null && gpu.hotSpot !== undefined
                  ? L.hotSpot + ' ' + nf.one.format(gpu.hotSpot) + ' °C'
                  : gpu.chip || null,
            }),
            h(Card, {
              key: 'gpu-clock',
              title: L.gpuClock,
              value: formatClock(gpu.clock, nf),
              note: gpu.memClock ? L.memoryClock + ' ' + nf.zero.format(gpu.memClock) + ' MHz' : null,
            }),
            h(Card, {
              key: 'gpu-vram',
              title: L.gpuVram,
              value: gpu.vramUsedMB ? nf.one.format(gpu.vramUsedMB / 1024) : '—',
              unit: gpu.vramUsedMB ? L.gib : null,
              ratio: vramRatio,
              note: vramNote,
            }),
          ]
        : [
            h(
              'div',
              { key: 'gpu-missing', className: 'dsd-missing' },
              L.gpuMissingTitle,
              h('br'),
              L.gpuMissingBody,
            ),
          ]

      var cpuCards = cpu
        ? [
            h(Card, {
              key: 'cpu-temp',
              title: L.cpuTemp,
              value: formatTemp(cpu.temp, nf),
              unit: cpu.temp === null || cpu.temp === undefined ? null : '°C',
              color: stateColor(cpu.temp),
              note:
                cpu.temp === null
                  ? L.sensorUnavailable
                  : cpu.tempSource === 'gpu-z'
                    ? L.viaGpuZ
                    : cpu.tempSource === 'acpi' || cpu.tempSource === 'perf'
                      ? L.motherboardZone
                      : null,
            }),
            h(Card, {
              key: 'cpu-clock',
              title: L.cpuClock,
              value: formatClock(cpu.mhz, nf),
              note: cpu.load !== null && cpu.load !== undefined ? L.load + ' ' + nf.zero.format(cpu.load) + ' %' : null,
            }),
            h(Card, {
              key: 'cpu-ram',
              title: L.cpuMem,
              value: mem ? formatBytes(mem.usedBytes, nf, L.gib) || '—' : '—',
              ratio: ramRatio,
              note: ramNote,
            }),
          ]
        : [h('div', { key: 'cpu-missing', className: 'dsd-missing' }, L.cpuUnavailable)]

      return h(
        'div',
        {
          className: 'dsd-window' + (collapsed ? ' dsd-collapsed' : ''),
          style: { left: pos.x + 'px', top: pos.y + 'px' },
          role: 'region',
          'aria-label': L.regionLabel,
        },
        h('style', null, CSS),
        h(
          'div',
          {
            className: 'dsd-head',
            onPointerDown: startDrag,
            title: L.dragHint,
          },
          h('span', { className: 'dsd-title' }, L.sensors),
          h('span', { className: 'dsd-status' }, h('span', { className: dotClass }), statusText),
          h(
            'button',
            {
              className: 'dsd-icon',
              type: 'button',
              title: collapsed ? L.expand : L.collapse,
              'aria-label': collapsed ? L.expand : L.collapse,
              onPointerDown: function (event) {
                event.stopPropagation()
              },
              onClick: function () {
                setCollapsed(!collapsed)
              },
            },
            collapsed ? '▾' : '▴',
          ),
        ),
        h(
          'div',
          { className: 'dsd-body' },
          h(
            'div',
            { className: 'dsd-grid' },
            h(
              'div',
              { className: 'dsd-col' },
              h(
                'div',
                { className: 'dsd-col-head' },
                h('span', { className: 'dsd-col-name' }, 'GPU'),
                h(
                  'span',
                  { className: 'dsd-col-model', title: gpu && gpu.name ? gpu.name : '' },
                  gpu && gpu.name ? gpu.name : 'GPU-Z',
                ),
              ),
              gpuCards,
            ),
            h(
              'div',
              { className: 'dsd-col' },
              h(
                'div',
                { className: 'dsd-col-head' },
                h('span', { className: 'dsd-col-name' }, 'CPU'),
                h(
                  'span',
                  { className: 'dsd-col-model', title: cpu && cpu.name ? cpu.name : '' },
                  cpu && cpu.name ? cpu.name : 'Windows',
                ),
              ),
              cpuCards,
            ),
          ),
          helperError && !live
            ? h(
                'div',
                { className: 'dsd-note', title: String(helperError), style: { marginTop: '8px', opacity: 0.7 } },
                String(helperError).slice(0, 120),
              )
            : null,
        ),
      )
    }

    return {
      inject: ['slots'],
      apply: function apply(ctx) {
        LANGUAGE = resolveLanguage(ctx)
        ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-local-monitor', order: 200, label: 'Sensors' },
            Dashboard,
          )
        })
      },
    }
  },
})
