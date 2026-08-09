(function () {
  const root = document.documentElement
  const appShell = document.getElementById('app-shell')
  const queueScreen = document.getElementById('queue-screen')
  const workbenchScreen = document.getElementById('workbench-screen')
  const errorScreen = document.getElementById('error-screen')
  const dialog = document.getElementById('new-task-dialog')
  const newTaskForm = document.getElementById('new-task-form')
  const newTaskTrigger = document.getElementById('new-task-trigger')
  const urlInput = document.getElementById('content-url')
  const routePreview = document.getElementById('route-preview')
  const enteredUrlCount = document.getElementById('entered-url-count')
  const taskError = document.getElementById('new-task-error')
  const toast = document.getElementById('toast')
  const themeMeta = document.querySelector('meta[name="theme-color"]')
  let toastTimer
  let lastDialogTrigger = newTaskTrigger
  let syncLock = false

  function iconUse(id) {
    return `<svg aria-hidden="true"><use href="#${id}"></use></svg>`
  }

  function showToast(message) {
    clearTimeout(toastTimer)
    toast.textContent = message
    toast.classList.add('is-visible')
    toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2200)
  }

  function classifyUrls(value) {
    return value
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((raw) => {
        try {
          const parsed = new URL(raw)
          if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocol')
          const host = parsed.hostname.toLowerCase().replace(/^www\./u, '')
          const isX = host === 'x.com' || host === 'twitter.com'
          if (isX && !/\/status\/\d+/u.test(parsed.pathname)) {
            return { raw, valid: false, label: 'X 链接需指向单条 status', type: '不支持', route: '请粘贴帖子或 X Article 链接' }
          }
          return isX
            ? { raw, valid: true, source: 'x', label: host, type: 'X 链接', route: '自动使用 X 专用解析' }
            : { raw, valid: true, source: 'web', label: host, type: '普通网页', route: '自动使用通用网页解析' }
        } catch {
          return { raw, valid: false, label: raw || '空链接', type: '无效', route: '请输入 http 或 https 链接' }
        }
      })
  }

  function renderRoutes() {
    const rows = classifyUrls(urlInput.value)
    enteredUrlCount.textContent = rows.length ? `已输入 ${rows.length} 个` : '自动识别来源'
    routePreview.innerHTML = rows.map((item) => {
      const icon = item.source === 'x' ? 'icon-x' : item.valid ? 'icon-globe' : 'icon-warning'
      return `<div class="route-row${item.valid ? '' : ' is-invalid'}"><span class="route-icon">${iconUse(icon)}</span><div><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.route)}</span></div><span class="route-type">${escapeHtml(item.type)}</span></div>`
    }).join('')
    taskError.hidden = true
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/gu, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    })[character])
  }

  function setVisibleScreen(target) {
    for (const screen of [queueScreen, workbenchScreen, errorScreen]) screen.classList.remove('is-visible')
    target.classList.add('is-visible')
  }

  function updateDemoButtons(view) {
    document.querySelectorAll('[data-demo-view]').forEach((button) => {
      button.setAttribute('aria-pressed', button.dataset.demoView === view ? 'true' : 'false')
    })
  }

  function resetWorkbenchTab() {
    document.querySelector('[data-tab="compare"]').click()
  }

  function setView(view) {
    if (dialog.open && view !== 'new-task') dialog.close()
    if (view === 'new-task') {
      setVisibleScreen(queueScreen)
      appShell.dataset.source = 'web'
      updateDemoButtons(view)
      window.requestAnimationFrame(() => openDialog(newTaskTrigger))
      return
    }
    if (view === 'web' || view === 'x') {
      setVisibleScreen(workbenchScreen)
      appShell.dataset.source = view
      updateDemoButtons(view)
      resetWorkbenchTab()
      return
    }
    if (view === 'error') {
      setVisibleScreen(errorScreen)
      updateDemoButtons(view)
      return
    }
    setVisibleScreen(queueScreen)
    updateDemoButtons('')
  }

  function openDialog(trigger) {
    lastDialogTrigger = trigger || document.activeElement
    if (!dialog.open) dialog.showModal()
    window.requestAnimationFrame(() => urlInput.focus())
  }

  function closeDialog() {
    if (dialog.open) dialog.close()
    if (lastDialogTrigger && typeof lastDialogTrigger.focus === 'function') lastDialogTrigger.focus()
    updateDemoButtons('')
  }

  document.querySelectorAll('[data-action]').forEach((element) => {
    element.addEventListener('click', (event) => {
      const action = event.currentTarget.dataset.action
      if (action === 'open-new-task') openDialog(event.currentTarget)
      if (action === 'close-new-task') closeDialog()
      if (action === 'show-queue') setView('queue')
      if (action === 'show-web') setView('web')
      if (action === 'show-x') setView('x')
      if (action === 'open-source') showToast('设计稿未打开外部网页；正式版会调用系统浏览器。')
      if (action === 'export-markdown') showToast('已准备 translated.zh-CN.md（设计稿演示）。')
      if (action === 'complete-review') completeReview(event.currentTarget)
      if (action === 'retry') retryCapture(event.currentTarget)
      if (action === 'toggle-theme') toggleTheme()
    })
  })

  document.querySelectorAll('[data-demo-view]').forEach((button) => {
    button.addEventListener('click', () => setView(button.dataset.demoView))
  })

  document.querySelectorAll('input[name="task-kind"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      document.querySelectorAll('.new-task-kind-option').forEach((option) => option.removeAttribute('data-selected'))
      radio.closest('.new-task-kind-option').setAttribute('data-selected', 'true')
      if (radio.value !== 'document') {
        showToast('本设计稿只展开“网页翻译”；视频任务保持 Etch 现有流程。')
      }
    })
  })

  newTaskForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const kind = new FormData(newTaskForm).get('task-kind')
    if (kind !== 'document') {
      showToast('本设计稿只演示“网页翻译”新路径。')
      return
    }
    const rows = classifyUrls(urlInput.value)
    const invalid = rows.find((row) => !row.valid)
    if (!rows.length || invalid) {
      taskError.hidden = false
      taskError.textContent = !rows.length ? '请至少输入一个网页或 X 链接。' : `${invalid.label}：${invalid.route}`
      return
    }
    const source = rows.some((row) => row.source === 'x') ? 'x' : 'web'
    dialog.close()
    setView(source)
    showToast(source === 'x' ? '已识别 X 链接并切换到专用解析。' : '已识别普通网页并进入通用解析。')
  })

  urlInput.addEventListener('input', renderRoutes)
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    closeDialog()
  })
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeDialog()
  })

  document.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('[data-tab]').forEach((candidate) => {
        const active = candidate === tab
        candidate.classList.toggle('is-active', active)
        candidate.setAttribute('aria-selected', active ? 'true' : 'false')
      })
      const targetId = `${tab.dataset.tab}-panel`
      document.querySelectorAll('.tab-panel').forEach((panel) => {
        const active = panel.id === targetId
        panel.hidden = !active
        panel.classList.toggle('is-visible', active)
      })
    })
  })

  function activeScrollPane(kind) {
    return Array.from(document.querySelectorAll(`[data-sync-scroll="${kind}"]`)).find((element) => getComputedStyle(element).display !== 'none')
  }

  document.querySelectorAll('[data-sync-scroll]').forEach((pane) => {
    pane.addEventListener('scroll', () => {
      if (syncLock) return
      const sourceKind = pane.dataset.syncScroll
      const targetKind = sourceKind === 'source' ? 'translation' : 'source'
      const source = activeScrollPane(sourceKind)
      const target = activeScrollPane(targetKind)
      if (!source || !target || source !== pane) return
      const sourceRange = source.scrollHeight - source.clientHeight
      const targetRange = target.scrollHeight - target.clientHeight
      if (sourceRange <= 0 || targetRange <= 0) return
      syncLock = true
      target.scrollTop = (source.scrollTop / sourceRange) * targetRange
      window.requestAnimationFrame(() => { syncLock = false })
    }, { passive: true })
  })

  function completeReview(button) {
    if (button.disabled) return
    button.disabled = true
    button.innerHTML = `${iconUse('icon-check')}校对已完成`
    const reviewNode = workbenchScreen.querySelector('.rail-node:nth-child(4)')
    reviewNode.dataset.status = 'completed'
    reviewNode.querySelector('.rail-dot').innerHTML = iconUse('icon-check')
    reviewNode.querySelector('.rail-sub').textContent = '已确认'
    workbenchScreen.querySelector('.pipeline-mini > span:first-child').textContent = '5 / 5 · 已完成'
    showToast('校对已确认，完整性验证通过。')
  }

  function retryCapture(button) {
    if (button.disabled) return
    button.disabled = true
    const original = button.innerHTML
    button.textContent = '正在重试…'
    window.setTimeout(() => {
      button.disabled = false
      button.innerHTML = original
      showToast('仍需要登录；已保留任务和原始 URL。')
    }, 900)
  }

  function toggleTheme() {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark'
    root.dataset.theme = next
    themeMeta.setAttribute('content', next === 'dark' ? '#0b0d10' : '#f2f5f8')
    showToast(next === 'dark' ? '已切换为深色设计稿。' : '已切换为浅色设计稿。')
  }

  renderRoutes()
  setView('new-task')
})()
