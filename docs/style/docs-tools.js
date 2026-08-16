(() => {
  if (window.top !== window.self) {
    return
  }

  const page = window.location.pathname.replace(/^\/+/, '')
  if (!page.startsWith('docs/')) {
    return
  }

  const comparisonUrl = `/__compare?page=${encodeURIComponent(page)}`
  const button = document.createElement('a')
  button.className = 'docs-compare-button'
  button.href = comparisonUrl
  button.textContent = 'Compare with base'

  button.addEventListener('click', async (event) => {
    event.preventDefault()

    try {
      const response = await window.fetch(comparisonUrl, { method: 'HEAD' })
      if (response.ok) {
        window.location.assign(comparisonUrl)
        return
      }
    } catch {
      // The comparison server is not running.
    }

    showUnavailableMessage()
  })

  document.body.append(button)

  function showUnavailableMessage() {
    let message = document.querySelector('.docs-compare-message')
    if (!message) {
      message = document.createElement('div')
      message.className = 'docs-compare-message'
      message.setAttribute('role', 'status')
      message.textContent = 'Run npm run docs:compare, then open the URL it prints.'
      document.body.append(message)
    }
  }
})()
